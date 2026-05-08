import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hasExistingLocalMediaReference } from '../src/tools/visual/seedanceWorkflow.js';

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artemis-media-paths-'));
  const image = path.join(dir, 'character-turnaround 2.png');
  const video = path.join(dir, 'beach reference clip.mov');
  const audio = path.join(dir, 'voice reference take 1.m4a');
  await writeFile(image, Buffer.alloc(128, 1));
  await writeFile(video, Buffer.alloc(128, 2));
  await writeFile(audio, Buffer.alloc(128, 3));

  assert.equal(await hasExistingLocalMediaReference(dir, image), true, 'absolute image path with spaces should be detected');
  assert.equal(await hasExistingLocalMediaReference(dir, video), true, 'absolute video path with spaces should be detected');
  assert.equal(await hasExistingLocalMediaReference(dir, audio), true, 'absolute audio path with spaces should be detected');
  assert.equal(
    await hasExistingLocalMediaReference(dir, image.replaceAll(' ', '\\ ')),
    true,
    'Finder/iTerm-style backslash-escaped media path should be detected',
  );
  assert.equal(
    await hasExistingLocalMediaReference(dir, `file://${encodeURI(image)}`),
    true,
    'file:// media URL should be detected',
  );
  assert.equal(await hasExistingLocalMediaReference(dir, '/definitely/not/here.png'), false);

  console.log('local media path smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
