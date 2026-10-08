// A hermetic Saga run for smoke tests: a temporary workspace configured like
// a hosted VPS (BytePlus Seedream images, BytePlus Seedance video), every
// HTTP call answered by a local mock, and real ffmpeg for frames and the final
// render. Nothing reaches the network or the machine's ~/.artemis.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'artemis-saga-hermetic-'));
process.env.ARTEMIS_HOME = path.join(root, 'home');
process.env.ARTEMIS_MEDIA_OUTPUT_ROOT = path.join(root, 'media');

const { ProviderStore } = await import('../src/providers/store.js');
const { executeGenerateLongVideo } = await import('../src/tools/generateLongVideo.js');
const {
  setAssetDownloadResolverForTests,
  setAssetDownloadTransportForTests,
} = await import('../src/tools/visual/safeDownload.js');
const { BYTEPLUS_SEEDANCE_2_PRO_MODEL } = await import('../src/tools/visual/videoCapabilities.js');

export type RecordedRequest = { method: string; url: string; body: Record<string, any> };

export type HermeticOptions = {
  imageModel?: string;
  imageProvider?: string;
  /** Answer image generations with this HTTP status instead of an image. */
  imageStatus?: number;
  /** Image generations from this 1-based request number on fail with HTTP 500. */
  imageFailFrom?: number;
  /** 1-based video task creations answered with a privacy rejection of an input image. */
  rejectVideoCreates?: number[];
};

const fixtureDir = path.join(root, 'fixtures');
execFileSync('mkdir', ['-p', fixtureDir]);
const clipPath = path.join(fixtureDir, 'clip.mp4');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=24:duration=5',
  '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipPath,
]);
const pngPath = path.join(fixtureDir, 'still.png');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=512x512', '-frames:v', '1', pngPath]);
const clipBytes = readFileSync(clipPath);
const pngBytes = readFileSync(pngPath);

/** A real PNG on disk, for reference-image inputs. */
export function fixturePng(): string {
  return pngPath;
}

setAssetDownloadResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
setAssetDownloadTransportForTests(async (url, { signal }) => {
  const res = await fetch(url, { redirect: 'manual', signal });
  return {
    status: res.status,
    location: res.headers.get('location') ?? undefined,
    contentType: res.headers.get('content-type') ?? undefined,
    body: Buffer.from(await res.arrayBuffer()),
  };
});

async function configure(cwd: string, options: HermeticOptions): Promise<void> {
  const store = new ProviderStore(cwd);
  const data = await store.load();
  data.visualProfile = {
    enabled: true,
    image: {
      provider: options.imageProvider ?? 'byteplus',
      apiKey: 'hermetic-key',
      baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      model: options.imageModel ?? 'seedream-5-0-260128',
      defaultParams: { size: '2K', quality: 'standard', style: 'realistic', watermark: false },
    },
    video: {
      enabled: true,
      provider: 'byteplus',
      apiKey: 'hermetic-key',
      baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
      model: BYTEPLUS_SEEDANCE_2_PRO_MODEL,
      defaultParams: { duration: '5s', resolution: '720p', quality: 'standard', style: 'realistic', format: 'mp4', framerate: '24fps', watermark: false },
    },
  } as any;
  await store.save(data);
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A configured temporary workspace with every HTTP call answered by the mock;
 * `run` receives the workspace and the list the requests are recorded in.
 */
export async function withHermeticWorkspace<T>(
  options: HermeticOptions,
  run: (cwd: string, requests: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const cwd = mkdtempSync(path.join(root, 'ws-'));
  await configure(cwd, options);
  const requests: RecordedRequest[] = [];
  let taskCounter = 0;
  let imageCounter = 0;
  let createCounter = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: Record<string, any> = {};
    if (typeof init?.body === 'string') {
      try { body = JSON.parse(init.body); } catch { body = {}; }
    }
    requests.push({ method, url, body });
    if (url.endsWith('/chat/completions')) {
      // No LLM in the hermetic run: every Saga LLM step falls back.
      return json(400, { error: { message: 'no llm in hermetic smoke' } });
    }
    if (url.endsWith('/images/generations')) {
      imageCounter += 1;
      if (options.imageFailFrom && imageCounter >= options.imageFailFrom) return json(500, { error: { message: 'image service down in this test' } });
      if (options.imageStatus) return json(options.imageStatus, { error: { message: 'image generation refused in this test' } });
      return json(200, { data: [{ url: 'https://cdn.example.test/still.png' }] });
    }
    if (method === 'POST' && url.endsWith('/contents/generations/tasks')) {
      createCounter += 1;
      if (options.rejectVideoCreates?.includes(createCounter)) {
        return json(400, { error: { code: 'InputImageSensitiveContentDetected', message: 'The request failed because the input image may contain real person.' } });
      }
      taskCounter += 1;
      return json(200, { id: `task-${taskCounter}` });
    }
    if (/\/contents\/generations\/tasks\/task-\d+$/.test(url)) {
      return json(200, { status: 'succeeded', content: { video_url: 'https://cdn.example.test/clip.mp4' } });
    }
    if (url === 'https://cdn.example.test/clip.mp4') return new Response(clipBytes, { status: 200, headers: { 'Content-Type': 'video/mp4' } });
    if (url === 'https://cdn.example.test/still.png') return new Response(pngBytes, { status: 200, headers: { 'Content-Type': 'image/png' } });
    return new Response(`unexpected request ${method} ${url}`, { status: 500 });
  }) as typeof fetch;
  try {
    return await run(cwd, requests);
  } finally {
    globalThis.fetch = original;
  }
}

/** Runs generate_long_video with every HTTP call mocked; returns the result, the requests made and the log lines. */
export async function runHermeticSaga(
  action: Record<string, unknown>,
  options: HermeticOptions = {},
): Promise<{ result: Awaited<ReturnType<typeof executeGenerateLongVideo>>; requests: RecordedRequest[]; logs: string[] }> {
  const { withRuntimeLogSink } = await import('../src/utils/log.js');
  return withHermeticWorkspace(options, async (cwd, requests) => {
    const logs: string[] = [];
    const result = await withRuntimeLogSink(
      (entry) => { logs.push(entry.message); },
      () => executeGenerateLongVideo(
        { type: 'generate_long_video', assemblyMode: 'ffmpeg', gpu: 'off', maxPolls: 3, pollIntervalMs: 1000, ...action } as any,
        { cwd, permissionMode: 'full-access', sessionId: 'saga-hermetic', locale: 'en' } as any,
      ),
    );
    return { result, requests, logs };
  });
}

/** The video task bodies sent to ModelArk, in order. */
export function videoTaskBodies(requests: RecordedRequest[]): Array<Record<string, any>> {
  return requests.filter((r) => r.method === 'POST' && r.url.endsWith('/contents/generations/tasks')).map((r) => r.body);
}

/** The image generation bodies sent, in order. */
export function imageBodies(requests: RecordedRequest[]): Array<Record<string, any>> {
  return requests.filter((r) => r.url.endsWith('/images/generations')).map((r) => r.body);
}
