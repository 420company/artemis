import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitCommandArgs } from '../src/cli/commandArgs.js';
import { getHelpText, parseArgs } from '../src/cli/parseArgs.js';

// Tests run one after another; async tests are awaited, so a failing
// assertion fails the run before its ✔ is printed.
let pending: Promise<void> = Promise.resolve();
function test(name: string, fn: () => void | Promise<void>): void {
  pending = pending.then(async () => {
    await fn();
    console.log(`✔ ${name}`);
  });
}

console.log('\n  systemSmoke');
console.log('  ===========');

test('package exposes only artemis global command', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.bin), ['artemis']);
  assert.equal(pkg.bin.artemis, 'dist/cli.js');
});

test('legacy shim is absent', () => {
  assert.equal(existsSync(resolve('bin', `my${'laude'}.js`)), false);
});

test('help lists real workflow and utility commands', () => {
  const help = getHelpText('en');
  for (const command of ['tool', 'analyze', 'execute', 'skill', 'audit', 'session', 'design']) {
    assert.match(help, new RegExp(`\\b${command}\\b`));
  }
});

test('parser accepts documented utility commands', () => {
  assert.equal(parseArgs(['tool', '--list']).command, 'tool');
  assert.deepEqual(parseArgs(['tool', 'run', 'generate_long_video', 'title=Neon Rain Observatory']).promptArgs, [
    'run',
    'generate_long_video',
    'title=Neon Rain Observatory',
  ]);
  assert.equal(parseArgs(['skill', '--detail', 'color-master']).command, 'skill');
  assert.equal(parseArgs(['session', '--list']).command, 'session');
  assert.equal(parseArgs(['audit', '--scan']).command, 'audit');
  assert.equal(parseArgs(['analyze', 'hello']).prompt, 'hello');
  assert.equal(parseArgs(['execute', 'hello']).prompt, 'hello');
});

test('execute and analyze can continue an existing session', () => {
  const id = '3f2a9c1e-8b7d-4e6f-9a01-23456789abcd';
  const parsed = parseArgs(['execute', '--session', id, 'and', 'now', 'the', 'next', 'step']);
  assert.equal(parsed.command, 'execute');
  assert.equal(parsed.sessionId, id);
  assert.equal(parsed.prompt, 'and now the next step');
  assert.equal(parseArgs(['analyze', '--session', id, 'why']).sessionId, id);
  assert.equal(parseArgs(['execute', 'hello']).sessionId, undefined);
  assert.throws(() => parseArgs(['execute', '--session']), /execute --session requires a valid session id/);
  assert.throws(() => parseArgs(['execute', '--session', 'not-an-id', 'hi']), /requires a valid session id/);
});

test('execute and analyze take attached images', () => {
  const parsed = parseArgs(['execute', '--image', 'uploads/a.png', '--image', 'b.jpg', 'what', 'is', 'this']);
  assert.deepEqual(parsed.imagePaths, ['uploads/a.png', 'b.jpg']);
  assert.equal(parsed.prompt, 'what is this');
  assert.equal(parseArgs(['execute', 'hello']).imagePaths, undefined);
  assert.throws(() => parseArgs(['execute', '--image']), /--image requires a file path/);
});

const PNG_HEADER = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A file that sniffs as PNG and is exactly `size` bytes long. */
function writePngOfSize(file: string, size: number): void {
  const bytes = Buffer.alloc(size);
  PNG_HEADER.copy(bytes);
  fs.writeFileSync(file, bytes);
}

test('images for the model: type sniffed from content; files over 3.75 MB rejected', async () => {
  const { sniffImageType, loadImageForModel, ImageInputError, MAX_IMAGE_BYTES } = await import('../src/core/imageInput.js');
  assert.equal(MAX_IMAGE_BYTES, 3.75 * 1024 * 1024, 'base64 of the largest image stays within the 5 MB Anthropic per-image limit');
  assert.equal(sniffImageType(PNG_HEADER), 'image/png');
  assert.equal(sniffImageType(Buffer.from('ffd8ffe000104a46', 'hex')), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from('not an image')), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-image-'));
  try {
    fs.writeFileSync(path.join(dir, 'shot.jpg'), PNG_HEADER); // the content decides, not the name
    const image = await loadImageForModel('shot.jpg', dir);
    assert.equal(image.mediaType, 'image/png');
    assert.equal(image.label, 'Image: shot.jpg');
    fs.writeFileSync(path.join(dir, 'notes.png'), 'hello');
    await assert.rejects(loadImageForModel('notes.png', dir), (e: unknown) => e instanceof ImageInputError && /not a PNG/.test(String(e)));
    await assert.rejects(loadImageForModel('missing.png', dir), /cannot read missing.png/);
    writePngOfSize(path.join(dir, 'limit.png'), MAX_IMAGE_BYTES);
    assert.equal((await loadImageForModel('limit.png', dir)).mediaType, 'image/png', 'exactly at the cap is accepted');
    writePngOfSize(path.join(dir, 'big.png'), MAX_IMAGE_BYTES + 1);
    await assert.rejects(loadImageForModel('big.png', dir), (e: unknown) => e instanceof ImageInputError && /images up to 3\.75 MB/.test(String(e)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('view_image queue: one per run, taken once, and it reports what it drops to fit one request', async () => {
  const { ViewedImageQueue, fitImagesToRequest, imageByteSize, MAX_IMAGES_PER_REQUEST, MAX_REQUEST_IMAGE_BYTES, MAX_IMAGE_BYTES } = await import('../src/core/imageInput.js');
  const small = (n: number) => ({ data: 'iVBORw0KGgo=', mediaType: 'image/png' as const, label: `Image: ${n}.png` });
  const queue = new ViewedImageQueue();
  for (let n = 1; n <= MAX_IMAGES_PER_REQUEST; n += 1) assert.deepEqual(queue.add(small(n)), []);
  const dropped = queue.add(small(MAX_IMAGES_PER_REQUEST + 1));
  assert.deepEqual(dropped.map((i) => i.label), ['Image: 1.png'], 'the oldest image is dropped and reported');
  const taken = queue.take();
  assert.equal(taken.length, MAX_IMAGES_PER_REQUEST);
  assert.equal(taken[0]?.label, 'Image: 2.png');
  assert.equal(queue.take().length, 0, 'taken once');
  assert.equal(new ViewedImageQueue().size, 0, 'a new run starts empty');

  // Byte budget: four images at the per-image cap fit in one request, a fifth does not.
  const big = (n: number) => ({ data: 'A'.repeat((MAX_IMAGE_BYTES * 4) / 3), mediaType: 'image/png' as const, label: `Image: big${n}.png` });
  assert.equal(imageByteSize(big(1)), MAX_IMAGE_BYTES);
  const fit = fitImagesToRequest([big(1), big(2), big(3), big(4), big(5)]);
  assert.ok(fit.kept.reduce((sum, i) => sum + imageByteSize(i), 0) <= MAX_REQUEST_IMAGE_BYTES);
  assert.deepEqual(fit.kept.map((i) => i.label), ['Image: big2.png', 'Image: big3.png', 'Image: big4.png', 'Image: big5.png']);
  assert.deepEqual(fit.dropped.map((i) => i.label), ['Image: big1.png']);
});

test('--image: loads for any model; rejected over 8 images or over the request budget', async () => {
  const { loadPromptImages, MAX_IMAGE_BYTES } = await import('../src/core/imageInput.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-prompt-images-'));
  try {
    fs.writeFileSync(path.join(dir, 'shot.png'), PNG_HEADER);
    // Whether the model can see them is the run's business (vision helper or a note).
    assert.equal((await loadPromptImages(['shot.png'], dir)).length, 1);
    assert.deepEqual(await loadPromptImages([], dir), []);
    await assert.rejects(loadPromptImages(Array(9).fill('shot.png'), dir), /At most 8 images/);
    for (let n = 1; n <= 5; n += 1) writePngOfSize(path.join(dir, `big${n}.png`), MAX_IMAGE_BYTES);
    await assert.rejects(
      loadPromptImages(['big1.png', 'big2.png', 'big3.png', 'big4.png', 'big5.png'], dir),
      /add up to 18\.75 MB; at most 15 MB/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('vision helper: per-run cache by content hash, per-image split, notes and size limits', async () => {
  const { createVisionHelper, hashImage, prepareUserImagesForModel, formatNoVisionNote } = await import('../src/core/visionHelper.js');
  const { MAX_IMAGE_BYTES } = await import('../src/core/imageInput.js');
  const a = { data: 'iVBORw0KGgo=', mediaType: 'image/png' as const, label: 'Image: a.png' };
  const b = { data: 'R0lGODlh', mediaType: 'image/gif' as const, sourceUrl: 'https://cdn.example/x/b.gif' };
  assert.equal(hashImage(a), hashImage({ ...a, label: 'renamed' }), 'the key is the content, not the name');
  assert.notEqual(hashImage(a), hashImage(b));

  const batches: number[] = [];
  const helper = createVisionHelper({
    supportsImages: true,
    async complete(_messages, options) {
      const n = options?.imageAttachments?.length ?? 0;
      batches.push(n);
      return { text: n === 1 ? 'Only B.' : '### Image 1\nThis is A.\n\n### Image 2\nThis is B.', raw: null };
    },
  });
  assert.deepEqual(await helper.describe([a, b]), [{ ok: true, text: 'This is A.' }, { ok: true, text: 'This is B.' }]);
  assert.deepEqual(await helper.describe([b, a]), [{ ok: true, text: 'This is B.' }, { ok: true, text: 'This is A.' }]);
  assert.deepEqual(batches, [2], 'a second look at the same images is served from the cache');
  const fresh = createVisionHelper({ supportsImages: true, async complete() { batches.push(-1); return { text: 'Only B.', raw: null }; } });
  await fresh.describe([b]);
  assert.deepEqual(batches, [2, -1], 'another run (helper) has its own cache');

  assert.equal(
    formatNoVisionNote([a, b]),
    '[The user attached 2 image(s) (file names: a.png, b.gif) but this plan cannot read images. Tell the user briefly and continue with the text.]',
  );
  const passthrough = await prepareUserImagesForModel({ userText: 'hi', images: [a], modelSeesImages: true, getHelper: async () => helper });
  assert.deepEqual(passthrough, { images: [a] }, 'a vision model gets the images unchanged');

  const huge = { data: 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 10) * 4) / 3)), mediaType: 'image/png' as const, label: 'Image: huge.png' };
  const sent: number[] = [];
  const limited = await prepareUserImagesForModel({
    userText: 'hi',
    images: [a, huge],
    modelSeesImages: false,
    getHelper: async () => createVisionHelper({ supportsImages: true, async complete(_m, o) { sent.push(o?.imageAttachments?.length ?? 0); return { text: 'A.', raw: null }; } }),
  });
  assert.deepEqual(sent, [1], 'an image over the per-image limit never reaches the helper');
  assert.match(limited.note ?? '', /\[Image 1 description by vision helper — the main model cannot see images\]\nA\./);
  assert.match(limited.note ?? '', /\[Image 2 \(huge\.png\): the attached image could not be read, because it is larger than the per-image limit/);
  assert.deepEqual(limited.images, []);
});

test('vision helper: visionProfileId resolves like specialistProfileId (cwd store, then global) and needs a vision model', async () => {
  const { resolveVisionProfile } = await import('../src/core/visionHelper.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-vision-profile-'));
  const originalHome = process.env.ARTEMIS_HOME;
  const writeStore = (dir: string, data: unknown) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(data));
  };
  const profile = (id: string, model: string, supportsImages?: boolean) => ({ id, protocol: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'k', model, ...(supportsImages === undefined ? {} : { supportsImages }) });
  try {
    const home = path.join(root, 'home');
    process.env.ARTEMIS_HOME = home;
    writeStore(home, { visionProfileId: 'platform-vision', profiles: [profile('platform-vision', 'vision-alias', true)] });
    const project = path.join(root, 'project');
    fs.mkdirSync(project, { recursive: true });
    assert.equal((await resolveVisionProfile(project))?.profile.id, 'platform-vision', 'falls back to the global store');

    // ARTEMIS_HOME maps a workspace to <home>/workspaces/<hash>; write a local store there.
    const { resolveDataRootDir } = await import('../src/utils/fs.js');
    writeStore(resolveDataRootDir(project), { visionProfileId: 'local-vision', profiles: [profile('local-vision', 'gpt-4o')] });
    assert.equal((await resolveVisionProfile(project))?.profile.id, 'local-vision', 'the cwd store wins');

    writeStore(resolveDataRootDir(project), { visionProfileId: 'text-only', profiles: [profile('text-only', 'vision-alias', false)] });
    assert.equal(await resolveVisionProfile(project), undefined, 'a profile that cannot see images is no helper');
  } finally {
    if (originalHome === undefined) delete process.env.ARTEMIS_HOME;
    else process.env.ARTEMIS_HOME = originalHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('vision capability: profile flag first, then known vision families; DeepSeek and unknown models are text-only', async () => {
  const { inferModelSupportsImages, modelSupportsImages } = await import('../src/providers/imageSupport.js');
  for (const model of ['claude-sonnet-4-5', 'anthropic/claude-opus-4.1', 'gpt-4o', 'gpt-4.1-mini', 'gpt-5.4', 'o3', 'o4-mini', 'gemini-2.5-pro', 'qwen-vl-max', 'qwen3-vl-plus', 'glm-4.5v', 'grok-4', 'doubao-seed-1.6', 'pixtral-large-latest', 'mock-vision']) {
    assert.equal(inferModelSupportsImages(model), true, model);
  }
  for (const model of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4', 'o3-mini', 'gpt-3.5-turbo', 'claude-2.1', 'qwen-max', 'qwen3-coder-plus', 'llama-3.1-70b-instruct', 'kimi-k2', 'some-new-model', '']) {
    assert.equal(inferModelSupportsImages(model), false, model);
  }
  assert.equal(modelSupportsImages({ model: 'deepseek-chat', supportsImages: true }), true, 'the profile flag wins');
  assert.equal(modelSupportsImages({ model: 'gpt-4o', supportsImages: false }), false, 'the profile flag wins');
  const { OpenAICompatibleProvider } = await import('../src/providers/openaiCompatible.js');
  const { MessagesCompatibleProvider } = await import('../src/providers/messagesCompatible.js');
  const { ResponsesCompatibleProvider } = await import('../src/providers/responsesCompatible.js');
  const config = { baseUrl: 'http://127.0.0.1:9', apiKey: 'k' };
  assert.equal(new OpenAICompatibleProvider({ ...config, protocol: 'openai', model: 'deepseek-chat' }).supportsImages, false);
  assert.equal(new OpenAICompatibleProvider({ ...config, protocol: 'openai', model: 'gpt-4o' }).supportsImages, true);
  assert.equal(new MessagesCompatibleProvider({ ...config, protocol: 'messages', model: 'claude-sonnet-4-5' }).supportsImages, true);
  assert.equal(new ResponsesCompatibleProvider({ ...config, protocol: 'responses', model: 'gpt-5.4' }).supportsImages, true);
});

test('parser accepts direct workflow commands', () => {
  const parsed = parseArgs(['design', 'make', 'a', 'homepage']);
  assert.equal(parsed.command, 'design');
  assert.equal(parsed.prompt, 'make a homepage');
});

test('command arg splitter preserves quoted key-value values', () => {
  assert.deepEqual(
    splitCommandArgs(`run generate_long_video title='Neon Rain Observatory' prompt="two connected shots" totalDuration=20`),
    [
      'run',
      'generate_long_video',
      'title=Neon Rain Observatory',
      'prompt=two connected shots',
      'totalDuration=20',
    ],
  );
});

await pending;
console.log('\n  ✔ All system smoke tests passed');
