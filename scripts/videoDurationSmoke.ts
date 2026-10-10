// Model-aware video durations: every decision derives from L, the active
// video model's longest single clip (Seedance 2.0: 15 s, Seedance 2.5: 30 s,
// or what the platform declares in visualProfile.video.capabilities).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runHermeticSaga, videoTaskBodies, withHermeticWorkspace } from './sagaHermeticHarness.js';
import { ProviderStore } from '../src/providers/store.js';
import { planSegmentDurations, splitLongShots } from '../src/tools/visual/segmentPlan.js';
import { resolveVideoModelCapabilities, resolveVideoModelProfile } from '../src/tools/visual/videoCapabilities.js';
import { resolveVideoModelLimits } from '../src/tools/visual/videoModelLimits.js';
import { normalizeVideoDurationForProvider } from '../src/tools/visual/videoParams.js';
import { resolveActiveVideoClipSeconds } from '../src/tools/visual/activeVideoModel.js';
import {
  classifyVideoRequestLength,
  handleSagaLongVideoWorkflow,
  longVideoDurationChoices,
  offerSagaLongVideoWorkflow,
} from '../src/tools/visual/sagaWorkflow.js';
import { handleSeedanceMultimodalWorkflow, singleClipChoices } from '../src/tools/visual/seedanceWorkflow.js';
import { looksLikeSagaRequest, routeWorkflow } from '../src/core/workflowRouter.js';
import { planHeadlessWorkflow, videoLengthChoices } from '../src/services/headlessWorkflow.js';
import { SessionStore } from '../src/storage/sessions.js';
import { findInternalNames } from '../src/utils/internalNames.js';

const SEEDANCE_20 = 'dreamina-seedance-2-0-260128';
// No public 2.5 id is pinned here: any id matching /seedance[-_ ]?2[._-]?5/ is 2.5.
const SEEDANCE_25 = 'dreamina-seedance-2-5-260901';
const COST_RE = /费用|计费|收费|价格|\bcosts?\b|\bbilled\b|\bprice\b|\bmoney\b/i;

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
  assert.deepEqual(longVideoDurationChoices(30), [{ seconds: 30, segments: 1 }, { seconds: 60, segments: 2 }, { seconds: 90, segments: 3 }, { seconds: 120, segments: 4 }]);
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
    const byIndex = await planHeadlessWorkflow({ ...base, intent: undefined, session: third, prompt: '3' });
    assert.equal(byIndex.kind === 'run' && byIndex.workflow, L === 30 ? 'direct' : 'direct', 'the third choice (L s) is one clip');
    assert.match(byIndex.kind === 'run' ? byIndex.hint : '', new RegExp(`duration: ${L}`));
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

console.log(`\n  ✔ ${passed} video duration checks passed`);
process.exit(0);
