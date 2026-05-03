// Phosphene — Visual Generation bridge
//
// Phosphene no longer owns a separate visual backend stack. Real image/video
// generation is delegated to the Artemis CLI visual tools so it always uses the
// user's configured API from the real Artemis data root: ~/.artemis/providers.json.

import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import type { DreamImageConfig } from './types.js';
import { assertArtemisVisualConfig, detectArtemisVisualConfig } from './artemis-visual-config.js';

export { assertArtemisVisualConfig, detectArtemisVisualConfig } from './artemis-visual-config.js';

export interface GeneratedImage {
  /** Local file path returned by Artemis. */
  path: string;
  /** The backend that produced the image. */
  backend: DreamImageConfig['provider'];
  /** The full prompt that was used. */
  prompt: string;
  /** Width in pixels, when requested/known. */
  width: number;
  /** Height in pixels, when requested/known. */
  height: number;
  /** Raw Artemis CLI output for diagnostics. */
  stdout?: string;
}

export interface GeneratedVideo {
  path: string;
  backend: 'artemis';
  prompt: string;
  durationSeconds: number;
  stdout?: string;
}

function runArtemisTool(
  tool: 'generate_image' | 'generate_video',
  args: Record<string, string | number | boolean | undefined>,
): Promise<string> {
  const artemisBin = process.env.ARTEMIS_CLI_BIN || 'artemis';
  const cliArgs = ['tool', tool];
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && value !== '') cliArgs.push(`${key}=${String(value)}`);
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

function extractGeneratedPath(stdout: string, fallback: string): string {
  const matches = [...stdout.matchAll(/:\s*(\/[^\n]+)$/gm)];
  return matches.at(-1)?.[1]?.trim() ?? fallback;
}

/**
 * Generate a single dream image through Artemis CLI's configured visual API.
 *
 * The default provider is `artemis`. This deliberately reads the user's live
 * Artemis visual configuration from ~/.artemis/providers.json by running the
 * Artemis tool with cwd=homedir().
 */
export async function generateDreamImage(
  prompt: string,
  style: string,
  config: DreamImageConfig = { provider: 'artemis' },
  outputPath?: string,
  seed?: number,
): Promise<GeneratedImage> {
  const backend = config.provider ?? 'artemis';
  const fullPrompt = style ? `${prompt}, ${style}` : prompt;

  if (backend === 'none') {
    throw new Error('Image generation is disabled (provider: "none")');
  }

  if (backend !== 'artemis') {
    throw new Error(`Unsupported dream image provider "${backend}". Phosphene dream images must use Artemis' configured visual model.`);
  }

  assertArtemisVisualConfig();

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

export async function generateDreamVideo(
  prompt: string,
  style: string,
  config: DreamImageConfig = { provider: 'artemis' },
  outputPath?: string,
): Promise<GeneratedVideo> {
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

export function coverImageUrl(
  insights: string[],
  imageStyle: string,
  config: DreamImageConfig = {},
  seed?: number,
): string {
  void insights;
  void imageStyle;
  void config;
  void seed;
  throw new Error('Remote cover-image URLs are disabled. Use generateDreamImage() so Artemis generate_image creates a real local asset.');
}
