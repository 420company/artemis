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
  looksLikeSagaRequest,
  parseClassifierReply,
  routeWorkflow,
  stripRetiredWorkflowSlash,
  type AutoWorkflow,
} from '../src/core/workflowRouter.js';
import { detectExplicitWorkflowIntent } from '../src/core/workflowDispatcher.js';
import {
  buildSagaOfferQuestion,
  handleSagaLongVideoWorkflow,
  hasActiveSagaLongVideoWorkflow,
  isClearSagaLongVideoRequest,
  looksLikeSagaWizardAnswer,
  parseRequestedVideoSeconds,
  offerSagaLongVideoWorkflow,
  parseSagaOfferReply,
} from '../src/tools/visual/sagaWorkflow.js';
import { finishSagaIfGenerated, normalizeHeadlessIntent, planHeadlessWorkflow } from '../src/services/headlessWorkflow.js';
import { isSagaSessionActive } from '../src/core/sagaSessionState.js';
import { maybeRerouteToSagaLongVideo } from '../src/core/agent.js';
import { resolveWorkflowClassifierProvider } from '../src/providers/workflowClassifier.js';
import { BYTEPLUS_SEEDANCE_2_PRO_MODEL } from '../src/tools/visual/videoCapabilities.js';
import { ProviderStore } from '../src/providers/store.js';
import { executeAction } from '../src/tools/index.js';
import { getAllowedActionTypesForProfile } from '../src/core/agentProfiles.js';
import { listDirectToolNames } from '../src/tools/directTools.js';
import { runAgent } from '../src/core/agent.js';
import { SessionStore } from '../src/storage/sessions.js';
import { parseArgs } from '../src/cli/parseArgs.js';
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
// The same, but an engineering request (an editing verb, no file references).
const AMBIGUOUS_ENGINEERING =
  'Our nightly export job sometimes writes the same customer rows twice when the upstream API is slow. ' +
  'It started after we moved the job to the new scheduler last month, and support keeps finding duplicates ' +
  'in the monthly invoices. Nobody on the team remembers exactly how the retries were set up back then. ' +
  'Please fix this properly so that it cannot happen again, and tell me what you changed.';

async function main(): Promise<void> {
  console.log('\n  workflowRouterSmoke');
  console.log('  ==================');

  // ── acceptance table ──────────────────────────────────────────────────────
  // The review's 77-case route table (expected routes after its decisions:
  // questions, idea lists, writing tasks and retired slash words never reach
  // the expensive workflows; Saga is only for new long-video requests), plus
  // its Saga false-positive, question/writing and slash-command probes.
  const table: Array<[string, AutoWorkflow, boolean?]> = [
    // [message, expected, inCodeRepo]
    ['你好', 'direct'],
    ['在吗', 'direct'],
    ['thanks!', 'direct'],
    ['今天天气怎么样？', 'direct'],
    ['什么是 React Server Components？', 'direct'],
    ['帮我把 README.md 里的错别字改一下', 'direct'],
    ['fix the typo in src/index.ts', 'direct'],
    ['帮我修复 src/a.ts 和 src/b.ts 里的类型错误', 'plan', true],
    ['重构一下整个仓库的日志模块，迁移到 pino，所有文件都要改', 'team', true],
    ['帮我做个完整的电商网站', 'team'],
    ['帮我做个完整的电商网站，前端用 React，后端 Node，带登录和数据库', 'team'],
    ['帮我做一个个人博客网站', 'design'],
    ['给我三个方案', 'direct'],
    ['给我三个方案，怎么给这个服务加缓存', 'direct'],
    ['对比一下A和B', 'direct'],
    ['对比一下 Vue 和 React 哪个好？', 'direct'],
    ['Redis 和 Memcached 有什么区别？', 'direct'],
    ['what are the pros and cons of Rust vs Go?', 'direct'],
    ['which approach is better for caching, LRU or LFU?', 'direct'],
    ['给我三个标题建议', 'direct'],
    ['帮我起三个名字', 'direct'],
    ['帮我设计一个 logo', 'direct'],
    ['帮我设计一个落地页', 'design'],
    ['这个网站打不开了，报错 500', 'direct'],
    ['首页样式乱了，帮我修一下', 'direct'],
    ['生成一个15秒的视频，猫在跳舞', 'direct'],
    ['帮我做一个30秒的产品宣传视频', 'direct'],
    ['帮我做一个60秒的产品宣传视频', 'saga'],
    ['帮我生成一个1分钟的短片，讲一个宇航员回家的故事', 'saga'],
    ['长视频是什么', 'direct'],
    ['长视频是什么？', 'direct'],
    ['saga怎么用', 'direct'],
    ['saga 怎么用？', 'direct'],
    ['帮我写个saga的代码', 'direct'],
    ['帮我写个 saga 模式的 redux 代码', 'direct'],
    ['用 redux-saga 实现一个登录流程', 'direct'],
    ['帮我实现一个 saga pattern 的分布式事务', 'direct'],
    ['图片 视频 长视频', 'direct'],
    ['我之前用 /team 很好用', 'direct'],
    ['看看 https://github.com/foo/team 这个仓库', 'direct'],
    ['/team 帮我把这个项目的测试补全', 'direct'],
    ['/niko 研究一下这个 bug', 'plan'],
    ['/contest 怎么做缓存', 'direct'],
    ['/athena hi', 'direct'],
    ['/design', 'direct'],
    ['继续', 'direct'],
    ['1', 'direct'],
    ['9:16', 'direct'],
    ['默认', 'direct'],
    ['好的，按方案二来', 'direct'],
    ['0-5s 镜头一：城市清晨\n5-10s 镜头二：主角出门', 'saga'],
    ['00:00-00:05 开场\n00:05-00:10 结尾', 'direct'],
    ['0-5s 开场\n5-10s 结尾，帮我写成文案', 'direct'],
    ['会议纪要：0-5s 讨论预算；5-10s 讨论视频方案', 'direct'],
    ['请把这个视频的 00:10-00:20 和 00:30-00:40 剪掉', 'direct'],
    ['make a 2 minute video about space exploration', 'saga'],
    ['make a long video', 'saga'],
    ['how do I make a long video?', 'direct'],
    ['can you make long videos?', 'direct'],
    ['你能做长视频吗', 'direct'],
    ['你能生成1分钟的视频吗？', 'direct'],
    ['帮我把这段 90 秒的视频剪成 30 秒', 'direct'],
    ['帮我总结一下这个 60 分钟的视频', 'direct'],
    ['写一个视频脚本，大概 2 分钟', 'direct'],
    ['帮我写一个 3 分钟的视频文案', 'direct'],
    ['给我做个视频，1分钟左右，介绍我们公司', 'saga'],
    ['Write a test for parser.ts', 'direct'],
    ['帮我分析一下这三个方案哪个好：A用Redis，B用本地缓存，C用CDN', 'direct'],
    ['帮我比较一下这两种做法', 'direct'],
    ['评估一下我们的技术选型', 'direct'],
    ['我们之前讨论过多方案对比，结果是用 A', 'direct'],
    ['frontend and backend are both broken after the deploy, error 500 everywhere', 'direct'],
    ['build a dashboard for our sales data', 'design'],
    ['帮我写一篇关于完整的电商网站的文章', 'direct'],
    ['完整的项目文档在哪里？', 'direct'],
    ['从零开始学 Python 应该怎么做', 'direct'],
    ['帮我做个完整的PPT', 'direct'],
    // Saga false positives: editing / converting footage, software about
    // video, text-only deliverables, reviews of timecoded text.
    ['帮我把这段 90 秒的视频剪成 30 秒', 'direct'],
    ['把这个 2 分钟的视频加上中文字幕', 'direct'],
    ['帮我把这个长视频剪成几个短视频', 'direct'],
    ['帮我把 video.mp4 转成 gif，大概 1 分钟', 'direct'],
    ['帮我做一个长视频平台的前端页面', 'design'],
    ['帮我做一个视频网站，首页放 60 秒的宣传片', 'design'],
    ['用 ffmpeg 把这个 3 分钟的视频压缩一下', 'direct'],
    ['帮我总结这个视频的内容：\n00:00-01:30：介绍产品\n01:30-03:00：演示功能', 'direct'],
    ['这是我的分镜脚本，帮我检查有没有错别字：\n[0-5秒] 城市清晨\n[5-10秒] 主角出门', 'direct'],
    ['[0-8秒] 城市清晨，主角醒来\n[8-16秒] 主角出门，镜头跟随', 'saga'],
    ['0-8s: 城市清晨，主角醒来\n8-16s: 主角出门，镜头跟随', 'saga'],
    ['Make a 90 second highlight reel from these clips', 'direct'],
    ['please render the scene in 60fps', 'direct'],
    ['make the video 2 minutes shorter', 'direct'],
    ['帮我写一个生成长视频的 Python 脚本', 'direct'],
    ['帮我做一个长视频剪辑工具', 'direct'],
    ['做一个 1 分钟倒计时的网页', 'design'],
    ['帮我做一个 60 秒倒计时动画', 'direct'],
    ['给我拍一段 1 分钟的 vlog 的拍摄建议', 'direct'],
    ['帮我把这一分钟的会议录像做成纪要', 'direct'],
    ['turn this 5 minute podcast into a summary', 'direct'],
    ['create a 10 minute workout plan video script', 'direct'],
    ['Generate a long video explanation of how transformers work? no, just text please', 'direct'],
    ['把这个电影的前 2 分钟翻译成中文', 'direct'],
    ['帮我做一个完整的视频播放器组件', 'direct'],
    // Questions, idea lists and writing tasks.
    ['我是做前端的，后端不太懂，能解释一下 REST 吗？', 'direct'],
    ['前端和后端分别要写什么？', 'direct'],
    ['I write frontend code; what does a backend engineer do?', 'direct'],
    ['what does full-stack mean?', 'direct'],
    ['端到端测试是什么？怎么写？', 'direct'],
    ['全栈工程师要学什么？', 'direct'],
    ['帮我写一个从零开始的学习计划', 'direct'],
    ['帮我做个PPT介绍我们的网站', 'direct'],
    ['网站首页的文案帮我写一下', 'direct'],
    ['帮我写一段 landing page 的文案', 'direct'],
    ['write the copy for our homepage', 'direct'],
    ['make the website copy more friendly', 'direct'],
    ['Explain the trade-offs between REST and GraphQL', 'direct'],
    ['compare these two options for me: postgres or mysql?', 'direct'],
    ['你觉得这三个方案哪个好？', 'direct'],
    ['帮我列出几种不同的做法', 'direct'],
    ['give me 3 ideas for a birthday party', 'direct'],
    ['suggest two options for dinner', 'direct'],
    ['list several alternatives to Notion', 'direct'],
    ['/athena 你好', 'direct'],
    ['/contest 1+1等于几', 'direct'],
    // Slash commands are never Saga.
    ['/nidhogg 帮我写一个生成长视频的 Python 脚本', 'direct'],
    ['/run 帮我做一个60秒的视频', 'direct'],
    ['/nidhogg 重构 saga 长视频模块，把多段视频生成改成并行', 'direct'],
    ['/niko 帮我写个生成长视频的脚本', 'plan'],
    ['/team 帮我做一个长视频剪辑工具', 'direct'],
    ['/design 帮我生成一段长视频，讲海边的一天', 'direct'],
    // Correct routes that must stay.
    ['Python 里 list 和 tuple 有什么区别？', 'direct'],
    ['帮我写一个 Python 脚本，把这个目录里的图片都转成 webp', 'direct'],
    ['把这 2 个实现合并一下', 'direct'],
    ['帮我完整地检查一下这个项目', 'direct'],
    ['排查一下为什么 bridge 在 Telegram 上发图片会超时，看看 src/bragi/runtime.ts 和 src/telegram 下的上传逻辑，找到根因并修复', 'plan'],
    ['Investigate why the session lock times out under load and fix the root cause in the storage layer', 'plan'],
    ['Build a complete full-stack e-commerce app with a React frontend, a Node backend, auth and tests', 'team'],
    ['Refactor the auth module across the whole codebase to use the new token service', 'team'],
    ['给我三个方案比较一下，选最好的实现', 'compare'],
    ['Try three different approaches to the cache layer and pick the best one', 'compare'],
    ['Design a landing page for my coffee shop', 'design'],
    ['在桌面建立一个文件夹“69420”，然后进入该文件夹，并设为工作区，编写一个卖丝袜的电商网站，UI要高级毛玻璃质感。', 'design'],
    ['帮我设计一个咖啡店的落地页，要有高级感', 'design'],
    ['帮我生成一段长视频，讲一只猫在东京的一天', 'saga'],
    ['Turn this story idea into a 60-second cinematic Saga video.', 'saga'],
    ['帮我生成一段30秒左右的视频，内容是在不同的海滩享受阳光和海风。', 'direct'],
    // Round 3: statements, lists, transcripts and small writing tasks.
    ['推荐几部好看的短片', 'direct'],
    ['这个预告片什么时候上映', 'direct'],
    ['vlog怎么剪', 'direct'],
    ['写一个一分钟的自我介绍', 'direct'],
    ['MV的歌词是什么', 'direct'],
    ['帮我写一个一分钟的自我介绍视频的台词', 'direct'],
    ['帮我做一个十分精彩的视频', 'direct'],
    ['帮我做一个十分钟内能看完的视频清单', 'direct'],
    ['Make a 90s-style music video', 'direct'],
    ['make a 1980s retro video for my band', 'direct'],
    ['帮我生成一个满分作文范文视频', 'direct'],
    ['我想要一个3分钟的番茄钟', 'direct'],
    ['我要一个5分钟后的提醒', 'direct'],
    ['我需要一个60秒的广告片脚本', 'direct'],
    ['[00:00-00:15] 张三：大家好\n[00:15-00:30] 李四：今天讨论预算\n[00:30-00:45] 王五：同意', 'direct'],
    ['[0-5s] intro\n[5-10s] verse\n[10-20s] chorus', 'direct'],
    ['帮我把这个字幕文件翻译成英文：\n[00:00-00:05] Hello\n[00:05-00:10] World', 'direct'],
    ['【BGM】有什么推荐？', 'direct'],
    ['我们公司从零搭建了一个系统，你觉得怎么样？', 'direct'],
    ['我们公司从零搭建了一个完整的电商系统，前端后端都有。', 'direct'],
    ['我是前端开发，后端是同事负责的', 'direct'],
    ['上周我们重构了整个仓库', 'direct'],
    ['他们开发了一个完整的平台，包括用户、订单、支付', 'direct'],
    ['这个 SaaS 平台是谁开发的', 'direct'],
    ['帮我看看这个平台：用户系统、订单、支付这三块哪块最慢', 'direct'],
    ['我做了三个版本，你帮我选一个最好的', 'direct'],
    ['设计三个 logo，挑一个最好的', 'compare'],
    ['写三个标题，选最好的', 'direct'],
    ['给我三个名字，选一个最好的', 'direct'],
    ['出三套试卷，比较难度', 'direct'],
    ['想三个周末活动，挑一个最好的', 'direct'],
    ['做个60s的宣传视频', 'saga'],
  ];
  await test(`acceptance table: ${table.length} CN + EN cases route as expected without a classifier call`, async () => {
    const wrong: string[] = [];
    for (const [text, expected, inCodeRepo] of table) {
      const route = await routeWorkflow({ text, inCodeRepo: inCodeRepo ?? false }, { getClassifier: neverClassifier });
      if (route.workflow !== expected) {
        wrong.push(`${JSON.stringify(text)} → ${route.workflow}/${route.source} (${route.reason}), expected ${expected}`);
      }
    }
    assert.deepEqual(wrong, []);
  });

  await test('long prose with an editing verb is not engineering: it goes to the classifier, else direct', async () => {
    const essay = '帮我修改这篇文章，让语气更正式一些，同时保留原来的结构。文章内容如下：今天我们团队完成了一个重要的里程碑，经过三个月的努力，新版本终于上线了，大家都很开心，感谢每一位同事的付出，接下来我们还会继续努力，把产品做得更好。';
    const route = await routeWorkflow({ text: essay });
    assert.equal(route.workflow, 'direct');
  });

  await test('user-facing reasons are localized for known heuristics', async () => {
    const { describeRouteReason } = await import('../src/core/workflowRouter.js');
    const plan = await routeWorkflow({ text: 'Investigate why the session lock times out under load and fix the root cause in the storage layer' });
    assert.equal(describeRouteReason(plan, 'zh-CN'), '需要先调查的工程任务');
    assert.equal(describeRouteReason(plan, 'en'), plan.reason);
    const hinted = await routeWorkflow({ text: '/niko 研究一下这个 bug' });
    assert.equal(describeRouteReason(hinted, 'zh-CN'), '按 /niko 提示');
  });

  await test('signals: attachments add size, a repo lowers the bar for deep engineering work', async () => {
    const plain = collectWorkflowSignals({ text: '看看这个' });
    const withImages = collectWorkflowSignals({ text: '看看这个', attachmentCount: 2 });
    assert.ok(withImages.length > plain.length);
    const text = '重构一下 session 存储层的锁超时和重试处理逻辑';
    assert.equal((await routeWorkflow({ text, inCodeRepo: true })).workflow, 'plan');
    assert.equal((await routeWorkflow({ text, inCodeRepo: false })).workflow, 'direct');
  });

  // ── retired slash words ──────────────────────────────────────────────────
  await test('retired slash words are stripped and never force a workflow', async () => {
    assert.deepEqual(stripRetiredWorkflowSlash('/niko 帮我看看这个函数'), { text: '帮我看看这个函数', retiredSlash: '/niko', hint: 'plan' });
    assert.equal(stripRetiredWorkflowSlash('/CONTEST pick a queue').retiredSlash, '/contest');
    for (const text of ['/help', '/new', '/model gpt', '/saga 一个故事', '/designer foo', '/nidhogg harden it', 'niko fix it']) {
      assert.equal(stripRetiredWorkflowSlash(text).retiredSlash, undefined, text);
      assert.equal(stripRetiredWorkflowSlash(text).text, text);
    }
    const plain = await routeWorkflow({ text: '/niko 帮我看看这个函数' }, { getClassifier: neverClassifier });
    assert.equal(plain.workflow, 'direct', 'the /niko hint only applies to engineering requests');
    assert.equal(plain.text, '帮我看看这个函数');
    const team = await routeWorkflow({ text: '/team 做个网站' }, { getClassifier: neverClassifier });
    assert.equal(team.workflow, 'design');
    assert.equal(team.text, '做个网站');
    const bare = await routeWorkflow({ text: '/athena' }, { getClassifier: neverClassifier });
    assert.equal(bare.workflow, 'direct');
    assert.equal(bare.text, '/athena');
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

  // ── Saga: offer, confirm, decline ─────────────────────────────────────────
  await test('saga: a natural request is only offered; the wizard starts after yes, /saga starts at once', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'artemis-router-saga-'));
    const store = new ProviderStore(cwd);
    const data = await store.load();
    data.visualProfile = {
      enabled: true,
      image: { provider: 'byteplus', apiKey: 'smoke-key', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', model: 'seedream-5-0-260128' },
      video: { enabled: true, provider: 'byteplus', apiKey: 'smoke-key', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', model: BYTEPLUS_SEEDANCE_2_PRO_MODEL },
    };
    await store.save(data);
    const send = (key: string, text: string, forceIntent = false) =>
      handleSagaLongVideoWorkflow({ scope: 'bridge', key, cwd, locale: 'zh-CN', text, forceIntent });
    const request = '帮我生成一段长视频，讲一只猫在东京的一天';
    assert.equal(looksLikeSagaRequest(request), true);

    // Without an offer the wizard never starts by itself.
    assert.equal((await send('plain', request)).handled, false);

    // Offer → "1" → wizard.
    const question = await offerSagaLongVideoWorkflow({ scope: 'bridge', key: 'yes', cwd, locale: 'zh-CN', text: request });
    assert.match(question ?? '', /要我帮你做成一段完整的长视频吗[\s\S]*1\. 好，开始[\s\S]*2\. 不用了/);
    assert.equal(hasActiveSagaLongVideoWorkflow('bridge', 'yes'), true, 'a pending offer keeps replies away from the router');
    const yes = await send('yes', '1');
    assert.equal(yes.handled, true);
    assert.match(yes.handled ? yes.reply : '', /这段视频里/);

    // Offer → "不是" → the original request goes on the normal path.
    await offerSagaLongVideoWorkflow({ scope: 'bridge', key: 'no', cwd, locale: 'zh-CN', text: request });
    const no = await send('no', '不是');
    assert.equal(no.handled, false);
    assert.equal(!no.handled && no.replayText, request);
    assert.equal(hasActiveSagaLongVideoWorkflow('bridge', 'no'), false);

    // Offer → an unrelated message: the offer lapses, the message is not consumed.
    await offerSagaLongVideoWorkflow({ scope: 'bridge', key: 'other', cwd, locale: 'zh-CN', text: request });
    const other = await send('other', '帮我查一下明天的天气');
    assert.equal(other.handled, false);
    assert.equal(!other.handled && other.replayText, undefined);
    assert.equal(hasActiveSagaLongVideoWorkflow('bridge', 'other'), false);

    // /saga: immediate.
    assert.equal((await send('explicit', '一个赛博朋克的清晨', true)).handled, true);

    // Slash-prefixed messages are never offered Saga.
    assert.equal(looksLikeSagaRequest('/nidhogg 帮我写一个生成长视频的 Python 脚本'), false);
    assert.equal(looksLikeSagaRequest('/run 帮我做一个60秒的视频'), false);

    // No video provider: no offer.
    const bare = await mkdtemp(path.join(os.tmpdir(), 'artemis-router-saga-none-'));
    assert.equal(await offerSagaLongVideoWorkflow({ scope: 'bridge', key: 'none', cwd: bare, locale: 'zh-CN', text: request }), undefined);
    for (const reply of ['1', '是', '好的', 'yes', '1. 是，开始']) assert.equal(parseSagaOfferReply(reply), 'yes', reply);
    for (const reply of ['2', '不是', 'no', '算了']) assert.equal(parseSagaOfferReply(reply), 'no', reply);
    assert.equal(parseSagaOfferReply('帮我做个网站'), undefined);
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  });

  await test('headless (web): Saga is asked first; state, not a marker, keeps wizard answers in Saga; other turns end it', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'artemis-router-headless-'));
    const store = new SessionStore(tmpDir);
    const session = store.createSession({ title: 'headless saga' });
    const base = {
      session, cwd: tmpDir, attachmentCount: 0, inCodeRepo: false, autoRoute: true,
      getClassifier: async () => undefined, hasVideoProvider: async () => true,
    };
    const offer = await planHeadlessWorkflow({ ...base, prompt: '帮我做一个60秒的产品宣传视频' });
    assert.equal(offer.kind, 'reply');
    const offerText = offer.kind === 'reply' ? offer.reply : '';
    assert.match(offerText, /要我帮你做成一段完整的长视频吗/);
    assert.doesNotMatch(offerText, /saga|费用|计费/i, 'no internal name and no cost wording');
    assert.match(offerText, /```choices\n\{"options":\["好，开始","不用了"\]\}\n```/, 'the web gets a clickable choices card');
    assert.equal(offerText.split('要我帮你做成一段完整的长视频吗').length, 2, 'the intro is not repeated inside the card');
    // A question about the offer drops it and is answered normally.
    const price = await planHeadlessWorkflow({ ...base, prompt: '要多少钱？' });
    assert.equal(price.kind === 'run' && price.workflow, 'direct');
    assert.equal(session.metadata?.workflowRouting, undefined);

    await planHeadlessWorkflow({ ...base, prompt: '帮我做一个60秒的产品宣传视频' });
    const yes = await planHeadlessWorkflow({ ...base, prompt: '是，开始' });
    assert.equal(yes.kind === 'run' && yes.workflow, 'saga');
    assert.equal(yes.kind === 'run' && yes.prompt, '帮我做一个60秒的产品宣传视频', 'the stored request is the user\'s own text, no marker');
    assert.match(yes.kind === 'run' ? yes.hint : '', /generate_long_video/);
    assert.equal(isSagaSessionActive(session), true);
    for (const answer of ['9:16', '60秒', '2', '带字幕', '[0-8秒] 城市清晨\n[8-16秒] 主角出门']) {
      const step = await planHeadlessWorkflow({ ...base, prompt: answer });
      assert.equal(step.kind === 'run' && step.workflow, 'saga', `wizard answer ${answer} stays in Saga`);
    }
    // Unrelated direct turns end it (and do not refresh it).
    const mail = await planHeadlessWorkflow({ ...base, prompt: '帮我写一封邮件给老板，说我明天请假' });
    assert.equal(mail.kind === 'run' && mail.workflow, 'direct');
    assert.equal(isSagaSessionActive(session), false);
    const after = await planHeadlessWorkflow({ ...base, prompt: '9:16' });
    assert.equal(after.kind === 'run' && after.workflow, 'direct');

    // A generated long video ends it too.
    await planHeadlessWorkflow({ ...base, prompt: '/saga 一个赛博朋克的清晨' });
    assert.equal(isSagaSessionActive(session), true, '/saga is immediate');
    const done = finishSagaIfGenerated(session, [
      { id: 't', role: 'tool', name: 'generate_long_video', content: JSON.stringify({ ok: true, output: '/tmp/v.mp4' }), createdAt: new Date().toISOString() },
    ]);
    assert.equal(done, true);
    assert.equal(isSagaSessionActive(session), false);

    await planHeadlessWorkflow({ ...base, prompt: 'make a 2 minute video about space exploration' });
    const no = await planHeadlessWorkflow({ ...base, prompt: 'no' });
    assert.equal(no.kind === 'run' && no.workflow, 'direct');
    assert.equal(no.kind === 'run' && no.prompt, 'make a 2 minute video about space exploration');

    const noVideo = await planHeadlessWorkflow({ ...base, prompt: 'make a long video', hasVideoProvider: async () => false, session: store.createSession({ title: 'x' }) });
    assert.equal(noVideo.kind === 'run' && noVideo.workflow, 'direct');
    // A Goal Mode tick after a confirmed Saga ends it.
    const goalSession = store.createSession({ title: 'y' });
    await planHeadlessWorkflow({ ...base, session: goalSession, prompt: '帮我生成一段长视频，讲雨夜' });
    await planHeadlessWorkflow({ ...base, session: goalSession, prompt: '1' });
    const tick = await planHeadlessWorkflow({ ...base, session: goalSession, prompt: '[Goal tick] continue working toward goal: refactor auth module', autoRoute: false });
    assert.equal(tick.kind === 'run' && tick.workflow, 'direct');
    assert.equal(isSagaSessionActive(goalSession), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await test('headless --intent: long_video starts at once, image/reminder get a run-context hint, research plans, unknown is ignored', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'artemis-router-intent-'));
    const store = new SessionStore(tmpDir);
    const infos: string[] = [];
    const base = {
      cwd: tmpDir, attachmentCount: 0, inCodeRepo: false, autoRoute: true,
      getClassifier: async () => undefined, hasVideoProvider: async () => true, onInfo: (message: string) => infos.push(message),
    };
    // long_video: no question first, the stored request is the user's own text.
    const longSession = store.createSession({ title: 'intent long video' });
    const longVideo = await planHeadlessWorkflow({ ...base, session: longSession, intent: 'long_video', prompt: '一只小猫在雨夜的城市里冒险' });
    assert.equal(longVideo.kind, 'run', 'no offer for an explicit long-video intent');
    assert.equal(longVideo.kind === 'run' && longVideo.workflow, 'saga');
    assert.equal(longVideo.kind === 'run' && longVideo.prompt, '一只小猫在雨夜的城市里冒险');
    assert.equal(isSagaSessionActive(longSession), true);
    const prefixed = await planHeadlessWorkflow({ ...base, session: store.createSession({ title: 'p' }), intent: 'long-video', prompt: '/saga 雨夜' });
    assert.equal(prefixed.kind === 'run' && prefixed.prompt, '雨夜', 'a typed command prefix is not stored');
    // A wizard answer after it stays in the long video.
    const step = await planHeadlessWorkflow({ ...base, session: longSession, prompt: '9:16' });
    assert.equal(step.kind === 'run' && step.workflow, 'saga');

    for (const [intent, workflow, hintPattern] of [
      ['image', 'direct', /generate_image/],
      ['reminder', 'direct', /schedule_create/],
      ['research', 'plan', /Workflow budget — plan[\s\S]*researched answer/],
    ] as const) {
      const session = store.createSession({ title: `intent ${intent}` });
      const plan = await planHeadlessWorkflow({ ...base, session, intent, prompt: '帮我做一个3分钟的长视频，讲雨夜' });
      assert.equal(plan.kind, 'run', `${intent}: an explicit intent is never answered with the long-video question`);
      assert.equal(plan.kind === 'run' && plan.workflow, workflow, intent);
      assert.equal(plan.kind === 'run' && plan.prompt, '帮我做一个3分钟的长视频，讲雨夜', `${intent}: the hint is not part of the stored message`);
      assert.match(plan.kind === 'run' ? plan.hint : '', hintPattern, intent);
      assert.match(plan.kind === 'run' ? plan.hint : '', /never name workflows, tools, models or providers/);
    }
    const unknown = await planHeadlessWorkflow({ ...base, session: store.createSession({ title: 'u' }), intent: 'teleport', prompt: '帮我写一封请假邮件' });
    assert.equal(unknown.kind === 'run' && unknown.workflow, 'direct');
    assert.ok(infos.some((line) => /unknown intent "teleport" ignored/.test(line)), 'an unknown intent warns');
    const readOnly = await planHeadlessWorkflow({ ...base, session: store.createSession({ title: 'r' }), intent: 'long_video', autoRoute: false, prompt: '雨夜' });
    assert.equal(readOnly.kind === 'run' && readOnly.workflow, 'direct', 'a read-only run never starts generation');
    assert.equal(normalizeHeadlessIntent('LongVideo'), 'long_video');
    assert.equal(normalizeHeadlessIntent('Long_Video'), 'long_video');
    assert.equal(normalizeHeadlessIntent('nope'), undefined);
    // The CLI flag.
    assert.equal(parseArgs(['execute', '--session', '11111111-1111-4111-8111-111111111111', '--intent', 'image', 'draw a cat']).intent, 'image');
    assert.equal(parseArgs(['execute', '--intent=research', 'compare databases']).intent, 'research');
    assert.equal(parseArgs(['execute', '--intent=research', 'compare databases']).prompt, 'compare databases');
    assert.equal(parseArgs(['execute', 'hello']).intent, undefined);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  await test('generate_video → generate_long_video safety net: only for an active or recent, unfinished Saga', () => {
    const video: AgentAction = { type: 'generate_video', prompt: 'a cat', duration: 10 } as AgentAction;
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const marker = '[Artemis Saga long video workflow]\ntotalDuration: 60';
    const mk = (messages: Array<{ role: string; name?: string; content: string; createdAt: string }>, metadata?: Record<string, unknown>) =>
      ({ messages: messages.map((m, i) => ({ id: `m${i}`, ...m })), metadata } as unknown as Parameters<typeof maybeRerouteToSagaLongVideo>[0]);
    assert.equal(maybeRerouteToSagaLongVideo(mk([{ role: 'user', content: marker, createdAt: at(5) }]), video).type, 'generate_long_video', 'recent CLI/bridge wizard marker');
    assert.equal(maybeRerouteToSagaLongVideo(mk([{ role: 'user', content: marker, createdAt: at(120) }]), video).type, 'generate_video', 'an old marker no longer reroutes');
    assert.equal(maybeRerouteToSagaLongVideo(mk([
      { role: 'user', content: marker, createdAt: at(5) },
      { role: 'tool', name: 'generate_long_video', content: '{"ok":true}', createdAt: at(1) },
    ]), video).type, 'generate_video', 'a finished Saga no longer reroutes');
    assert.equal(maybeRerouteToSagaLongVideo(mk([], { workflowRouting: { sagaActiveAt: Date.now() - 60_000 } }), video).type, 'generate_long_video', 'confirmed web Saga in metadata');
    assert.equal(maybeRerouteToSagaLongVideo(mk([], { workflowRouting: { sagaActiveAt: Date.now() - 2 * 3_600_000 } }), video).type, 'generate_video', 'expired web Saga');
    assert.equal(maybeRerouteToSagaLongVideo(mk([]), video).type, 'generate_video');
    const bare = (messages: unknown[]) => ({ messages } as unknown as Parameters<typeof maybeRerouteToSagaLongVideo>[0]);
    assert.equal(maybeRerouteToSagaLongVideo(bare([{ role: 'user', content: marker }]), video).type, 'generate_video', 'a marker without a timestamp is not recent');
    assert.equal(maybeRerouteToSagaLongVideo(bare([{ role: 'user', content: marker, createdAt: 'n/a' }]), video).type, 'generate_video');
    assert.equal(maybeRerouteToSagaLongVideo(bare([
      { role: 'user', content: marker, createdAt: at(2) },
      { role: 'tool', content: '{"action":{"type":"generate_long_video"},"ok":true}' },
    ]), video).type, 'generate_video', 'a finished video recorded without a tool name ends it too');
  });

  await test('saga offer: whole-reply answers only; the question carries a pick line for chat buttons', () => {
    const yes = ['1', '1.', '是', '是的', '好', '好的', '开始', '确定', '可以', 'yes', 'y', 'ok', 'okay', 'sure', '好的！', '1️⃣', '👍', '确定！', '是，开始', '1. 是，开始', 'Yes, start'];
    const no = ['2', '不是', '不', 'no', '算了', '不要', '2. 不是', 'No'];
    const neither = ['好的，按方案二来', '好，我再想想', '好贵啊', '可以吗？', '要不算了', '对了，顺便问一下', '是什么意思？', '开始之前我想问',
      '1分钟太长了', 'ok but shorter', 'go away', '要多少钱？', 'yes please make it 30s', '是不是很贵', '不错', '嗯', '行', '好的，不过先别生成', 'yeah no', 'sure, but what does it cost?'];
    for (const reply of yes) assert.equal(parseSagaOfferReply(reply), 'yes', reply);
    for (const reply of no) assert.equal(parseSagaOfferReply(reply), 'no', reply);
    for (const reply of neither) assert.equal(parseSagaOfferReply(reply), undefined, reply);
    assert.match(buildSagaOfferQuestion('zh-CN'), /^要我帮你做成一段完整的长视频吗？\n1\. 好，开始\n2\. 不用了\n请回复编号。$/);
    assert.match(buildSagaOfferQuestion('en'), /1\. Yes, go ahead\n2\. No thanks\nReply with the number\.$/);
    for (const reply of ['好，开始', '1. 好，开始', 'Yes, go ahead']) assert.equal(parseSagaOfferReply(reply), 'yes', reply);
    for (const reply of ['不用了', '2. 不用了', 'No thanks']) assert.equal(parseSagaOfferReply(reply), 'no', reply);
    for (const answer of ['9:16', '60秒', '两分钟', '1080p', '3', '默认', 'b', 'B.', 'a', '生成', 'go', '10', '加字幕', 'done']) assert.equal(looksLikeSagaWizardAnswer(answer), true, answer);
    for (const other of ['帮我写一封邮件', '翻译成英文', '今天天气怎么样？', 'a quick question about my code', 'A 股今天怎么样', 'D盘的文件帮我看看', '1. 我想先改一下剧本', 'start over with a new topic please', 'C++ 的虚函数是什么']) assert.equal(looksLikeSagaWizardAnswer(other), false, other);
  });

  await test('saga detection: video nouns, spelled lengths, guide briefs; exclusions only before the segments', async () => {
    for (const text of ['十分精彩', '90s-style', '1980s retro', 'an 80s music video', 'the 60s']) assert.equal(parseRequestedVideoSeconds(text), undefined, text);
    // A round "60s" before a video word is a length, not a decade.
    for (const [text, seconds] of [['make a 60s video', 60], ['a 30s clip', 30], ['做个60s的视频', 60], ['十分钟', 600], ['2分30秒', 150], ['90-second trailer', 90], ['a 2-minute film', 120], ['1.5 minutes', 90], ['一分钟', 60], ['两分钟', 120], ['九十秒', 90], ['一分半', 90], ['1分半', 90], ['one-minute ad', 60]] as const) {
      assert.equal(parseRequestedVideoSeconds(text), seconds, text);
    }
    const brief = `【整片叙事】一个女孩在旧影院里重逢童年的自己。\n主体模式：有主角。身份来源：纯文字。\n[0-8秒] 女孩推开旧影院的门，灰尘在光束中飘浮。\n[8-16秒] 她走到银幕前，银幕上映出海浪。\n[16-24秒] 童年的她从银幕里走出来，轻声问："你还记得我吗？"`;
    const base = '帮我生成一段2分钟的电影感视频。\n[0-8秒] 镜头1：女孩站在火车站台上等车。\n[8-16秒] 镜头2：她低头看手机。\n[16-24秒] 镜头3：列车进站。';
    const cases: Array<[string, AutoWorkflow]> = [
      ['帮我生成一个2分钟的品牌宣传片', 'saga'],
      ['做一段60秒的旅行vlog视频', 'saga'],
      ['Make a 90-second cinematic trailer for my game', 'saga'],
      ['make a 2-minute cinematic short film about a lighthouse keeper', 'saga'],
      ['生成一部 3 分钟的科幻短片，讲火星殖民', 'saga'],
      ['我想要一个一分钟的视频，介绍我们的咖啡店', 'saga'],
      ['帮我生成一个1分半的产品介绍视频', 'saga'],
      ['用这张图做一个60秒的视频', 'saga'],
      ['给我的游戏做一个 90 秒的预告片', 'saga'],
      ['帮我做个长视频，主题是城市夜景', 'saga'],
      ['请生成一个 2 分钟的动画短片，讲一个机器人学会画画的故事', 'saga'],
      ['帮我生成一个两分钟的视频', 'saga'],
      [brief, 'saga'],
      ['【整片叙事】雨夜的东京，一只猫寻找回家的路。\n[0-8秒] 猫在便利店门口躲雨\n[8-16秒] 霓虹灯下穿过小巷\n[16-24秒] 回到主人怀里', 'saga'],
      ['把下面的剧本做成视频：\n[0-8秒] 城市清晨\n[8-16秒] 主角出门\n[16-24秒] 地铁站相遇', 'saga'],
      [base, 'saga'],
      [base + '\n配音：温柔女声旁白', 'saga'],
      ['Make a 2 minute cinematic video.\n[0-8s] A girl waits on the platform.\n[8-16s] Cut to: the train arrives.\n[16-24s] She boards.', 'saga'],
      [base + '\n[24-32秒] 镜头4：她翻开日记的页面。', 'saga'],
      [base.replace('低头看手机', '打开手机app'), 'saga'],
      [base + '\n镜头建议慢推。', 'saga'],
      [base + '\n[24-32秒] 镜头4：她回头问：你还记得我吗？', 'saga'],
      [base + '\n需要中文字幕，加字幕', 'saga'],
      [base + '\n[24-32秒] 镜头4：两条河流合并成一条。', 'saga'],
      [base + '\n结尾总结：希望与重逢。', 'saga'],
      ['好的，帮我生成一段2分钟的电影感视频，讲火车站的离别', 'saga'],
      // Team and compare that were missed.
      ['帮我做一个完整的电商网站，包括商品、购物车、支付和后台管理', 'team'],
      ['帮我从零搭建一个博客系统，前端 React 后端 Node，带登录和评论', 'team'],
      ['把整个仓库从 JavaScript 迁移到 TypeScript', 'team'],
      ['Build a full-stack todo app with React, Express and Postgres, with auth', 'team'],
      ['我们要做一个 SaaS 平台：用户系统、计费、管理后台、API 网关，帮我搭起来', 'team'],
      ['给我三个缓存方案，比较后选最好的实现', 'compare'],
      ['写三种不同的实现，benchmark 一下选最快的', 'compare'],
      ['Try three different approaches to this parser and pick the best one', 'compare'],
      ['出两个方案对比一下，然后实现更好的那个', 'compare'],
      ['帮我设计三版首页，然后选一个最好的', 'compare'],
      ['帮我做一个个人作品集网站', 'design'],
      ['帮我修复 src/a.ts 和 src/b.ts 里的类型错误', 'plan'],
      ['把整个仓库从 JavaScript 迁移到 TypeScript', 'team'],
    ];
    const wrong: string[] = [];
    for (const [text, expected] of cases) {
      const route = await routeWorkflow({ text, inCodeRepo: expected === 'plan' });
      if (route.workflow !== expected) wrong.push(`${JSON.stringify(text.slice(0, 60))} → ${route.workflow} (${route.reason}), expected ${expected}`);
    }
    assert.deepEqual(wrong, []);
    assert.equal(isClearSagaLongVideoRequest('00:00-00:05 开场\n00:05-00:10 结尾'), false, 'unbracketed agenda times without video words');
  });

  await test('classifier provider: none without a worker profile, so the main model is never used to route', async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), 'artemis-router-noworker-'));
    assert.equal(await resolveWorkflowClassifierProvider([empty], empty), undefined);
    fs.rmSync(empty, { recursive: true, force: true });
  });

  // ── classifier: only for ambiguous, substantial requests ─────────────────
  await test('classifier: ambiguous long request asks the classifier once and follows a sound verdict', async () => {
    const calls = { count: 0 };
    const route = await routeWorkflow(
      { text: AMBIGUOUS_ENGINEERING },
      { getClassifier: () => fixedClassifier('{"workflow":"plan","complexity":"medium","reason":"needs a plan"}', calls) },
    );
    assert.equal(calls.count, 1);
    assert.equal(route.workflow, 'plan');
    assert.equal(route.source, 'classifier');
  });

  await test('classifier: expensive verdicts without heuristic support are stepped down', async () => {
    const calls = { count: 0 };
    const team = await routeWorkflow(
      { text: AMBIGUOUS_ENGINEERING },
      { getClassifier: () => fixedClassifier('{"workflow":"team","complexity":"high","reason":"big"}', calls) },
    );
    assert.equal(team.workflow, 'plan', 'team needs a real multi-part build object; engineering steps down to plan');
    const teamProse = await routeWorkflow(
      { text: AMBIGUOUS_LONG },
      { getClassifier: () => fixedClassifier('{"workflow":"team","complexity":"high","reason":"big"}', calls) },
    );
    assert.equal(teamProse.workflow, 'direct', 'non-engineering prose never gets plan or team');
    const planProse = await routeWorkflow(
      { text: AMBIGUOUS_LONG },
      { getClassifier: () => fixedClassifier('{"workflow":"plan","complexity":"high","reason":"plan"}', calls) },
    );
    assert.equal(planProse.workflow, 'direct');
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
      { text: AMBIGUOUS_ENGINEERING },
      { getClassifier: () => fixedClassifier('{"workflow":"plan","complexity":"low","reason":"easy"}', calls) },
    );
    assert.equal(low.workflow, 'direct');

    const signals = collectWorkflowSignals({ text: 'x' });
    assert.equal(gateClassifierVerdict({ workflow: 'team', complexity: 'high', reason: '' }, { ...signals, bigProject: true }), 'team');
    // A long continuation of the conversation never reaches the classifier.
    const followUp = await routeWorkflow({ text: `继续，${AMBIGUOUS_LONG}` }, { getClassifier: neverClassifier });
    assert.equal(followUp.workflow, 'direct');
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
    // Enough output room for the JSON when a model spends a few tokens first.
    let maxOutputTokens = 0;
    const recording: ChatProvider = {
      async complete(_messages, options) {
        maxOutputTokens = options?.maxOutputTokens ?? 0;
        return { text: '{"workflow":"direct","complexity":"low"}', raw: null };
      },
    };
    await routeWorkflow({ text: AMBIGUOUS_LONG }, { getClassifier: () => recording });
    assert.ok(maxOutputTokens >= 300, String(maxOutputTokens));
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
    // Builder execution passes count too.
    const builder = createDelegationBudget('direct');
    const approve: AgentAction = { type: 'approve_builder_execution', sessionId: 's1' };
    checkDelegationBudget(approve, builder);
    checkDelegationBudget(approve, builder);
    assert.match(checkDelegationBudget(approve, builder) ?? '', /budget used up/);
    // A Saga run never grows into a multi-agent workflow.
    const saga = createDelegationBudget('saga');
    assert.equal(saga.limit, 0);
    checkDelegationBudget({ type: 'use_workflow', workflow: 'team' }, saga);
    assert.equal(saga.limit, 0);
    assert.ok(checkDelegationBudget(delegate, saga));
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

  await test('CLI: playbooks go in the turn message, not the system prompt; no notes pile up; no effort bump', () => {
    const interactive = fs.readFileSync(path.join(process.cwd(), 'src/cli/interactive.ts'), 'utf8');
    assert.ok(!interactive.includes('runHintedWorkflowTurn'));
    assert.ok(!interactive.includes('buildWorkflowCompletionNote'));
    assert.ok(!/WORKFLOW_EFFORT/.test(interactive));
    assert.match(interactive, /workflowPlaybook \? \{ turnContext: workflowPlaybook \}/);
    assert.ok(!interactive.includes('--- USER REQUEST ---'), 'the playbook is never part of the stored user message');
    const brain = fs.readFileSync(path.join(process.cwd(), 'src/brain.ts'), 'utf8');
    assert.match(brain, /const runtimeNote = \[turnContextText, skillIndexSection, requestNote\]/, 'think() sends turnContext as unsaved runtime context');
    const headless = fs.readFileSync(path.join(process.cwd(), 'src/services/headlessAgent.ts'), 'utf8');
    assert.match(headless, /delegationBudget: createDelegationBudget\(plan\.workflow\)/, 'every headless run (Goal Mode, analysis too) is bounded');
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
