/* eslint-disable @typescript-eslint/no-unused-vars */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, ensureNotSensitivePath } from '../utils/fs.js';
import { resolveBytePlusCredentials } from './byteplusMedia.js';
import FreyaSearch from './visual/freyaSearch.js';
import { FreyaVisualAgent } from '../agents/freyaAgent.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { toolLog, toolWarn } from '../utils/log.js';
import { createVisualProvider } from './visual/providers/interface.js';
import { saveGeneratedAssetToWorkspace } from './visual/saveGeneratedAsset.js';
import {
    buildVisualSetupRequiredMessage,
    describeVisualProvider,
    isVisualSetupRequiredError,
    resolveConfiguredVisualProvider,
    resolveMainSecondaryVisualFallbackCandidates,
} from '../utils/visualGenerationConfig.js';
import {
    ASSET_DOWNLOAD_TIMEOUT_MS,
    IMAGE_GENERATION_TIMEOUT_MS,
} from './visual/providers/timeouts.js';

const DEFAULT_MODEL = 'seedream-5-0-260128';
const DEFAULT_SIZE = '2K';
const DEFAULT_SUBDIR = 'generated-media/images';

function allowWebFallback(action: any): boolean {
    return action?.allowWebFallback === true;
}

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

function buildDefaultOutputPath(cwd: string, index: number, total: number, extension = '.png'): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const suffix = total > 1 ? `-${index + 1}` : '';
    return path.join(cwd, DEFAULT_SUBDIR, `${ts}${suffix}${extension}`);
}

async function downloadUrl(url: string): Promise<Buffer> {
    const res = await fetch(url, {
        signal: AbortSignal.timeout(ASSET_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok)
        throw new Error(`download failed: HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}

type ImageDimensions = {
    width: number;
    height: number;
};

export async function executeGenerateImage(action: any, context: any) {
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
        const { apiKey, baseUrl } = await resolveBytePlusCredentials(context.cwd, 'image');
        const model = action.model?.trim() || DEFAULT_MODEL;
        const size = action.size?.trim() || DEFAULT_SIZE;
        const count = sanitizeCount(action.count);

        const endpoint = `${baseUrl}/images/generations`;
        const body: Record<string, unknown> = {
            model,
            prompt: action.prompt,
            size,
            response_format: 'url',
            watermark: Boolean(action.watermark),
            stream: false,
        };
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
            if (allowWebFallback(action)) {
                return await fallbackToDeepSearch(action, context, `BytePlus image API returned HTTP ${res.status}`);
            }
            return {
                action,
                ok: false,
                output: `generate_image failed: BytePlus image API returned HTTP ${res.status}. Web-search fallback is disabled.`,
            };
        }

        let payload: any;
        try {
            payload = JSON.parse(raw);
        } catch {
            if (allowWebFallback(action)) {
                return await fallbackToDeepSearch(action, context, 'BytePlus image API returned invalid JSON');
            }
            return {
                action,
                ok: false,
                output: 'generate_image failed: BytePlus image API returned invalid JSON. Web-search fallback is disabled.',
            };
        }

        const items = payload.data ?? [];
        if (!items.length) {
            if (allowWebFallback(action)) {
                return await fallbackToDeepSearch(action, context, 'BytePlus image API returned no images');
            }
            return {
                action,
                ok: false,
                output: 'generate_image failed: BytePlus image API returned no images. Web-search fallback is disabled.',
            };
        }

        const savedEntries: Array<{ path: string; url?: string }> = [];
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
            ensureNotSensitivePath(absolute, targetRaw);

            const buf = await downloadUrl(url);
            await ensureDir(path.dirname(absolute));
            await writeFile(absolute, buf);
            savedEntries.push({ path: absolute, url });
        }

        if (!savedEntries.length) {
            if (allowWebFallback(action)) {
                return await fallbackToDeepSearch(action, context, 'BytePlus image API returned unusable image items');
            }
            return {
                action,
                ok: false,
                output: 'generate_image failed: BytePlus image API returned unusable image items. Web-search fallback is disabled.',
            };
        }

        const lines = [
            `Generated ${savedEntries.length} image(s) via ${model}:`,
            ...savedEntries.map((entry, idx) => `  [${idx + 1}] ${entry.path}`),
        ];
        return { action, ok: true, output: lines.join('\n') };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (allowWebFallback(action)) {
            toolLog('ℹ️ BytePlus API unavailable, falling back to deep search...');
            return await fallbackToDeepSearch(action, context, message);
        }
        if (isVisualSetupRequiredError(error)) {
            return {
                action,
                ok: false,
                output: buildVisualSetupRequiredMessage('image'),
            };
        }
        return {
            action,
            ok: false,
            output: `generate_image failed: ${message}. Web-search fallback is disabled.`,
        };
    }
}

async function tryGenerateWithConfiguredVisualProvider(action: any, context: any) {
    const configured = await resolveConfiguredVisualProvider(context.cwd, 'image');
    if (!configured) {
        return null;
    }

    const provider = await createVisualProvider(configured.config, 'image');
    if (!provider.supportsImages) {
        toolWarn(`⚠️ 已配置的视觉提供商不支持图片生成: ${configured.provider}`);
        return {
            action,
            ok: false,
            output: `generate_image failed: configured visual provider does not support image generation: ${configured.provider}`,
        };
    }

    return generateImageWithVisualProvider(action, context, configured.config, provider, configured.model, 'configured visual API');
}

async function tryGenerateWithMainSecondaryFallbackProviders(action: any, context: any) {
    const candidates = await resolveMainSecondaryVisualFallbackCandidates(context.cwd, 'image');
    if (!candidates.length) return null;

    const failures: string[] = [];
    for (const candidate of candidates) {
        try {
            toolLog(`🧪 测试主/副模型图片生成能力: ${candidate.label} (${candidate.provider}/${candidate.model})`);
            const provider = await createVisualProvider(candidate.config, 'image');
            if (!provider.supportsImages) {
                failures.push(`${candidate.label}: provider does not support images`);
                continue;
            }

            const result = await generateImageWithVisualProvider(action, context, candidate.config, provider, candidate.model, 'main/secondary fallback');
            if (result.ok) return result;
            failures.push(`${candidate.label}: ${result.output}`);
        } catch (error) {
            failures.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    if (allowWebFallback(action)) {
        return await fallbackToDeepSearch(action, context, `Configured visual API missing/unusable; main/secondary visual tests failed: ${failures.join(' | ')}`);
    }
    return {
        action,
        ok: false,
        output: `${buildVisualSetupRequiredMessage('image')}\n\nMain/secondary provider test results:\n${failures.map((line) => `  - ${line}`).join('\n')}`,
    };
}

async function generateImageWithVisualProvider(
    action: any,
    context: any,
    config: any,
    provider: any,
    configuredModel: string,
    sourceLabel: string,
) {
    const count = sanitizeCount(action.count);
    const imageConfig = config.image;
    const savedEntries: Array<{ path: string; provider: string; model: string }> = [];
    for (let i = 0; i < count; i += 1) {
        const model = action.model?.trim() || imageConfig.model || configuredModel;
        const outputFormat = normalizeImageOutputFormat(action.outputFormat) || imageConfig.defaultParams.outputFormat;
        toolLog(`🎨 使用${sourceLabel}生成图片: ${describeVisualProvider(config, 'image')}`);
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
        });

        if (!result.success || !result.assetPath) {
            const message = result.error ?? 'unknown error';
            toolWarn(`⚠️ ${sourceLabel}图片生成失败: ${message}`);
            return {
                action,
                ok: false,
                output: `generate_image failed: ${sourceLabel} failed: ${message}.`,
            };
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
            `Generated ${savedEntries.length} image(s) via ${sourceLabel}:`,
            ...savedEntries.map((entry, idx) => `  [${idx + 1}] ${entry.provider}/${entry.model}: ${entry.path}`),
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

async function fallbackToDeepSearch(action: any, context: any, reason?: string) {
    try {
        if (reason) {
            toolWarn(`⚠️ ${reason}`);
        }
        toolLog('🔍 Starting deep search fallback...');
        
        // 使用 FreyaVisualAgent 扩展提示词
        const config = {
            enabled: true,
            image: {
                provider: 'byteplus',
                apiKey: '',
                baseUrl: '',
                model: 'seedream-5-0-260128',
                defaultParams: {
                    style: 'realistic' as const,
                    quality: 'standard' as const,
                    size: '2K' as const,
                    watermark: false
                }
            },
            video: {
                enabled: true,
                provider: 'byteplus',
                apiKey: '',
                baseUrl: '',
                model: 'seedance-1-5-pro-251215',
                defaultParams: {
                    quality: 'standard' as const,
                    duration: '5s' as const,
                    resolution: '1080p' as const,
                    style: 'realistic' as const,
                    format: 'mp4' as const,
                    framerate: '30fps' as const,
                    watermark: false
                }
            }
        };
        
        const freyaAgent = new FreyaVisualAgent(config);
        const expandedPrompt = await freyaAgent.expandPrompt(action.prompt, 'image');
        
        // 确定输出路径
        const targetRaw = action.outputPath 
            ? action.outputPath 
            : buildDefaultOutputPath(context.cwd, 0, 1);
        const { absolute } = await resolveToolPathWithWorkspaceAccess({
            inputPath: targetRaw,
            toolName: 'generate_image',
            context,
        });
        ensureNotSensitivePath(absolute, targetRaw);
        await ensureDir(path.dirname(absolute));
        
        // 执行深度搜索
        const searchResult = await FreyaSearch.deepSearchSimilarImage(expandedPrompt, absolute);
        
        if (searchResult.success && searchResult.downloadedPath) {
            const bestResult = searchResult.searchResults?.[0];
            const sourceLine = bestResult
                ? `\nSource: ${bestResult.source} - ${bestResult.title}`
                : '';
            return { 
                action, 
                ok: true, 
                output: `Fetched image via Freya web-search fallback (not generated locally): ${searchResult.downloadedPath}${sourceLine}` 
            };
        } else {
            return {
                action,
                ok: false,
                output: 'generate_image failed: web-search fallback did not return a usable image.',
            };
        }
    } catch (fallbackError) {
        const message = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        return {
            action,
            ok: false,
            output: `generate_image fallback failed: ${message}`
        };
    }
}

function appendSuffixToPath(p: string, suffix: number): string {
    const ext = path.extname(p);
    const base = ext ? p.slice(0, -ext.length) : p;
    return `${base}-${suffix}${ext || '.png'}`;
}
