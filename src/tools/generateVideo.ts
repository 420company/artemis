import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { ensureDir, ensureNotSensitivePath } from '../utils/fs.js';
import { resolveBytePlusCredentials } from './byteplusMedia.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { createVisualProvider } from './visual/providers/interface.js';
import { saveGeneratedAssetToWorkspace } from './visual/saveGeneratedAsset.js';
import { buildDirectedVideoPrompt } from './visual/videoDirector.js';
import { normalizeVideoDurationForProvider } from './visual/videoParams.js';
import {
  buildVisualSetupRequiredMessage,
  describeVisualProvider,
  isVisualSetupRequiredError,
  resolveConfiguredVisualProvider,
  resolveMainSecondaryVisualFallbackCandidates,
} from '../utils/visualGenerationConfig.js';
import { toolLog, toolWarn } from '../utils/log.js';
import {
  ASSET_DOWNLOAD_TIMEOUT_MS,
  VIDEO_CREATE_TIMEOUT_MS,
  VIDEO_POLL_TIMEOUT_MS,
} from './visual/providers/timeouts.js';

const DEFAULT_MODEL = 'seedance-1-5-pro-251215';
const DEFAULT_RATIO = '16:9';
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

async function downloadUrl(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS),
  });
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

    const fallbackProviderResult = await tryGenerateWithMainSecondaryFallbackProviders(action, context);
    if (fallbackProviderResult) {
      return fallbackProviderResult;
    }

    // Legacy BytePlus env/config fallback after visualProfile and main/secondary tests.
    const { apiKey, baseUrl } = await resolveBytePlusCredentials(context.cwd, 'video');
    const model = action.model?.trim() || DEFAULT_MODEL;
    const ratio = action.ratio?.trim() || DEFAULT_RATIO;
    const duration = normalizeVideoDurationForProvider(action.duration, 'byteplus', model);
    const maxPolls =
      typeof action.maxPolls === 'number' && action.maxPolls > 0
        ? Math.floor(action.maxPolls)
        : DEFAULT_MAX_POLLS;
    const pollIntervalMs =
      typeof action.pollIntervalMs === 'number' && action.pollIntervalMs >= 1000
        ? Math.floor(action.pollIntervalMs)
        : DEFAULT_POLL_INTERVAL_MS;
    const directed = buildDirectedVideoPrompt({
      prompt: action.prompt,
      provider: 'byteplus',
      model,
      duration,
      ratio,
      referenceImageCount: action.referenceImageUrls?.length ?? 0,
    });
    toolLog(`🎞️ Artemis Director 已优化视频提示词: ${directed.providerProfile}`);

    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: directed.directedPrompt },
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
      signal: AbortSignal.timeout(VIDEO_CREATE_TIMEOUT_MS),
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
        signal: AbortSignal.timeout(VIDEO_POLL_TIMEOUT_MS),
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
    if (context.permissionMode !== 'accept-all') {
      ensureNotSensitivePath(absolute, targetRaw);
    }

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
    if (isVisualSetupRequiredError(error)) {
      return { action, ok: false, output: buildVisualSetupRequiredMessage('video') };
    }
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

  const model = action.model?.trim() || configured.config.video.model || configured.model;
  return generateVideoWithVisualProvider(action, context, configured.config, provider, model, 'configured visual API');
}

async function tryGenerateWithMainSecondaryFallbackProviders(
  action: GenerateVideoAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult | null> {
  const candidates = await resolveMainSecondaryVisualFallbackCandidates(context.cwd, 'video');
  if (!candidates.length) return null;

  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      toolLog(`🧪 测试主/副模型视频生成能力: ${candidate.label} (${candidate.provider}/${candidate.model})`);
      const provider = await createVisualProvider(candidate.config, 'video');
      if (!provider.supportsVideos || !provider.generateVideo) {
        failures.push(`${candidate.label}: provider does not support videos`);
        continue;
      }
      const result = await generateVideoWithVisualProvider(action, context, candidate.config, provider, candidate.model, 'main/secondary fallback');
      if (result.ok) return result;
      failures.push(`${candidate.label}: ${result.output}`);
    } catch (error) {
      failures.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    action,
    ok: false,
    output: `${buildVisualSetupRequiredMessage('video')}\n\nMain/secondary provider test results:\n${failures.map((line) => `  - ${line}`).join('\n')}`,
  };
}

async function generateVideoWithVisualProvider(
  action: GenerateVideoAction,
  context: ToolExecutionContext,
  config: any,
  provider: any,
  model: string,
  sourceLabel: string,
): Promise<ToolExecutionResult> {
  const videoConfig = config.video;
  toolLog(`🎬 使用${sourceLabel}生成视频: ${describeVisualProvider(config, 'video')}`);
  const duration = normalizeVideoDurationForProvider(action.duration, videoConfig.provider, model);
  const ratio = action.ratio;
  const directed = buildDirectedVideoPrompt({
    prompt: action.prompt,
    provider: videoConfig.provider,
    model,
    duration,
    ratio,
    referenceImageCount: action.referenceImageUrls?.length ?? 0,
  });
  toolLog(`🎞️ Artemis Director 已优化视频提示词: ${directed.providerProfile}`);
  const result = await provider.generateVideo({
    prompt: directed.directedPrompt,
    model,
    ratio,
    duration,
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
      output: `generate_video: ${sourceLabel} failed: ${message}`,
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
    output: `Generated video via ${sourceLabel} ${result.modelInfo?.provider ?? provider.name}/${result.modelInfo?.model ?? model} saved to ${savedPath}`,
  };
}
