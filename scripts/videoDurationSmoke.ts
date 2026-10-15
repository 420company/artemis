// Model-aware video durations: every decision derives from L, the active
// video model's longest single clip (Seedance 2.0: 15 s, Seedance 2.5: 30 s,
// or what the platform declares in visualProfile.video.capabilities).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHermeticSaga, videoTaskBodies, withHermeticWorkspace } from './sagaHermeticHarness.js';
import { ProviderStore } from '../src/providers/store.js';
import { offsetBeatTimeline, packShotsIntoClips, planSegmentDurations, segmentCountFor, sentencesOf, splitBeatText, splitLongShots } from '../src/tools/visual/segmentPlan.js';
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
    { prompt: 'A kitten crosses a rainy city at night and reaches a rooftop at dawn.', totalDuration: 60, ratio: '9:16', generateAudio: false },
    { videoCapabilities: { maxClipSeconds: 30 } },
  );
  assert.equal(long.result.ok, true, long.result.output);
  assert.deepEqual(videoTaskBodies(long.requests).map((body) => body.duration), [30, 30]);
  assert.ok(long.logs.some((line) => /第 2\/2 段/.test(line)), 'progress counts the real plan');

  const brief = '[0-20秒] 镜头1：小猫在雨里奔跑。它跳过水坑。它停在路灯下。\n[20-28秒] 镜头2：小猫跳上屋顶。';
  const timed = await runHermeticSaga({ prompt: brief, story: brief, totalDuration: 28, ratio: '9:16', generateAudio: false, identitySource: 'text_only' });
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
  assert.equal(on30.length, 3, `fewest clips on L=30 (${on30.map((clip) => clip.duration)})`);
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
  const on25 = await runHermeticSaga(action, { videoModel: 'dreamina-seedance-2.5' });
  assert.equal(on25.result.ok, true, on25.result.output);
  const durations25 = videoTaskBodies(on25.requests).map((body) => body.duration);
  assert.equal(durations25.length, 3, `three clips on L=30 (${durations25})`);
  assert.ok(durations25.every((value) => value <= 30));
  assert.equal(durations25.reduce((sum, value) => sum + value, 0), 60);
  const text25 = JSON.stringify(videoTaskBodies(on25.requests)[0]);
  assert.match(text25, /Hard cut to Shot 2/, 'the clip is cut inside');
  const on20 = await runHermeticSaga(action, {});
  const durations20 = videoTaskBodies(on20.requests).map((body) => body.duration);
  assert.ok(durations20.length > durations25.length, `more clips on L=15 (${durations20})`);
  assert.ok(durations20.every((value) => value <= 15));
  assert.equal(durations20.reduce((sum, value) => sum + value, 0), 60);

  // No planned shots: two 30 s clips, each written as several camera shots, not one held take.
  const fallback = await runHermeticSaga(
    { prompt: 'A kitten crosses a rainy city at night. It reaches a rooftop. The sun rises over the roofs. It curls up and sleeps.', totalDuration: 60, ratio: '16:9', generateAudio: false },
    { videoModel: SEEDANCE_25 },
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
    assert.match(prompt, new RegExp(`each clip at most ${L} s with hard cuts inside it \\(about ${segmentCountFor(60, L)} clip\\(s\\) for 60 s\\)`));
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
  assert.match(prompt, /each clip at most 15 s/);
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

console.log(`\n  ✔ ${passed} video duration checks passed`);
process.exit(0);
