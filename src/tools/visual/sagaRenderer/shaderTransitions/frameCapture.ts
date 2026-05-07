import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Browser } from 'playwright';
import { buildSagaShaderHtml } from './template.js';
import { SAGA_SHADER_REGISTRY, type SagaShaderName } from './shaders.js';

const execFileAsync = promisify(execFile);

// Render a Saga shader transition between two frames as a PNG sequence.
// We launch a single Playwright Chromium tab, load the shader page (which
// has both source frames embedded as data URLs), then call
// window.__sagaShaderRender(progress) per frame and screenshot the canvas.
//
// Why Playwright over Puppeteer: it's already in the project's dependency
// graph (`playwright: ^1.59.1`), so no new install needed.

export type SagaShaderRenderRequest = {
  shader: SagaShaderName;
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  imageAPath: string;       // PNG of segment A's last frame
  imageBPath: string;       // PNG of segment B's first frame
  outputDir: string;        // where the PNG sequence + intermediate mp4 land
  accentHex?: string;       // default '#f8c96a'
};

export type SagaShaderRenderResult = {
  ok: true;
  intermediateMp4: string;  // ready to be concatenated with surrounding segments
  frameCount: number;
  outputDir: string;
} | {
  ok: false;
  error: string;
  outputDir: string;
};

async function fileToDataUrl(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

let cachedBrowser: Browser | null = null;
let cachedBrowserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (cachedBrowser) return cachedBrowser;
  if (cachedBrowserPromise) return cachedBrowserPromise;
  cachedBrowserPromise = (async () => {
    const playwright = await import('playwright');
    // Prefer hardware-accelerated WebGL where it exists (macOS Metal,
    // Linux desktop with proper GPU drivers). The earlier
    // `--use-gl=swiftshader` flag forced software rasterization, which
    // routinely hits CONTEXT_LOST_WEBGL on 1080×1920 canvases when
    // canvas.toDataURL() (a ReadPixels GPU stall) is called every frame.
    //
    // Falling back order in Chromium:
    //   1) hardware GL when available
    //   2) ANGLE (Metal/D3D11/etc) when --use-angle is set
    //   3) swiftshader software rasterizer
    //
    // We only force --use-gl=angle as a stability hint. If a host has
    // truly no GPU, ANGLE itself will fall back to software.
    const browser = await playwright.chromium.launch({
      headless: true,
      args: [
        '--enable-webgl',
        '--ignore-gpu-blocklist',
        '--enable-features=Vulkan,UseSkiaRenderer',
        '--use-angle=default',
        '--disable-features=UseChromeOSDirectVideoDecoder',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    cachedBrowser = browser;
    cachedBrowserPromise = null;
    return browser;
  })();
  return cachedBrowserPromise;
}

export async function closeSagaShaderBrowser(): Promise<void> {
  if (cachedBrowser) {
    try {
      await cachedBrowser.close();
    } catch {
      // ignore
    }
    cachedBrowser = null;
  }
  cachedBrowserPromise = null;
}

export async function renderSagaShaderTransition(request: SagaShaderRenderRequest): Promise<SagaShaderRenderResult> {
  const descriptor = SAGA_SHADER_REGISTRY[request.shader];
  if (!descriptor) {
    return { ok: false, error: `unknown saga shader: ${request.shader}`, outputDir: request.outputDir };
  }
  await mkdir(request.outputDir, { recursive: true });

  let imageAUrl: string;
  let imageBUrl: string;
  try {
    [imageAUrl, imageBUrl] = await Promise.all([
      fileToDataUrl(request.imageAPath),
      fileToDataUrl(request.imageBPath),
    ]);
  } catch (error) {
    return {
      ok: false,
      error: `saga shader: failed to read source frames — ${error instanceof Error ? error.message : String(error)}`,
      outputDir: request.outputDir,
    };
  }

  const html = buildSagaShaderHtml({
    width: request.width,
    height: request.height,
    accentHex: (request.accentHex ?? '#f8c96a'),
    imageADataUrl: imageAUrl,
    imageBDataUrl: imageBUrl,
    fragmentSource: descriptor.source,
  });
  const htmlPath = path.join(request.outputDir, 'shader.html');
  await writeFile(htmlPath, html, 'utf8');

  const totalFrames = Math.max(2, Math.round(request.durationSeconds * request.fps));

  let browser: Browser | null = null;
  try {
    browser = await getBrowser();
  } catch (error) {
    return {
      ok: false,
      error: `saga shader: failed to launch headless browser — ${error instanceof Error ? error.message : String(error)}`,
      outputDir: request.outputDir,
    };
  }

  const context = await browser.newContext({
    viewport: { width: request.width, height: request.height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const consoleLog: string[] = [];
  page.on('console', (msg) => {
    consoleLog.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    consoleLog.push(`[pageerror] ${err.message}`);
  });
  try {
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 30_000 });
    // Wait for the shader runtime to confirm the textures are loaded and the
    // render function is exposed.
    await page.waitForFunction(
      () => Boolean((window as unknown as { __sagaShaderReady?: boolean; __sagaShaderError?: string }).__sagaShaderReady) ||
            Boolean((window as unknown as { __sagaShaderError?: string }).__sagaShaderError),
      { timeout: 15_000 },
    );
    const error = await page.evaluate(() => (window as unknown as { __sagaShaderError?: string }).__sagaShaderError ?? null);
    if (error) {
      throw new Error(`saga shader runtime error: ${error}\nconsole:\n${consoleLog.join('\n')}`);
    }
    if (process.env.SAGA_SHADER_DEBUG === '1') {
      const ready = await page.evaluate(() => Boolean((window as unknown as { __sagaShaderReady?: boolean }).__sagaShaderReady));
      console.error(`[saga shader debug] ready=${ready} consoleLines=${consoleLog.length}`);
      for (const line of consoleLog.slice(-20)) console.error('[saga shader debug]', line);
    }

    // Render and capture each frame via canvas.toDataURL() — this reads the
    // actual WebGL pixel buffer, which Playwright's element.screenshot()
    // does NOT do reliably across all platforms (it sometimes captures the
    // DOM-paint state, missing the WebGL backbuffer). Reading the data URL
    // and decoding base64 → file is slower per-frame but produces correct
    // pixels every time.
    for (let frame = 0; frame < totalFrames; frame += 1) {
      const progress = totalFrames === 1 ? 1 : frame / (totalFrames - 1);
      const dataUrl = await page.evaluate((p: number) => {
        const fn = (window as unknown as { __sagaShaderRender?: (p: number) => boolean }).__sagaShaderRender;
        if (!fn) return null;
        const ok = fn(p);
        if (!ok) return null;
        const canvas = document.getElementById('c') as HTMLCanvasElement | null;
        return canvas ? canvas.toDataURL('image/png') : null;
      }, progress);
      if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
        return {
          ok: false,
          error: `saga shader: canvas.toDataURL returned empty at frame ${frame}/${totalFrames}`,
          outputDir: request.outputDir,
        };
      }
      const base64 = dataUrl.slice('data:image/png;base64,'.length);
      const buffer = Buffer.from(base64, 'base64');
      const target = path.join(request.outputDir, `frame-${String(frame).padStart(5, '0')}.png`);
      await writeFile(target, buffer);
    }
  } catch (error) {
    return {
      ok: false,
      error: `saga shader: capture failed — ${error instanceof Error ? error.message : String(error)}`,
      outputDir: request.outputDir,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  // Encode the PNG sequence to an intermediate MP4 that matches the project
  // codec, then return the path. Concat-side will treat this as just another
  // input segment with no audio (audio is silent during shader transitions
  // so the surrounding segments' acrossfade still works smoothly).
  const intermediateMp4 = path.join(request.outputDir, 'transition.mp4');
  const framePattern = path.join(request.outputDir, 'frame-%05d.png');
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-framerate', String(request.fps),
      '-i', framePattern,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-r', String(request.fps),
      intermediateMp4,
    ], { timeout: 5 * 60_000 });
  } catch (error) {
    return {
      ok: false,
      error: `saga shader: ffmpeg encode of PNG sequence failed — ${error instanceof Error ? error.message : String(error)}`,
      outputDir: request.outputDir,
    };
  }

  return {
    ok: true,
    intermediateMp4,
    frameCount: totalFrames,
    outputDir: request.outputDir,
  };
}
