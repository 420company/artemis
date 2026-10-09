/**
 * Automatic workflow routing (src/core/workflowRouter.ts): classification
 * table (CN + EN), retired slash words as natural language, Saga entry,
 * classifier gating / fallback, sub-agent cost bounds, and the runAgent
 * integration (budget refusal, per-run playbook not stored).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLASSIFIER_TIMEOUT_MS,
  MAX_SUB_AGENTS_PER_RUN,
  WORKFLOW_BUDGETS,
  buildRoutedWorkflowHint,
  checkDelegationBudget,
  createDelegationBudget,
  gateClassifierVerdict,
  collectWorkflowSignals,
  parseClassifierReply,
  routeWorkflow,
  stripRetiredWorkflowSlash,
  type AutoWorkflow,
} from '../src/core/workflowRouter.js';
import { detectExplicitWorkflowIntent } from '../src/core/workflowDispatcher.js';
import { handleSagaLongVideoWorkflow, isClearSagaLongVideoRequest } from '../src/tools/visual/sagaWorkflow.js';
import { BYTEPLUS_SEEDANCE_2_PRO_MODEL } from '../src/tools/visual/videoCapabilities.js';
import { ProviderStore } from '../src/providers/store.js';
import { executeAction } from '../src/tools/index.js';
import { getAllowedActionTypesForProfile } from '../src/core/agentProfiles.js';
import { listDirectToolNames } from '../src/tools/directTools.js';
import { runAgent } from '../src/core/agent.js';
import { SessionStore } from '../src/storage/sessions.js';
import { PermissionManager } from '../src/security/permissions.js';
import type { ChatProvider, ProviderResponse } from '../src/providers/types.js';
import type { AgentAction } from '../src/core/types.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✔ ${name}`);
}

const neverClassifier = (): ChatProvider => ({
  async complete(): Promise<ProviderResponse> {
    throw new Error('the classifier must not be called for a clear request');
  },
});

const fixedClassifier = (text: string, calls: { count: number }): ChatProvider => ({
  async complete(): Promise<ProviderResponse> {
    calls.count += 1;
    return { text, raw: null };
  },
});

// A request long enough to be "substantial" with no clear workflow signal.
const AMBIGUOUS_LONG =
  'Our team keeps losing track of decisions made in weekly meetings. People forget who owns what, ' +
  'follow-ups slip, and new members cannot find the history. I want a better way of working here: ' +
  'something that captures decisions and owners, reminds people, and lets newcomers catch up quickly. ' +
  'Please think about what we should set up and get it going for us.';

async function main(): Promise<void> {
  console.log('\n  workflowRouterSmoke');
  console.log('  ==================');

  // ── classification table ──────────────────────────────────────────────────
  const table: Array<[string, AutoWorkflow]> = [
    // casual chat
    ['你好', 'direct'],
    ['在吗', 'direct'],
    ['thanks!', 'direct'],
    // quick questions
    ['Python 里 list 和 tuple 有什么区别？', 'direct'],
    ['What is a closure in JavaScript?', 'direct'],
    ['React vs Vue 哪个好？', 'direct'],
    // small coding tasks stay on the plain path
    ['把 README 里的拼写错误改一下', 'direct'],
    ['fix the typo in src/app.ts', 'direct'],
    ['帮我写一个 Python 脚本，把这个目录里的图片都转成 webp', 'direct'],
    ['把这 2 个实现合并一下', 'direct'],
    ['merge these two implementations into one', 'direct'],
    ['帮我写一个完整的工具函数', 'direct'],
    ['帮我完整地检查一下这个项目', 'direct'],
    // non-trivial engineering → deep planning
    ['排查一下为什么 bridge 在 Telegram 上发图片会超时，看看 src/bragi/runtime.ts 和 src/telegram 下的上传逻辑，找到根因并修复', 'plan'],
    ['Investigate why the session lock times out under load and fix the root cause in the storage layer', 'plan'],
    // big projects → bounded parallel team
    ['帮我做个完整的待办事项项目，前端用 React，后端用 Node，带登录和测试', 'team'],
    ['Build a complete full-stack e-commerce app with a React frontend, a Node backend, auth and tests', 'team'],
    ['Refactor the auth module across the whole codebase to use the new token service', 'team'],
    // explicit multi-option asks → compare
    ['给我三个方案比较一下', 'compare'],
    ['这个缓存层怎么做比较好？给我 3 个方案对比优缺点', 'compare'],
    ['Compare three approaches for caching API responses and recommend one', 'compare'],
    ['Give me two different approaches to rate limiting this API', 'compare'],
    // design
    ['帮我设计一个咖啡店的落地页，要有高级感', 'design'],
    ['Design a landing page for my coffee shop', 'design'],
    ['在桌面建立一个文件夹“69420”，然后进入该文件夹，并设为工作区，编写一个卖丝袜的电商网站，UI要高级毛玻璃质感。', 'design'],
    ['网站打不开了，报错 500', 'direct'],
    // long video → Saga
    ['帮我生成一段长视频，讲一只猫在东京的一天', 'saga'],
    ['Make a 2 minute video about a day in Tokyo', 'saga'],
    ['把这个故事想法扩展成 60 秒 Saga 电影感视频。', 'saga'],
    ['Turn this story idea into a 60-second cinematic Saga video.', 'saga'],
    // ...but not short clips, keyword lists or questions about the feature
    ['帮我生成一段30秒左右的视频，内容是在不同的海滩享受阳光和海风。', 'direct'],
    ['图片 视频 长视频', 'direct'],
    ['为什么长视频生成失败了？', 'direct'],
  ];
  await test('classification table: CN + EN heuristics pick the expected workflow without a classifier call', async () => {
    const wrong: string[] = [];
    for (const [text, expected] of table) {
      const route = await routeWorkflow({ text }, { getClassifier: neverClassifier });
      if (route.workflow !== expected || route.source !== 'heuristic') {
        wrong.push(`${text} → ${route.workflow}/${route.source} (${route.reason}), expected ${expected}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  await test('long prose with an editing verb is not engineering: it goes to the classifier, else direct', async () => {
    const essay = '帮我修改这篇文章，让语气更正式一些，同时保留原来的结构。文章内容如下：今天我们团队完成了一个重要的里程碑，经过三个月的努力，新版本终于上线了，大家都很开心，感谢每一位同事的付出，接下来我们还会继续努力，把产品做得更好。';
    const route = await routeWorkflow({ text: essay });
    assert.equal(route.workflow, 'direct');
    assert.equal(route.source, 'fallback');
  });

  await test('user-facing reasons are localized for known heuristics and slash hints', async () => {
    const { describeRouteReason } = await import('../src/core/workflowRouter.js');
    const plan = await routeWorkflow({ text: 'Investigate why the session lock times out under load and fix the root cause in the storage layer' });
    assert.equal(describeRouteReason(plan, 'zh-CN'), '需要先调查的工程任务');
    assert.equal(describeRouteReason(plan, 'en'), plan.reason);
    const hinted = await routeWorkflow({ text: '/contest 缓存方案' });
    assert.equal(describeRouteReason(hinted, 'zh-CN'), '按 /contest 提示');
  });

  await test('signals: attachments add size, a repo lowers the bar for deep engineering work', () => {
    const plain = collectWorkflowSignals({ text: '看看这个' });
    const withImages = collectWorkflowSignals({ text: '看看这个', attachmentCount: 2 });
    assert.ok(withImages.length > plain.length);
    const text = '重构一下 session 存储的锁逻辑';
    assert.equal(collectWorkflowSignals({ text, inCodeRepo: true }).inCodeRepo, true);
  });

  await test('signals: a repo makes a short refactor request a planning task', async () => {
    const text = '重构一下 session 存储层的锁超时和重试处理逻辑';
    assert.equal((await routeWorkflow({ text, inCodeRepo: true })).workflow, 'plan');
    assert.equal((await routeWorkflow({ text, inCodeRepo: false })).workflow, 'direct');
  });

  // ── retired slash words ──────────────────────────────────────────────────
  await test('retired slash words are stripped and only used as a hint', async () => {
    assert.deepEqual(stripRetiredWorkflowSlash('/niko 帮我看看这个函数'), { text: '帮我看看这个函数', retiredSlash: '/niko', hint: 'plan' });
    assert.deepEqual(stripRetiredWorkflowSlash('/CONTEST pick a queue'), { text: 'pick a queue', retiredSlash: '/contest', hint: 'compare' });
    assert.equal(stripRetiredWorkflowSlash('/athena refactor x').hint, 'team');
    assert.equal(stripRetiredWorkflowSlash('/design a hero section').hint, 'design');
    // /team carries no hint: the router decides from the text.
    assert.deepEqual(stripRetiredWorkflowSlash('/team 做个网站'), { text: '做个网站', retiredSlash: '/team', hint: undefined });
    // Other commands and look-alikes are not touched.
    for (const text of ['/help', '/new', '/model gpt', '/saga 一个故事', '/designer foo', '/nidhogg harden it', 'niko fix it']) {
      assert.equal(stripRetiredWorkflowSlash(text).retiredSlash, undefined, text);
      assert.equal(stripRetiredWorkflowSlash(text).text, text);
    }

    const hinted = await routeWorkflow({ text: '/niko 帮我看看这个函数' }, { getClassifier: neverClassifier });
    assert.equal(hinted.workflow, 'plan');
    assert.equal(hinted.source, 'slash-hint');
    assert.equal(hinted.text, '帮我看看这个函数');
    const team = await routeWorkflow({ text: '/team 做个网站' }, { getClassifier: neverClassifier });
    assert.equal(team.workflow, 'design');
    assert.equal(team.text, '做个网站');
    // A bare retired word passes the message on unchanged, on the plain path.
    const bare = await routeWorkflow({ text: '/athena' }, { getClassifier: neverClassifier });
    assert.equal(bare.workflow, 'direct');
    assert.equal(bare.text, '/athena');
    // A Saga request wins over a retired hint.
    assert.equal((await routeWorkflow({ text: '/design 帮我生成一段长视频，讲海边的一天' })).workflow, 'saga');
  });

  await test('dispatcher: only /nidhogg and /run remain explicit workflow commands', () => {
    for (const text of ['/niko fix it', '/athena x', '/contest y', '/design z', '/team w', '用 /niko 模式 修一下']) {
      assert.equal(detectExplicitWorkflowIntent(text).command, null, text);
    }
    assert.equal(detectExplicitWorkflowIntent('/nidhogg harden the parser').command, '/nidhogg');
    assert.equal(detectExplicitWorkflowIntent('/run build it').command, '/run');
    assert.equal(detectExplicitWorkflowIntent('用 /nidhogg 模式').command, '/nidhogg');
    assert.equal(detectExplicitWorkflowIntent('/nidhoggx').command, null);
  });

  // ── Saga ──────────────────────────────────────────────────────────────────
  await test('saga: clear natural-language requests start the wizard; /saga still does; others do not', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'artemis-router-saga-'));
    const store = new ProviderStore(cwd);
    const data = await store.load();
    data.visualProfile = {
      enabled: true,
      image: { provider: 'byteplus', apiKey: 'smoke-key', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', model: 'seedream-5-0-260128' },
      video: { enabled: true, provider: 'byteplus', apiKey: 'smoke-key', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', model: BYTEPLUS_SEEDANCE_2_PRO_MODEL },
    };
    await store.save(data);

    // What the bridge and CLI do: forceIntent = explicit /saga || clear request.
    const start = (key: string, text: string, explicit = false) => handleSagaLongVideoWorkflow({
      scope: 'bridge', key, cwd, locale: 'zh-CN', text,
      forceIntent: explicit || isClearSagaLongVideoRequest(text),
    });
    const natural = await start('natural', '帮我生成一段长视频，讲一只猫在东京的一天');
    assert.equal(natural.handled, true);
    assert.match(natural.handled ? natural.reply : '', /这段视频里/);
    const explicit = await start('explicit', '一个赛博朋克的清晨', true);
    assert.equal(explicit.handled, true);
    const brief = await start('brief', '[0-5秒] 镜头1：女孩推开旧影院的门。\n[5-10秒] 镜头2：她走到银幕前，银幕上映出海浪。');
    assert.equal(brief.handled, true, 'a timecoded multi-segment brief starts Saga');
    for (const text of [
      '帮我生成一段30秒左右的视频，你的角色现在叫饼干姐姐，亚洲女性，内容是在不同的海滩享受阳光和海风。',
      '图片 视频 长视频',
      '为什么长视频生成失败了？',
      'Saga 长视频的代码逻辑有问题，帮我修复',
      '这个解析器处理 [0-5秒] [5-10秒] 的格式有 bug',
    ]) {
      assert.equal(isClearSagaLongVideoRequest(text), false, text);
      assert.equal((await start(`neg-${text.length}`, text)).handled, false, text);
    }
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  // ── classifier: only for ambiguous, substantial requests ─────────────────
  await test('classifier: ambiguous long request asks the classifier once and follows a sound verdict', async () => {
    const calls = { count: 0 };
    const route = await routeWorkflow(
      { text: AMBIGUOUS_LONG },
      { getClassifier: () => fixedClassifier('{"workflow":"plan","complexity":"medium","reason":"needs a plan"}', calls) },
    );
    assert.equal(calls.count, 1);
    assert.equal(route.workflow, 'plan');
    assert.equal(route.source, 'classifier');
  });

  await test('classifier: expensive verdicts without heuristic support are stepped down', async () => {
    const calls = { count: 0 };
    const team = await routeWorkflow(
      { text: AMBIGUOUS_LONG },
      { getClassifier: () => fixedClassifier('{"workflow":"team","complexity":"high","reason":"big"}', calls) },
    );
    assert.equal(team.workflow, 'plan', 'team needs bigProject or a very large request');
    const compare = await routeWorkflow(
      { text: AMBIGUOUS_LONG },
      { getClassifier: () => fixedClassifier('{"workflow":"compare","complexity":"medium","reason":"options"}', calls) },
    );
    assert.equal(compare.workflow, 'direct', 'compare needs an explicit multi-option ask');
    const design = await routeWorkflow(
      { text: AMBIGUOUS_LONG },
      { getClassifier: () => fixedClassifier('{"workflow":"design","complexity":"high","reason":"ui"}', calls) },
    );
    assert.equal(design.workflow, 'direct', 'design needs a UI surface in the request');
    const low = await routeWorkflow(
      { text: AMBIGUOUS_LONG },
      { getClassifier: () => fixedClassifier('{"workflow":"plan","complexity":"low","reason":"easy"}', calls) },
    );
    assert.equal(low.workflow, 'direct');

    const signals = collectWorkflowSignals({ text: 'x' });
    assert.equal(gateClassifierVerdict({ workflow: 'team', complexity: 'high', reason: '' }, { ...signals, bigProject: true }), 'team');
    assert.equal(gateClassifierVerdict({ workflow: 'compare', complexity: 'high', reason: '' }, { ...signals, compareExplicit: true }), 'compare');
  });

  await test('classifier: errors, timeouts, invalid JSON and a missing provider all fall back to direct', async () => {
    const failing: ChatProvider = { async complete() { throw new Error('503 upstream'); } };
    const error = await routeWorkflow({ text: AMBIGUOUS_LONG }, { getClassifier: () => failing });
    assert.equal(error.workflow, 'direct');
    assert.equal(error.source, 'fallback');
    assert.match(error.reason, /classifier failed: 503 upstream/);

    let aborted = false;
    const hanging: ChatProvider = {
      complete(_messages, options) {
        options?.abortSignal?.addEventListener('abort', () => { aborted = true; });
        return new Promise(() => undefined);
      },
    };
    const started = Date.now();
    const timeout = await routeWorkflow({ text: AMBIGUOUS_LONG }, { getClassifier: () => hanging, timeoutMs: 60 });
    assert.equal(timeout.workflow, 'direct');
    assert.match(timeout.reason, /timeout/);
    assert.ok(Date.now() - started < 2_000);
    assert.equal(aborted, true, 'the timed-out classifier request is aborted');
    assert.ok(CLASSIFIER_TIMEOUT_MS <= 10_000, 'default classifier timeout stays short');

    const calls = { count: 0 };
    for (const reply of ['plan', 'Sure! {"workflow":"plan","complexity":"high"}', '{"workflow":"saga","complexity":"high","reason":"x"}', '{"workflow":"plan","complexity":"extreme"}', '']) {
      const route = await routeWorkflow({ text: AMBIGUOUS_LONG }, { getClassifier: () => fixedClassifier(reply, calls) });
      assert.equal(route.workflow, 'direct', reply);
      assert.equal(route.source, 'fallback', reply);
    }
    const throwingFactory = await routeWorkflow({ text: AMBIGUOUS_LONG }, { getClassifier: () => { throw new Error('no profile'); } });
    assert.equal(throwingFactory.workflow, 'direct');
    const none = await routeWorkflow({ text: AMBIGUOUS_LONG });
    assert.equal(none.workflow, 'direct');
    assert.equal(none.source, 'fallback');
  });

  await test('classifier reply parser is strict', () => {
    assert.deepEqual(parseClassifierReply('{"workflow":"team","complexity":"high","reason":"big"}'), { workflow: 'team', complexity: 'high', reason: 'big' });
    assert.deepEqual(parseClassifierReply('```json\n{"workflow":"direct","complexity":"low"}\n```'), { workflow: 'direct', complexity: 'low', reason: 'classifier' });
    assert.equal(parseClassifierReply('[{"workflow":"plan","complexity":"low"}]'), null);
    assert.equal(parseClassifierReply('{"workflow":"nidhogg","complexity":"high"}'), null);
  });

  // ── cost bounds ──────────────────────────────────────────────────────────
  await test('cost bounds: every workflow has a sub-agent cap no higher than the per-run ceiling', () => {
    assert.equal(MAX_SUB_AGENTS_PER_RUN, 4);
    for (const [workflow, budget] of Object.entries(WORKFLOW_BUDGETS)) {
      assert.ok(budget.maxSubAgents <= MAX_SUB_AGENTS_PER_RUN, workflow);
      assert.ok(budget.maxRounds <= 2, workflow);
    }
    assert.equal(WORKFLOW_BUDGETS.compare.maxCandidates, 3);
    assert.equal(WORKFLOW_BUDGETS.direct.maxSubAgents, 2);
    assert.equal(WORKFLOW_BUDGETS.saga.maxSubAgents, 0);
  });

  await test('cost bounds: the budget refuses sub-agents past the cap; use_workflow raises it only up to the ceiling', () => {
    const delegate: AgentAction = { type: 'delegate_task', role: 'reviewer', task: 'review' };
    const background: AgentAction = { type: 'spawn_background_workflow', command: 'run', prompt: 'x' };
    const read: AgentAction = { type: 'read_file', path: 'a.ts' } as AgentAction;
    const budget = createDelegationBudget('direct');
    assert.equal(checkDelegationBudget(read, budget), undefined);
    assert.equal(checkDelegationBudget(delegate, budget), undefined);
    assert.equal(checkDelegationBudget(background, budget), undefined);
    assert.match(checkDelegationBudget(delegate, budget) ?? '', /Sub-agent budget used up \(2 of 2/);
    assert.equal(budget.used, 2);
    // Escalating to a lighter workflow never lowers the limit...
    checkDelegationBudget({ type: 'use_workflow', workflow: 'plan' }, budget);
    assert.equal(budget.limit, 2);
    // ...escalating to team raises it to team's cap, never above the ceiling.
    checkDelegationBudget({ type: 'use_workflow', workflow: 'team' }, budget);
    assert.equal(budget.limit, MAX_SUB_AGENTS_PER_RUN);
    assert.equal(budget.workflow, 'team');
    checkDelegationBudget(delegate, budget);
    checkDelegationBudget(delegate, budget);
    assert.ok(checkDelegationBudget(delegate, budget));
    assert.equal(budget.used, MAX_SUB_AGENTS_PER_RUN);
    // No budget: nothing is limited (explicit /nidhogg and tests keep their behaviour).
    assert.equal(checkDelegationBudget(delegate, undefined), undefined);
    assert.equal(createDelegationBudget('saga').limit, 0);
  });

  await test('playbooks: routed hints carry the budget and no slash command names', () => {
    for (const workflow of ['plan', 'team', 'compare', 'design', 'saga'] as const) {
      const hint = buildRoutedWorkflowHint(workflow, { cwd: '/tmp', userPrompt: '做一个网站', reason: 'test' });
      assert.match(hint, /chose this workflow automatically/);
      assert.doesNotMatch(hint, /\/(?:niko|athena|contest|team|design)\b/, workflow);
      if (workflow !== 'saga') assert.match(hint, new RegExp(`At most ${WORKFLOW_BUDGETS[workflow].maxSubAgents} sub-agent`));
    }
    assert.match(buildRoutedWorkflowHint('compare', { cwd: '/tmp', userPrompt: 'x' }), /at most 3 candidate/i);
    assert.match(buildRoutedWorkflowHint('saga', { cwd: '/tmp', userPrompt: 'x' }), /generate_long_video/);
    assert.match(buildRoutedWorkflowHint('design', { cwd: '/tmp', userPrompt: 'x' }), /design-workflow 技能/);
    assert.equal(buildRoutedWorkflowHint('direct', { cwd: '/tmp', userPrompt: 'x' }), '');
  });

  // ── use_workflow tool ─────────────────────────────────────────────────────
  await test('use_workflow: main agent and the CLI tool loop can switch workflow; the tool returns the playbook', async () => {
    assert.ok(getAllowedActionTypesForProfile('main').includes('use_workflow'));
    assert.ok(!getAllowedActionTypesForProfile('reviewer').includes('use_workflow'));
    assert.ok(listDirectToolNames().includes('use_workflow'));
    const result = await executeAction({ type: 'use_workflow', workflow: 'compare', reason: 'several designs' }, { cwd: process.cwd() });
    assert.equal(result.ok, true);
    assert.match(result.output, /Switched to the compare workflow/);
    assert.match(result.output, /多方案对比/);
    assert.match(result.output, /At most 4 sub-agent/);
    const invalid = await executeAction({ type: 'use_workflow', workflow: 'swarm' } as unknown as AgentAction, { cwd: process.cwd() });
    assert.equal(invalid.ok, false);
  });

  // ── runAgent integration ─────────────────────────────────────────────────
  await test('runAgent: a used-up budget refuses delegate_task; the playbook is per-run context, not stored', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'artemis-router-agent-'));
    const store = new SessionStore(tmpDir);
    const session = store.createSession({ title: 'router budget smoke' });
    await store.save(session);
    const PLAYBOOK = '[Workflow budget — smoke playbook marker]';
    let calls = 0;
    let sawPlaybook = false;
    let toolOutput = '';
    const provider: ChatProvider = {
      async complete(messages): Promise<ProviderResponse> {
        calls += 1;
        sawPlaybook ||= messages.some((message) => message.content.includes(PLAYBOOK));
        if (calls === 1) {
          return {
            text: JSON.stringify({
              reply: 'Delegating a review.',
              done: false,
              actions: [{ type: 'delegate_task', role: 'reviewer', task: 'Review the change.' }],
            }),
            raw: null,
          };
        }
        toolOutput = messages.filter((message) => message.role === 'tool').map((message) => message.content).join('\n');
        return { text: JSON.stringify({ reply: 'Done without a reviewer.', done: true }), raw: null };
      },
    };
    const budget = createDelegationBudget('direct');
    budget.limit = 0;
    const result = await runAgent(session, 'Review my change.', {
      cwd: tmpDir,
      provider,
      sessionStore: store,
      permissionManager: new PermissionManager('accept-all', false),
      maxTurns: 3,
      profile: 'main',
      workflowHint: PLAYBOOK,
      delegationBudget: budget,
    });
    assert.equal(sawPlaybook, true, 'the playbook reaches the model');
    assert.match(toolOutput, /Sub-agent budget used up/);
    assert.equal(budget.used, 0);
    assert.match(result.reply, /Done without a reviewer/);
    const stored = JSON.stringify((await store.load(session.id)).messages);
    assert.ok(!stored.includes(PLAYBOOK), 'the playbook is never stored in the session');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  console.log(`\n  ✔ ${passed} workflow router tests passed (${table.length} classification cases)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
