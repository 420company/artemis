import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { ensureDir, ensureNotSensitivePath } from '../utils/fs.js';
import { resolveBytePlusCredentials } from './byteplusMedia.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { createVisualProvider } from './visual/providers/interface.js';
import { saveGeneratedAssetToWorkspace } from './visual/saveGeneratedAsset.js';
import {
  describeVisualProvider,
  resolveConfiguredVisualProvider,
} from '../utils/visualGenerationConfig.js';
import { toolLog, toolWarn } from '../utils/log.js';

const DEFAULT_MODEL = 'seedance-1-5-pro-251215';
const DEFAULT_RATIO = '16:9';
const DEFAULT_DURATION = 5;
const DEFAULT_SUBDIR = 'generated-media/videos';
const DEFAULT_MAX_POLLS = 60;
const DEFAULT_POLL_INTERVAL_MS = 5000;

type GenerateVideoAction = Extract<AgentAction, { type: 'generate_video' }>;

type TaskCreateResponse = {
  id?: string;
  task_id?: string;
  error?: { message?: string };
};

type TaskStatusResponse = {
  status?: string;
  content?: {
    video_url?: string;
    url?: string;
  };
  video_url?: string;
  url?: string;
  error?: { message?: string };
};

function buildDefaultOutputPath(cwd: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(cwd, DEFAULT_SUBDIR, `${ts}.mp4`);
}

function sanitizeDuration(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_DURATION;
  const n = Math.floor(raw);
  if (n < 1) return 1;
  if (n > 60) return 60;
  return n;
}

async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

function extractTaskId(payload: TaskCreateResponse): string | undefined {
  return payload.id ?? payload.task_id;
}

function extractVideoUrl(payload: TaskStatusResponse): string | undefined {
  return (
    payload.content?.video_url ??
    payload.content?.url ??
    payload.video_url ??
    payload.url
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeGenerateVideo(
  action: GenerateVideoAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  try {
    const configuredResult = await tryGenerateWithConfiguredVisualProvider(action, context);
    if (configuredResult) {
      return configuredResult;
    }

    const { apiKey, baseUrl } = await resolveBytePlusCredentials(context.cwd, 'video');
    const model = action.model?.trim() || DEFAULT_MODEL;
    const ratio = action.ratio?.trim() || DEFAULT_RATIO;
    const duration = sanitizeDuration(action.duration);
    const maxPolls =
      typeof action.maxPolls === 'number' && action.maxPolls > 0
        ? Math.floor(action.maxPolls)
        : DEFAULT_MAX_POLLS;
    const pollIntervalMs =
      typeof action.pollIntervalMs === 'number' && action.pollIntervalMs >= 1000
        ? Math.floor(action.pollIntervalMs)
        : DEFAULT_POLL_INTERVAL_MS;

    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: action.prompt },
    ];
    if (Array.isArray(action.referenceImageUrls)) {
      for (const url of action.referenceImageUrls) {
        if (typeof url === 'string' && url.trim()) {
          content.push({
            type: 'image_url',
            image_url: { url: url.trim() },
            role: 'reference_image',
          });
        }
      }
    }

    const createEndpoint = `${baseUrl}/contents/generations/tasks`;
    const createBody = {
      model,
      content,
      ratio,
      duration,
      generate_audio: action.generateAudio !== false,
      watermark: Boolean(action.watermark),
    };

    const createRes = await fetch(createEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(createBody),
    });

    const createRaw = await createRes.text();
    if (!createRes.ok) {
      return {
        action,
        ok: false,
        output: `generate_video: task create failed (HTTP ${createRes.status}): ${createRaw.slice(0, 500)}`,
      };
    }

    let createPayload: TaskCreateResponse;
    try {
      createPayload = JSON.parse(createRaw) as TaskCreateResponse;
    } catch {
      return {
        action,
        ok: false,
        output: `generate_video: could not parse create response: ${createRaw.slice(0, 500)}`,
      };
    }

    const taskId = extractTaskId(createPayload);
    if (!taskId) {
      return {
        action,
        ok: false,
        output: `generate_video: no task id in response. ${createPayload.error?.message ?? ''}`.trim(),
      };
    }

    const statusEndpoint = `${baseUrl}/contents/generations/tasks/${encodeURIComponent(taskId)}`;
    let videoUrl: string | undefined;
    let lastStatus = 'pending';

    for (let attempt = 0; attempt < maxPolls; attempt++) {
      await sleep(pollIntervalMs);
      const pollRes = await fetch(statusEndpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const pollRaw = await pollRes.text();
      if (!pollRes.ok) {
        return {
          action,
          ok: false,
          output: `generate_video: poll failed (HTTP ${pollRes.status}): ${pollRaw.slice(0, 500)}`,
        };
      }
      let pollPayload: TaskStatusResponse;
      try {
        pollPayload = JSON.parse(pollRaw) as TaskStatusResponse;
      } catch {
        continue;
      }
      lastStatus = (pollPayload.status ?? '').toLowerCase();
      if (lastStatus === 'failed' || lastStatus === 'cancelled' || lastStatus === 'canceled') {
        return {
          action,
          ok: false,
          output: `generate_video: task ${taskId} ended with status=${lastStatus}. ${pollPayload.error?.message ?? ''}`.trim(),
        };
      }
      const maybeUrl = extractVideoUrl(pollPayload);
      if (maybeUrl && (lastStatus === 'succeeded' || lastStatus === 'completed' || lastStatus === 'success' || lastStatus === '')) {
        videoUrl = maybeUrl;
        break;
      }
    }

    if (!videoUrl) {
      return {
        action,
        ok: false,
        output: `generate_video: task ${taskId} did not finish within ${maxPolls} polls (${(maxPolls * pollIntervalMs) / 1000}s). Last status: ${lastStatus}.`,
      };
    }

    const targetRaw = action.outputPath ?? buildDefaultOutputPath(context.cwd);
    const { absolute } = await resolveToolPathWithWorkspaceAccess({
      inputPath: targetRaw,
      toolName: 'generate_video',
      context,
    });
    ensureNotSensitivePath(absolute, targetRaw);

    const buf = await downloadUrl(videoUrl);
    await ensureDir(path.dirname(absolute));
    await writeFile(absolute, buf);

    return {
      action,
      ok: true,
      output: `Generated video via ${model} (task ${taskId}) saved to ${absolute}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { action, ok: false, output: `generate_video error: ${message}` };
  }
}

async function tryGenerateWithConfiguredVisualProvider(
  action: GenerateVideoAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult | null> {
  const configured = await resolveConfiguredVisualProvider(context.cwd, 'video');
  if (!configured) {
    return null;
  }

  const provider = await createVisualProvider(configured.config, 'video');
  if (!provider.supportsVideos || !provider.generateVideo) {
    return {
      action,
      ok: false,
      output: `generate_video: configured visual provider does not support video generation: ${configured.provider}`,
    };
  }

  const videoConfig = configured.config.video;
  const model = action.model?.trim() || videoConfig.model || configured.model;
  toolLog(`🎬 使用本地视觉 API 生成视频: ${describeVisualProvider(configured.config, 'video')}`);
  const result = await provider.generateVideo({
    prompt: action.prompt,
    model,
    ratio: action.ratio,
    duration: sanitizeDuration(action.duration),
    referenceImageUrls: action.referenceImageUrls,
    generateAudio: action.generateAudio,
    watermark: action.watermark ?? videoConfig.defaultParams.watermark,
    maxPolls: action.maxPolls,
    pollIntervalMs: action.pollIntervalMs,
  } as any);

  if (!result.success || !result.assetPath) {
    const message = result.error ?? 'unknown error';
    toolWarn(`⚠️ 本地视频生成 API 失败: ${message}`);
    return {
      action,
      ok: false,
      output: `generate_video: configured visual provider failed: ${message}`,
    };
  }

  const targetRaw = action.outputPath ?? buildDefaultOutputPath(context.cwd);
  const savedPath = await saveGeneratedAssetToWorkspace({
    assetPath: result.assetPath,
    targetPath: targetRaw,
    defaultExtension: '.mp4',
    toolName: 'generate_video',
    context,
  });

  return {
    action,
    ok: true,
    output: `Generated video via configured visual API ${result.modelInfo?.provider ?? provider.name}/${result.modelInfo?.model ?? model} saved to ${savedPath}`,
  };
}
