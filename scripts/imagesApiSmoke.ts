/**
 * Image models of the Images API shape configured on the ModelArk-style
 * image provider (a hosted server's image model behind the platform
 * gateway): size / quality mapping, the request each path sends
 * (generations as JSON, reference images as a multipart edit), base64
 * answers written as files, the consistency pass route, and ModelArk
 * requests unchanged.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ARTEMIS_HOME = mkdtempSync(path.join(os.tmpdir(), 'images-api-smoke-'));

const {
  imagesApiSize,
  imagesApiQuality,
  imagesApiRequestFields,
  isImagesApiImageModel,
  decodeDataUri,
} = await import('../src/tools/visual/imagesApiParams.js');
const { BytePlusProvider } = await import('../src/tools/visual/providers/byteplusProvider.js');
const { superVisualImageRoute } = await import('../src/tools/visual/superVisualMode.js');

let passed = 0;
function check(label: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(run)
    .then(() => {
      passed += 1;
      console.log(`ok - ${label}`);
    });
}

const IMAGE_MODEL = 'gpt-image-test-1';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

function provider(model: string, defaults: Record<string, unknown> = { size: '2K', quality: 'auto', style: 'realistic', watermark: false }) {
  return new BytePlusProvider(
    {
      enabled: true,
      image: { provider: 'byteplus', apiKey: 'model-key', baseUrl: 'https://gateway.test/v1', model, defaultParams: defaults },
      video: { enabled: false, provider: 'byteplus', apiKey: '', baseUrl: '', model: '', defaultParams: {} },
    } as never,
    'image',
  );
}

type Sent = { url: string; json?: Record<string, unknown>; form?: Array<[string, string | File]>; headers: Record<string, string> };
async function withFetch<T>(answer: () => Response, run: (sent: Sent[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const entry: Sent = { url: String(input), headers: { ...(init?.headers as Record<string, string>) } };
    if (typeof init?.body === 'string') entry.json = JSON.parse(init.body);
    else if (init?.body instanceof FormData) entry.form = [...init.body.entries()] as Array<[string, string | File]>;
    sent.push(entry);
    return answer();
  }) as typeof fetch;
  try {
    return await run(sent);
  } finally {
    globalThis.fetch = original;
  }
}

await check('recognises Images API model ids, and nothing else', () => {
  assert.equal(isImagesApiImageModel('gpt-image-2.5-x'), true);
  assert.equal(isImagesApiImageModel('openai/gpt-image-1'), true);
  assert.equal(isImagesApiImageModel('seedream-5-0-260128'), false);
  assert.equal(isImagesApiImageModel(undefined), false);
});

await check('maps sizes to the ones the Images API takes', () => {
  for (const [given, want] of [
    ['1024x1024', '1024x1024'],
    ['1536x1024', '1536x1024'],
    ['1024x1536', '1024x1536'],
    ['auto', 'auto'],
    ['2K', 'auto'],
    ['1k', 'auto'],
    ['', 'auto'],
    [undefined, 'auto'],
    ['landscape', '1536x1024'],
    ['portrait', '1024x1536'],
    ['square', '1024x1024'],
    ['2560x1440', '1536x1024'],
    ['1440x2560', '1024x1536'],
    ['2048x2048', '1024x1024'],
    ['2304x1728', '1536x1024'],
    ['16:9', '1536x1024'],
    ['9:16', '1024x1536'],
    ['1:1', '1024x1024'],
    ['huge', 'auto'],
  ] as const) {
    assert.equal(imagesApiSize(given), want, String(given));
  }
});

await check('maps quality to low / medium / high / auto', () => {
  assert.equal(imagesApiQuality('high'), 'high');
  assert.equal(imagesApiQuality('LOW'), 'low');
  assert.equal(imagesApiQuality('standard'), 'medium');
  assert.equal(imagesApiQuality('hd'), 'high');
  assert.equal(imagesApiQuality('ultra'), 'high');
  assert.equal(imagesApiQuality('auto'), 'auto');
  assert.equal(imagesApiQuality(undefined), 'auto');
  assert.deepEqual(
    imagesApiRequestFields({ model: IMAGE_MODEL, prompt: 'p', size: 'portrait', quality: 'standard', outputFormat: 'jpg', outputCompression: 72.4, background: 'opaque' }),
    { model: IMAGE_MODEL, prompt: 'p', n: 1, size: '1024x1536', quality: 'medium', output_format: 'jpeg', output_compression: 72, background: 'opaque' },
  );
  // Compression only for jpeg / webp; an unknown background is left out.
  assert.deepEqual(imagesApiRequestFields({ model: IMAGE_MODEL, prompt: 'p', outputFormat: 'png', outputCompression: 50, background: 'glass' }), { model: IMAGE_MODEL, prompt: 'p', n: 1, size: 'auto', quality: 'auto', output_format: 'png' });
  assert.deepEqual(decodeDataUri('data:image/png;base64,iVBO'), { type: 'image/png', bytes: Buffer.from('iVBO', 'base64') });
  assert.equal(decodeDataUri('https://x/y.png'), undefined);
});

await check('generates without references through /images/generations, writing the base64 image', async () => {
  await withFetch(
    () => Response.json({ data: [{ b64_json: PNG.toString('base64') }], usage: { input_tokens: 10, output_tokens: 272 } }),
    async (sent) => {
      // A count above 1 still asks for one image: one is saved per call, and every image made is billed.
      const result = await provider(IMAGE_MODEL).generateImage({ prompt: 'a red fox', size: '2K', outputFormat: 'webp', count: 3 });
      assert.equal(result.success, true, result.error);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.url, 'https://gateway.test/v1/images/generations');
      // Defaults from the hosted profile (2K, quality auto) mapped; nothing ModelArk-only, no response_format.
      assert.deepEqual(sent[0]!.json, { model: IMAGE_MODEL, prompt: 'a red fox', n: 1, size: 'auto', quality: 'auto', output_format: 'webp' });
      assert.equal(path.extname(result.assetPath!), '.webp');
      assert.deepEqual(readFileSync(result.assetPath!), PNG);
    },
  );
});

await check('sends reference images as a multipart edit', async () => {
  await withFetch(
    () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] }),
    async (sent) => {
      const refs = [`data:image/png;base64,${PNG.toString('base64')}`, `data:image/jpeg;base64,${Buffer.from([255, 216, 255]).toString('base64')}`];
      const result = await provider(IMAGE_MODEL).generateImage({ prompt: 'make it blue', size: '2560x1440', quality: 'high', referenceImages: refs });
      assert.equal(result.success, true, result.error);
      assert.equal(sent[0]!.url, 'https://gateway.test/v1/images/edits');
      assert.equal(sent[0]!.headers['Content-Type'], undefined, 'multipart sets its own content type');
      const fields = Object.fromEntries(sent[0]!.form!.filter(([, v]) => typeof v === 'string'));
      assert.deepEqual(fields, { model: IMAGE_MODEL, prompt: 'make it blue', n: '1', size: '1536x1024', quality: 'high' });
      const files = sent[0]!.form!.filter(([k]) => k === 'image[]').map(([, v]) => v as File);
      assert.deepEqual(files.map((f) => [f.name, f.type, f.size]), [['reference-1.png', 'image/png', PNG.length], ['reference-2.jpg', 'image/jpeg', 3]]);
    },
  );
});

await check('reports an API failure with its status, without naming the model family', async () => {
  await withFetch(
    () => new Response('{"error":{"code":"insufficient_balance","message":"Balance too low: please top up"}}', { status: 402 }),
    async () => {
      const result = await provider(IMAGE_MODEL).generateImage({ prompt: 'x' });
      assert.equal(result.success, false);
      assert.equal(result.httpStatus, 402);
      assert.doesNotMatch(result.error!, /gpt|openai/i);
    },
  );
});

await check('marks an answer whose image cannot be decoded as a download failure (the image was billed)', async () => {
  await withFetch(
    () => Response.json({ data: [{ b64_json: '' }] }),
    async () => {
      const result = await provider(IMAGE_MODEL).generateImage({ prompt: 'x' });
      assert.equal(result.success, false);
      assert.equal(result.failureStage, 'download');
    },
  );
  await withFetch(
    () => Response.json({ data: [{}] }),
    async () => assert.equal((await provider(IMAGE_MODEL).generateImage({ prompt: 'x' })).failureStage, 'download'),
  );
});

await check('caps reference images before sending anything', async () => {
  await withFetch(
    () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] }),
    async (sent) => {
      const refs = Array.from({ length: 17 }, () => `data:image/png;base64,${PNG.toString('base64')}`);
      const result = await provider(IMAGE_MODEL).generateImage({ prompt: 'x', referenceImages: refs });
      assert.equal(result.success, false);
      assert.match(result.error!, /at most 16 reference images/);
      assert.equal(sent.length, 0);
    },
  );
});

await check('stops a reference download over its size limit', async () => {
  const { downloadGuardedUrl, setAssetDownloadResolverForTests, setAssetDownloadTransportForTests } = await import('../src/tools/visual/safeDownload.js');
  setAssetDownloadResolverForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  setAssetDownloadTransportForTests(async () => ({ status: 200, contentType: 'image/png', body: Buffer.alloc(11) }));
  try {
    await assert.rejects(downloadGuardedUrl('https://images.example/a.png', { timeoutMs: 1_000, maxBytes: 10 }), /larger than 10 bytes/);
    assert.equal((await downloadGuardedUrl('https://images.example/a.png', { timeoutMs: 1_000, maxBytes: 11 })).body.length, 11);
  } finally {
    setAssetDownloadResolverForTests();
    setAssetDownloadTransportForTests();
  }
});

await check('the legacy credentials path sends an Images API model its own request', async () => {
  const { executeGenerateImage } = await import('../src/tools/generateImage.js');
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'images-api-legacy-'));
  const previous = process.env.ARK_API_KEY;
  process.env.ARK_API_KEY = 'legacy-key';
  try {
    await withFetch(
      () => Response.json({ data: [{ b64_json: PNG.toString('base64') }] }),
      async (sent) => {
        const result = await executeGenerateImage(
          { type: 'generate_image', prompt: 'a lighthouse', model: IMAGE_MODEL, size: '2K', outputPath: path.join(cwd, 'out.png') },
          { cwd, permissionMode: 'full-access' },
        );
        assert.equal(result.ok, true, String(result.output));
        const call = sent.find((entry) => entry.url.endsWith('/images/generations'));
        assert.ok(call, sent.map((entry) => entry.url).join(', '));
        assert.deepEqual(call!.json, { model: IMAGE_MODEL, prompt: 'a lighthouse', n: 1, size: 'auto', quality: 'auto' });
        assert.deepEqual(readFileSync(path.join(cwd, 'out.png')), PNG);
      },
    );
  } finally {
    if (previous === undefined) delete process.env.ARK_API_KEY;
    else process.env.ARK_API_KEY = previous;
  }
});

await check('keeps ModelArk requests unchanged', async () => {
  await withFetch(
    () => new Response('{"error":{"message":"stop"}}', { status: 500 }),
    async (sent) => {
      await provider('seedream-5-0-260128').generateImage({ prompt: 'a cat', referenceImages: ['data:image/png;base64,AA=='] });
      assert.equal(sent[0]!.url, 'https://gateway.test/v1/images/generations');
      assert.deepEqual(sent[0]!.json, { model: 'seedream-5-0-260128', prompt: 'a cat', size: '2K', response_format: 'url', watermark: false, stream: false, image: 'data:image/png;base64,AA==' });
    },
  );
});

await check('lets the consistency pass use an Images API model on the same provider', () => {
  assert.equal(superVisualImageRoute('byteplus', IMAGE_MODEL), 'reference-images');
  assert.equal(superVisualImageRoute('byteplus', 'seedream-5-0-260128'), 'reference-images');
  assert.equal(superVisualImageRoute('byteplus', 'seedream-3-0-t2i-250415'), undefined);
});

console.log(`imagesApiSmoke: ${passed} checks passed`);
