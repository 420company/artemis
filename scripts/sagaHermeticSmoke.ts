// End-to-end Saga checks against mocked BytePlus image and video APIs and
// real ffmpeg (see sagaHermeticHarness.ts). Each run polls ModelArk once per
// segment with the provider's fixed 5 s interval, so runs stay short.
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFile, mkdtemp } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
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
import { deriveTitleFromBrief, stripRawModeTag } from '../src/tools/generateLongVideo.js';
import { executeGenerateVideo } from '../src/tools/generateVideo.js';
import { appendRenderingGuardrails, SAGA_VIDEO_RENDERING_GUARDRAILS } from '../src/tools/visual/renderingGuardrails.js';
import { resolveVideoModelLimits } from '../src/tools/visual/videoModelLimits.js';
import { buildContinuityBible, compileShotPromptWithContinuity, IDENTITY_CARD_MAX_CHARS } from '../src/tools/visual/sagaRenderer/continuity.js';
import { normalizeSagaPromptForVideoGeneration } from '../src/tools/visual/sagaLanguageDirector.js';
import { parseSagaBriefGlobals, worldAnchorLinesFor } from '../src/tools/visual/sagaBriefGlobals.js';
import { buildDirectedVideoPrompt } from '../src/tools/visual/videoDirector.js';
import { renderingGuardrailsLength } from '../src/tools/visual/renderingGuardrails.js';

const STORY = 'A young woman named Mei walks along a beach at sunset, then sits on a rock and watches the waves.';

async function resolutionChecks(): Promise<void> {
  const hd = await runHermeticSaga({ prompt: STORY, totalDuration: 10, ratio: '9:16', resolution: '1080P', generateAudio: false });
  assert.equal(hd.result.ok, true, hd.result.output);
  const hdTasks = videoTaskBodies(hd.requests);
  assert.equal(hdTasks.length, 2);
  assert.ok(hdTasks.every((body) => body.resolution === '1080p'), 'every segment carries the requested, normalized resolution');
  assert.match(hd.result.output, /resolution 1080p/);

  const plain = await runHermeticSaga({ prompt: '《码头》夜景，方天豪走向镜头，海风吹起他的风衣。', totalDuration: 5, ratio: '9:16', generateAudio: false });
  assert.equal(plain.result.ok, true, plain.result.output);
  // Titles and filenames come from the user's brief (CJK kept), never from the generation template.
  assert.match(plain.result.output, /Title:\s+码头/);
  assert.match(plain.result.output, /_\d+s_9x16_码头_video-[^/\s]*\.mp4/);
  assert.doesNotMatch(hd.result.output, /Generation-instruction|Title:\s+Generation instruction/);
  assert.match(hd.result.output, /Title:\s+A young woman named Mei walks along a beach at…/);
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
  assert.equal(superVisualImageLimit(1), 4);
  assert.equal(superVisualImageLimit(12), 16, 'a long video gets a turnaround and its fallback, one keyframe per segment and two re-renders');
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
  assert.match(run.result.output, /Consistency:  image-to-image · userImagesUsed=1/);
  assert.match(run.result.output, /Keyframes:\s+generated=2\/2 · images=3\/6/);
  const images = imageBodies(run.requests);
  assert.equal(images.length, 3, 'one turnaround and one keyframe per segment');
  const refCount = (body: Record<string, any>) => Array.isArray(body.image) ? body.image.length : body.image ? 1 : 0;
  assert.equal(refCount(images[0]!), 1, 'the turnaround carries the user reference');
  assert.equal(images[0]!.size, '2560x1440', 'the turnaround sheet is landscape');
  assert.equal(refCount(images[1]!), 1, 'segment 1 keyframe carries the turnaround');
  assert.equal(refCount(images[2]!), 2, 'segment 2 keyframe carries the turnaround and the previous frame');
  assert.ok(images.slice(1).every((body) => body.size === '1440x2560'), 'keyframes follow the 9:16 ratio');
  assert.ok(images.every((body) => String(Array.isArray(body.image) ? body.image[0] : body.image).startsWith('data:image/png;base64,')), 'references are sent as data URIs');
  assert.ok(run.logs.some((line) => /第 2\/2 段生成图片 1 张；全片累计 3\/6 张/.test(line)), 'per-segment image counts are logged');

  // Images the API produced count against the cap even when their download
  // fails, and the text-to-image fallback respects the cap too.
  const lost = await runHermeticSaga(
    { prompt: STORY, totalDuration: 30, ratio: '9:16', generateAudio: false, referenceImagePaths: [fixturePng()] },
    { imageDownloadFailsFrom: 2 },
  );
  assert.equal(lost.result.ok, true, lost.result.output);
  const billed = imageBodies(lost.requests).length;
  const counted = lost.result.output.match(/images=(\d+)\/(\d+)/);
  assert.ok(counted, lost.result.output);
  assert.equal(Number(counted[1]), billed, `every billed image is counted (${counted[0]}, ${billed} requests)`);
  assert.ok(billed <= Number(counted[2]), `billed images stay within the cap (${billed}/${counted[2]})`);

  // A turnaround whose download fails still leaves room for its text-to-image fallback.
  const lostTurnaround = await runHermeticSaga(
    { prompt: STORY, totalDuration: 10, ratio: '9:16', generateAudio: false, referenceImagePaths: [fixturePng()] },
    { imageDownloadFailsAt: [1], chatReply: 'An illustrated young woman with short black hair and a red scarf.' },
  );
  assert.equal(lostTurnaround.result.ok, true, lostTurnaround.result.output);
  assert.match(lostTurnaround.result.output, /Consistency:  text-to-image/, lostTurnaround.result.output.split('\n').find((line) => line.includes('Consistency')));

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
    assert.match(skipped.ok ? '' : skipped.reason, /image limit/);
    assert.equal(requests.length, before);
  });

  // A text-to-image-only model falls back cleanly: no Super Visual, no image calls, the video still renders.
  const t2i = await runHermeticSaga(
    { prompt: STORY, totalDuration: 5, ratio: '9:16', generateAudio: false },
    { imageModel: 'seedream-3-0-t2i-250415' },
  );
  assert.equal(t2i.result.ok, true, t2i.result.output);
  assert.match(t2i.result.output, /Consistency:  off \(the image model cannot generate from reference images/);
  assert.equal(imageBodies(t2i.requests).length, 0);
}

function titleChecks(): void {
  assert.equal(deriveTitleFromBrief('片名：海边的女孩\n她在海边奔跑。'), '海边的女孩');
  assert.equal(deriveTitleFromBrief('30秒短片《码头》\n[0-10秒] 夜景。'), '码头');
  assert.equal(
    deriveTitleFromBrief('【CHARACTER LOCK】方天豪，黑色风衣。\n时长：30秒\n[0-5秒] 镜头1：女孩推开旧影院的门，尘埃在光束里漂浮。'),
    '女孩推开旧影院的门，尘埃在光束里漂浮',
    'structure lines and timecodes are skipped',
  );
  assert.equal(deriveTitleFromBrief('[原样直传]\n---'), undefined, 'nothing usable falls back to the default title');
  assert.equal(deriveTitleFromBrief('帮我生成一段长视频\n\n[0-5秒] 镜头1：女孩推开旧影院的门。'), '女孩推开旧影院的门', 'request preambles are skipped');
  assert.equal(deriveTitleFromBrief('/saga 30秒长视频\n女孩在雨中奔跑。'), '女孩在雨中奔跑');
  assert.equal(deriveTitleFromBrief('Make me a 60 second long video.\nA girl runs in the rain.'), 'A girl runs in the rain');
  assert.equal(deriveTitleFromBrief('00:00-00:05 女孩在雨中跳舞'), '女孩在雨中跳舞', 'mm:ss time ranges are removed whole');
  assert.equal(deriveTitleFromBrief('Dr. Smith walks in. He sits.'), 'Dr. Smith walks in', 'abbreviations do not end the sentence');
  assert.equal(deriveTitleFromBrief('时长：60秒\n比例：9:16\n1080p'), undefined, 'spec-only lines are not titles');
  assert.equal(deriveTitleFromBrief('https://example.com/a.png 参考这张图'), '参考这张图');
  assert.equal(deriveTitleFromBrief('../../etc/passwd\n女孩在雨中。'), '女孩在雨中');
}

async function directorKeepsShotContent(): Promise<void> {
  // No LLM in the hermetic run, so every segment prompt goes through the
  // deterministic language template and the Director. Each segment's own
  // shot text must still reach its video request.
  const script = '[0-5秒] 镜头1：红色风筝飞过山坡，戴黄帽子的男孩追着跑。\n[5-10秒] 镜头2：风筝落进开满蓝色野花的草地，男孩蹲下捡起它。';
  const run = await runHermeticSaga({ prompt: script, story: script, totalDuration: 10, ratio: '16:9', generateAudio: false });
  assert.equal(run.result.ok, true, run.result.output);
  const textOf = (body: Record<string, any>) => (body.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
  const [first, second] = videoTaskBodies(run.requests).map(textOf);
  assert.ok(first?.includes('红色风筝飞过山坡，戴黄帽子的男孩追着跑'), `segment 1 shot text is missing: ${first}`);
  assert.ok(second?.includes('风筝落进开满蓝色野花的草地，男孩蹲下捡起它'), `segment 2 shot text is missing: ${second}`);
  assert.ok([first, second].every((text) => (text?.length ?? 0) <= 4000));
  // Each shot's own beat comes before the bible, which repeats the whole story.
  for (const [text, beat] of [[first, '红色风筝飞过山坡'], [second, '风筝落进开满蓝色野花的草地']] as const) {
    const bibleAt = text!.indexOf('continuity bible');
    assert.ok(bibleAt === -1 || text!.indexOf(beat) < bibleAt, `the shot beat should precede the continuity bible: ${text}`);
  }
}

async function rawModeChecks(): Promise<void> {
  assert.equal(stripRawModeTag('海边的女孩。\n\n[原样直传]'), '海边的女孩。');
  assert.equal(stripRawModeTag('【raw直传】 kite story'), 'kite story');
  assert.equal(stripRawModeTag('原样直传\n风筝'), '风筝');
  assert.equal(stripRawModeTag('她说要原样直传这段剧本。'), '她说要原样直传这段剧本。', 'the word inside a sentence stays');
  const rawStory = '[原样直传]\nA young woman named Mei walks along a beach at sunset, then sits on a rock and watches the waves.';
  const raw = await runHermeticSaga({ prompt: rawStory, story: rawStory, totalDuration: 10, ratio: '9:16', generateAudio: false, rawPassthrough: true });
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
  assert.ok(tasks.every((body) => promptText(body).length <= 4000), 'raw prompts fit the model prompt limit');
  // "[原样直传]" is the script as written: no identity card, negatives or bible.
  for (const body of tasks) {
    const text = promptText(body);
    assert.doesNotMatch(text, /\[NEGATIVE|SAGA-CONTINUITY-POLICY|CHARACTERS|SCENE-PRIORITY|continuity bible|Shot \d+ of/, `raw passthrough sends only the script: ${text}`);
    assert.ok(text.length < 400, `raw passthrough sends only the segment text: ${text.length} chars`);
  }
  const rawTimecoded = '[原样直传]\n画幅比例：9:16\n[0-5秒] 一只橘猫跳上窗台，阳光洒在毛上。\n[5-10秒] 橘猫打了个哈欠，**对白**: "喵。"';
  const rawRun = await runHermeticSaga({ prompt: rawTimecoded, story: rawTimecoded, totalDuration: 10, ratio: '9:16', generateAudio: false, rawPassthrough: true });
  const [rawFirst, rawSecond] = videoTaskBodies(rawRun.requests).map(promptText);
  assert.equal(rawFirst, '一只橘猫跳上窗台，阳光洒在毛上。', 'segment 1 goes exactly as written');
  assert.match(rawSecond ?? '', /^Dialogue handling:\n- Only these marked lines are spoken: “喵。”/, 'a raw segment carries its own dialogue note');
  assert.match(rawSecond ?? '', /橘猫打了个哈欠，\*\*对白\*\*: "喵。"$/);

  // cleanDirect (guide §9.10) only drops the aesthetic dressing: the
  // narrative analysis and the Super Visual turnaround still run.
  const cleanStory = 'Use raw look / low filter / raw-seedance / clean-direct.\nA young woman named Mei walks along a beach at sunset, then sits on a rock and watches the waves.';
  const clean = await runHermeticSaga({ prompt: cleanStory, story: cleanStory, totalDuration: 10, ratio: '9:16', generateAudio: false, cleanDirect: true });
  assert.equal(clean.result.ok, true, clean.result.output);
  const cleanTasks = videoTaskBodies(clean.requests);
  assert.ok(clean.requests.some((r) => r.url.endsWith('/chat/completions')), 'cleanDirect keeps the narrative analysis');
  assert.ok(imageBodies(clean.requests).length >= 1 && imageBodies(clean.requests).length <= 2, 'cleanDirect keeps the turnaround but makes no keyframes');
  for (const body of cleanTasks) {
    const text = promptText(body);
    assert.ok(text.length <= 4000, 'cleanDirect prompts fit the model prompt limit');
    assert.ok(!/Fibonacci|focal point|\[STYLE-LOCK|\[AESTHETIC-LOCK|Rendering rules:/.test(text), 'cleanDirect drops the aesthetic dressing');
    assert.ok(/\[NEGATIVE/.test(text) && /SAGA-CONTINUITY-POLICY|LOCKED-CHARACTERS|CHARACTERS:/.test(text), 'cleanDirect keeps the identity and negative locks');
    assert.ok(!/clean-direct|raw-seedance/.test(text), 'the cleanDirect instruction line never reaches the video model');
  }
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

async function inputPathChecks(): Promise<void> {
  // A reference outside the workspace that the host does not approve is refused before any request.
  const declined = await runHermeticSaga(
    { prompt: STORY, totalDuration: 10, referenceImagePaths: [fixturePng()] },
    {},
    () => ({ permissionMode: 'ask', requestWorkspaceSwitch: async () => false }),
  );
  assert.equal(declined.result.ok, false);
  assert.match(declined.result.output, /Workspace switch declined/);
  assert.equal(declined.requests.length, 0, 'nothing is read or sent for a refused path');

  // A protected file inside the workspace is refused outside full access.
  let protectedPath = '';
  const guarded = await runHermeticSaga(
    { prompt: STORY, totalDuration: 10, soundtrackPath: '.ssh/theme.mp3' },
    {},
    (cwd) => {
      protectedPath = path.join(cwd, '.ssh');
      mkdirSync(protectedPath, { recursive: true });
      writeFileSync(path.join(protectedPath, 'theme.mp3'), 'not really audio');
      return { permissionMode: 'ask' };
    },
  );
  assert.equal(guarded.result.ok, false);
  assert.match(guarded.result.output, /protected directory/);
  assert.equal(guarded.requests.length, 0);
}

async function silentShortClipChecks(): Promise<void> {
  // The mock provider returns 5-second clips for 8-second segments. With
  // audio, the silent audio padding used to stretch the timeline; without
  // audio the video came out 10 s instead of 16 s and failed the final
  // duration check. Each clip now holds its last frame to its planned length.
  const script = '[0-8秒] 镜头1：红色风筝飞过山坡。\n[8-16秒] 镜头2：风筝落进草地。';
  for (const generateAudio of [false, true]) {
    const run = await runHermeticSaga({ prompt: script, story: script, totalDuration: 16, ratio: '9:16', generateAudio });
    assert.equal(run.result.ok, true, `generateAudio=${generateAudio}: ${run.result.output}`);
    const seconds = Number(String(run.result.output).match(/^([\d.]+)s · 2 segments/m)?.[1]);
    assert.ok(seconds >= 15.5 && seconds <= 16.5, `generateAudio=${generateAudio}: the video fills its 16 s, got ${seconds}`);
  }
}

async function plainVideoDialogueChecks(): Promise<void> {
  // A plain generate_video prompt (no Saga, no LLM) keeps quoted speech as dialogue.
  for (const prompt of ['A tired soldier looks into the camera and says "We made it home."', '一个女孩对着镜头笑着说“我们回家吧！”']) {
    await withHermeticWorkspace({}, async (cwd, requests) => {
      const result = await executeGenerateVideo({ type: 'generate_video', prompt, outputPath: path.join(cwd, 'v.mp4') } as any, { cwd, permissionMode: 'full-access' } as any);
      assert.equal(result.ok, true, result.output);
      const text = videoTaskBodies(requests).map((body) => (body.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n')).join('\n');
      assert.match(text, /Quoted text in the brief is spoken dialogue|Treat quoted speech in the brief as spoken dialogue/, prompt);
      assert.doesNotMatch(text, /not speech/, prompt);
    });
  }
}

async function segmentDialogueAndCutChecks(): Promise<void> {
  // cleanDirect: each segment lists only its own marked lines, never the
  // whole brief's (the bible no longer carries the brief's dialogue note).
  const brief = '请用原始质感 / 少滤镜 / raw-seedance / clean-direct。\n[0-8秒] 段 1 · 地铁站\n他从地铁站出口走出。\n[8-16秒] 段 2 · 窗边\n他坐在窗边。\n**对白（约 2 秒）**: "终于到了。"';
  const clean = await runHermeticSaga({ prompt: brief, story: brief, totalDuration: 16, ratio: '16:9', generateAudio: false, cleanDirect: true, identitySource: 'text_only' });
  assert.equal(clean.result.ok, true, clean.result.output);
  const textOf = (body: Record<string, any>) => (body.content ?? []).filter((item: any) => item.type === 'text').map((item: any) => item.text).join('\n');
  const [first, second] = videoTaskBodies(clean.requests).map(textOf);
  assert.ok(!first!.includes('终于到了'), `segment 1 has no dialogue of its own: ${first}`);
  assert.match(second!, /^Dialogue handling:\n- Only these marked lines are spoken: “终于到了。”/, 'segment 2 lists its own line');

  // A written INSTANT HARD CUT starts a new picture: no tail frame crosses it.
  const cut = '[0-5秒] 段 1 · 女孩在雨夜街头停下。结尾 INSTANT HARD CUT。\n[5-10秒] 段 2 · 东京的早晨，女孩推开窗。';
  const cutRun = await runHermeticSaga({ prompt: cut, story: cut, totalDuration: 10, ratio: '9:16', generateAudio: false, identitySource: 'text_only' });
  assert.equal(cutRun.result.ok, true, cutRun.result.output);
  const images = (body: Record<string, any>) => (body.content ?? []).filter((item: any) => item.type === 'image_url').length;
  assert.equal(images(videoTaskBodies(cutRun.requests)[1]!), 0, 'no tail frame across a hard cut');
  const flow = cut.replace('结尾 INSTANT HARD CUT。', '');
  const flowRun = await runHermeticSaga({ prompt: flow, story: flow, totalDuration: 10, ratio: '9:16', generateAudio: false, identitySource: 'text_only' });
  assert.equal(images(videoTaskBodies(flowRun.requests)[1]!), 1, 'without a cut the tail frame is chained');
  // A negated cut or a cutting rhythm inside a shot is not an incoming cut.
  const notCut = [
    '[0-6秒] 段 1 · 男人在走廊奔跑，机位锁死。',
    '[6-12秒] 段 2 · 紧接上文，不要硬切：同机位、同动作方向，他继续向右奔跑。',
    '[12-18秒] 段 3 · 节奏：每 2 秒一硬切，男人在楼梯间不同角度的剪影。',
    '[18-24秒] 段 4 · 继续：他推开天台的门。No hard cut here, continuous take.',
  ].join('\n');
  const notCutRun = await runHermeticSaga({ prompt: notCut, story: notCut, totalDuration: 24, ratio: '16:9', generateAudio: false, identitySource: 'text_only' });
  assert.equal(notCutRun.result.ok, true, notCutRun.result.output);
  assert.deepEqual(videoTaskBodies(notCutRun.requests).map(images), [0, 1, 1, 1], 'negated cuts and cutting rhythms keep the chain');
  const startCut = '[0-5秒] 段 1 · 女孩在雨夜街头停下。\n[5-10秒] 段 2 · INSTANT HARD CUT，东京的早晨，女孩推开窗。';
  const startCutRun = await runHermeticSaga({ prompt: startCut, story: startCut, totalDuration: 10, ratio: '9:16', generateAudio: false, identitySource: 'text_only' });
  assert.equal(images(videoTaskBodies(startCutRun.requests)[1]!), 0, 'a cut opening the segment is its incoming cut');

  // Subtitles on "auto": a segment that marks a subtitle line may show it.
  const bible = buildContinuityBible({ story: '雨夜的城市。', ratio: '9:16', subtitleMode: 'auto' });
  const compile = (storyBeat: string, subtitleMode: 'auto' | 'off') => compileShotPromptWithContinuity({
    bible, mode: 'strong-vision', shotIndex: 1, shotCount: 1, duration: 8, title: '0-8s', storyBeat, visualPrompt: '', camera: '', continuity: '', transition: '', subtitleMode,
  });
  const withSubtitle = compile('他推门进来。**字幕**: "成都 · 2019"', 'auto');
  assert.doesNotMatch(withSubtitle.match(/\[NEGATIVE[^\]]*\]/)?.[0] ?? '', /no readable text|no subtitles/);
  assert.doesNotMatch(withSubtitle, /no (?:readable )?subtitles(?=[,\n\]])/);
  assert.match(compile('他推门进来。', 'auto'), /no readable text, no subtitles/);
  const offBible = buildContinuityBible({ story: '雨夜的城市。', ratio: '9:16', subtitleMode: 'off' });
  assert.match(compileShotPromptWithContinuity({ bible: offBible, mode: 'strong-vision', shotIndex: 1, shotCount: 1, duration: 8, title: '0-8s', storyBeat: '**字幕**: "成都"', visualPrompt: '', camera: '', continuity: '', transition: '', subtitleMode: 'off' }), /no subtitles/);

  // A world anchor that does not fit in full keeps its name and first lines.
  const globals = parseSagaBriefGlobals('【时空锚点 / WORLD ANCHOR】\n[锚点·黄昏大雨 | 0-24秒]\n- 地面湿滑，雨水反光\n- 角色头发贴在额头\n- 远处车灯在雨幕中散开\n\n[0-8秒] 段 1 · x');
  assert.equal(worldAnchorLinesFor(globals, 0, 8, true), '[WORLD ANCHOR · 黄昏大雨: 地面湿滑，雨水反光; 角色头发贴在额头]');
}

async function richBibleBudgetChecks(): Promise<void> {
  // A rich continuity bible (many locked characters, wardrobe, props,
  // locations) must not crowd the shot or the dialogue rules out of a
  // 4,000-character Seedance prompt.
  const model = 'dreamina-seedance-2-0-260128';
  const limit = resolveVideoModelLimits('byteplus', model).maxPromptChars;
  const many = (text: string, count: number) => Array.from({ length: count }, (_, i) => `${text} ${i}`);
  const bible = buildContinuityBible({
    story: '一个很长的故事。'.repeat(200),
    ratio: '16:9',
    characters: many('方天豪：三十五岁华人男性，短发，左眉有一道旧疤，身材魁梧，穿黑色长风衣', 16),
    wardrobe: many('黑色羊毛长风衣，内搭深灰色高领毛衣，黑色皮靴', 16),
    props: many('一把黄铜旧钥匙，钥匙柄上刻着一只海鸥', 16),
    locations: many('夜晚的旧码头，生锈的集装箱，湿漉漉的水泥地面', 16),
    accessoriesLock: many('左手无名指上的银色戒指', 8),
    shotContinuityNotes: many('镜头之间保持风衣下摆被海风吹向画面右侧', 16),
  } as any);
  assert.ok(bible.identityCard.length <= IDENTITY_CARD_MAX_CHARS, `identity card is ${bible.identityCard.length} chars`);
  const beat = 'BEAT-START 林夏从集装箱后走出，手里握着一把旧钥匙。' + '海浪拍打着码头，'.repeat(60) + '。林夏：（冷笑）“你以为你赢了吗？” BEAT-END';
  const shot = compileShotPromptWithContinuity({
    bible, mode: 'strong-vision' as any, shotIndex: 2, shotCount: 6, duration: 10, title: '5-10s',
    storyBeat: beat, visualPrompt: beat, camera: 'slow dolly in', continuity: 'same night', transition: 'cut', authoredPrompt: beat,
  } as any);
  assert.ok(!shot.includes('described below'), 'scene priority refers to the beat above it');
  const normalized = await normalizeSagaPromptForVideoGeneration({ cwd: '/nonexistent', text: shot, enableLlmRewrite: false });
  const directed = buildDirectedVideoPrompt({ prompt: normalized.generationText, provider: 'byteplus', model, duration: 10, ratio: '16:9', maxPromptChars: limit - renderingGuardrailsLength() });
  const final = appendRenderingGuardrails(directed.directedPrompt, limit).prompt;
  assert.ok(final.length <= limit);
  assert.ok(final.includes('BEAT-START') && final.includes('BEAT-END'), 'the whole shot beat survives');
  assert.ok(final.includes('Dialogue handling:') && final.includes('lip-sync'), 'the dialogue rules survive');
  assert.ok(final.includes('[LOCKED-CHARACTERS:'), 'the identity card survives');

  // A beat far longer than the budget is capped, so the identity card and its
  // negative constraints still make it into the prompt.
  const hugeBeat = 'HUGE-BEAT ' + '海浪拍打着码头，'.repeat(400);
  const hugeShot = compileShotPromptWithContinuity({
    bible, mode: 'strong-vision' as any, shotIndex: 2, shotCount: 6, duration: 10, title: '5-10s',
    storyBeat: hugeBeat, visualPrompt: hugeBeat, camera: 'slow dolly in', continuity: 'same night', transition: 'cut', authoredPrompt: hugeBeat,
  } as any);
  const hugeNormalized = await normalizeSagaPromptForVideoGeneration({ cwd: '/nonexistent', text: hugeShot, enableLlmRewrite: false });
  const hugeFinal = appendRenderingGuardrails(buildDirectedVideoPrompt({ prompt: hugeNormalized.generationText, provider: 'byteplus', model, duration: 10, ratio: '16:9', maxPromptChars: limit - renderingGuardrailsLength() }).directedPrompt, limit).prompt;
  assert.ok(hugeFinal.includes('HUGE-BEAT') && hugeFinal.includes('[NEGATIVE:'), 'a huge beat cannot crowd out the negative constraints');

  // Characters are shortened, not dropped, while optional lines can make room.
  const cast = [
    'Fang Tianhao: 35-year-old Chinese man, short black hair, old scar over the left eyebrow, broad build, long black wool trench coat',
    'Lin Xia: 28-year-old Chinese woman, shoulder-length wavy hair, small mole under the right eye, red leather jacket, silver hoop earrings',
    'Old Zhou: 60-year-old Chinese fisherman, grey stubble, deeply tanned wrinkled face, faded blue work jacket, straw hat',
  ];
  const castCard = buildContinuityBible({ story: 'x', ratio: '16:9', characters: cast, wardrobe: ['trench coat', 'red leather jacket', 'blue work jacket'] } as any).identityCard;
  assert.ok(['Fang Tianhao', 'Lin Xia', 'Old Zhou'].every((name) => castCard.includes(name)), castCard);
  const bigCast = buildContinuityBible({ story: 'x', ratio: '16:9', characters: Array.from({ length: 8 }, (_, i) => `Person${i}: ${'detailed description, '.repeat(6)}`) } as any).identityCard;
  assert.ok(bigCast.length <= IDENTITY_CARD_MAX_CHARS);
  assert.ok(Array.from({ length: 8 }, (_, i) => `Person${i}`).every((name) => bigCast.includes(name)), 'eight characters are shortened to fit rather than dropped');
}

seedreamSizeChecks();
titleChecks();
await richBibleBudgetChecks();
await segmentDialogueAndCutChecks();
await plainVideoDialogueChecks();
await silentShortClipChecks();
eligibilityChecks();
budgetChecks();
await inputPathChecks();
await resolutionChecks();
await superVisualOnSeedream();
await rawModeChecks();
await chainAccountingChecks();
await guardrailChecks();
await directorKeepsShotContent();
console.log('saga hermetic smoke ok');
