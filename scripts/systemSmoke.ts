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

test('--image: rejected for models that cannot see images, over 8 images, or over the request budget', async () => {
  const { loadPromptImages, MAX_IMAGE_BYTES } = await import('../src/core/imageInput.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-prompt-images-'));
  try {
    fs.writeFileSync(path.join(dir, 'shot.png'), PNG_HEADER);
    await assert.rejects(
      loadPromptImages(['shot.png'], dir, { supportsImages: false, name: 'deepseek-chat' }),
      /deepseek-chat cannot see images, so --image cannot be used/,
    );
    assert.equal((await loadPromptImages(['shot.png'], dir, { supportsImages: true })).length, 1);
    assert.deepEqual(await loadPromptImages([], dir, { supportsImages: false }), [], 'no images, no vision needed');
    await assert.rejects(loadPromptImages(Array(9).fill('shot.png'), dir, { supportsImages: true }), /At most 8 images/);
    for (let n = 1; n <= 5; n += 1) writePngOfSize(path.join(dir, `big${n}.png`), MAX_IMAGE_BYTES);
    await assert.rejects(
      loadPromptImages(['big1.png', 'big2.png', 'big3.png', 'big4.png', 'big5.png'], dir, { supportsImages: true }),
      /add up to 18\.75 MB; at most 15 MB/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
