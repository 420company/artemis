// Phosphene — Visual Generation bridge
//
// Phosphene no longer owns a separate visual backend stack. Real image/video
// generation is delegated to the Artemis CLI visual tools so it always uses the
// user's configured API from the real Artemis data root: ~/.artemis/providers.json.
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { assertArtemisVisualConfig } from './artemis-visual-config.js';
export { assertArtemisVisualConfig, detectArtemisVisualConfig } from './artemis-visual-config.js';
function runArtemisTool(tool, args) {
    const artemisBin = process.env.ARTEMIS_CLI_BIN || 'artemis';
    const cliArgs = ['tool', tool];
    for (const [key, value] of Object.entries(args)) {
        if (value !== undefined && value !== '')
            cliArgs.push(`${key}=${String(value)}`);
    }
    return new Promise((resolve, reject) => {
        const child = spawn(artemisBin, cliArgs, {
            cwd: homedir(),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += String(chunk); });
        child.stderr.on('data', chunk => { stderr += String(chunk); });
        child.on('error', reject);
        child.on('close', code => {
            const output = [stdout, stderr].filter(Boolean).join('\n').trim();
            if (code === 0 && !/Invalid arguments|Unknown tool|Tool not found|failed:| error:/i.test(output)) {
                resolve(output);
                return;
            }
            reject(new Error(output || `${artemisBin} tool ${tool} exited with code ${code}`));
        });
    });
}
function extractGeneratedPath(stdout, fallback) {
    const matches = [...stdout.matchAll(/:\s*(\/[^\n]+)$/gm)];
    return matches.at(-1)?.[1]?.trim() ?? fallback;
}
// Legacy URL builder kept for markdown/gallery compatibility and explicit URL-only helpers.
export function pollinationsUrl(prompt, style, config = {}, seed) {
    const full = style ? `${prompt}, ${style}` : prompt;
    const params = {
        width: String(config.width ?? 1024),
        height: String(config.height ?? 768),
        model: config.model ?? 'flux',
        nologo: '1',
        enhance: 'false',
    };
    if (seed != null)
        params.seed = String(seed);
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}?${new URLSearchParams(params).toString()}`;
}
/**
 * Generate a single dream image through Artemis CLI's configured visual API.
 *
 * The default provider is `artemis`. This deliberately reads the user's live
 * Artemis visual configuration from ~/.artemis/providers.json by running the
 * Artemis tool with cwd=homedir().
 */
export async function generateDreamImage(prompt, style, config = { provider: 'artemis' }, outputPath, seed) {
    const backend = config.provider ?? 'artemis';
    const fullPrompt = style ? `${prompt}, ${style}` : prompt;
    if (backend === 'none') {
        throw new Error('Image generation is disabled (provider: "none")');
    }
    if (backend === 'artemis') {
        assertArtemisVisualConfig();
    }
    // Explicit legacy URL attachment remains available for old gallery workflows,
    // but real generation must use Artemis.
    if (backend === 'pollinations' && config.download === false) {
        return {
            path: pollinationsUrl(prompt, style, config, seed),
            backend: 'pollinations',
            prompt: fullPrompt,
            width: config.width ?? 1024,
            height: config.height ?? 768,
        };
    }
    const out = outputPath ?? join(homedir(), 'phosphene-generated', `phosphene-dream-${Date.now()}.png`);
    mkdirSync(join(out, '..'), { recursive: true });
    const stdout = await runArtemisTool('generate_image', {
        prompt: fullPrompt,
        outputPath: out,
        width: config.width,
        height: config.height,
        model: config.model,
    });
    return {
        path: extractGeneratedPath(stdout, out),
        backend: 'artemis',
        prompt: fullPrompt,
        width: config.width ?? 0,
        height: config.height ?? 0,
        stdout,
    };
}
export async function generateDreamVideo(prompt, style, config = { provider: 'artemis' }, outputPath) {
    const fullPrompt = style ? `${prompt}, ${style}` : prompt;
    const out = outputPath ?? join(homedir(), 'phosphene-generated', `phosphene-dream-${Date.now()}.mp4`);
    mkdirSync(join(out, '..'), { recursive: true });
    const stdout = await runArtemisTool('generate_video', {
        prompt: fullPrompt,
        outputPath: out,
        duration: config.durationSeconds ?? 6,
        width: config.width,
        height: config.height,
        model: config.model,
    });
    return {
        path: extractGeneratedPath(stdout, out),
        backend: 'artemis',
        prompt: fullPrompt,
        durationSeconds: config.durationSeconds ?? 6,
        stdout,
    };
}
export function coverImageUrl(insights, imageStyle, config = {}, seed) {
    const core = insights.slice(0, 2).join('. ');
    return pollinationsUrl(core || 'abstract dream landscape', imageStyle, config, seed);
}
//# sourceMappingURL=image-gen.js.map