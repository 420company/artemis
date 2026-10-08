// End-to-end Saga checks against mocked BytePlus image and video APIs and
// real ffmpeg (see sagaHermeticHarness.ts). Each run polls ModelArk once per
// segment with the provider's fixed 5 s interval, so runs stay short.
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import { fixturePng, imageBodies, runHermeticSaga, videoTaskBodies, withHermeticWorkspace } from './sagaHermeticHarness.js';
import {
  generateSafeBridgeKeyframe,
  generateSegmentKeyframe,
  getSuperVisualModeIneligibilityReason,
  SuperVisualImageBudget,
  superVisualImageLimit,
} from '../src/tools/visual/superVisualMode.js';
import { seedreamImageSize, seedreamPixelRange } from '../src/tools/visual/seedreamSizes.js';

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

function pixelsOf(size: string): number {
  const [w, h] = size.split('x').map(Number);
  return w! * h!;
}

function seedreamSizeChecks(): void {
  for (const model of ['seedream-4-0-250828', 'seedream-4-5-251128', 'seedream-5-0-260128', 'seedream-5-0-pro-260628']) {
    const range = seedreamPixelRange(model);
    for (const aspect of ['16:9', '9:16', '1:1', '4:3', '3:4'] as const) {
      const size = seedreamImageSize(model, aspect);
      assert.match(size, /^\d+x\d+$/);
      const pixels = pixelsOf(size);
      assert.ok(pixels >= range.min && pixels <= range.max, `${model} ${aspect} -> ${size} is outside ${range.min}-${range.max}`);
    }
  }
  assert.equal(seedreamImageSize('seedream-5-0-260128', '9:16'), '1440x2560');
  assert.equal(seedreamImageSize('seedream-5-0-260128', '16:9'), '2560x1440');
}

function eligibilityChecks(): void {
  const videoRefs = ['image', 'video', 'audio'] as any;
  assert.equal(getSuperVisualModeIneligibilityReason({ imageProvider: 'byteplus', imageModel: 'seedream-5-0-260128', videoReferenceInputs: videoRefs } as any), undefined);
  assert.equal(getSuperVisualModeIneligibilityReason({ imageProvider: 'byteplus', imageModel: 'seedream-4-0-250828', videoReferenceInputs: videoRefs } as any), undefined);
  assert.equal(getSuperVisualModeIneligibilityReason({ imageProvider: 'openai', imageModel: 'gpt-image-2', videoReferenceInputs: videoRefs } as any), undefined);
  assert.match(getSuperVisualModeIneligibilityReason({ imageProvider: 'byteplus', imageModel: 'seedream-3-0-t2i-250415', videoReferenceInputs: videoRefs } as any) ?? '', /cannot generate from reference images/);
  assert.match(getSuperVisualModeIneligibilityReason({ imageProvider: 'byteplus', imageModel: 'seededit-3-0-i2i-250628', videoReferenceInputs: videoRefs } as any) ?? '', /cannot generate from reference images/);
}

function budgetChecks(): void {
  assert.equal(superVisualImageLimit(1), 3);
  assert.equal(superVisualImageLimit(12), 15, 'a long video gets one turnaround, one keyframe per segment and two re-renders');
  const budget = new SuperVisualImageBudget(2);
  budget.record();
  budget.record(1);
  assert.equal(budget.canGenerate(), false);
  budget.raiseLimit(3);
  assert.equal(budget.canGenerate(), true);
  assert.equal(budget.usedFor(1), 1);
}

async function superVisualOnSeedream(): Promise<void> {
  // Hosted-style config (BytePlus Seedream images) now runs Super Visual.
  const run = await runHermeticSaga({ prompt: STORY, totalDuration: 10, ratio: '9:16', generateAudio: false, referenceImagePaths: [fixturePng()] });
  assert.equal(run.result.ok, true, run.result.output);
  assert.match(run.result.output, /Super visual: image-to-image · userImagesUsed=1/);
  assert.match(run.result.output, /Keyframes:\s+generated=2\/2 · images=3\/5/);
  const images = imageBodies(run.requests);
  assert.equal(images.length, 3, 'one turnaround and one keyframe per segment');
  const refCount = (body: Record<string, any>) => Array.isArray(body.image) ? body.image.length : body.image ? 1 : 0;
  assert.equal(refCount(images[0]!), 1, 'the turnaround carries the user reference');
  assert.equal(images[0]!.size, '2560x1440', 'the turnaround sheet is landscape');
  assert.equal(refCount(images[1]!), 1, 'segment 1 keyframe carries the turnaround');
  assert.equal(refCount(images[2]!), 2, 'segment 2 keyframe carries the turnaround and the previous frame');
  assert.ok(images.slice(1).every((body) => body.size === '1440x2560'), 'keyframes follow the 9:16 ratio');
  assert.ok(images.every((body) => String(Array.isArray(body.image) ? body.image[0] : body.image).startsWith('data:image/png;base64,')), 'references are sent as data URIs');
  assert.ok(run.logs.some((line) => /第 2\/2 段生成图片 1 张；全片累计 3\/5 张/.test(line)), 'per-segment image counts are logged');

  // Safe bridge frame on the same route carries its source frame.
  await withHermeticWorkspace({}, async (cwd, requests) => {
    const projectDir = await mkdtemp(path.join(os.tmpdir(), 'artemis-saga-bridge-'));
    const source = path.join(projectDir, 'keyframe.png');
    await copyFile(fixturePng(), source);
    const bridge = await generateSafeBridgeKeyframe({ context: { cwd } as any, projectDir, ratio: '16:9', shotIndex: 2, sourceFramePath: source });
    assert.equal(bridge.ok, true, JSON.stringify(bridge));
    const [body] = imageBodies(requests);
    assert.equal(String(body?.image).startsWith('data:image/png;base64,'), true);
    assert.equal(body?.size, '2560x1440');

    // A spent budget stops further images without a request.
    const spent = new SuperVisualImageBudget(0);
    const before = requests.length;
    const skipped = await generateSegmentKeyframe({
      context: { cwd } as any, projectDir, ratio: '16:9', shotIndex: 3, shotCount: 3, shot: { storyBeat: 'x' },
      turnaroundPath: source, imageBudget: spent,
    });
    assert.equal(skipped.ok, false);
    assert.match(skipped.ok ? '' : skipped.reason, /image cap/);
    assert.equal(requests.length, before);
  });

  // A text-to-image-only model falls back cleanly: no Super Visual, no image calls, the video still renders.
  const t2i = await runHermeticSaga(
    { prompt: STORY, totalDuration: 5, ratio: '9:16', generateAudio: false },
    { imageModel: 'seedream-3-0-t2i-250415' },
  );
  assert.equal(t2i.result.ok, true, t2i.result.output);
  assert.match(t2i.result.output, /Super visual: off \(the image model cannot generate from reference images/);
  assert.equal(imageBodies(t2i.requests).length, 0);
}

seedreamSizeChecks();
eligibilityChecks();
budgetChecks();
await resolutionChecks();
await superVisualOnSeedream();
console.log('saga hermetic smoke ok');
