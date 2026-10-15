// Model-aware video durations: every decision derives from L, the active
// video model's longest single clip (Seedance 2.0: 15 s, Seedance 2.5: 30 s,
// or what the platform declares in visualProfile.video.capabilities).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixturePng, imageBodies, runHermeticSaga, videoTaskBodies, withHermeticWorkspace } from './sagaHermeticHarness.js';
import { extractOpeningFramingRegex } from '../src/tools/visual/sagaFraming.js';
import { shouldPreserveUserScriptWithoutCriticRewrite } from '../src/tools/generateLongVideo.js';
import { ProviderStore } from '../src/providers/store.js';
import {
  clipBeatBudget,
  clipBeatShotCount,
  clipShotsHeader,
  fitClipBeat,
  offsetBeatTimeline,
  openingShotBeat,
  openingShotCamera,
  packShotsIntoClips,
  parseClipBeat,
  planSegmentDurations,
  renderClipBeat,
  restoreClipBeat,
  segmentCountFor,
  sentencesOf,
  splitBeatText,
  splitLongShots,
} from '../src/tools/visual/segmentPlan.js';
import { resolveVideoModelCapabilities, resolveVideoModelProfile } from '../src/tools/visual/videoCapabilities.js';
import { resolveVideoModelLimits } from '../src/tools/visual/videoModelLimits.js';
import { normalizeVideoDurationForProvider } from '../src/tools/visual/videoParams.js';
import { resolveActiveVideoClipSeconds } from '../src/tools/visual/activeVideoModel.js';
import {
  classifyVideoRequestLength,
  handleSagaLongVideoWorkflow,
  longVideoDurationChoices,
  offerSagaLongVideoWorkflow,
  parseRequestedVideoSeconds,
} from '../src/tools/visual/sagaWorkflow.js';
import { handleSeedanceMultimodalWorkflow, singleClipChoices } from '../src/tools/visual/seedanceWorkflow.js';
import { looksLikeSagaRequest, routeWorkflow } from '../src/core/workflowRouter.js';
import { parseVideoLengthAnswer, planHeadlessWorkflow, videoLengthChoices } from '../src/services/headlessWorkflow.js';
import { SessionStore } from '../src/storage/sessions.js';
import { findInternalNames } from '../src/utils/internalNames.js';

// Nothing here reaches the network: a call made outside a hermetic run (the
// wizard's story analysis) fails at once, as it does with no LLM configured.
globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'offline smoke' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

const SEEDANCE_20 = 'dreamina-seedance-2-0-260128';
// No public 2.5 id is pinned here: any id matching /seedance[-_ ]?2[._-]?5/ is 2.5.
const SEEDANCE_25 = 'dreamina-seedance-2-5-260901';
const COST_RE = /费用|计费|收费|扣费|价格|余额|充值|\bcosts?\b|\bbilled\b|\bprice\b|\bmoney\b/i;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✔ ${name}`);
}

function plain(text: string, where: string): void {
  assert.deepEqual(findInternalNames(text).map((hit) => hit.match), [], `${where}: internal names in ${text}`);
  assert.doesNotMatch(text, COST_RE, `${where}: cost wording`);
}

async function configureVideo(cwd: string, model: string, capabilities?: Record<string, unknown>): Promise<void> {
  const store = new ProviderStore(cwd);
  const data = await store.load();
  data.visualProfile = {
    enabled: true,
    image: { provider: 'byteplus', apiKey: 'k', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', model: 'seedream-5-0-260128', defaultParams: { size: '2K', quality: 'standard', style: 'realistic', watermark: false } },
    video: {
      enabled: true, provider: 'byteplus', apiKey: 'k', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', model,
      defaultParams: { duration: '5s', resolution: '720p', quality: 'standard', style: 'realistic', format: 'mp4', framerate: '24fps', watermark: false },
      ...(capabilities ? { capabilities } : {}),
    },
  } as any;
  await store.save(data);
}

async function workspace(model: string, capabilities?: Record<string, unknown>): Promise<string> {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'artemis-video-duration-'));
  await configureVideo(cwd, model, capabilities);
  return cwd;
}

console.log('\n  videoDurationSmoke\n  ==================');

await test('model profiles: one table; 2.5 renders 30 s clips, 2.0 stays at 15 s', () => {
  for (const id of [SEEDANCE_25, 'seedance_2.5_pro', 'Seedance 2.5 Pro', 'seedance-2-5']) {
    const profile = resolveVideoModelProfile('byteplus', id);
    assert.equal(profile.family, 'seedance-2.5', id);
    assert.equal(profile.maxClipSeconds, 30, id);
    assert.deepEqual([...profile.referenceInputs], ['image', 'video', 'audio'], id);
    assert.equal(profile.canGenerateAudio, true);
    assert.equal(profile.firstFrame, true);
  }
  assert.equal(resolveVideoModelProfile('byteplus', 'seedance-2-50-x').family !== 'seedance-2.5', true, 'a 2.50 id is not 2.5');
  const twenty = resolveVideoModelProfile('byteplus', SEEDANCE_20);
  assert.equal(twenty.maxClipSeconds, 15);
  assert.equal(twenty.maxPromptChars, 4000);
  assert.equal(resolveVideoModelProfile('byteplus', 'seedance-1-5-pro-251215').maxClipSeconds, 12);
  assert.equal(resolveVideoModelLimits('byteplus', SEEDANCE_25).maxSegmentSeconds, 30);
  assert.equal(resolveVideoModelLimits('byteplus', SEEDANCE_20).maxSegmentSeconds, 15);
  assert.deepEqual([...resolveVideoModelCapabilities('custom', SEEDANCE_25).referenceInputs], ['image', 'video', 'audio']);
  assert.equal(normalizeVideoDurationForProvider(30, 'byteplus', SEEDANCE_25), 30);
  assert.equal(normalizeVideoDurationForProvider(30, 'byteplus', SEEDANCE_20), 15);
  assert.equal(normalizeVideoDurationForProvider(2, 'byteplus', SEEDANCE_25), 4);
});

await test('platform overrides: video.capabilities wins for its model only', () => {
  const declared = resolveVideoModelProfile('byteplus', SEEDANCE_20, { maxClipSeconds: 30 });
  assert.equal(declared.maxClipSeconds, 30);
  assert.equal(declared.source, 'platform');
  assert.equal(resolveVideoModelProfile('byteplus', SEEDANCE_20, { model: 'another-model', maxClipSeconds: 30 }).maxClipSeconds, 15, 'scoped to another model: ignored');
  assert.equal(resolveVideoModelProfile('custom', 'my-video-v1', { maxClipSeconds: 20, referenceInputs: ['image'] }).maxClipSeconds, 20);
  assert.equal(normalizeVideoDurationForProvider(25, 'custom', 'my-video-v1', { maxClipSeconds: 20 }), 20);
  assert.equal(normalizeVideoDurationForProvider(7, 'byteplus', SEEDANCE_20, { allowedDurations: [5, 10] }), 5, 'snapped to an allowed length');
  assert.equal(resolveVideoModelProfile('byteplus', SEEDANCE_20, { maxClipSeconds: -3 }).maxClipSeconds, 15, 'a bad value keeps the built-in');
});

await test('segment math edge cases: minimum, unrounded spans, sentences never dropped', () => {
  // L is a hard limit; the 4 s minimum is soft when L is under 8 s.
  assert.deepEqual(planSegmentDurations(7, 5, 4), [4, 3]);
  assert.deepEqual(planSegmentDurations(9, 5, 4), [5, 4]);
  assert.deepEqual(planSegmentDurations(11, 5, 4), [4, 4, 3]);
  assert.deepEqual(planSegmentDurations(7, 4, 4), [4, 3]);
  assert.deepEqual(planSegmentDurations(6, 5, 4), [3, 3]);
  assert.deepEqual(planSegmentDurations(20, 15, 4), [10, 10]);
  for (const [total, L] of [[7, 5], [11, 5], [6, 5], [7, 4], [13, 6], [61, 15], [44, 30], [119, 30], [600, 7]] as const) {
    const plan = planSegmentDurations(total, L, 4);
    assert.equal(plan.reduce((sum, value) => sum + value, 0), total, `${total} on L=${L}: total stays exact`);
    assert.ok(plan.every((value) => value <= L), `${total} on L=${L}: no part is longer than L (${plan})`);
    if (L >= 8) assert.ok(plan.every((value) => value >= 4), `${total} on L=${L}: no part under 4 s (${plan})`);
  }
  const split = splitLongShots([{ title: 'a', storyBeat: '他走进来。他坐下。', timecodeStart: 0, timecodeEnd: 12.4 }], 12);
  assert.equal(split.length, 2, '12.4 s does not fit a 12 s clip');
  const six = splitLongShots([{ title: 'b', storyBeat: '他走进来。他坐下。', duration: 6 }], 5);
  assert.deepEqual(six.map((shot) => shot.duration), [3, 3], 'a 6 s shot on L=5 is split, not kept whole');
  const samples = [
    'He walks 3.5 meters forward. Then he stops.',
    'Wait... the door opens. Nobody is there!',
    'Visit example.com for details. Then leave',
    '今天3.5度。她说：“好冷啊！我们回去吧。”然后转身离开',
    '镜头拉远；城市亮起灯？没有人回答！',
    'No terminator at all',
    '“A quoted line. With two sentences.” He nods.',
    'v1.2.3 ships today. ok',
  ];
  for (const text of samples) {
    const sentences = sentencesOf(text);
    assert.equal(sentences.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''), `nothing dropped: ${JSON.stringify(sentences)}`);
    for (const parts of [2, 3]) {
      const pieces = splitBeatText(text, parts);
      if (sentences.length >= parts) assert.equal(pieces.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''), `${parts} parts of ${text}`);
    }
  }
  assert.deepEqual(sentencesOf('He walks 3.5 meters forward. Then he stops.'), ['He walks 3.5 meters forward.', 'Then he stops.']);
});

await test('model families: separator-tolerant ids', () => {
  for (const id of ['seedance-2.0', 'seedance_2_0', 'Seedance 2.0 Pro', SEEDANCE_20]) assert.equal(resolveVideoModelProfile('byteplus', id).maxClipSeconds, 15, id);
  for (const id of ['seedance-1.5-pro', 'seedance-1-5-pro-251215', 'Seedance 1.5']) assert.equal(resolveVideoModelProfile('byteplus', id).maxClipSeconds, 12, id);
  assert.equal(resolveVideoModelProfile('byteplus', 'seedance-1.0-lite').family, 'seedance-1.0');
  assert.equal(resolveVideoModelProfile('byteplus', 'seedance 2.5').maxClipSeconds, 30);
});

await test('length parsing: totals win, 两 and 半分钟, "30s video" is seconds', () => {
  for (const [text, seconds] of [
    ['make a 30s video of the sea', 30],
    ['a 60s clip about cats', 60],
    ['make a 45s video', 45],
    ['一分两秒的视频', 62],
    ['半分钟的视频', 30],
    ['每段5秒，总共60秒', 60],
    ['总时长 2 分钟，每个镜头 8 秒', 120],
    ['each shot 5 seconds, 90 seconds in total', 90],
  ] as const) assert.equal(parseRequestedVideoSeconds(text), seconds, text);
  assert.equal(parseRequestedVideoSeconds('a 90s style music video'), undefined, 'a decade, not a length');
  for (const decade of ['a 70s film', 'an 80s movie', 'the 90s video game era', '做个90s风格的视频', 'a 60s look', '80年代风']) {
    assert.equal(parseRequestedVideoSeconds(decade), undefined, decade);
  }
  for (const [text, seconds] of [['a 30s video', 30], ['做个60s的视频', 60], ['a 45s film', 45], ['60s video about games', 60]] as const) {
    assert.equal(parseRequestedVideoSeconds(text), seconds, text);
  }
  for (const [reply, seconds] of [['10s', 10], ['20 秒', 20], ['15 sec', 15], ['30 seconds', 30]] as const) assert.equal(parseVideoLengthAnswer(reply), seconds, reply);
  assert.equal(parseRequestedVideoSeconds('80s music vibe'), undefined);
  assert.deepEqual(parseVideoLengthAnswer('5'), 5);
  assert.deepEqual(parseVideoLengthAnswer('20'), 20);
  assert.deepEqual(parseVideoLengthAnswer('半分钟'), 30);
  assert.deepEqual(parseVideoLengthAnswer('1 分钟'), 60);
  assert.deepEqual(parseVideoLengthAnswer('更长，我来说'), 'longer');
  assert.equal(parseVideoLengthAnswer('嗯'), undefined);
});

await test('segment plans: fewest even segments of at most L (2.0 vs 2.5)', () => {
  const table: Array<[number, number[], number[]]> = [
    [15, [15], [15]],
    [30, [15, 15], [30]],
    [45, [15, 15, 15], [23, 22]],
    [60, [15, 15, 15, 15], [30, 30]],
    [75, [15, 15, 15, 15, 15], [25, 25, 25]],
    [120, [15, 15, 15, 15, 15, 15, 15, 15], [30, 30, 30, 30]],
  ];
  for (const [total, on20, on25] of table) {
    assert.deepEqual(planSegmentDurations(total, 15), on20, `${total}s on L=15`);
    assert.deepEqual(planSegmentDurations(total, 30), on25, `${total}s on L=30`);
  }
  assert.deepEqual(planSegmentDurations(2, 30), [4], 'never below the minimum');
});

await test('timecoded briefs: user segments kept; only a segment longer than L is split, never truncated', () => {
  const brief = (lengths: number[]) => {
    let cursor = 0;
    return lengths.map((length, index) => {
      const shot = { title: `seg${index + 1}`, duration: length, storyBeat: `第一句。第二句。第三句。`, timecodeStart: cursor, timecodeEnd: cursor + length };
      cursor += length;
      return shot;
    });
  };
  const lengths = [8, 20, 30, 40];
  const on20 = splitLongShots(brief(lengths), 15);
  const on25 = splitLongShots(brief(lengths), 30);
  assert.deepEqual(on20.map((shot) => shot.duration), [8, 10, 10, 15, 15, 14, 13, 13]);
  assert.deepEqual(on25.map((shot) => shot.duration), [8, 20, 30, 20, 20]);
  for (const shots of [on20, on25]) {
    assert.equal(shots.reduce((sum, shot) => sum + (shot.duration ?? 0), 0), 98, 'the total is kept');
    shots.forEach((shot, index) => {
      if (index > 0) assert.equal(shot.timecodeStart, shots[index - 1]!.timecodeEnd, 'parts stay contiguous');
    });
  }
  const parts = on20.filter((shot) => shot.title?.startsWith('seg2'));
  assert.deepEqual(parts.map((shot) => shot.title), ['seg2 (1/2)', 'seg2 (2/2)']);
  assert.equal(parts[1]!.transitionKind, 'cut', 'parts of one segment join with a plain cut');
  assert.match(parts[1]!.continuity ?? '', /Continues the previous part/);
  assert.notEqual(parts[0]!.storyBeat, parts[1]!.storyBeat, 'the beat is divided at sentence boundaries');
});

await test('routing: a stated length up to L is one clip; longer is a long video (offer threshold = L)', async () => {
  const thirty = '帮我做一段 30 秒的视频，小猫在屋顶看日出';
  const fortyFive = '帮我做一段 45 秒的视频，小猫在屋顶看日出';
  const twenty = '帮我做一段 20 秒的视频，小猫在屋顶看日出';
  assert.equal(looksLikeSagaRequest(thirty, 30), false, '30 s on 2.5: one clip');
  assert.equal(looksLikeSagaRequest(fortyFive, 30), true, '45 s on 2.5: long video');
  assert.equal(looksLikeSagaRequest(thirty, 15), true, '30 s on 2.0: long video');
  assert.equal(looksLikeSagaRequest(twenty, 15), true, '20 s on 2.0: long video');
  assert.equal(looksLikeSagaRequest('做一段 15 秒的长视频，讲雨夜', 15), false, 'a length that fits wins over the word 长视频');
  assert.equal(looksLikeSagaRequest(thirty), false, 'without L the old one-minute bar applies');
  assert.equal(looksLikeSagaRequest('帮我生成一段长视频，讲雨夜', 30), true, 'no length stated: long wording decides');
  assert.equal(looksLikeSagaRequest('[0-8秒] 城市清晨，主角醒来\n[8-16秒] 主角出门，镜头跟随', 30), true, 'a timecoded brief keeps its segments');
  assert.equal((await routeWorkflow({ text: thirty, maxClipSeconds: 30 })).workflow, 'direct');
  assert.equal((await routeWorkflow({ text: fortyFive, maxClipSeconds: 30 })).workflow, 'saga');
  assert.deepEqual(classifyVideoRequestLength(thirty, 30), { kind: 'single', seconds: 30 });
  assert.deepEqual(classifyVideoRequestLength(fortyFive, 30), { kind: 'long', seconds: 45 });
  assert.equal(classifyVideoRequestLength('帮我做一个小猫跳舞的视频', 30).kind, 'unknown');

  const on25 = await workspace(SEEDANCE_25);
  const on20 = await workspace(SEEDANCE_20);
  const declared = await workspace(SEEDANCE_20, { maxClipSeconds: 30 });
  assert.equal(await resolveActiveVideoClipSeconds(on25), 30);
  assert.equal(await resolveActiveVideoClipSeconds(on20), 15);
  assert.equal(await resolveActiveVideoClipSeconds(declared), 30, 'the platform declaration wins');
  const offer = (cwd: string, text: string) => offerSagaLongVideoWorkflow({ scope: 'cli', key: `${cwd}-${text}`, cwd, text, locale: 'zh-CN' });
  assert.equal(await offer(on25, thirty), undefined, '30 s on 2.5: no long-video offer');
  assert.ok(await offer(on25, fortyFive), '45 s on 2.5: offered');
  assert.ok(await offer(on20, thirty), '30 s on 2.0: offered');
  assert.equal(await offer(declared, thirty), undefined, 'declared 30 s clips: no offer');
});

await test('long-video wizard: the segment cap and duration choices state L (zh + en)', async () => {
  for (const [model, L, segmentsPerMinute] of [[SEEDANCE_20, 15, 4], [SEEDANCE_25, 30, 2]] as const) {
    const cwd = await workspace(model);
    for (const locale of ['zh-CN', 'en'] as const) {
      const key = `wizard-${model}-${locale}`;
      const say = async (text: string, forceIntent = false) => {
        const outcome = await handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text, locale, forceIntent });
        assert.equal(outcome.handled, true, text);
        return outcome.handled ? outcome.reply : '';
      };
      await say(locale === 'zh-CN' ? '一只小猫在雨夜的城市里冒险' : 'A kitten explores a rainy city', true);
      await say('2');
      await say(locale === 'zh-CN' ? '开始生成' : 'start');
      await say('1');
      const durationStep = await say('1');
      plain(durationStep, `duration step ${model} ${locale}`);
      if (locale === 'zh-CN') {
        assert.match(durationStep, new RegExp(`每段画面最长 ${L} 秒`));
        assert.match(durationStep, new RegExp(`"1分钟"（约 ${segmentsPerMinute} 段）`));
        assert.match(durationStep, /"2分钟"（约 \d+ 段）/);
      } else {
        assert.match(durationStep, new RegExp(`Each segment can be up to ${L}s`));
        assert.match(durationStep, new RegExp(`"1 minute" \\(about ${segmentsPerMinute} segments\\)`));
      }
      await say(locale === 'zh-CN' ? '取消' : 'cancel');
    }
  }
  // A long video is longer than one clip: on 30 s clips the examples start at a minute.
  assert.deepEqual(longVideoDurationChoices(30), [{ seconds: 60, segments: 2 }, { seconds: 90, segments: 3 }, { seconds: 120, segments: 4 }, { seconds: 180, segments: 6 }]);
  assert.deepEqual(longVideoDurationChoices(15).map((choice) => choice.seconds), [30, 60, 90, 120]);
  assert.deepEqual(longVideoDurationChoices(15).map((choice) => choice.segments), [2, 4, 6, 8]);
});

await test('long-video wizard: speech-rate warnings use the clips that will be generated', async () => {
  const cwd = await workspace(SEEDANCE_20);
  const key = 'speech-rate';
  // About 70 characters: some 14 s of speech, more than one 10 s clip holds.
  const line = '“今天的雨好大呀，我们要不要先找个安静的地方躲一躲，等雨停了以后再一起出发，沿着那条长长的小巷走到最高的屋顶上去看日出，好不好呀？”';
  const brief = `主体模式：有主角。身份来源：纯文字。\n[0-20秒] 小猫说：${line}\n[20-28秒] 小猫跳上屋顶。`;
  await handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text: brief, locale: 'zh-CN', forceIntent: true });
  await handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text: '开始生成', locale: 'zh-CN' });
  await handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text: '1', locale: 'zh-CN' });
  const step = await handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text: '1', locale: 'zh-CN' });
  const reply = step.handled ? step.reply : '';
  // A 20 s segment on 15 s clips is two 10 s clips; the whole line sits in the first.
  assert.match(reply, /段 1 第 1\/2 部分（10 秒）的对白/, reply);
  assert.doesNotMatch(reply, /段 1 第 2\/2 部分/, 'the line is not repeated in the second part');
});

await test('single-clip wizard: lengths offered follow the model', async () => {
  assert.deepEqual(singleClipChoices(resolveVideoModelProfile('byteplus', SEEDANCE_20)), [4, 5, 10, 15]);
  assert.deepEqual(singleClipChoices(resolveVideoModelProfile('byteplus', SEEDANCE_25)), [5, 10, 15, 20, 30]);
  const cwd = await workspace(SEEDANCE_25);
  const key = 'single-clip-25';
  await handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text: '生成一个赛博朋克产品发布视频', locale: 'zh-CN' });
  const duration = await handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text: '直接生成', locale: 'zh-CN' });
  assert.equal(duration.handled, true);
  assert.match(duration.handled ? duration.reply : '', /5、10、15、20、30 秒/);
  const chosen = await handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text: '30', locale: 'zh-CN' });
  assert.equal(chosen.handled, false);
  assert.match(chosen.handled ? '' : chosen.prompt ?? '', /duration: 30/);
  assert.match(chosen.handled ? '' : chosen.prompt ?? '', new RegExp(`model "${SEEDANCE_25}"`));
});

await test('headless --intent video: single clip, long video or one length question, on L=15 and L=30', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'artemis-video-intent-'));
  const store = new SessionStore(cwd);
  for (const L of [15, 30]) {
    const base = {
      cwd, attachmentCount: 0, inCodeRepo: false, autoRoute: true, intent: 'video',
      getClassifier: async () => undefined, hasVideoProvider: async () => true, videoClipSeconds: async () => L,
    };
    const fresh = () => store.createSession({ title: `video ${L}` });
    // A stated length up to L: one plain clip, no question, no long video.
    const short = await planHeadlessWorkflow({ ...base, session: fresh(), prompt: '帮我做一段10秒的小猫跳舞视频' });
    assert.equal(short.kind === 'run' && short.workflow, 'direct', `10 s on L=${L}`);
    assert.match(short.kind === 'run' ? short.hint : '', /ONE video clip with generate_video \(duration: 10\)/);
    assert.equal(short.kind === 'run' && short.prompt, '帮我做一段10秒的小猫跳舞视频', 'the stored message is the user’s text');
    // 30 s: one clip on 2.5, a long video (no confirmation) on 2.0.
    const thirty = await planHeadlessWorkflow({ ...base, session: fresh(), prompt: '帮我做一段30秒的小猫跳舞视频' });
    assert.equal(thirty.kind, 'run', 'never the long-video question: the user chose video');
    assert.equal(thirty.kind === 'run' && thirty.workflow, L >= 30 ? 'direct' : 'saga', `30 s on L=${L}`);
    // A timecoded brief with two segments: a long video directly.
    const brief = await planHeadlessWorkflow({ ...base, session: fresh(), prompt: '[0-5秒] 城市清晨\n[5-10秒] 主角出门' });
    assert.equal(brief.kind === 'run' && brief.workflow, 'saga', `two timecoded segments on L=${L}`);
    // No length: ask once, with lengths derived from L.
    const session = fresh();
    const question = await planHeadlessWorkflow({ ...base, session, prompt: '帮我做一个小猫跳舞的视频' });
    assert.equal(question.kind, 'reply');
    const reply = question.kind === 'reply' ? question.reply : '';
    plain(reply, `length question L=${L}`);
    const labels = videoLengthChoices(L, true).map((choice) => choice.label);
    assert.deepEqual(labels, L === 30 ? ['5 秒', '10 秒', '30 秒', '1 分钟', '更长，我来说'] : ['5 秒', '10 秒', '15 秒', '30 秒', '1 分钟']);
    assert.ok(reply.includes(`\`\`\`choices\n${JSON.stringify({ options: labels })}\n\`\`\``), reply);
    const answerTen = await planHeadlessWorkflow({ ...base, session, prompt: '10 秒' });
    assert.equal(answerTen.kind === 'run' && answerTen.workflow, 'direct');
    assert.equal(answerTen.kind === 'run' && answerTen.prompt, '10 秒', 'the stored message is the answer as typed');
    assert.match(answerTen.kind === 'run' ? answerTen.hint : '', /Their request: 帮我做一个小猫跳舞的视频/);
    const again = fresh();
    await planHeadlessWorkflow({ ...base, session: again, prompt: '帮我做一个小猫跳舞的视频' });
    const answerMinute = await planHeadlessWorkflow({ ...base, intent: undefined, session: again, prompt: '1 分钟' });
    assert.equal(answerMinute.kind === 'run' && answerMinute.workflow, 'saga', 'a minute is a long video, without the confirmation question');
    assert.match(answerMinute.kind === 'run' ? answerMinute.hint : '', /60-second video for their previous request/);
    const third = fresh();
    await planHeadlessWorkflow({ ...base, session: third, prompt: '帮我做一个小猫跳舞的视频' });
    // A typed bare number is seconds, never a button index: "5" is a 5 s clip.
    const five = await planHeadlessWorkflow({ ...base, intent: undefined, session: third, prompt: '5' });
    assert.equal(five.kind === 'run' && five.workflow, 'direct', `"5" on L=${L} is one 5 s clip`);
    assert.match(five.kind === 'run' ? five.hint : '', /duration: 5\)/);
    for (const [reply, seconds] of [['20', 20], ['半分钟', 30], ['一分两秒', 62], ['30 秒', 30]] as const) {
      const session = fresh();
      await planHeadlessWorkflow({ ...base, session, prompt: '帮我做一个小猫跳舞的视频' });
      const plan = await planHeadlessWorkflow({ ...base, intent: undefined, session, prompt: reply });
      assert.equal(plan.kind === 'run' && plan.workflow, seconds <= L ? 'direct' : 'saga', `"${reply}" on L=${L}`);
    }
    // Not a length: asked once more (the question stays), then the answer counts.
    const unclear = fresh();
    await planHeadlessWorkflow({ ...base, session: unclear, prompt: '帮我做一个小猫跳舞的视频' });
    const retry = await planHeadlessWorkflow({ ...base, intent: undefined, session: unclear, prompt: '嗯' });
    assert.equal(retry.kind, 'reply', 'an unclear answer is asked again, not run as a prompt');
    plain(retry.kind === 'reply' ? retry.reply : '', `length retry L=${L}`);
    const afterRetry = await planHeadlessWorkflow({ ...base, intent: undefined, session: unclear, prompt: '10' });
    assert.equal(afterRetry.kind === 'run' && afterRetry.workflow, 'direct');
    assert.match(afterRetry.kind === 'run' ? afterRetry.hint : '', /Their request: 帮我做一个小猫跳舞的视频/);
    // "不用了" / "cancel": the question ends with a short acknowledgement.
    for (const cancel of ['不用了', 'cancel', '取消']) {
      const session = fresh();
      await planHeadlessWorkflow({ ...base, session, prompt: '帮我做一个小猫跳舞的视频' });
      const reply = await planHeadlessWorkflow({ ...base, intent: undefined, session, prompt: cancel });
      assert.equal(reply.kind, 'reply', cancel);
      plain(reply.kind === 'reply' ? reply.reply : '', `cancel ${cancel}`);
      assert.equal((session.metadata?.workflowRouting as { videoLengthQuestion?: unknown } | undefined)?.videoLengthQuestion, undefined, 'the question is gone');
    }
    // A reply with real content is a new request, handled as usual.
    const freshRequest = fresh();
    await planHeadlessWorkflow({ ...base, session: freshRequest, prompt: '帮我做一个小猫跳舞的视频' });
    const weather = await planHeadlessWorkflow({ ...base, intent: undefined, session: freshRequest, prompt: '帮我查一下明天上海的天气怎么样' });
    assert.equal(weather.kind === 'run' && weather.workflow, 'direct');
    assert.equal(weather.kind === 'run' && weather.prompt, '帮我查一下明天上海的天气怎么样');
    assert.doesNotMatch(weather.kind === 'run' ? weather.hint : '', /generate_video/, 'not treated as the video answer');
    assert.equal((freshRequest.metadata?.workflowRouting as { videoLengthQuestion?: unknown } | undefined)?.videoLengthQuestion, undefined);
    // With a sticky --intent video, two unclear replies never loop or replace the request.
    const sticky = fresh();
    await planHeadlessWorkflow({ ...base, session: sticky, prompt: '帮我做一个小猫跳舞的视频' });
    const first = await planHeadlessWorkflow({ ...base, session: sticky, prompt: '嗯' });
    assert.equal(first.kind, 'reply');
    assert.equal((sticky.metadata?.workflowRouting as { videoLengthQuestion?: { text?: string } } | undefined)?.videoLengthQuestion?.text, '帮我做一个小猫跳舞的视频', 'the original request is kept');
    const second = await planHeadlessWorkflow({ ...base, session: sticky, prompt: '嗯' });
    assert.equal(second.kind, 'reply');
    assert.equal((sticky.metadata?.workflowRouting as { videoLengthQuestion?: unknown } | undefined)?.videoLengthQuestion, undefined, 'no third question');
    assert.doesNotMatch(second.kind === 'reply' ? second.reply : '', /```choices/);
    // A length far above the choices is confirmed once, then clamped.
    const huge = fresh();
    await planHeadlessWorkflow({ ...base, session: huge, prompt: '帮我做一个小猫跳舞的视频' });
    const confirm = await planHeadlessWorkflow({ ...base, intent: undefined, session: huge, prompt: '999' });
    assert.equal(confirm.kind, 'reply');
    assert.match(confirm.kind === 'reply' ? confirm.reply : '', /要做 10 分钟这么长吗？/);
    plain(confirm.kind === 'reply' ? confirm.reply : '', 'long confirmation');
    const go = await planHeadlessWorkflow({ ...base, intent: undefined, session: huge, prompt: '好，开始' });
    assert.equal(go.kind === 'run' && go.workflow, 'saga');
    assert.match(go.kind === 'run' ? go.hint : '', /600-second video/);
    // A read-only run leaves the question waiting.
    const waiting = fresh();
    await planHeadlessWorkflow({ ...base, session: waiting, prompt: '帮我做一个小猫跳舞的视频' });
    const readOnly = await planHeadlessWorkflow({ ...base, intent: undefined, autoRoute: false, session: waiting, prompt: '10' });
    assert.equal(readOnly.kind === 'run' && readOnly.workflow, 'direct');
    assert.equal(readOnly.kind === 'run' && readOnly.hint, '', 'no video hint on a read-only run');
    assert.ok((waiting.metadata?.workflowRouting as { videoLengthQuestion?: unknown; sagaActiveAt?: unknown } | undefined)?.videoLengthQuestion, 'the question is still pending');
    assert.equal((waiting.metadata?.workflowRouting as { sagaActiveAt?: unknown } | undefined)?.sagaActiveAt, undefined);
    if (L === 30) {
      const longer = fresh();
      await planHeadlessWorkflow({ ...base, session: longer, prompt: '帮我做一个小猫跳舞的视频' });
      const answer = await planHeadlessWorkflow({ ...base, intent: undefined, session: longer, prompt: '更长，我来说' });
      assert.equal(answer.kind === 'run' && answer.workflow, 'saga');
    }
    // long_video stays an alias that forces the long-video workflow.
    const forced = await planHeadlessWorkflow({ ...base, intent: 'long_video', session: fresh(), prompt: '帮我做一段10秒的小猫视频' });
    assert.equal(forced.kind === 'run' && forced.workflow, 'saga');
  }
});

await test('generation: 60 s on 30 s clips is two 30 s segments; a 20 s timecoded segment on 15 s clips is split, not cut', async () => {
  const long = await runHermeticSaga(
    // The one full render of this file: draft quality keeps it quick.
    { prompt: 'A kitten crosses a rainy city at night and reaches a rooftop at dawn.', totalDuration: 60, ratio: '9:16', generateAudio: false, quality: 'draft' },
    { videoCapabilities: { maxClipSeconds: 30 } },
  );
  assert.equal(long.result.ok, true, long.result.output);
  assert.deepEqual(videoTaskBodies(long.requests).map((body) => body.duration), [30, 30]);
  assert.ok(long.logs.some((line) => /第 2\/2 段/.test(line)), 'progress counts the real plan');

  const brief = '[0-20秒] 镜头1：小猫在雨里奔跑。它跳过水坑。它停在路灯下。\n[20-28秒] 镜头2：小猫跳上屋顶。';
  const timed = await runHermeticSaga({ prompt: brief, story: brief, totalDuration: 28, ratio: '9:16', generateAudio: false, identitySource: 'text_only' }, { render: false });
  assert.equal(timed.result.ok, true, timed.result.output);
  assert.deepEqual(videoTaskBodies(timed.requests).map((body) => body.duration), [10, 10, 8], 'every written second is generated');
  assert.ok(timed.logs.some((line) => /单段上限 15 秒/.test(line)), 'the split is reported');
});


await test('tier ids: dated, router-style and 2.0 ids resolve to their family and L; the platform declaration wins', async () => {
  for (const id of ['dreamina-seedance-2-5-260901', 'dreamina-seedance-2.5', 'dreamina-seedance-2-5', 'Dreamina-Seedance-2.5-Pro']) {
    const profile = resolveVideoModelProfile('byteplus', id);
    assert.equal(profile.family, 'seedance-2.5', id);
    assert.equal(profile.maxClipSeconds, 30, id);
    assert.equal(resolveVideoModelLimits('byteplus', id).maxSegmentSeconds, 30, id);
    assert.equal(normalizeVideoDurationForProvider(45, 'byteplus', id), 30, `${id}: no clip above L`);
  }
  for (const id of [SEEDANCE_20, 'dreamina-seedance-2.0', 'dreamina-seedance-2-0']) {
    const profile = resolveVideoModelProfile('byteplus', id);
    assert.equal(profile.family, 'seedance-2.0', id);
    assert.equal(profile.maxClipSeconds, 15, id);
    assert.equal(normalizeVideoDurationForProvider(30, 'byteplus', id), 15, `${id}: no clip above L`);
  }
  // A declaration scoped to the router-style id applies to it, one scoped to another model does not.
  assert.equal(resolveVideoModelProfile('byteplus', 'dreamina-seedance-2.5', { model: 'dreamina-seedance-2.5', maxClipSeconds: 20 }).maxClipSeconds, 20);
  assert.equal(resolveVideoModelProfile('byteplus', 'dreamina-seedance-2.5', { model: SEEDANCE_20, maxClipSeconds: 15 }).maxClipSeconds, 30);
  assert.equal(normalizeVideoDurationForProvider(30, 'byteplus', 'dreamina-seedance-2.5', { model: 'dreamina-seedance-2.5', maxClipSeconds: 20 }), 20);
  assert.equal(await resolveActiveVideoClipSeconds(await workspace('dreamina-seedance-2.5')), 30, 'router-style id configured');
  assert.equal(await resolveActiveVideoClipSeconds(await workspace('dreamina-seedance-2.5', { model: 'dreamina-seedance-2.5', maxClipSeconds: 20 })), 20, 'declared for it');
  assert.equal(await resolveActiveVideoClipSeconds(await workspace('dreamina-seedance-2.5', { model: SEEDANCE_20, maxClipSeconds: 15 })), 30, 'a declaration left over from the previous model is ignored');
});

await test('just above L: two segments, not more; up to L stays one clip', async () => {
  for (const L of [15, 30]) {
    assert.equal(segmentCountFor(L, L), 1, `${L}s on L=${L}`);
    assert.equal(segmentCountFor(L + 1, L), 2, `${L + 1}s on L=${L}`);
    assert.deepEqual(planSegmentDurations(L + 1, L), [Math.ceil((L + 1) / 2), Math.floor((L + 1) / 2)]);
    assert.equal(segmentCountFor(2 * L, L), 2, `${2 * L}s on L=${L}`);
    assert.deepEqual(classifyVideoRequestLength(`帮我做一段 ${L} 秒的视频，小猫在屋顶看日出`, L), { kind: 'single', seconds: L });
    assert.deepEqual(classifyVideoRequestLength(`帮我做一段 ${L + 1} 秒的视频，小猫在屋顶看日出`, L), { kind: 'long', seconds: L + 1 });
    // Natural shots just above L pack into two clips.
    const shots = [8, 8, 8, L + 1 - 24].filter((value) => value > 0).map((duration, index) => ({ title: `s${index + 1}`, duration, storyBeat: `beat ${index + 1}.` }));
    if (L === 30) assert.equal(packShotsIntoClips(shots, L).length, 2, '31 s of shots on L=30');
  }
  const cwd = await workspace(SEEDANCE_25);
  const key = 'just-above-L';
  const say = async (text: string, forceIntent = false) => {
    const outcome = await handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text, locale: 'zh-CN', forceIntent });
    return outcome.handled ? outcome.reply : '';
  };
  await say('做一段 31 秒的视频：一只小猫在雨夜的城市里冒险', true);
  await say('2');
  await say('开始生成');
  await say('1');
  const durationStep = await say('1');
  assert.match(durationStep, /识别到 31 秒（约 2 段）/, durationStep);
  await say('取消');
});

await test('cinematic shot planning: natural shots packed into as few clips as fit, more clips on L=15', () => {
  const natural = [6, 8, 5, 9, 7, 10, 6, 9];
  const shots = natural.map((duration, index) => ({
    title: `Shot ${index + 1}`,
    duration,
    storyBeat: `0–2s: beat ${index + 1} starts. 2s–end: beat ${index + 1} resolves.`,
    camera: index % 2 ? 'close-up' : 'wide',
  }));
  const on30 = packShotsIntoClips(shots, 30);
  const on15 = packShotsIntoClips(shots, 15);
  for (const [clips, L] of [[on30, 30], [on15, 15]] as const) {
    assert.equal(clips.reduce((sum, clip) => sum + (clip.duration ?? 0), 0), 60, `L=${L}: total kept`);
    assert.ok(clips.every((clip) => (clip.duration ?? 0) <= L && (clip.duration ?? 0) >= 4), `L=${L}: every clip within 4..L (${clips.map((clip) => clip.duration)})`);
    const beats = clips.map((clip) => clip.storyBeat).join(' ');
    natural.forEach((_, index) => assert.match(beats, new RegExp(`beat ${index + 1} starts`), `L=${L}: shot ${index + 1} kept`));
  }
  assert.deepEqual(on30.map((clip) => clip.duration), [30, 30], `as many clips as 60 s takes on L=30, not one more (${on30.map((clip) => clip.duration)})`);
  assert.deepEqual(on15.map((clip) => clip.duration), [15, 15, 15, 15], `L=15 (${on15.map((clip) => clip.duration)})`);
  assert.ok(on15.length > on30.length, 'the same story takes more clips on L=15');
  assert.ok(on30.length < shots.length, 'not one clip per shot');
  // Inside a packed clip each shot keeps its own length, framing and timeline.
  const first = on30[0]!;
  assert.match(first.storyBeat ?? '', /Shot 1 \(0–6s, wide\): 0–2s: beat 1 starts\. 2–6s: beat 1 resolves\./);
  assert.match(first.storyBeat ?? '', /Hard cut to Shot 2 \(6–14s, close-up\): 6–8s: beat 2 starts\. 8–14s: beat 2 resolves\./);
  assert.match(first.storyBeat ?? '', /same characters, wardrobe, props, place and light/);
  // Not 30-second monolithic shots: no packed shot is longer than its natural length.
  assert.doesNotMatch(on30.map((clip) => clip.storyBeat).join(' '), /\(0–30s/);
  // A shot that opens with a fade or a shader transition starts a new clip.
  const withFade = shots.map((shot, index) => (index === 2 ? { ...shot, transitionKind: 'fade-black' } : shot));
  const faded = packShotsIntoClips(withFade, 30);
  assert.equal(faded[1]!.transitionKind, 'fade-black');
  assert.match(faded[1]!.storyBeat ?? '', /beat 3 starts/);
  assert.doesNotMatch(faded[0]!.storyBeat ?? '', /beat 3/);
  // A user timeline, shots without a length, or a shot above L are left as they are.
  const timed = shots.map((shot, index) => ({ ...shot, timecodeStart: index * 10, timecodeEnd: index * 10 + 10 }));
  assert.equal(packShotsIntoClips(timed, 30).length, timed.length);
  assert.equal(packShotsIntoClips([{ title: 'a', storyBeat: 'x' }, { title: 'b', storyBeat: 'y' }], 30).length, 2);
  assert.equal(offsetBeatTimeline('0–3s: a. 3-7 s: b. 7s–end: c. 2.5–4秒：d。3-4 people wait.', 10, 12), '10–13s: a. 13–17s: b. 17–22s: c. 12.5–14秒：d。3-4 people wait.');
  // Only a timeline position moves: not a pause length or a decade.
  assert.equal(offsetBeatTimeline('0–4s: she waits, a 5-10s pause. Set in the 1990-2000s. 4s–end: she runs.', 10, 8), '10–14s: she waits, a 5-10s pause. Set in the 1990-2000s. 14–18s: she runs.');
  // A shot whose length was adjusted to fit the clip keeps its timeline inside it, in whole seconds.
  assert.equal(offsetBeatTimeline('0–2s: a. 2s–end: b.', 20, 10, { scale: 10 / 9 }), '20–22s: a. 22–30s: b.');
});

await test('cinematic generation: natural shots render in fewer clips on L=30; a long fallback clip is several shots', async () => {
  const natural = [6, 8, 5, 9, 7, 10, 6, 9];
  const shots = natural.map((duration, index) => ({
    title: `Shot ${index + 1}`,
    duration,
    storyBeat: `0–2s: the kitten ${['runs', 'leaps', 'pauses', 'climbs', 'turns', 'sprints', 'sits', 'looks up'][index]} in the rain. 2s–end: it moves on through the alley.`,
    visualPrompt: `Rainy alley at night, kitten, shot ${index + 1}`,
    camera: index % 2 ? 'close-up' : 'wide tracking',
  }));
  const action = { prompt: 'A kitten crosses a rainy city at night.', story: 'A kitten crosses a rainy city at night.', totalDuration: 60, ratio: '16:9', generateAudio: false, identitySource: 'text_only', shots };
  const on25 = await runHermeticSaga(action, { videoModel: 'dreamina-seedance-2.5', render: false });
  assert.equal(on25.result.ok, true, on25.result.output);
  const durations25 = videoTaskBodies(on25.requests).map((body) => body.duration);
  assert.equal(durations25.length, 2, `two clips on L=30, as 60 s takes (${durations25})`);
  assert.ok(durations25.every((value) => value <= 30));
  assert.equal(durations25.reduce((sum, value) => sum + value, 0), 60);
  const text25 = JSON.stringify(videoTaskBodies(on25.requests)[0]);
  assert.match(text25, /Hard cut to Shot 2/, 'the clip is cut inside');
  const on20 = await runHermeticSaga(action, { render: false });
  const durations20 = videoTaskBodies(on20.requests).map((body) => body.duration);
  assert.ok(durations20.length > durations25.length, `more clips on L=15 (${durations20})`);
  assert.ok(durations20.every((value) => value <= 15));
  assert.equal(durations20.reduce((sum, value) => sum + value, 0), 60);

  // No planned shots: two 30 s clips, each written as several camera shots, not one held take.
  const fallback = await runHermeticSaga(
    { prompt: 'A kitten crosses a rainy city at night. It reaches a rooftop. The sun rises over the roofs. It curls up and sleeps.', totalDuration: 60, ratio: '16:9', generateAudio: false },
    { videoModel: SEEDANCE_25, render: false },
  );
  assert.equal(fallback.result.ok, true, fallback.result.output);
  assert.deepEqual(videoTaskBodies(fallback.requests).map((body) => body.duration), [30, 30]);
  assert.match(JSON.stringify(videoTaskBodies(fallback.requests)[0]), /3 camera shots joined by hard cuts/);
});

await test('Saga plan prompt: natural shot lengths, clips up to the current L (zh, L=30 and L=15)', async () => {
  for (const [model, L] of [[SEEDANCE_25, 30], [SEEDANCE_20, 15]] as const) {
    const cwd = await workspace(model);
    const key = `plan-${model}`;
    const say = (text: string, forceIntent = false) => handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text, locale: 'zh-CN', forceIntent });
    await say('一只小猫在雨夜的城市里冒险，最后在屋顶看日出', true);
    await say('2');
    await say('开始生成');
    await say('1');
    await say('1');
    await say('60秒');
    const done = await say('不加');
    assert.equal(done.handled, false);
    const prompt = done.handled ? '' : done.prompt ?? '';
    assert.match(prompt, /SHOT LENGTHS — Cut like an editor/);
    assert.match(prompt, new RegExp(`usually 4–15 s`));
    assert.match(prompt, new RegExp(`clips of up to ${L} s with hard cuts inside them, ${segmentCountFor(60, L)} clips for 60 s`));
    assert.match(prompt, new RegExp(`never write a shot longer than ${L} s`));
    assert.doesNotMatch(prompt, /roughly equal length/, 'no clock-cut shots');
  }
});

await test('model change mid-wizard: L is read again; menus, counts, speech checks and the plan follow the new model', async () => {
  const cwd = await workspace(SEEDANCE_25);
  const key = 'tier-change';
  const say = async (text: string, forceIntent = false) => {
    const outcome = await handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text, locale: 'zh-CN', forceIntent });
    return outcome;
  };
  const line = '“今天的雨好大呀，我们要不要先找个安静的地方躲一躲，等雨停了以后再一起出发，沿着那条长长的小巷走到最高的屋顶上去看日出，好不好呀？”';
  await say(`主体模式：有主角。身份来源：纯文字。\n[0-20秒] 小猫说：${line}\n[20-28秒] 小猫跳上屋顶。`, true);
  await say('开始生成');
  await say('1');
  const on30 = await say('1');
  const reply30 = on30.handled ? on30.reply : '';
  assert.match(reply30, /每段画面最长 30 秒/);
  assert.doesNotMatch(reply30, /语速提示/, 'a 20 s segment holds the line on L=30');
  // The tier moves to the 15 s model while the wizard waits.
  await configureVideo(cwd, SEEDANCE_20);
  const on15 = await say('嗯');
  const reply15 = on15.handled ? on15.reply : '';
  plain(reply15, 'tier change note');
  assert.match(reply15, /每段画面最长 15 秒（之前 30 秒）/);
  assert.match(reply15, /每段画面最长 15 秒，我会按需要/);
  assert.match(reply15, /"1分钟"（约 4 段）/);
  assert.match(reply15, /段 1 第 1\/2 部分（10 秒）的对白/, 'speech rate is checked against the clips the new model makes');
  await say('28秒');
  const done = await say('不加');
  assert.equal(done.handled, false);
  const prompt = done.handled ? '' : done.prompt ?? '';
  assert.match(prompt, /clips of up to 15 s/);
  assert.doesNotMatch(prompt, /at most 30 s/, 'nothing planned above the new L');
});


await test('single-clip wizard: a model change mid-wizard re-reads the lengths and the model', async () => {
  const cwd = await workspace(SEEDANCE_25);
  const key = 'single-clip-tier-change';
  await handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text: '生成一个赛博朋克产品发布视频', locale: 'zh-CN' });
  const ask = await handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text: '直接生成', locale: 'zh-CN' });
  assert.match(ask.handled ? ask.reply : '', /5、10、15、20、30 秒/);
  await configureVideo(cwd, SEEDANCE_20);
  const refused = await handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text: '30', locale: 'zh-CN' });
  assert.equal(refused.handled, true, '30 s is no longer one clip');
  assert.match(refused.handled ? refused.reply : '', /4、5、10、15 秒/);
  const chosen = await handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text: '15', locale: 'zh-CN' });
  assert.equal(chosen.handled, false);
  const prompt = chosen.handled ? '' : chosen.prompt ?? '';
  assert.match(prompt, /duration: 15/);
  assert.match(prompt, new RegExp(`model "${SEEDANCE_20}"`), 'the clip is made with the model configured now');
});

/** Eight planned shots with a marker, a long action and a spoken line each (about 600 characters of text per shot). */
function dialogueShots(extra: (index: number) => string = () => ''): Array<Record<string, unknown>> {
  const natural = [6, 8, 5, 9, 7, 10, 6, 9];
  const verbs = ['runs', 'leaps', 'pauses', 'climbs', 'turns', 'sprints', 'sits', 'looks up'];
  return natural.map((duration, index) => ({
    title: `Shot ${index + 1}`,
    duration,
    storyBeat: `MARK${index + 1}: 0–2s: Mira ${verbs[index]} through the rain-soaked market, her red scarf whipping in the wind as lanterns sway overhead and puddles shatter under her boots.${extra(index)} 2–4s: she glances back over her shoulder at the crowd, breath fogging in the cold air, one hand gripping the brass key on its cord. 4s–end: Mira says: “Line number ${index + 1}, we have to keep moving before the bell tower rings again.” She pushes on through the alley.`,
    visualPrompt: `Rainy night market, neon reflections on wet cobblestones, Mira in a red scarf and long grey coat, shot ${index + 1}, shallow depth of field, anamorphic flare, 35mm lens, volumetric haze, lanterns swaying.`,
    camera: index % 2 ? 'close-up handheld follow' : 'wide tracking dolly',
  }));
}

function bodyTexts(requests: Parameters<typeof videoTaskBodies>[0]): string[] {
  return videoTaskBodies(requests).map((body) => (body.content as Array<{ type: string; text?: string }>).filter((item) => item.type === 'text').map((item) => item.text ?? '').join('\n'));
}

await test('packed clips keep every shot: each marker and spoken line reaches the request (L=30 and L=15)', async () => {
  const shots = dialogueShots();
  const action = { prompt: 'Mira crosses a rainy night market.', story: 'Mira crosses a rainy night market.', totalDuration: 60, ratio: '16:9', generateAudio: true, identitySource: 'text_only', shots };
  for (const [model, L, clips] of [[SEEDANCE_25, 30, 2], [SEEDANCE_20, 15, 4]] as const) {
    const run = await runHermeticSaga(action, { videoModel: model, render: false });
    assert.equal(run.result.ok, true, run.result.output);
    const bodies = videoTaskBodies(run.requests);
    assert.equal(bodies.length, clips, `L=${L}: ${bodies.map((body) => body.duration)}`);
    assert.ok(bodies.every((body) => body.duration <= L));
    const texts = bodyTexts(run.requests);
    for (let shot = 1; shot <= 8; shot += 1) {
      const holder = texts.findIndex((text) => text.includes(`MARK${shot}:`));
      assert.ok(holder >= 0, `L=${L}: shot ${shot}'s marker reaches a request`);
      assert.ok(texts[holder]!.includes(`Line number ${shot}, we have to keep moving before the bell tower rings again.`), `L=${L}: shot ${shot}'s line is in the same request`);
    }
    if (L === 30) assert.match(texts[0]!, /Shot 4 \(\d+–30s/, 'clip 1 holds four shots');
  }

  // No planned shots: a 30 s clip is three camera shots, all of them in the request.
  const sentences = Array.from({ length: 24 }, (_, index) => `The kitten crosses street ${index + 1} in the rain, ducking under awnings and leaping over the gutters while neon signs flicker above the wet cobblestones.`);
  const fallback = await runHermeticSaga(
    { prompt: sentences.join(' '), totalDuration: 60, ratio: '16:9', generateAudio: false },
    { videoModel: SEEDANCE_25, render: false },
  );
  assert.equal(fallback.result.ok, true, fallback.result.output);
  assert.deepEqual(videoTaskBodies(fallback.requests).map((body) => body.duration), [30, 30]);
  for (const text of bodyTexts(fallback.requests)) {
    assert.match(text, /3 camera shots joined by hard cuts/);
    assert.match(text, /Shot 1 \(0–10s/);
    assert.match(text, /Hard cut to Shot 2 \(10–20s/);
    assert.match(text, /Hard cut to Shot 3 \(20–30s/, 'the third shot is not cut off');
  }
});

await test('a packed clip opens on its first shot: keyframe and opening framing read only shot 1', async () => {
  // Shots 2 and 5 move rightward; clip 1 opens on shot 1, clip 2 on shot 5.
  const shots = [6, 8, 5, 9, 7, 10, 6, 9].map((duration, index) => ({
    title: `Shot ${index + 1}`,
    duration,
    storyBeat: `MARK${index + 1}: Mira walks through the market.${index === 1 || index === 4 ? ' She is moving rightward across the frame.' : ''} Mira says: “Line ${index + 1}.”`,
    camera: index % 2 ? 'close-up' : 'wide',
  }));
  const run = await runHermeticSaga(
    { prompt: 'Mira crosses a rainy night market.', story: 'Mira crosses a rainy night market.', totalDuration: 60, ratio: '16:9', generateAudio: false, referenceImagePaths: [fixturePng()], shots },
    { videoModel: SEEDANCE_25, render: false },
  );
  assert.equal(run.result.ok, true, run.result.output);
  assert.equal(videoTaskBodies(run.requests).length, 2);
  const keyframes = imageBodies(run.requests).map((body) => JSON.stringify(body)).filter((text) => /MARK\d/.test(text));
  assert.equal(keyframes.length, 2, 'one keyframe per clip');
  assert.match(keyframes[0]!, /MARK1/);
  assert.doesNotMatch(keyframes[0]!, /MARK[2-8]/, 'clip 1\'s keyframe shows shot 1 only');
  assert.doesNotMatch(keyframes[0]!, /RIGHTWARD/, 'a later shot\'s direction is not the opening framing');
  assert.match(keyframes[1]!, /MARK5/);
  assert.doesNotMatch(keyframes[1]!, /MARK[1-46-8]/, 'clip 2\'s keyframe shows shot 5 only');
  assert.match(keyframes[1]!, /RIGHTWARD/, 'the first shot\'s direction is');
  const merged = packShotsIntoClips(shots, 30)[0]!.storyBeat ?? '';
  assert.ok(extractOpeningFramingRegex({ storyBeat: merged, sourceStory: '', shotIndex: 1, shotCount: 2 }).some((cue) => /RIGHTWARD/.test(cue.text)), 'the whole clip would carry shot 2\'s cue');
  assert.ok(!extractOpeningFramingRegex({ storyBeat: openingShotBeat(merged), sourceStory: '', shotIndex: 1, shotCount: 2 }).some((cue) => /RIGHTWARD/.test(cue.text)));
});

await test('no packing: cleanDirect, preserveUserScript, a Shot N script, or a model that does not cut inside a clip', async () => {
  // Two short shots: one clip on L=30 when packed, two when kept as written.
  const shots = dialogueShots().slice(0, 2);
  const base = { prompt: 'Mira crosses a rainy night market.', story: 'Mira crosses a rainy night market.', totalDuration: 14, ratio: '16:9', generateAudio: false, identitySource: 'text_only', shots };
  const packed = await runHermeticSaga(base, { videoModel: SEEDANCE_25, render: false });
  assert.deepEqual(videoTaskBodies(packed.requests).map((body) => body.duration), [14], 'packed when Artemis planned the shots');
  for (const [label, action] of [
    ['cleanDirect', { ...base, cleanDirect: true }],
    ['preserveUserScript', { ...base, preserveUserScript: true }],
    ['Shot N markers', { ...base, story: 'Shot 1: Mira runs. Shot 2: she leaps. Shot 3: she pauses.' }],
    ['镜头N markers', { ...base, story: '镜头1：米拉奔跑。镜头2：她跳起。' }],
    ['第N段 markers', { ...base, story: '第1段：米拉奔跑。第2段：她跳起。' }],
  ] as const) {
    const run = await runHermeticSaga(action, { videoModel: SEEDANCE_25, render: false });
    assert.equal(run.result.ok, true, `${label}: ${run.result.output}`);
    assert.deepEqual(videoTaskBodies(run.requests).map((body) => body.duration), [6, 8], `${label}: one clip per written shot`);
    assert.ok(bodyTexts(run.requests).every((text) => !/Hard cut to Shot 2/.test(text)), `${label}: no shots cut together`);
  }
  // Only the 2.x family cuts inside a clip; anything else does when the platform says so.
  for (const id of [SEEDANCE_25, SEEDANCE_20, 'dreamina-seedance-2.0', 'dreamina-seedance-2.5']) assert.equal(resolveVideoModelProfile('byteplus', id).multiShot, true, id);
  for (const id of ['seedance-1-0-lite-t2v-250428', 'seedance-1-0-pro-250528', 'seedance-1-5-pro-251215', 'wan2.6-i2v', 'some-other-video-model']) {
    assert.equal(resolveVideoModelProfile('byteplus', id).multiShot, false, id);
  }
  assert.equal(resolveVideoModelProfile('byteplus', 'seedance-1-0-pro-250528', { multiShot: true }).multiShot, true, 'declared');
  assert.equal(resolveVideoModelLimits('byteplus', 'seedance-1-0-lite-t2v-250428').multiShot, false);
});

await test('Saga plan prompt: a short or single-shot clip keeps the fewest equal shots (L=12, L=5, no multi-shot)', async () => {
  for (const [label, capabilities, L] of [
    ['L=12', { maxClipSeconds: 12 }, 12],
    ['L=5', { maxClipSeconds: 5 }, 5],
    ['single-shot model', { multiShot: false }, 15],
  ] as const) {
    const cwd = await workspace(SEEDANCE_20, capabilities);
    const key = `plan-short-${label}`;
    const say = (text: string, forceIntent = false) => handleSagaLongVideoWorkflow({ scope: 'cli', key, cwd, text, locale: 'zh-CN', forceIntent });
    await say('一只小猫在雨夜的城市里冒险，最后在屋顶看日出', true);
    await say('2');
    await say('开始生成');
    await say('1');
    await say('1');
    await say('60秒');
    const done = await say('不加');
    assert.equal(done.handled, false, label);
    const prompt = done.handled ? '' : done.prompt ?? '';
    const count = segmentCountFor(60, L);
    assert.match(prompt, new RegExp(`Each shot is ONE generated clip of at most ${L} s\\. Use the fewest shots that fit: ${count} shots of roughly equal length for 60 s`), label);
    assert.doesNotMatch(prompt, /SHOT LENGTHS|insert 4–6 s|packs consecutive shots/, `${label}: no natural-shot rules`);
    assert.match(prompt, new RegExp(`each shot must be at most ${L} s`), label);
  }
});

await test('packing: whole seconds, authored prompts, long shots split first, dialogue never squeezed out', () => {
  // A shot above L is split before packing, so callers need not do it.
  const long = packShotsIntoClips([
    { title: 'a', duration: 40, storyBeat: 'One. Two. Three. Four.' },
    { title: 'b', duration: 20, storyBeat: 'Five. Six.' },
  ], 30);
  assert.deepEqual(long.map((clip) => clip.duration), [30, 30]);
  // Fractional lengths: whole-second shots and clips, the total kept.
  const fractional = packShotsIntoClips([6.4, 8.3, 5.6, 9.7, 7.2, 10.1, 6.2, 6.5].map((duration, index) => ({ title: `s${index + 1}`, duration, storyBeat: `0–2s: beat ${index + 1}. 2s–end: more.` })), 30);
  assert.equal(fractional.reduce((sum, clip) => sum + (clip.duration ?? 0), 0), 60);
  assert.ok(fractional.every((clip) => Number.isInteger(clip.duration)));
  for (const clip of fractional) {
    for (const match of (clip.storyBeat ?? '').matchAll(/Shot \d+ \(([\d.]+)–([\d.]+)s/g)) {
      assert.ok(Number.isInteger(Number(match[1])) && Number.isInteger(Number(match[2])), `whole-second shot ranges: ${match[0]}`);
    }
  }
  // Only some shots authored: each authored prompt stays, in its own shot.
  const mixed = packShotsIntoClips([
    { title: 'a', duration: 8, storyBeat: 'beat a.', prompt: 'AUTHORED A prompt text.' },
    { title: 'b', duration: 8, storyBeat: 'beat b.' },
    { title: 'c', duration: 8, storyBeat: 'beat c.', prompt: 'AUTHORED C prompt text.' },
  ], 30);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0]!.prompt, undefined);
  assert.match(mixed[0]!.storyBeat ?? '', /Shot 1 \(0–8s\): AUTHORED A prompt text\. Hard cut to Shot 2 \(8–16s\): beat b\. Hard cut to Shot 3 \(16–24s\): AUTHORED C prompt text\./);
  // Long beats: every shot keeps its marker and its line; the look lines go first.
  const packed = packShotsIntoClips(dialogueShots() as Array<{ title: string; duration: number; storyBeat: string; visualPrompt: string; camera: string }>, 30);
  for (const clip of packed) {
    const beat = clip.storyBeat ?? '';
    assert.ok(beat.length <= clipBeatBudget(clipBeatShotCount(beat)), `within the beat budget (${beat.length})`);
    assert.doesNotMatch(beat, /\[Look:/);
  }
  const all = packed.map((clip) => clip.storyBeat).join(' ');
  for (let shot = 1; shot <= 8; shot += 1) {
    assert.match(all, new RegExp(`MARK${shot}:`));
    assert.match(all, new RegExp(`“Line number ${shot}, we have to keep moving before the bell tower rings again\\.”`));
  }
  // Shots whose lines alone would not fit one clip's beat go to more clips rather than lose a line.
  const talky = Array.from({ length: 6 }, (_, index) => ({ title: `t${index + 1}`, duration: 5, storyBeat: `Mira says: “${`Line ${index + 1} `.repeat(60).trim()}.” She waits.` }));
  const talkyClips = packShotsIntoClips(talky, 30);
  assert.ok(talkyClips.length > 1, 'more clips');
  const talkyText = talkyClips.map((clip) => clip.storyBeat).join(' ');
  for (let index = 1; index <= 6; index += 1) assert.ok(talkyText.includes(`${`Line ${index} `.repeat(60).trim()}.`), `line ${index} whole`);
  // The opening frame of a clip is its first shot.
  const first = packed[0]!;
  assert.match(openingShotBeat(first.storyBeat ?? ''), /^MARK1:/);
  assert.doesNotMatch(openingShotBeat(first.storyBeat ?? ''), /MARK2|Hard cut/);
  assert.equal(openingShotCamera(first.camera ?? ''), 'wide tracking dolly');
  assert.equal(openingShotCamera('slow dolly-in'), 'slow dolly-in');
  // A beat already cut together is shortened shot by shot, never after its first shots.
  const fitted = fitClipBeat(renderClipBeat([1, 2, 3].map((index) => ({ marker: `${index > 1 ? 'Hard cut to ' : ''}Shot ${index} (${(index - 1) * 10}–${index * 10}s): `, body: `${'A long action sentence about the scene. '.repeat(20)}Mira says: “Shot ${index} line.”`, look: `[Look: look ${index}]` }))), 900);
  assert.ok(fitted.length <= 900, `${fitted.length}`);
  for (const index of [1, 2, 3]) assert.match(fitted, new RegExp(`Shot ${index} \\(.*“Shot ${index} line\\.”`));
});

await test('single-clip wizard: any configured model replaces the old one mid-wizard, lengths clamped to its L', async () => {
  const cwd = await workspace(SEEDANCE_25);
  const key = 'single-clip-any-model';
  const say = (text: string) => handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text, locale: 'zh-CN' });
  await say('生成一个赛博朋克产品发布视频');
  const ask = await say('直接生成');
  assert.match(ask.handled ? ask.reply : '', /5、10、15、20、30 秒/);
  // A router-style 2.0 id, then a 12 s model: neither is the pinned 2.x id.
  await configureVideo(cwd, 'dreamina-seedance-2.0');
  const on20 = await say('30');
  assert.equal(on20.handled, true, '30 s is not one clip on the router-style 2.0 id');
  assert.match(on20.handled ? on20.reply : '', /4、5、10、15 秒/);
  await configureVideo(cwd, 'seedance-1-5-pro-251215');
  const on15 = await say('30');
  assert.equal(on15.handled, true, '30 s is not one clip on the 12 s model');
  assert.match(on15.handled ? on15.reply : '', /5、10、12 秒/);
  const chosen = await say('12');
  assert.equal(chosen.handled, false);
  const prompt = chosen.handled ? '' : chosen.prompt ?? '';
  assert.match(prompt, /model "seedance-1-5-pro-251215"/, 'the clip is made with the model configured now');
  assert.match(prompt, /duration: 12/);
  assert.doesNotMatch(prompt, /2-5|2\.5/, 'not the model the wizard started on');
});

/** The story beat of a request body: from its "One clip of" line to the identity card. */
function clipBeatOf(text: string): string {
  const start = text.indexOf('One clip of');
  assert.ok(start >= 0, 'a clip of several shots');
  const rest = text.slice(start);
  const end = rest.search(/ \[[A-Z]/);
  return end >= 0 ? rest.slice(0, end) : rest;
}

await test('fallback shots: story text and motion from the user story, never the story rules', async () => {
  const sentences = Array.from({ length: 24 }, (_, index) => `The kitten crosses street ${index + 1} in the rain, ducking under awnings and leaping over the gutters while neon signs flicker above the wet cobblestones.`);
  // No planned shots and no entities passed: the analysis appends the story
  // rules and the entity map to the story, after the fallback is cut from it.
  const run = await runHermeticSaga(
    { prompt: sentences.join(' '), totalDuration: 60, ratio: '16:9', generateAudio: false },
    { videoModel: SEEDANCE_25, render: false },
  );
  assert.equal(run.result.ok, true, run.result.output);
  const texts = bodyTexts(run.requests);
  assert.equal(texts.length, 2);
  for (const [clip, text] of texts.entries()) {
    const shots = parseClipBeat(clipBeatOf(text));
    assert.equal(shots?.length, 3, `clip ${clip + 1}: three shots`);
    for (const [index, shot] of shots!.entries()) {
      const where = `clip ${clip + 1} shot ${index + 1}`;
      assert.match(shot.body, /^\d+–\d+s: the protagonist /, `${where}: the motion leads (${shot.body.slice(0, 80)})`);
      assert.match(shot.body, /^\d+–\d+s: the protagonist [^.]+\. \d+–\d+s: [^.]+\. \d+–\d+s: [^.]+\. /, `${where}: all three movements`);
      assert.match(shot.body, /The kitten crosses street \d+/, `${where}: story text`);
      assert.doesNotMatch(shot.body, /Narrative Rules|MUST OBEY|Entity Map|"protagonist"|═/, `${where}: no rule text`);
    }
  }
});

await test('user scripts: a timed range or a timeline line is a script; a bare number range is not', async () => {
  const preserved = (story: string) => shouldPreserveUserScriptWithoutCriticRewrite({ action: { story }, timestampedStoryShots: [] });
  for (const story of ['She waits 3-4 minutes by the door.', 'Set in 2019-2020, a quiet town.', 'Read pages 10-12 first.', 'A 5-10 minute walk home.']) {
    assert.equal(preserved(story), false, story);
  }
  for (const story of ['0-5s: she runs.', '她奔跑（3–8 秒）。', '10-15 sec: the door opens.', '0-5: she runs.\n5-10: she stops.', '[0-5] she runs', 'Shot 1: she runs.', '镜头1：奔跑', '第2段：跳跃']) {
    assert.equal(preserved(story), true, story);
  }
  assert.equal(shouldPreserveUserScriptWithoutCriticRewrite({ action: { story: 'plain', preserveUserScript: true }, timestampedStoryShots: [] }), true);
  // A bare range in the story no longer stops two planned shots sharing a clip.
  const shots = dialogueShots().slice(0, 2);
  const story = 'Mira waits 3-4 minutes, then crosses the market.';
  const packed = await runHermeticSaga(
    { prompt: story, story, totalDuration: 14, ratio: '16:9', generateAudio: false, identitySource: 'text_only', shots },
    { videoModel: SEEDANCE_25, render: false },
  );
  assert.deepEqual(videoTaskBodies(packed.requests).map((body) => body.duration), [14]);
});

await test('single-clip wizard: a model that takes fewer references drops the others and says so first', async () => {
  const cwd = await workspace(SEEDANCE_25);
  const key = 'single-clip-fewer-refs';
  const say = (text: string) => handleSeedanceMultimodalWorkflow({ scope: 'cli', key, cwd, text, locale: 'zh-CN' });
  const start = await say('生成一个赛博朋克产品发布视频 https://example.com/look.png https://example.com/move.mp4 https://example.com/beat.mp3');
  assert.match(start.handled ? start.reply : '', /已收集参考素材 3 个/);
  // The images-only 12 s model arrives while the wizard waits for the length.
  await configureVideo(cwd, 'seedance-1-5-pro-251215');
  const told = await say('10');
  assert.equal(told.handled, true, 'told before anything is generated');
  const note = told.handled ? told.reply : '';
  plain(note, 'reference note');
  assert.match(note, /视频服务已更新，现在只能使用图片参考，已移除视频 1 个、音频 1 个/);
  assert.match(note, /已收集参考素材 1 个/);
  assert.match(note, /5、10、12 秒/);
  // A model without sound: the clip is silent, and the user is told.
  await configureVideo(cwd, 'seedance-1-0-pro-250528');
  const silent = await say('10');
  assert.equal(silent.handled, true);
  assert.match(silent.handled ? silent.reply : '', /不能生成声音，这次会做成无声视频/);
  plain(silent.handled ? silent.reply : '', 'sound note');
  // An unsupported reference sent later is left out with the same note.
  const later = await say('https://example.com/more.mp4');
  assert.match(later.handled ? later.reply : '', /当前视频服务现在只能使用图片参考，已移除视频 1 个/);
  const done = await say('10');
  assert.equal(done.handled, false);
  const prompt = done.handled ? '' : done.prompt ?? '';
  assert.match(prompt, /model "seedance-1-0-pro-250528"/);
  assert.match(prompt, /generateAudio: false/);
  assert.match(prompt, /look\.png/);
  assert.doesNotMatch(prompt, /move\.mp4|beat\.mp3|more\.mp4|referenceVideoUrls|referenceAudioUrls/);
  // English, for the en locale.
  const enCwd = await workspace(SEEDANCE_25);
  const enSay = (text: string) => handleSeedanceMultimodalWorkflow({ scope: 'cli', key: 'single-clip-fewer-refs-en', cwd: enCwd, text, locale: 'en' });
  await enSay('make a cyberpunk product launch video https://example.com/look.png https://example.com/move.mp4');
  await configureVideo(enCwd, 'seedance-1-5-pro-251215');
  const enNote = await enSay('10');
  assert.match(enNote.handled ? enNote.reply : '', /The video service changed and now takes only image references; removed 1 video reference\./);
});

await test('rewrites and fractions: a clip beat keeps its shots; split parts keep the exact length', () => {
  const parts = splitLongShots([{ title: 'a', duration: 40.6, storyBeat: 'One. Two. Three. Four.' }], 30);
  assert.equal(parts.length, 2);
  assert.ok(Math.abs(parts.reduce((sum, part) => sum + (part.duration ?? 0), 0) - 40.6) < 1e-9, `${parts.map((part) => part.duration)}`);
  assert.ok(parts.every((part) => (part.duration ?? 0) <= 30));
  const before = packShotsIntoClips(dialogueShots() as Array<{ title: string; duration: number; storyBeat: string }>, 30)[0]!.storyBeat ?? '';
  const shots = parseClipBeat(before)!;
  assert.equal(shots.length, 4);
  const body = shots.map((shot) => `${shot.marker}${shot.body} (rewritten)`).join(' ');
  // A rewrite that keeps the opening line and every marker is kept.
  const kept = renderClipBeat(shots.map((shot) => ({ ...shot, body: `${shot.body} (rewritten)` })), false);
  assert.equal(restoreClipBeat(before, kept), kept);
  // One that drops the opening line gets it back.
  assert.equal(restoreClipBeat(before, body), `${clipShotsHeader(4)} ${body}`);
  // One that loses a shot, or every marker, keeps the beat before it.
  assert.equal(restoreClipBeat(before, shots.slice(0, 3).map((shot) => `${shot.marker}${shot.body}`).join(' ')), before);
  assert.equal(restoreClipBeat(before, 'Mira crosses the market in one take.'), before);
  // A beat of one shot is the rewrite's to change.
  assert.equal(restoreClipBeat('0–2s: a. 2s–end: b.', 'new beat'), 'new beat');
});

console.log(`\n  ✔ ${passed} video duration checks passed`);
process.exit(0);
