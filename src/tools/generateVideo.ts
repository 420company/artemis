import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { ensureDir, ensureNotSensitivePath } from '../utils/fs.js';
import { uploadLocalReferenceAssets } from './vidarAssetHosting.js';
import { resolveModelArkMediaCredentials } from './vidarMedia.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { createVisualProvider } from './visual/providers/interface.js';
import { saveGeneratedAssetToWorkspace } from './visual/saveGeneratedAsset.js';
import {
  BYTEPLUS_SEEDANCE_2_PRO_MODEL,
  formatUnsupportedVideoReferences,
  getUnsupportedVideoReferences,
  hasMultimodalVideoReferences,
  isBytePlusProvider,
  isGeneratedAudioUnsupported,
  requiresGeneratedAudio,
  resolveVideoModelCapabilities,
  shouldPromoteBytePlusVideoModel,
} from './visual/videoCapabilities.js';
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
// 120 polls × 5s = 10 minutes. BytePlus 6-15s segments occasionally take
// 5-7 minutes when the provider's queue is busy; 60-poll cap (5 min) was
// causing false-negative timeouts. The Saga retry layer will submit a fresh
// task if even this window is exceeded.
const DEFAULT_MAX_POLLS = 120;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const UNSAFE_VIDEO_MODEL_ALIASES = new Set([
  'auto',
  'default',
  'veo-3.1-fast',
  'runway-gen3',
]);

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

function appendReferenceContent(
  content: Array<Record<string, unknown>>,
  urls: string[] | undefined,
  type: 'image_url' | 'video_url' | 'audio_url',
  role: 'reference_image' | 'reference_video' | 'reference_audio',
): void {
  if (!Array.isArray(urls)) return;
  for (const url of urls) {
    if (typeof url !== 'string' || !url.trim()) continue;
    content.push({
      type,
      [type]: { url: url.trim() },
      role,
    });
  }
}

function mimeTypeForImagePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/png';
}

function nonEmptyValues(values: string[] | undefined): string[] {
  return Array.isArray(values)
    ? values.map((value) => value.trim()).filter(Boolean)
    : [];
}

async function localImagePathsToDataUrls(paths: string[] | undefined, context: ToolExecutionContext): Promise<string[]> {
  const dataUrls: string[] = [];
  for (const rawPath of nonEmptyValues(paths)) {
    const resolved = await resolveToolPathWithWorkspaceAccess({
      inputPath: rawPath,
      toolName: 'generate_video',
      context,
    });
    const buffer = await readFile(resolved.absolute);
    dataUrls.push(`data:${mimeTypeForImagePath(resolved.absolute)};base64,${buffer.toString('base64')}`);
  }
  return dataUrls;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveConfiguredVideoModel(action: GenerateVideoAction, configuredModel: string): string {
  const requestedModel = action.model?.trim();
  if (!requestedModel) return configuredModel;
  if (UNSAFE_VIDEO_MODEL_ALIASES.has(requestedModel.toLowerCase())) return configuredModel;
  return requestedModel;
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
    const { apiKey, baseUrl } = await resolveModelArkMediaCredentials(context.cwd, 'video');
    const model = action.model?.trim() || (hasMultimodalVideoReferences(action) || requiresGeneratedAudio(action) ? BYTEPLUS_SEEDANCE_2_PRO_MODEL : DEFAULT_MODEL);
    const capabilities = resolveVideoModelCapabilities('byteplus', model);
    const unsupportedReferences = getUnsupportedVideoReferences(
      action,
      capabilities,
    );
    if (unsupportedReferences.length > 0) {
      return {
        action,
        ok: false,
        output: `generate_video: selected video model does not accept ${formatUnsupportedVideoReferences(unsupportedReferences)}. Choose Seedance 2.0 Pro for full multimodal reference input.`,
      };
    }
    if (isGeneratedAudioUnsupported(action, capabilities)) {
      return {
        action,
        ok: false,
        output: 'generate_video: selected video model cannot generate audio. Choose Seedance 2.0 Pro, or set generateAudio to false.',
      };
    }
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
      referenceVideoCount: (action.referenceVideoUrls?.length ?? 0) + (action.referenceVideoPaths?.length ?? 0),
      referenceAudioCount: (action.referenceAudioUrls?.length ?? 0) + (action.referenceAudioPaths?.length ?? 0),
    });
    toolLog(`🎞️ Artemis Director 已优化视频提示词: ${directed.providerProfile}`);

    const content: Array<Record<string, unknown>> = [
      { type: 'text', text: directed.directedPrompt },
    ];
    const referenceImageUrls = [
      ...nonEmptyValues(action.referenceImageUrls),
      ...await localImagePathsToDataUrls(action.referenceImagePaths, context),
    ];
    const referenceVideoUrls = [
      ...nonEmptyValues(action.referenceVideoUrls),
      ...await uploadLocalReferenceAssets(action.referenceVideoPaths, 'video', context),
    ];
    const referenceAudioUrls = [
      ...nonEmptyValues(action.referenceAudioUrls),
      ...await uploadLocalReferenceAssets(action.referenceAudioPaths, 'audio', context),
    ];
    appendReferenceContent(content, referenceImageUrls, 'image_url', 'reference_image');
    appendReferenceContent(content, referenceVideoUrls, 'video_url', 'reference_video');
    appendReferenceContent(content, referenceAudioUrls, 'audio_url', 'reference_audio');

    const createEndpoint = `${baseUrl}/contents/generations/tasks`;
    const createBody = {
      model,
      content,
      ratio,
      duration,
      generate_audio: capabilities.canGenerateAudio ? action.generateAudio !== false : false,
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
    if (context.permissionMode !== 'full-access') {
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

  // Chat models sometimes pass provider-generic video aliases (for example
  // "veo-3.1-fast", "default", "auto", or "runway-gen3") as action.model.
  // Those aliases should not override the configured visual model, but explicit
  // real model IDs must still work for custom video APIs.
  const model = shouldPromoteBytePlusVideoModel(action, configured.config)
    ? BYTEPLUS_SEEDANCE_2_PRO_MODEL
    : resolveConfiguredVideoModel(action, configured.config.video.model || configured.model);
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
      const model = shouldPromoteBytePlusVideoModel(action, candidate.config)
        ? BYTEPLUS_SEEDANCE_2_PRO_MODEL
        : candidate.model;
      const result = await generateVideoWithVisualProvider(action, context, candidate.config, provider, model, 'main/secondary fallback');
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
  const capabilities = resolveVideoModelCapabilities(videoConfig.provider, model);
  const unsupportedReferences = getUnsupportedVideoReferences(action, capabilities);
  if (unsupportedReferences.length > 0) {
    const modelHint = isBytePlusProvider(videoConfig.provider)
      ? ' Choose Seedance 2.0 Pro for full multimodal reference input.'
      : ' Use this provider with a text-only prompt, or configure a model that accepts reference assets.';
    return {
      action,
      ok: false,
      output: `generate_video: ${videoConfig.provider}/${model} does not accept ${formatUnsupportedVideoReferences(unsupportedReferences)}.${modelHint}`,
    };
  }
  if (isGeneratedAudioUnsupported(action, capabilities)) {
    const modelHint = isBytePlusProvider(videoConfig.provider)
      ? ' Choose Seedance 2.0 Pro, or set generateAudio to false.'
      : ' Disable generateAudio, or configure a model that supports audio output.';
    return {
      action,
      ok: false,
      output: `generate_video: ${videoConfig.provider}/${model} cannot generate audio.${modelHint}`,
    };
  }
  const ratio = action.ratio;
  const referenceImageUrls = [
    ...nonEmptyValues(action.referenceImageUrls),
    ...await localImagePathsToDataUrls(action.referenceImagePaths, context),
  ];
  const referenceVideoUrls = [
    ...nonEmptyValues(action.referenceVideoUrls),
    ...await uploadLocalReferenceAssets(action.referenceVideoPaths, 'video', context),
  ];
  const referenceAudioUrls = [
    ...nonEmptyValues(action.referenceAudioUrls),
    ...await uploadLocalReferenceAssets(action.referenceAudioPaths, 'audio', context),
  ];
  const directed = buildDirectedVideoPrompt({
    prompt: action.prompt,
    provider: videoConfig.provider,
    model,
    duration,
    ratio,
    referenceImageCount: referenceImageUrls.length,
    referenceVideoCount: referenceVideoUrls.length,
    referenceAudioCount: referenceAudioUrls.length,
  });
  toolLog(`🎞️ Artemis Director 已优化视频提示词: ${directed.providerProfile}`);
  const result = await provider.generateVideo({
    prompt: directed.directedPrompt,
    model,
    ratio,
    duration,
    referenceImageUrls,
    referenceVideoUrls,
    referenceAudioUrls,
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
