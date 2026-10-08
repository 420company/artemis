import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitCommandArgs } from '../src/cli/commandArgs.js';
import { getHelpText, parseArgs } from '../src/cli/parseArgs.js';

function test(name: string, fn: () => void): void {
  fn();
  console.log(`✔ ${name}`);
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

test('images for the model: sniffed by content, size-capped, queued per session', async () => {
  const { sniffImageType, loadImageForModel, queueImage, takeQueuedImages, ImageInputError } = await import('../src/core/imageInput.js');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal(sniffImageType(png), 'image/png');
  assert.equal(sniffImageType(Buffer.from('ffd8ffe000104a46', 'hex')), 'image/jpeg');
  assert.equal(sniffImageType(Buffer.from('not an image')), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-image-'));
  try {
    fs.writeFileSync(path.join(dir, 'shot.jpg'), png); // the content decides, not the name
    const image = await loadImageForModel('shot.jpg', dir);
    assert.equal(image.mediaType, 'image/png');
    assert.equal(image.label, 'Image: shot.jpg');
    fs.writeFileSync(path.join(dir, 'notes.png'), 'hello');
    await assert.rejects(loadImageForModel('notes.png', dir), (e: unknown) => e instanceof ImageInputError && /not a PNG/.test(String(e)));
    await assert.rejects(loadImageForModel('missing.png', dir), /cannot read missing.png/);
    queueImage('s1', image);
    queueImage('s1', image);
    assert.equal(takeQueuedImages('s1').length, 2);
    assert.equal(takeQueuedImages('s1').length, 0, 'taken once');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

console.log('\n  ✔ All system smoke tests passed');
