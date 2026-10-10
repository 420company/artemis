// Guard: users never see internal system / vendor / tool / workflow names,
// nor fee wording outside the billing UI.
// Runs the long-video wizard (zh + en, CLI and chat-bridge scope), the
// long-video offer (CLI, headless/web and bridge), the single-clip video
// wizard, hermetic long-video runs (success and error paths), image and video
// tool results, the stored-prompt history view, and every exported
// user-facing string table, and fails on any internal name in what a user
// would see. Progress lines are checked as the user receives them (through a
// runtime log sink).
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixturePng, runHermeticSaga, withHermeticWorkspace } from './sagaHermeticHarness.js';
import {
  buildSagaOfferQuestion,
  handleSagaLongVideoWorkflow,
  offerSagaLongVideoWorkflow,
  parseLongVideoCommand,
  parseSagaOfferReply,
  type SagaWorkflowScope,
} from '../src/tools/visual/sagaWorkflow.js';
import { handleSeedanceMultimodalWorkflow } from '../src/tools/visual/seedanceWorkflow.js';
import { describeAutoWorkflow, describeRouteReason, type AutoWorkflow } from '../src/core/workflowRouter.js';
import {
  describeToolForUser,
  describeToolOutputForUser,
  findInternalNames,
  scrubInternalNames,
  userVisibleMessageText,
} from '../src/utils/internalNames.js';
import { buildVisualSetupRequiredMessage } from '../src/utils/visualGenerationConfig.js';
import { describeVideoGenerationFailure } from '../src/tools/visual/videoGenerationFailure.js';
import { formatImageGenerationFailure } from '../src/tools/visual/imageGenerationFailure.js';
import { getCommandDescriptors } from '../src/commands/descriptors.js';
import { buildRemoteCommandHelpSections } from '../src/commands/catalog.js';
import { planHeadlessWorkflow } from '../src/services/headlessWorkflow.js';
import { SessionStore } from '../src/storage/sessions.js';
import { parseRemoteCommand, runRemoteCommand } from '../src/bragi/runtime.js';
import { executeGenerateLongVideo } from '../src/tools/generateLongVideo.js';
import { executeGenerateImage } from '../src/tools/generateImage.js';
import { executeGenerateVideo } from '../src/tools/generateVideo.js';
import { withRuntimeLogSink } from '../src/utils/log.js';
import type { UiLocale } from '../src/cli/locale.js';

// The shared denylist plus a retired subsystem name the source tree may not spell out.
const EXTRA_DENYLIST: Array<{ name: string; re: RegExp }> = [
  { name: 'retired subsystem', re: /\bodin\b/i },
  // No fee / price wording in prompts and progress (billing has its own UI).
  { name: 'cost wording', re: /费用|计费|收费|扣费|价格|\bcosts?\b|\bbilled\b|\bprices?\b|\bmoney\b/i },
];

let checked = 0;
const failures: string[] = [];

/** Records every internal name in one piece of user-visible text. */
function expectClean(where: string, raw: string | undefined): void {
  checked += 1;
  if (!raw) return;
  // The hermetic harness's own temporary directory is not product output.
  const text = raw.replace(/artemis-saga-hermetic-[A-Za-z0-9]+/g, 'artemis-test-root');
  const hits = [
    ...findInternalNames(text).map((hit) => `${hit.name} ("${hit.match}")`),
    ...EXTRA_DENYLIST.filter(({ re }) => re.test(text)).map(({ name }) => name),
  ];
  if (hits.length > 0) {
    const line = text.split('\n').find((candidate) => findInternalNames(candidate).length > 0 || EXTRA_DENYLIST.some(({ re }) => re.test(candidate))) ?? text;
    failures.push(`${where}: ${hits.join(', ')}\n    ${line.trim().slice(0, 240)}`);
  }
}

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  const before = failures.length;
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: threw ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
  const ok = failures.length === before;
  console.log(`  ${ok ? '✔' : '✘'} ${name}`);
}

const LOCALES: UiLocale[] = ['zh-CN', 'en'];
const STORY_ZH = '一只橘色小猫在雨夜的城市里冒险，穿过霓虹街道，最后在屋顶上看见日出。';
const STORY_EN = 'An orange kitten explores a rainy city at night, crosses neon streets, and watches the sunrise from a rooftop.';

// ── Static string tables ───────────────────────────────────────────────────

await test('string tables: long-video offer question (zh/en, numbered/choices)', () => {
  for (const locale of LOCALES) {
    for (const format of ['numbered', 'choices'] as const) {
      const question = buildSagaOfferQuestion(locale, format);
      expectClean(`offer ${locale} ${format}`, question);
      assert.match(question, locale === 'zh-CN' ? /完整的长视频/ : /long video/i);
    }
  }
  assert.match(buildSagaOfferQuestion('zh-CN'), /1\. 好，开始\n2\. 不用了\n请回复编号。/);
});

await test('string tables: offer answers parse, new and old labels', () => {
  const yes = ['1', '1.', '好，开始', '1. 好，开始', '是，开始', '是', '好', 'Yes, go ahead', 'Yes, start', 'yes', 'ok', '✅'];
  const no = ['2', '2.', '不用了', '2. 不用了', '不是', '不用', '算了', 'No thanks', 'no', 'No', 'cancel'];
  for (const reply of yes) assert.equal(parseSagaOfferReply(reply), 'yes', reply);
  for (const reply of no) assert.equal(parseSagaOfferReply(reply), 'no', reply);
  for (const reply of ['好的，按方案二来', '1分钟太长了', 'ok but shorter']) assert.equal(parseSagaOfferReply(reply), undefined, reply);
});

await test('string tables: /longvideo and /saga both start a long video (input only)', () => {
  assert.equal(parseLongVideoCommand('/longvideo 小猫冒险'), '小猫冒险');
  assert.equal(parseLongVideoCommand('/saga 小猫冒险'), '小猫冒险');
  assert.equal(parseLongVideoCommand('/长视频 小猫冒险'), '小猫冒险');
  assert.equal(parseLongVideoCommand('/saga'), '');
  assert.equal(parseLongVideoCommand('/sagas'), undefined);
  assert.equal(parseLongVideoCommand('make a saga video'), undefined);
});

await test('string tables: workflow labels and route reasons', () => {
  const workflows: AutoWorkflow[] = ['direct', 'plan', 'team', 'compare', 'design', 'saga'];
  const reasons = ['clear request for a long multi-segment video', 'asked for several candidate solutions and the best one', 'question', 'follow-up', 'builds or restyles a website / UI', 'large multi-part build or change', 'engineering task that needs investigation first', 'non-trivial engineering task'];
  for (const locale of LOCALES) {
    for (const workflow of workflows) expectClean(`describeAutoWorkflow(${workflow}, ${locale})`, describeAutoWorkflow(workflow, locale));
    for (const reason of reasons) expectClean(`describeRouteReason(${reason}, ${locale})`, describeRouteReason({ reason }, locale));
  }
});

await test('string tables: tool labels for progress lines and chat captions', () => {
  const tools = ['generate_long_video', 'generate_video', 'generate_image', 'bridge_send_video', 'bridge_send_image', 'run_command', 'read_file', 'search_web', 'delegate_task', 'use_workflow', 'some_future_tool'];
  for (const locale of LOCALES) {
    for (const tool of tools) {
      expectClean(`describeToolForUser(${tool}, ${locale})`, describeToolForUser(tool, locale));
      expectClean(`describeToolOutputForUser(${tool}, ${locale})`, describeToolOutputForUser(tool, locale));
    }
  }
});

await test('string tables: setup-required and generation failure messages', () => {
  expectClean('setup required (image)', buildVisualSetupRequiredMessage('image'));
  expectClean('setup required (video)', buildVisualSetupRequiredMessage('video'));
  const details = [
    { detail: 'HTTP 402 insufficient balance', status: 402 },
    { detail: 'rate limited', status: 429 },
    { detail: 'payload too large', status: 413 },
    { detail: 'InputImageSensitiveContentDetected', status: 400 },
    { detail: 'invalid api key', status: 401 },
    { detail: 'did not complete within 90 polls' },
    { detail: 'socket hang up' },
  ];
  for (const locale of LOCALES) {
    for (const input of details) expectClean(`video failure ${input.detail} ${locale}`, describeVideoGenerationFailure(input, locale).userMessage);
  }
  for (const input of details) expectClean(`image failure ${input.detail}`, formatImageGenerationFailure(input).output);
});

await test('string tables: command descriptions (help, menus, chat /help)', () => {
  for (const descriptor of getCommandDescriptors()) {
    // Command syntax the user types ("artemis bragi telegram") is input, not a name we show off.
    const withoutSyntax = (text: string) => text.replace(/\bartemis\s+[a-z-]+(?:\s+[a-z-]+)?/gi, '<command>');
    expectClean(`command ${descriptor.id} desc zh`, withoutSyntax(descriptor.desc.zh));
    expectClean(`command ${descriptor.id} desc en`, withoutSyntax(descriptor.desc.en));
  }
  for (const locale of LOCALES) {
    for (const section of buildRemoteCommandHelpSections(locale)) expectClean(`remote help title ${locale}`, section.title);
  }
});

await test('scrubber: internal names in progress lines become plain words', () => {
  const line = '🎨 Saga: Super Visual 第 1 段 · Saga Critic: ok · BytePlus dreamina-seedance-2-0-260128 / seedream-5-0-260128 · generate_long_video';
  const scrubbed = scrubInternalNames(line);
  expectClean('scrubbed progress line', scrubbed);
  assert.match(scrubbed, /第 1 段/);
});

// ── Wizard flows (long video) ──────────────────────────────────────────────

type Step = { text: string; images?: boolean };

async function walk(cwd: string, scope: SagaWorkflowScope, locale: UiLocale, label: string, first: string, steps: Step[]): Promise<string | undefined> {
  const key = `guard-${label}-${scope}-${locale}-${Date.now()}`;
  const start = await handleSagaLongVideoWorkflow({ scope, key, cwd, text: first, locale, forceIntent: true });
  assert.equal(start.handled, true, `${label}: the wizard did not start`);
  if (start.handled) expectClean(`${label} ${scope} ${locale} start`, start.reply);
  let finalPrompt: string | undefined;
  for (const step of steps) {
    const outcome = await handleSagaLongVideoWorkflow({ scope, key, cwd, text: step.text, locale, deliveryPlatform: scope === 'bridge' ? 'telegram' : undefined, deliveryTargetId: scope === 'bridge' ? '42' : undefined });
    if (outcome.handled) {
      expectClean(`${label} ${scope} ${locale} after "${step.text.slice(0, 30)}"`, outcome.reply);
    } else {
      finalPrompt = outcome.prompt;
      if (outcome.action) {
        assert.match(String(outcome.action.projectId), /^video-/, 'new projects are not named after the engine');
      }
      break;
    }
  }
  return finalPrompt;
}

await test('long-video wizard: every menu, re-ask, upload, BGM and resolution reply (zh + en, CLI + bridge)', async () => {
  await withHermeticWorkspace({}, async (cwd) => {
    const image = fixturePng();
    for (const locale of LOCALES) {
      const zh = locale === 'zh-CN';
      const story = zh ? STORY_ZH : STORY_EN;
      for (const scope of ['cli', 'bridge'] as const) {
        // Protagonist from a character photo, every optional step on the way.
        const prompt = await walk(cwd, scope, locale, 'photo', story, [
          { text: '1' },
          { text: '9' },
          { text: '2' },
          { text: zh ? '完成' : 'done' },
          { text: image },
          { text: zh ? '完成' : 'done' },
          { text: zh ? '剧情增强' : 'story enhance' },
          { text: zh ? '分镜图' : 'storyboard' },
          { text: image },
          { text: zh ? '小猫先在雨里奔跑，然后跳上屋檐，最后在屋顶看见第一缕阳光照亮整座城市。' : 'The kitten first runs through the rain, then jumps onto the eaves, and finally sees the first light over the city.' },
          { text: '720p' },
          { text: zh ? '开始生成' : 'start' },
          { text: 'x' },
          { text: '1' },
          { text: '?' },
          { text: '1' },
          { text: 'abc' },
          { text: zh ? '60秒' : '60s' },
          { text: '2' },
          { text: 'https://open.spotify.com/track/abc' },
          { text: 'https://cdn.example.test/song.mp3' },
          { text: 'blah' },
          { text: zh ? '默认' : 'default' },
        ]);
        assert.ok(prompt, 'the photo flow reaches generation');
        const shown = userVisibleMessageText(prompt!);
        expectClean(`stored prompt as shown in history (${scope} ${locale})`, shown);
        assert.ok(shown.includes(zh ? '橘色小猫' : 'orange kitten'), 'history shows the user’s own story');

        // Turnaround sheet, then cancel.
        await walk(cwd, scope, locale, 'turnaround', story, [
          { text: '1' }, { text: '1' }, { text: zh ? '完成' : 'done' }, { text: image }, { text: image }, { text: zh ? '完成' : 'done' }, { text: zh ? '取消' : 'cancel' },
        ]);
        // Image used directly, with a caption.
        await walk(cwd, scope, locale, 'direct', story, [
          { text: '1' }, { text: '3' }, { text: `${image} ${zh ? '这是第一幕的街道' : 'this is the street of act one'}` }, { text: image }, { text: zh ? '完成' : 'done' }, { text: zh ? '无主角' : 'abstract' }, { text: zh ? '取消' : 'cancel' },
        ]);
        // Text-only identity, then a pure-visual run.
        await walk(cwd, scope, locale, 'text-only', story, [{ text: '1' }, { text: '4' }, { text: zh ? '取消' : 'cancel' }]);
        await walk(cwd, scope, locale, 'pure-visual', story, [
          { text: '2' }, { text: zh ? '开始生成' : 'start' }, { text: '2' }, { text: '3' }, { text: zh ? '自动' : 'auto' }, { text: '1' },
        ]);
        // A brief that declares subject, identity and ratio, with dialogue too long for its segment.
        const brief = zh
          ? '主体模式：有主角。身份来源：纯文字。\n画幅比例：9:16 竖屏\n[0-4秒] 小猫说：“今天的雨好大呀，我们要不要找个地方躲一躲，等雨停了再出发去屋顶看日出？”\n[4-8秒] 小猫跳上屋顶。'
          : 'Subject mode: has a protagonist. Identity source: text only.\nRatio: 9:16 portrait\n[0-4s] The kitten says: "The rain is so heavy today, should we find somewhere to hide and wait until it stops before we go up to the rooftop to watch the sunrise together?"\n[4-8s] The kitten jumps onto the roof.';
        await walk(cwd, scope, locale, 'declared', brief, [{ text: zh ? '开始生成' : 'start' }, { text: '16:9' }, { text: '1' }, { text: zh ? '取消' : 'cancel' }]);
      }
    }
  });
});

await test('long-video offer: CLI / bridge question and answers (zh + en)', async () => {
  await withHermeticWorkspace({}, async (cwd) => {
    for (const locale of LOCALES) {
      const text = locale === 'zh-CN' ? `帮我做一个3分钟的长视频，${STORY_ZH}` : `Make me a 3 minute long video: ${STORY_EN}`;
      for (const scope of ['cli', 'bridge'] as const) {
        const key = `guard-offer-${scope}-${locale}`;
        const question = await offerSagaLongVideoWorkflow({ scope, key, cwd, text, locale });
        assert.ok(question, 'a configured video provider gets the offer');
        expectClean(`offer ${scope} ${locale}`, question);
        const yes = await handleSagaLongVideoWorkflow({ scope, key, cwd, text: '1', locale });
        assert.equal(yes.handled, true);
        if (yes.handled) expectClean(`offer accepted ${scope} ${locale}`, yes.reply);
        await handleSagaLongVideoWorkflow({ scope, key, cwd, text: locale === 'zh-CN' ? '取消' : 'cancel', locale });
        await offerSagaLongVideoWorkflow({ scope, key, cwd, text, locale });
        const no = await handleSagaLongVideoWorkflow({ scope, key, cwd, text: locale === 'zh-CN' ? '不用了' : 'No thanks', locale });
        assert.equal(no.handled, false);
        assert.equal(no.handled === false ? no.replayText : undefined, text, 'declining goes on with the original request');
      }
    }
  });
});

await test('long-video offer: headless / web reply (zh + en)', async () => {
  await withHermeticWorkspace({}, async (cwd) => {
    const store = new SessionStore(cwd);
    for (const prompt of [`帮我做一个3分钟的长视频，讲一个小猫在城市里冒险的故事，分成好几个镜头。`, `Make me a 3 minute long video about ${STORY_EN}`]) {
      const session = store.createSession({ title: 'guard' });
      const plan = await planHeadlessWorkflow({
        session,
        prompt,
        cwd,
        attachmentCount: 0,
        inCodeRepo: false,
        autoRoute: true,
        getClassifier: async () => undefined,
        hasVideoProvider: async () => true,
      });
      assert.equal(plan.kind, 'reply', 'a long-video request gets the question, nothing runs');
      if (plan.kind === 'reply') expectClean(`headless offer "${prompt.slice(0, 12)}"`, plan.reply);
      const answer = await planHeadlessWorkflow({
        session, prompt: '1', cwd, attachmentCount: 0, inCodeRepo: false, autoRoute: true,
        getClassifier: async () => undefined, hasVideoProvider: async () => true,
      });
      assert.equal(answer.kind, 'run');
      assert.equal(answer.kind === 'run' ? answer.workflow : '', 'saga');
    }
  });
});

await test('chat bridge: /longvideo, /saga, the offer and the wizard as a chat user sees them (zh + en)', async () => {
  await withHermeticWorkspace({}, async (cwd) => {
    const store = new SessionStore(cwd);
    for (const locale of LOCALES) {
      const stored = store.createSession({ title: `guard-bridge-${locale}` });
      await store.save(stored);
      const send = async (text: string): Promise<string> => (await runRemoteCommand(parseRemoteCommand(text), {
        binding: { storedSession: stored, permissionMode: 'read-only', rolledOver: false },
        store,
        locale,
        cwd,
        bridgePlatform: 'telegram',
        targetId: `guard-${locale}`,
      } as any)).replies.join('\n');
      const zh = locale === 'zh-CN';
      for (const text of [
        '/longvideo',
        '/saga',
        `/longvideo ${zh ? STORY_ZH : STORY_EN}`,
        zh ? '取消' : 'cancel',
        `/saga ${zh ? STORY_ZH : STORY_EN}`,
        '2',
        zh ? '取消' : 'cancel',
        zh ? `帮我做一个3分钟的长视频，${STORY_ZH}` : `Make me a 3 minute long video: ${STORY_EN}`,
        '1',
        '1',
        zh ? '取消' : 'cancel',
      ]) {
        expectClean(`bridge ${locale} reply to "${text.slice(0, 24)}"`, await send(text));
      }
    }
  });
});

// ── Single-clip video wizard ───────────────────────────────────────────────

await test('video wizard: offer, references, duration, invalid duration, dream journal, cancel (zh + en)', async () => {
  await withHermeticWorkspace({}, async (cwd) => {
    for (const locale of LOCALES) {
      const zh = locale === 'zh-CN';
      for (const scope of ['cli', 'bridge'] as const) {
        const key = `guard-video-${scope}-${locale}`;
        const say = async (text: string, extra: Record<string, unknown> = {}) => {
          const outcome = await handleSeedanceMultimodalWorkflow({ scope, key, cwd, text, locale, ...extra } as any);
          if (outcome.handled) expectClean(`video wizard ${scope} ${locale} "${text.slice(0, 20)}"`, outcome.reply);
          if (!outcome.handled && outcome.prompt) expectClean(`video wizard stored prompt ${scope} ${locale}`, userVisibleMessageText(outcome.prompt));
          return outcome;
        };
        await say(zh ? '生成一个赛博朋克产品发布视频' : 'Generate a cyberpunk product launch video', { imageAttachments: [{ mediaType: 'image/png', data: '' }] });
        await say(zh ? '添加' : 'add');
        await say('https://cdn.example.test/still.png');
        await say(zh ? '开始生成' : 'start');
        await say('20');
        await say(zh ? '取消' : 'cancel');
        await say(zh ? '生成一个赛博朋克产品发布视频' : 'Generate a cyberpunk product launch video');
        await say(zh ? '直接生成' : 'direct generate');
        await say('10');
        const dream = { id: 'dream-guard', body: zh ? '我梦见一只发光的鲸鱼在城市上空游过。' : 'I dreamed of a glowing whale swimming over the city.' };
        await say(zh ? '请把最后一个梦境做成视频' : 'Turn my last dream into a video', { latestDream: dream });
        await say(zh ? '不用' : 'no');
        await say(zh ? '取消' : 'cancel');
        await say(zh ? '请把最后一个梦境做成视频' : 'Turn my last dream into a video', { latestDream: dream });
        await say(zh ? '使用最新梦境' : 'use latest dream', { latestDream: dream });
        await say('5', { latestDream: dream });
      }
    }
  });
});

// ── Generation runs: results, progress lines, error paths ──────────────────

function checkRun(label: string, run: { result: { output: string }; logs: string[] }): void {
  expectClean(`${label}: tool result`, run.result.output);
  run.logs.forEach((line, index) => expectClean(`${label}: progress line ${index + 1}`, line));
}

await test('long-video run: success result, file names and progress lines', async () => {
  const run = await runHermeticSaga({ prompt: STORY_EN, totalDuration: 5, ratio: '9:16', generateAudio: false });
  assert.equal(run.result.ok, true, run.result.output);
  checkRun('success', run);
  assert.match(run.result.output, /_\d+s_9x16_[^/\s]*_video-[^/\s]*\.mp4/, 'the file name carries no engine name');
});

await test('long-video run: identity reference, keyframes and the consistency pass', async () => {
  const run = await runHermeticSaga({ prompt: STORY_EN, totalDuration: 5, ratio: '9:16', generateAudio: false, referenceImagePaths: [fixturePng()] });
  assert.equal(run.result.ok, true, run.result.output);
  checkRun('identity reference', run);
});

await test('long-video run: image service refuses (consistency off) and video service rejects every segment', async () => {
  const refused = await runHermeticSaga(
    { prompt: STORY_EN, totalDuration: 5, ratio: '9:16', generateAudio: false, referenceImagePaths: [fixturePng()] },
    { imageStatus: 400 },
  );
  checkRun('image refused', refused);
  const rejected = await runHermeticSaga(
    { prompt: STORY_EN, totalDuration: 5, ratio: '9:16', generateAudio: false, referenceImagePaths: [fixturePng()] },
    { rejectVideoCreates: [1, 2, 3, 4, 5, 6] },
  );
  assert.equal(rejected.result.ok, false);
  checkRun('video rejected', rejected);
  const badResolution = await runHermeticSaga({ prompt: STORY_EN, totalDuration: 5, resolution: '4k' });
  assert.equal(badResolution.result.ok, false);
  checkRun('bad resolution', badResolution);
});

await test('long-video, image and video tools without a configured provider', async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'artemis-guard-noprovider-'));
  const logs: string[] = [];
  await withRuntimeLogSink((entry) => { logs.push(entry.message); }, async () => {
    const context = { cwd, permissionMode: 'full-access', sessionId: 'guard', locale: 'en' } as any;
    expectClean('long video, no provider', (await executeGenerateLongVideo({ type: 'generate_long_video', prompt: STORY_EN } as any, context)).output);
    expectClean('image, no provider', (await executeGenerateImage({ type: 'generate_image', prompt: STORY_EN }, context)).output);
    expectClean('video, no provider', (await executeGenerateVideo({ type: 'generate_video', prompt: STORY_EN } as any, context)).output);
  });
  logs.forEach((line, index) => expectClean(`no provider: progress line ${index + 1}`, line));
});

await test('image and single-clip video tools: success and failure results', async () => {
  for (const options of [{}, { imageStatus: 500 }, { rejectVideoCreates: [1, 2, 3] }]) {
    await withHermeticWorkspace(options, async (cwd) => {
      const logs: string[] = [];
      await withRuntimeLogSink((entry) => { logs.push(entry.message); }, async () => {
        const context = { cwd, permissionMode: 'full-access', sessionId: 'guard', locale: 'en', requestWorkspaceSwitch: async () => true } as any;
        expectClean(`image ${JSON.stringify(options)}`, (await executeGenerateImage({ type: 'generate_image', prompt: STORY_EN }, context)).output);
        expectClean(`video ${JSON.stringify(options)}`, (await executeGenerateVideo({ type: 'generate_video', prompt: STORY_EN, duration: 5, maxPolls: 3, pollIntervalMs: 1000 } as any, context)).output);
      });
      logs.forEach((line, index) => expectClean(`tools ${JSON.stringify(options)}: progress line ${index + 1}`, line));
    });
  }
});

// ── Stored wizard prompts in history ───────────────────────────────────────

await test('history: a stored generation prompt shows only the user’s story (web and CLI history)', async () => {
  await withHermeticWorkspace({}, async (cwd) => {
    const key = `guard-history-${Date.now()}`;
    const steps = ['2', '开始生成', '1', '1', '30秒', '不加'];
    await handleSagaLongVideoWorkflow({ scope: 'bridge', key, cwd, text: STORY_ZH, locale: 'zh-CN', forceIntent: true });
    let prompt: string | undefined;
    for (const text of steps) {
      const outcome = await handleSagaLongVideoWorkflow({ scope: 'bridge', key, cwd, text, locale: 'zh-CN' });
      if (!outcome.handled) prompt = outcome.prompt;
    }
    assert.ok(prompt?.includes('[Artemis Saga long video workflow]'), 'the stored marker is unchanged (saved sessions depend on it)');
    const store = new SessionStore(cwd);
    const session = store.createSession({ title: 'guard-history' });
    store.appendMessage(session, 'user', prompt!);
    store.appendMessage(session, 'assistant', '好的，正在制作长视频。');
    // An older session stored before the wording change.
    store.appendMessage(session, 'user', `${STORY_ZH}\n\n[Seedance 2.0 Pro multimodal video workflow]\nUse generate_video with model "dreamina-seedance-2-0-260128".`);
    await store.save(session);
    const page = await store.loadHistoryPage(session, { limit: 20 });
    for (const message of page.messages) expectClean(`history page ${message.role}`, message.content);
    assert.equal(page.messages[0]?.content, STORY_ZH);
  });
});

// ── Report ─────────────────────────────────────────────────────────────────

console.log(`\n  ${checked} user-visible texts checked`);
if (failures.length > 0) {
  console.error(`\n  ✘ ${failures.length} internal-name leak(s):\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('  ✔ No internal names in user-visible output');
// The harness leaves timers behind; exit explicitly.
process.exit(0);
