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
import { stripRawModeTag } from '../src/tools/generateLongVideo.js';
import { executeGenerateVideo } from '../src/tools/generateVideo.js';
import { appendRenderingGuardrails, SAGA_VIDEO_RENDERING_GUARDRAILS } from '../src/tools/visual/renderingGuardrails.js';
import { resolveVideoModelLimits } from '../src/tools/visual/videoModelLimits.js';

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

async function rawModeChecks(): Promise<void> {
  assert.equal(stripRawModeTag('海边的女孩。\n\n[原样直传]'), '海边的女孩。');
  assert.equal(stripRawModeTag('【raw直传】 kite story'), 'kite story');
  assert.equal(stripRawModeTag('原样直传\n风筝'), '风筝');
  assert.equal(stripRawModeTag('她说要原样直传这段剧本。'), '她说要原样直传这段剧本。', 'the word inside a sentence stays');
  const rawStory = '[原样直传]\nA young woman named Mei walks along a beach at sunset, then sits on a rock and watches the waves.';
  const raw = await runHermeticSaga({ prompt: rawStory, story: rawStory, totalDuration: 10, ratio: '9:16', generateAudio: false, cleanDirect: true });
  assert.equal(raw.result.ok, true, raw.result.output);
  const tasks = videoTaskBodies(raw.requests);
  assert.equal(tasks.length, 2);
  const imagesIn = (body: Record<string, any>) => (body.content ?? []).filter((item: any) => item.type === 'image_url');
  assert.equal(imagesIn(tasks[0]!).length, 0, 'segment 1 has no previous frame');
  assert.equal(imagesIn(tasks[1]!).length, 1, 'raw mode still passes the previous tail frame to segment 2');
  assert.match(raw.result.output, /chained=1\/2/);
  const promptText = (body: Record<string, any>) => (body.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
  assert.ok(tasks.every((body) => !/原样直传/.test(promptText(body))), 'the raw-mode tag never reaches the video model');
  assert.ok(tasks.every((body) => !/Artemis Director|Fibonacci|focal point/i.test(promptText(body))), 'raw mode bypasses the Director');
  assert.equal(raw.requests.filter((r) => r.url.endsWith('/chat/completions')).length, 0, 'raw mode makes no narrative, rewrite or Director LLM calls');
  assert.equal(imageBodies(raw.requests).length, 0, 'raw mode generates no turnaround or keyframes');
  assert.ok(tasks.every((body) => !promptText(body).includes('Rendering rules:')), 'raw mode never gets the rendering rules');
}

async function chainAccountingChecks(): Promise<void> {
  // Segment 2's first request is rejected for its keyframe; the safe bridge
  // re-render fails too, so the retry goes out without the keyframe and
  // without any frame from segment 1. It must not be reported as chained.
  const run = await runHermeticSaga(
    { prompt: STORY, totalDuration: 10, ratio: '9:16', generateAudio: false, referenceImagePaths: [fixturePng()] },
    { rejectVideoCreates: [2], imageFailFrom: 4 },
  );
  assert.equal(run.result.ok, true, run.result.output);
  const tasks = videoTaskBodies(run.requests);
  assert.equal(tasks.length, 3, 'segment 2 is retried once');
  assert.match(run.result.output, /chained=0\/2/, run.result.output.split('\n').find((line) => line.includes('Continuity')));
}

async function guardrailChecks(): Promise<void> {
  const added = SAGA_VIDEO_RENDERING_GUARDRAILS.length + 2;
  assert.ok(added < 600, `rendering rules add ${added} characters`);
  assert.equal(appendRenderingGuardrails('x'.repeat(3990), 4000).added, 0, 'rules are dropped rather than overflow the limit');
  assert.equal(appendRenderingGuardrails('x'.repeat(100), 4000).added, added);
  assert.equal(resolveVideoModelLimits('byteplus', 'dreamina-seedance-2-0-260128').maxPromptChars, 4000);
  assert.equal(resolveVideoModelLimits('openai', 'sora-2').maxPromptChars, 2600);

  const run = await runHermeticSaga({ prompt: STORY, totalDuration: 10, ratio: '9:16', generateAudio: false, referenceImagePaths: [fixturePng()] });
  assert.equal(run.result.ok, true, run.result.output);
  const textOf = (body: Record<string, any>) => (body.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
  const prompts = videoTaskBodies(run.requests).map(textOf);
  assert.ok(prompts.every((text) => text.endsWith(SAGA_VIDEO_RENDERING_GUARDRAILS)), 'every Saga segment carries the rendering rules');
  assert.ok(prompts.every((text) => text.length <= 4000), `segment prompts stay within the Seedance limit: ${prompts.map((t) => t.length).join(', ')}`);
  console.log(`  rendering rules: +${added} chars; segment prompts ${prompts.map((t) => t.length).join(', ')} chars`);
  const images = imageBodies(run.requests);
  assert.ok(images.every((body) => String(body.prompt).includes("character's own left or right")), 'turnaround and keyframes carry the side rule');
  assert.ok(images.slice(1).every((body) => String(body.prompt).includes('Exactly one protagonist body')), 'keyframes carry the single-protagonist rule');

  // A plain generate_video call never gets them.
  await withHermeticWorkspace({}, async (cwd, requests) => {
    const result = await executeGenerateVideo(
      { type: 'generate_video', prompt: 'a kite drifting over a hill', outputPath: path.join(cwd, 'kite.mp4') } as any,
      { cwd, permissionMode: 'full-access' } as any,
    );
    assert.equal(result.ok, true, result.output);
    assert.ok(videoTaskBodies(requests).every((body) => !textOf(body).includes('Rendering rules:')));
  });
}

seedreamSizeChecks();
eligibilityChecks();
budgetChecks();
await resolutionChecks();
await superVisualOnSeedream();
await rawModeChecks();
await chainAccountingChecks();
await guardrailChecks();
console.log('saga hermetic smoke ok');
