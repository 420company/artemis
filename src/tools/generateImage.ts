import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, ensureNotSensitivePath } from '../utils/fs.js';
import { modelArkEndpoint, resolveModelArkMediaCredentials } from './vidarMedia.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { toolLog, toolWarn } from '../utils/log.js';
import { createVisualProvider } from './visual/providers/interface.js';
import { saveGeneratedAssetToWorkspace } from './visual/saveGeneratedAsset.js';
import {
    buildVisualSetupRequiredMessage,
    isVisualSetupRequiredError,
    resolveConfiguredVisualProvider,
    resolveMainSecondaryVisualFallbackCandidates,
} from '../utils/visualGenerationConfig.js';
import {
    ASSET_DOWNLOAD_TIMEOUT_MS,
    IMAGE_GENERATION_TIMEOUT_MS,
} from './visual/providers/timeouts.js';
import { getMediaOutputRoot } from '../utils/mediaOutputRoot.js';
import {
    classifyImageGenerationFailure,
    describeImageGenerationFailureParts,
    formatImageGenerationFailure,
    type ImageGenerationFailureInput,
    type ImageGenerationFailureKind,
} from './visual/imageGenerationFailure.js';
import { baseUrlIsLoopback, downloadProviderAsset } from './visual/safeDownload.js';
import {
    checkBytePlusReferenceSupport,
    resolveReferenceImages,
} from './visual/referenceImages.js';

const DEFAULT_MODEL = 'seedream-5-0-260128';
const DEFAULT_SIZE = '2K';
const DEFAULT_SUBDIR = 'images';

function sanitizeCount(raw: unknown): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw))
        return 1;
    const n = Math.floor(raw);
    if (n < 1)
        return 1;
    if (n > 4)
        return 4;
    return n;
}

function buildDefaultOutputPath(_cwd: string, index: number, total: number, extension = '.png'): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = total > 1 ? `-${index + 1}` : '';
    return path.join(getMediaOutputRoot(), DEFAULT_SUBDIR, `${ts}${suffix}${extension}`);
}

type FailureOptions = Omit<ImageGenerationFailureInput, 'detail'>;

function failure(action: any, detail: string, options: FailureOptions = {}) {
    return {
        action,
        ok: false,
        output: formatImageGenerationFailure({ detail, ...options }).output,
    };
}

/**
 * Some of the requested images were saved and the rest failed: report the saved
 * paths (they are real, usable results) together with why the rest failed.
 */
function partialSuccess(
    action: any,
    savedLines: string[],
    requested: number,
    _sourceLabel: string,
    failed: ImageGenerationFailureInput,
) {
    const parts = describeImageGenerationFailureParts(failed);
    return {
        action,
        ok: true,
        output: [
            `Generated ${savedLines.length} of ${requested} requested image(s):`,
            ...savedLines,
            `The other ${requested - savedLines.length} image(s) failed: ${parts.reason}`,
            parts.details,
        ].join('\n'),
    };
}

/**
 * Generates images with the configured visual provider, then eligible
 * main/secondary providers, then the legacy ModelArk (BytePlus) credentials.
 * Every path generates a real image or fails with an actionable reason; there
 * is no web-image substitute.
 */
export async function executeGenerateImage(action: any, context: any) {
    let referenceImages: string[];
    try {
        referenceImages = await resolveReferenceImages(action.referenceImages, context, {
            outputCount: sanitizeCount(action.count),
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            action,
            ok: false,
            output: `Image generation failed: invalid referenceImages. ${message}\nNo image was created.`,
        };
    }

    try {
        const configuredResult = await tryGenerateWithConfiguredVisualProvider(action, context, referenceImages);
        if (configuredResult) {
            return configuredResult;
        }

        const fallbackProviderResult = await tryGenerateWithMainSecondaryFallbackProviders(action, context, referenceImages);
        if (fallbackProviderResult) {
            return fallbackProviderResult;
        }

        // Legacy BytePlus env/config path after visualProfile and main/secondary tests.
        const { apiKey, baseUrl } = await resolveModelArkMediaCredentials(context.cwd, 'image');
        const model = action.model?.trim() || DEFAULT_MODEL;
        const size = action.size?.trim() || DEFAULT_SIZE;
        const count = sanitizeCount(action.count);
        const source = 'BytePlus image API';
        const hasReferences = referenceImages.length > 0;

        const referenceError = checkBytePlusReferenceSupport(model, referenceImages.length);
        if (referenceError) {
            return { action, ok: false, output: `Image generation failed: ${referenceError}\nNo image was created.` };
        }

        const endpoint = modelArkEndpoint(baseUrl, 'images/generations');
        const body: Record<string, unknown> = {
            model,
            prompt: action.prompt,
            size,
            response_format: 'url',
            watermark: Boolean(action.watermark),
            stream: false,
        };
        if (referenceImages.length === 1) {
            body['image'] = referenceImages[0];
        } else if (referenceImages.length > 1) {
            body['image'] = referenceImages;
        }
        if (count > 1) {
            body['sequential_image_generation'] = 'auto';
            body['sequential_image_generation_options'] = { max_images: count };
        }

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(IMAGE_GENERATION_TIMEOUT_MS),
        });

        const raw = await res.text();
        if (!res.ok) {
            return failure(action, raw.slice(0, 1000), { status: res.status, source, hasReferences });
        }

        let payload: any;
        try {
            payload = JSON.parse(raw);
        } catch {
            return failure(action, `invalid JSON response: ${raw.slice(0, 200)}`, { source });
        }

        const items = payload.data ?? [];
        if (!items.length) {
            const reason = payload.error ? JSON.stringify({ error: payload.error }) : 'no images returned';
            return failure(action, reason, { source });
        }

        const savedEntries: Array<{ path: string; url?: string }> = [];
        let downloadError: string | undefined;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const url = item?.url;
            if (!url) continue;

            const targetRaw = action.outputPath
                ? (items.length > 1
                    ? appendSuffixToPath(action.outputPath, i + 1)
                    : action.outputPath)
                : buildDefaultOutputPath(context.cwd, i, items.length);
            const { absolute } = await resolveToolPathWithWorkspaceAccess({
                inputPath: targetRaw,
                toolName: 'generate_image',
                context,
            });
            if (context.permissionMode !== 'full-access') {
                ensureNotSensitivePath(absolute, targetRaw);
            }

            let buf: Buffer;
            try {
                buf = await downloadProviderAsset(url, {
                    timeoutMs: ASSET_DOWNLOAD_TIMEOUT_MS,
                    allowLoopback: baseUrlIsLoopback(baseUrl),
                });
            } catch (error) {
                downloadError = `Image download failed: ${error instanceof Error ? error.message : String(error)}`;
                continue;
            }
            await ensureDir(path.dirname(absolute));
            await writeFile(absolute, buf);
            savedEntries.push({ path: absolute, url });
        }

        if (!savedEntries.length) {
            return downloadError
                ? failure(action, downloadError, { source, stage: 'download' })
                : failure(action, 'response contained no downloadable image URLs', { source });
        }

        const savedLines = savedEntries.map((entry, idx) => `  [${idx + 1}] ${entry.path}`);
        if (downloadError && savedEntries.length < items.length) {
            return partialSuccess(action, savedLines, items.length, model, { detail: downloadError, source, stage: 'download' });
        }
        const lines = [
            `Generated ${savedEntries.length} image(s):`,
            ...savedLines,
        ];
        return { action, ok: true, output: lines.join('\n') };
    } catch (error) {
        if (isVisualSetupRequiredError(error)) {
            return {
                action,
                ok: false,
                output: buildVisualSetupRequiredMessage('image'),
            };
        }
        const message = error instanceof Error ? error.message : String(error);
        return failure(action, message);
    }
}

async function tryGenerateWithConfiguredVisualProvider(action: any, context: any, referenceImages: string[]) {
    const configured = await resolveConfiguredVisualProvider(context.cwd, 'image');
    if (!configured) {
        return null;
    }

    const provider = await createVisualProvider(configured.config, 'image');
    if (!provider.supportsImages) {
        toolWarn('⚠️ 已配置的视觉服务不支持图片生成。');
        return {
            action,
            ok: false,
            output: 'Image generation failed: the configured visual service does not support image generation.',
        };
    }

    return generateImageWithVisualProvider(action, context, configured.config, provider, configured.model, 'configured visual API', referenceImages);
}

// Failure kinds the user has to act on; when any provider reports one, it is
// surfaced instead of the generic "set up a visual provider" message.
const ACTIONABLE_FAILURE_PRIORITY: ImageGenerationFailureKind[] = [
    'insufficient_balance',
    'content_rejected',
    'payload_too_large',
];

async function tryGenerateWithMainSecondaryFallbackProviders(action: any, context: any, referenceImages: string[]) {
    const candidates = await resolveMainSecondaryVisualFallbackCandidates(context.cwd, 'image');
    if (!candidates.length) return null;

    const failures: Array<{ label: string; detail: string }> = [];
    for (const candidate of candidates) {
        try {
            toolLog(`🧪 测试主/副模型图片生成能力: ${candidate.label}`);
            const provider = await createVisualProvider(candidate.config, 'image');
            if (!provider.supportsImages) {
                failures.push({ label: candidate.label, detail: 'provider does not support images' });
                continue;
            }

            const result = await generateImageWithVisualProvider(action, context, candidate.config, provider, candidate.model, candidate.label, referenceImages);
            if (result.ok) return result;
            failures.push({ label: candidate.label, detail: String(result.output) });
        } catch (error) {
            failures.push({ label: candidate.label, detail: error instanceof Error ? error.message : String(error) });
        }
    }

    for (const kind of ACTIONABLE_FAILURE_PRIORITY) {
        const match = failures.find((entry) => classifyImageGenerationFailure({ detail: entry.detail }) === kind);
        if (match) {
            return { action, ok: false, output: match.detail.startsWith('Image generation failed:')
                ? match.detail
                : formatImageGenerationFailure({ detail: match.detail, source: match.label }).output };
        }
    }
    return {
        action,
        ok: false,
        output: `${buildVisualSetupRequiredMessage('image')}\n\nMain/secondary provider test results:\n${failures.map((entry) => `  - ${entry.label}: ${entry.detail}`).join('\n')}`,
    };
}

async function generateImageWithVisualProvider(
    action: any,
    context: any,
    config: any,
    provider: any,
    configuredModel: string,
    sourceLabel: string,
    referenceImages: string[] = [],
) {
    const count = sanitizeCount(action.count);
    const imageConfig = config.image;
    if (referenceImages.length > 0 && provider.supportsImageReferences !== true) {
        return {
            action,
            ok: false,
            output: `Image generation failed: reference images are not supported by the configured image model. Retry without referenceImages (describe the reference in the prompt instead) or switch the image provider.\nNo image was created.`,
        };
    }
    const savedEntries: Array<{ path: string; provider: string; model: string }> = [];
    for (let i = 0; i < count; i += 1) {
        const model = action.model?.trim() || imageConfig.model || configuredModel;
        const outputFormat = normalizeImageOutputFormat(action.outputFormat) || imageConfig.defaultParams.outputFormat;
        toolLog('🎨 开始生成图片。');
        const result = await provider.generateImage({
            prompt: action.prompt,
            model,
            size: action.size?.trim() || imageConfig.defaultParams.size,
            quality: action.quality?.trim?.() || imageConfig.defaultParams.quality,
            style: imageConfig.defaultParams.style,
            outputFormat,
            outputCompression: normalizeOutputCompression(action.outputCompression) ?? imageConfig.defaultParams.outputCompression,
            background: action.background?.trim?.() || imageConfig.defaultParams.background,
            watermark: action.watermark ?? imageConfig.defaultParams.watermark,
            count: 1,
            ...(referenceImages.length > 0 ? { referenceImages } : {}),
        });

        if (!result.success || !result.assetPath) {
            const message = result.error ?? 'unknown error';
            toolWarn(`⚠️ ${sourceLabel}图片生成失败: ${message}`);
            const failed: ImageGenerationFailureInput = {
                detail: message,
                status: result.httpStatus,
                stage: result.failureStage,
                source: sourceLabel,
                hasReferences: referenceImages.length > 0,
            };
            if (savedEntries.length > 0) {
                return partialSuccess(
                    action,
                    savedEntries.map((entry, idx) => `  [${idx + 1}] ${entry.path}`),
                    count,
                    sourceLabel,
                    failed,
                );
            }
            return failure(action, message, failed);
        }

        const targetRaw = action.outputPath
            ? (count > 1 ? appendSuffixToPath(action.outputPath, i + 1) : action.outputPath)
            : buildDefaultOutputPath(context.cwd, i, count, extensionForImageOutputFormat(outputFormat));
        const savedPath = await saveGeneratedAssetToWorkspace({
            assetPath: result.assetPath,
            targetPath: targetRaw,
            defaultExtension: extensionForImageOutputFormat(outputFormat),
            toolName: 'generate_image',
            context,
        });
        savedEntries.push({
            path: savedPath,
            provider: result.modelInfo?.provider ?? provider.name,
            model: result.modelInfo?.model ?? model,
        });
    }

    return {
        action,
        ok: true,
        output: [
            `Generated ${savedEntries.length} image(s):`,
            ...savedEntries.map((entry, idx) => `  [${idx + 1}] ${entry.path}`),
        ].join('\n'),
    };
}

function normalizeImageOutputFormat(raw: unknown): 'png' | 'jpeg' | 'webp' | undefined {
    if (typeof raw !== 'string') return undefined;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'jpg' || normalized === 'jpeg') return 'jpeg';
    if (normalized === 'png' || normalized === 'webp') return normalized;
    return undefined;
}

function extensionForImageOutputFormat(format: string | undefined): string {
    const normalized = normalizeImageOutputFormat(format);
    if (normalized === 'jpeg') return '.jpg';
    if (normalized === 'webp') return '.webp';
    return '.png';
}

function normalizeOutputCompression(raw: unknown): number | undefined {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
    return Math.max(0, Math.min(100, Math.round(raw)));
}

function appendSuffixToPath(p: string, suffix: number): string {
    const ext = path.extname(p);
    const base = ext ? p.slice(0, -ext.length) : p;
    return `${base}-${suffix}${ext || '.png'}`;
}
