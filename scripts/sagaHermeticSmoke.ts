// End-to-end Saga checks against mocked BytePlus image and video APIs and
// real ffmpeg (see sagaHermeticHarness.ts). Each run polls ModelArk once per
// segment with the provider's fixed 5 s interval, so runs stay short.
import assert from 'node:assert/strict';
import { runHermeticSaga, videoTaskBodies } from './sagaHermeticHarness.js';

const STORY = 'A young woman named Mei walks along a beach at sunset, then sits on a rock and watches the waves.';

async function resolutionChecks(): Promise<void> {
  const hd = await runHermeticSaga({ prompt: STORY, totalDuration: 10, ratio: '9:16', resolution: '1080P', generateAudio: false });
  assert.equal(hd.result.ok, true, hd.result.output);
  const hdTasks = videoTaskBodies(hd.requests);
  assert.equal(hdTasks.length, 2);
  assert.ok(hdTasks.every((body) => body.resolution === '1080p'), 'every segment carries the requested, normalized resolution');
  assert.match(hd.result.output, /resolution 1080p/);

  const plain = await runHermeticSaga({ prompt: STORY, totalDuration: 5, ratio: '9:16', generateAudio: false });
  assert.equal(plain.result.ok, true, plain.result.output);
  assert.ok(videoTaskBodies(plain.requests).every((body) => !('resolution' in body)), 'no resolution is sent unless asked for');

  const fourK = await runHermeticSaga({ prompt: STORY, totalDuration: 5, resolution: '4k' });
  assert.equal(fourK.result.ok, false);
  assert.match(fourK.result.output, /resolution must be one of 480p, 720p, 1080p/);
  assert.equal(fourK.requests.length, 0, 'an unsupported resolution fails before any request');
}

await resolutionChecks();
console.log('saga hermetic smoke ok');
