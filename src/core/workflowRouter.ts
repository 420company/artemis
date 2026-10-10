/**
 * Automatic workflow routing.
 *
 * Users no longer pick a workflow with a slash command (/niko, /athena,
 * /contest, /team, /design). Every request is routed here instead:
 *
 *   1. Cheap heuristics decide the clear cases (chat, quick questions, small
 *      edits, explicit "compare N options", website/UI builds, big multi-part
 *      projects, long multi-segment videos).
 *   2. Only when the request looks substantial but matches nothing clearly,
 *      one small LLM call classifies it (strict JSON, short timeout).
 *   3. Any doubt, error, timeout or invalid reply means the plain
 *      single-agent path ("direct").
 *
 * The expensive workflows (parallel team, multi-option comparison) need clear
 * signals of size or stakes, and every routed run carries a hard sub-agent
 * budget (see checkDelegationBudget, enforced in core/agent.ts). The model can
 * also escalate itself mid-task with the use_workflow tool, which returns the
 * playbook and raises the budget up to the workflow's cap, never above
 * MAX_SUB_AGENTS_PER_RUN.
 *
 * The internal workflow names (niko, athena, contest, design) are kept for
 * persisted sessions and runtime records; the router speaks in plain names.
 */

import type { ChatProvider } from '../providers/types.js';
import type { AgentAction, SessionMessage } from './types.js';
import type { WorkflowMode } from './workflowMode.js';
import { buildWorkflowHint } from './workflowHints.js';
import { isClearSagaLongVideoRequest, splitSagaBrief } from '../tools/visual/sagaWorkflow.js';

export type AutoWorkflow = 'direct' | 'plan' | 'team' | 'compare' | 'design' | 'saga';
/** Workflows the model can switch into with the use_workflow tool. */
export type EscalationWorkflow = 'plan' | 'team' | 'compare' | 'design';
export const ESCALATION_WORKFLOWS: readonly EscalationWorkflow[] = ['plan', 'team', 'compare', 'design'];

export type RouteSource = 'heuristic' | 'classifier' | 'fallback' | 'slash-hint';

export interface WorkflowBudget {
  /** Hard cap on sub-agents (delegate_task / spawn_background_workflow) started in one run. */
  maxSubAgents: number;
  /** Review / critique rounds the playbook allows (guidance in the playbook text). */
  maxRounds: number;
  /** Compare only: how many candidate solutions to weigh. */
  maxCandidates?: number;
}

/** Absolute ceiling for any run, whatever the workflow or escalation. */
export const MAX_SUB_AGENTS_PER_RUN = 4;

export const WORKFLOW_BUDGETS: Readonly<Record<AutoWorkflow, WorkflowBudget>> = {
  direct: { maxSubAgents: 2, maxRounds: 1 },
  plan: { maxSubAgents: 2, maxRounds: 1 },
  design: { maxSubAgents: 2, maxRounds: 1 },
  compare: { maxSubAgents: 4, maxRounds: 1, maxCandidates: 3 },
  team: { maxSubAgents: 4, maxRounds: 2 },
  saga: { maxSubAgents: 0, maxRounds: 0 },
};

/** Internal workflow mode each routed workflow runs as (saga has its own engine). */
export const AUTO_WORKFLOW_MODE: Readonly<Record<Exclude<AutoWorkflow, 'saga'>, WorkflowMode>> = {
  direct: 'direct',
  plan: 'niko',
  team: 'athena',
  compare: 'contest',
  design: 'design',
};

export function autoWorkflowForMode(mode: WorkflowMode): AutoWorkflow | undefined {
  switch (mode) {
    case 'direct': return 'direct';
    case 'niko': return 'plan';
    case 'athena': return 'team';
    case 'contest': return 'compare';
    case 'design': return 'design';
    default: return undefined;
  }
}

export interface WorkflowRouteInput {
  text: string;
  /** Images or files attached to this message. */
  attachmentCount?: number;
  /** The workspace is a code repository (has .git). */
  inCodeRepo?: boolean;
  /**
   * L, the configured video model's longest single clip. A video request
   * that states a length up to L is a plain clip; longer is a long video.
   * Unknown: a minute is the bar.
   */
  maxClipSeconds?: number;
}

export interface WorkflowRoute {
  workflow: AutoWorkflow;
  source: RouteSource;
  reason: string;
  /** The request with any retired workflow slash word removed. */
  text: string;
  budget: WorkflowBudget;
  /** The retired slash command the user typed, when there was one. */
  retiredSlash?: string;
}

export interface RouteWorkflowOptions {
  /** Lazily resolves the cheap classifier provider; only called for ambiguous, substantial requests. */
  getClassifier?: () => Promise<ChatProvider | undefined> | ChatProvider | undefined;
  /** Classifier timeout; default CLASSIFIER_TIMEOUT_MS. */
  timeoutMs?: number;
  onInfo?: (message: string) => void;
}

export const CLASSIFIER_TIMEOUT_MS = 8_000;
// Room for the JSON even when a model spends a few tokens before it.
const CLASSIFIER_MAX_OUTPUT_TOKENS = 400;

// ── Retired slash commands ───────────────────────────────────────────────────

/**
 * Old workflow slash words. A message that still starts with one is treated
 * as natural language: the word is removed and the rest is routed through
 * every gate. Only /niko's cheap planning hint is honoured, for engineering
 * requests; the others never force a workflow.
 */
const RETIRED_WORKFLOW_SLASH_HINTS: Readonly<Record<string, AutoWorkflow | undefined>> = {
  '/niko': 'plan',
  '/athena': 'team',
  '/contest': 'compare',
  '/design': 'design',
  '/team': undefined,
};

export function stripRetiredWorkflowSlash(text: string): {
  text: string;
  retiredSlash?: string;
  hint?: AutoWorkflow;
} {
  const trimmed = text.trim();
  const match = /^(\/[a-z]+)(?=\s|$)/i.exec(trimmed);
  const command = match?.[1]?.toLowerCase();
  if (!command || !(command in RETIRED_WORKFLOW_SLASH_HINTS)) {
    return { text: trimmed };
  }
  return {
    text: trimmed.slice(command.length).trim(),
    retiredSlash: command,
    hint: RETIRED_WORKFLOW_SLASH_HINTS[command],
  };
}

// ── Heuristic signals ────────────────────────────────────────────────────────

const CJK_RE = /[㐀-鿿]/g;

/** Rough size of a request: a CJK character carries about three Latin characters of content. */
function weightedLength(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const rest = text.replace(CJK_RE, '').replace(/\s+/g, ' ').trim().length;
  return cjk * 3 + rest;
}

const SHORT_LENGTH = 60;
const TEAM_MIN_LENGTH = 24;
const SUBSTANTIAL_LENGTH = 240;

const CASUAL_RE = /^(?:hi|hello|hey|yo|thanks|thank you|thx|ok|okay|cool|nice|great|good (?:morning|night)|bye|你好|您好|嗨|哈喽|在吗|在不在|谢谢|多谢|好的|好|嗯|嗯嗯|哈哈+|晚安|早安|早上好|辛苦了|收到|明白了?)[\s!！.。~～?？]*$/i;
// Follow-ups of an ongoing conversation stay on the plain path.
const FOLLOW_UP_RE = /^(?:继续|接着|然后|另外|补充|还有|再|好的|好|对|不对|不是|按|就按|continue|go on|also|and |then |ok,|okay,|yes|no\b)/i;

// Questions, including "explain / compare / which is better" asks.
const QUESTION_RE = /(?:[?？]\s*$|(?:吗|呢|么)[。!！]?\s*$|^(?:what|why|how|when|where|who|which|is|are|can|could|does|do|should|would|explain)\b|^(?:什么|怎么|为什么|为啥|哪个|哪种|是否|能不能|可不可以|有没有))/i;
// Question words anywhere count only in a short message; a long brief may
// mention "how" or "为什么" while asking for work.
const QUESTION_WORD_RE = /(?:什么|怎么|为什么|为啥|谁|哪个|哪种|哪些|是否|能不能|可不可以|有没有|区别|差别|优缺点|利弊|\b(?:explain|what|how|why|who|which|whether|difference|differences)\b|pros and cons|trade-?offs?|\bvs\.?\b|\bversus\b)/i;
// An imperative build / change request at the start of the message.
const BUILD_IMPERATIVE_RE = /^(?:(?:请|麻烦|帮我|帮忙|给我|替我|请帮我|please)\s*,?\s*)?(?:帮我\s*)?(?:做|搭建|搭|构建|开发|实现|写|创建|建|生成|修复|修|重构|迁移|改造|设计|改版|重做|排查|调查|查一下|定位|build|create|make|develop|implement|write|fix|refactor|migrate|port|design|redesign|set up|scaffold|investigate|debug|look into|track down)(?![了过])/i;
// "Can you / 你能 …?" asks about ability: answered directly.
const CAPABILITY_QUESTION_RE = /^(?:can you|could you|do you|are you able|你能|你会|能不能|会不会|可不可以)/i;
// Text deliverables: articles, copy, slides, docs, plans.
const WRITING_RE = /(?:文章|文案|稿子|作文|小说|诗|PPT|ppt|幻灯片|演示文稿|文档|报告|简历|邮件|介绍|说明书|学习计划|\barticle\b|\bcopy\b|\bessay\b|\bblog post\b|\bslides?\b|\bdeck\b|\bpoem\b|\bemail\b|\breport\b|\bresume\b)/i;

const CODE_TASK_RE = /(?:实现|重构|迁移|修复|修一下|修改|排查|调试|优化|改造|集成|接入|部署|编写|写.{0,12}(?:脚本|函数|接口|测试|模块|插件|代码|程序)|加(?:一个|个)?功能|新增功能|\bimplement|\brefactor|\bmigrat|\bfix\b|\bdebug|\binvestigat|\boptimi[sz]e|\bintegrat|\bport\b|\badd (?:a |an )?(?:feature|endpoint|test|module)|\bwrite (?:a |an )?(?:test|script|function|module|parser))/i;
const DEEP_CODE_RE = /(?:重构|迁移|排查|调查|根因|性能|架构|改造|内存泄漏|竞态|并发|\brefactor|\bmigrat|\binvestigat|root cause|performance|architecture|memory leak|race condition|concurren)/i;
const CODE_CONTEXT_RE = /(?:```|\bstack ?trace\b|Traceback|\bat [\w.<>]+ \(|仓库|代码库|\brepo(?:sitory)?\b|\bcodebase\b|\bPR\b|pull request|\bcommit\b|分支|\bbranch\b)/i;
const FILE_REF_RE = /(?:[\w.-]+[/\\])*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|css|scss|html|vue|svelte|yml|yaml|toml|java|kt|swift|rb|php|c|cc|cpp|h|sql|sh)\b/gi;
const BUG_WORDING_RE = /(?:bug|报错|错误|异常|崩溃|白屏|打不开|不显示|失败|乱了|\berror\b|\bcrash|\bbroken\b|not (?:working|loading|showing))/i;

// A real multi-part build object or a repo-wide change.
const TEAM_OBJECT_RE = /(?:(?:完整的|一整套|一个完整的?).{0,12}(?:系统|项目|网站|应用|平台|商城|后台|小程序|app|App|APP)|全栈|前端.{0,24}后端|后端.{0,24}前端|多个(?:服务|子系统)|微服务|(?:SaaS|saas)\s*平台|(?:平台|系统|项目|应用|产品)\s*[：:][^。\n]*、[^。\n]*、|整个(?:仓库|代码库|项目)|全仓|所有(?:文件|模块)|\bfull[- ]stack (?:[\w-]+ ){0,2}(?:app|application|website|site|project|platform|product)|\bcomplete (?:\w+ ){0,3}(?:app|application|system|platform|website|project)\b|frontend.{0,40}backend|backend.{0,40}frontend|multiple (?:services|subsystems)|microservices|\bSaaS (?:platform|product|app)\b|\bwhole (?:repo|codebase|project)|across the (?:repo|codebase|project)|every (?:file|module))/i;
// A request marker and a build verb in the same clause ("…，帮我搭起来",
// "我要做一个完整的…"). Statements about past work ("我们重构了整个仓库",
// "他们开发了一个平台") and who-asks ("…是谁开发的") are not requests.
const REQUEST_MARKER_RE = /(?:^\s*(?:把|将)|帮我|帮忙|请|给我|我要|我想要|我想|你来|替我|麻烦|\blet'?s\b|\bplease\b|\bcan you\b|\bcould you\b|\bi want you to\b|\bi need you to\b)/i;
const BUILD_VERB_RE = /(?:搭建|搭起来|搭一个|构建|开发|实现|迁移|重构|改造|做一个|做个|写一个|\bbuild\b|\bcreate\b|\bdevelop\b|\bimplement\b|\bmigrate\b|\brefactor\b|\bport\b|\bset up\b|\bscaffold\b)(?![了过])/i;
function hasBuildRequestClause(text: string): boolean {
  return text
    .split(/[，,。.;；!！?？\n]+/)
    .some((clause) => REQUEST_MARKER_RE.test(clause) && BUILD_VERB_RE.test(clause) && !/是.{0,12}的\s*$/.test(clause));
}
const MANY_FILES_RE = /\b(\d{1,3})\s+(?:independent\s+)?files?\b|(\d{1,3})\s*个文件/i;

// Asked to PRODUCE several candidate solutions…
const COMPARE_PRODUCE_RE = /(?:(?:给我|出|做|写|想|设计|提供|拿出|尝试|试|实现)\s*(?:两|三|四|五|几|多|2|3|4|5)\s*(?:个|种|套|版)\s*[^，。,.\n]{0,6}?(?:方案|实现|设计|做法|版本|思路)|(?:设计|做|出|写)\s*(?:两|三|四|五|几|2|3|4|5)\s*(?:个|种|套|版)|(?:做|出|给|用|走|来)\s*(?:个)?多(?:种)?方案|\b(?:try|write|build|implement|draft|prototype|propose|produce|give me|come up with)\b.{0,20}\b(?:two|three|four|several|multiple|a few|\d)\s+(?:different\s+|alternative\s+|competing\s+)?(?:approaches|implementations|versions|solutions|designs|prototypes|variants)\b|best[- ]of[- ]?(?:n|\d))/i;
// …and to pick / compare / build the best one.
const COMPARE_CHOOSE_RE = /(?:比较|对比|选(?:出|一个|最好|最优|择)|挑|择优|评选|最好的|最优的?|胜出|\bpick\b|\bchoose\b|\bselect\b|\bthe best\b|\bcompare\b|\bevaluate\b|\bbenchmark\b|\bwinner\b)/i;

const SMALL_DELIVERABLE_RE = /(?:标题|文案|段落|句子|试卷|题目|名字|标语|口号|活动|slogan|\btitles?\b|\bcopy\b|\bemails?\b|\bnames?\b|\bheadlines?\b|\btaglines?\b)/i;

// Talking about something already done ("我们之前讨论过多方案对比").
const PAST_MENTION_RE = /(?:之前|以前|上次|已经|结果是|当时|\bpreviously\b|\bearlier\b|\balready\b|\blast time\b|\bwe (?:did|tried|compared)\b)/i;

const DESIGN_SURFACE_RE = /(?:页面|网页|网站|官网|落地页|着陆页|首页|主页|界面|仪表盘|海报|视觉稿|设计稿|原型|组件库|设计系统|\bUI\b|\bUX\b|landing ?page|website|web ?page|homepage|home page|user interface|dashboard|poster|mockup|wireframe|prototype|design system|web app)/i;
const DESIGN_VERB_RE = /(?:做|设计|搭建|创建|生成|制作|编写|开发|写|改版|重新设计|重做|美化|打造|\bbuild|\bdesign|\bcreate|\bmake|\bredesign|\bcraft|\brestyle|\bmock up)/i;
const CONTINUATION_START_RE = /^(?:继续|接着|然后|另外|补充|continue|go on)/i;

export interface WorkflowSignals {
  length: number;
  casual: boolean;
  followUp: boolean;
  question: boolean;
  buildImperative: boolean;
  writing: boolean;
  codeTask: boolean;
  deepCode: boolean;
  codeContext: number;
  inCodeRepo: boolean;
  bigProject: boolean;
  compareExplicit: boolean;
  design: boolean;
  designSurface: boolean;
  bug: boolean;
  saga: boolean;
}

export function collectWorkflowSignals(input: WorkflowRouteInput, fullText = input.text.trim()): WorkflowSignals {
  // In a timecoded brief only the request before the segments counts: the
  // segments are story content ("翻开日记的页面", "配音：…", "Cut to:").
  const brief = splitSagaBrief(fullText);
  const text = brief.segmentLines >= 2 ? brief.preamble : fullText;
  const fileRefs = new Set((text.match(FILE_REF_RE) ?? []).map((ref) => ref.toLowerCase())).size;
  const manyFiles = MANY_FILES_RE.exec(text);
  const fileCount = Number.parseInt(manyFiles?.[1] ?? manyFiles?.[2] ?? '0', 10);
  const length = weightedLength(fullText) + (input.attachmentCount ?? 0) * 80;
  const designSurface = DESIGN_SURFACE_RE.test(text);
  const bug = BUG_WORDING_RE.test(text);
  const codeTask = CODE_TASK_RE.test(text);
  const writing = WRITING_RE.test(text);
  const buildImperative = BUILD_IMPERATIVE_RE.test(text);
  const asksQuestion = QUESTION_RE.test(text) || (length < SUBSTANTIAL_LENGTH && QUESTION_WORD_RE.test(text));
  const question = asksQuestion && !(buildImperative && !CAPABILITY_QUESTION_RE.test(text));
  const codeContext = fileRefs + (CODE_CONTEXT_RE.test(text) ? 1 : 0);
  return {
    length,
    casual: CASUAL_RE.test(text),
    // "好的，按方案二来" is a follow-up; "好的，帮我生成一段2分钟的视频…" is a request.
    followUp: FOLLOW_UP_RE.test(text) && length < SHORT_LENGTH,
    question,
    buildImperative,
    writing,
    codeTask,
    deepCode: DEEP_CODE_RE.test(text),
    codeContext,
    inCodeRepo: input.inCodeRepo === true,
    bigProject: (buildImperative || hasBuildRequestClause(text)) && !writing && !bug && length >= TEAM_MIN_LENGTH &&
      (TEAM_OBJECT_RE.test(text) || fileCount > 5 || fileRefs > 5),
    // Titles, names, copy, exam papers… are small writing tasks: direct.
    compareExplicit: COMPARE_PRODUCE_RE.test(text) && COMPARE_CHOOSE_RE.test(text) && !PAST_MENTION_RE.test(text) && !SMALL_DELIVERABLE_RE.test(text),
    design: designSurface && DESIGN_VERB_RE.test(text) && !bug && !writing,
    designSurface,
    bug,
    // Saga comes after every code / design / question check: only plain
    // creation requests for a new long video qualify.
    saga: !codeTask && !designSurface && codeContext === 0 && isClearSagaLongVideoRequest(fullText, { maxClipSeconds: input.maxClipSeconds }),
  };
}

function makeRoute(
  workflow: AutoWorkflow,
  source: RouteSource,
  reason: string,
  text: string,
  retiredSlash?: string,
): WorkflowRoute {
  return { workflow, source, reason, text, budget: WORKFLOW_BUDGETS[workflow], ...(retiredSlash ? { retiredSlash } : {}) };
}

export type HeuristicVerdict =
  | { kind: 'clear'; workflow: AutoWorkflow; reason: string }
  | { kind: 'ambiguous'; reason: string };

/**
 * Heuristics only: a clear workflow, or "ambiguous" when the request is
 * substantial but unclassified. Order matters: chat, follow-ups and
 * questions never reach the expensive workflows, and Saga is checked last.
 */
export function classifyWorkflowHeuristically(signals: WorkflowSignals): HeuristicVerdict {
  if (signals.casual) return { kind: 'clear', workflow: 'direct', reason: 'casual chat' };
  if (signals.followUp) return { kind: 'clear', workflow: 'direct', reason: 'follow-up' };
  if (signals.question) return { kind: 'clear', workflow: 'direct', reason: 'question' };
  if (signals.compareExplicit) return { kind: 'clear', workflow: 'compare', reason: 'asked for several candidate solutions and the best one' };
  if (signals.bigProject) return { kind: 'clear', workflow: 'team', reason: 'large multi-part build or change' };
  if (signals.design) return { kind: 'clear', workflow: 'design', reason: 'builds or restyles a website / UI' };
  if (signals.codeTask && signals.deepCode && signals.length >= (signals.inCodeRepo ? SHORT_LENGTH : SHORT_LENGTH * 1.5)) {
    return { kind: 'clear', workflow: 'plan', reason: 'engineering task that needs investigation first' };
  }
  // Long prose with an editing verb ("修改这篇文章…") is not engineering: it
  // needs code context, else the classifier decides.
  if (signals.codeTask && (signals.codeContext >= 2 || (signals.length >= SUBSTANTIAL_LENGTH && (signals.codeContext >= 1 || signals.inCodeRepo)))) {
    return { kind: 'clear', workflow: 'plan', reason: 'non-trivial engineering task' };
  }
  if (signals.saga) return { kind: 'clear', workflow: 'saga', reason: 'clear request for a long multi-segment video' };
  if (signals.length < SUBSTANTIAL_LENGTH || signals.writing) {
    return { kind: 'clear', workflow: 'direct', reason: 'small, clear request' };
  }
  return { kind: 'ambiguous', reason: 'substantial request without a clear workflow signal' };
}

/**
 * Sync check used before the Saga wizard on bridges and the CLI: does this
 * plain message (no slash command) look like a request for a new long video?
 */
export function looksLikeSagaRequest(text: string, maxClipSeconds?: number): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return false;
  const verdict = classifyWorkflowHeuristically(collectWorkflowSignals({ text: trimmed, maxClipSeconds }));
  return verdict.kind === 'clear' && verdict.workflow === 'saga';
}

// ── Classifier (ambiguous, substantial requests only) ───────────────────────

const CLASSIFIER_SYSTEM_PROMPT = [
  'You route one user request to a workflow of a coding and creative agent.',
  'Reply with ONLY one JSON object, no prose, no code fence:',
  '{"workflow":"direct|plan|team|compare|design","complexity":"low|medium|high","reason":"<at most 12 words>"}',
  'direct: answer it or do it with normal tools. The default for anything simple or unclear.',
  'plan: non-trivial engineering that needs investigation and a plan before editing.',
  'team: a large build or change with several independent parts worth parallel sub-agents.',
  'compare: the user explicitly asks you to produce several alternative solutions and pick the best one.',
  'design: building or restyling a website, app screen or other visual front end.',
  'Questions, explanations, writing tasks and follow-ups are direct. When unsure, choose direct.',
].join('\n');

const CLASSIFIER_WORKFLOWS = new Set(['direct', 'plan', 'team', 'compare', 'design']);
const CLASSIFIER_COMPLEXITY = new Set(['low', 'medium', 'high']);

export interface ClassifierVerdict {
  workflow: Exclude<AutoWorkflow, 'saga'>;
  complexity: 'low' | 'medium' | 'high';
  reason: string;
}

/** Strict parse: exactly one JSON object with known values, else null. */
export function parseClassifierReply(raw: string): ClassifierVerdict | null {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const workflow = record.workflow;
  const complexity = record.complexity;
  if (typeof workflow !== 'string' || !CLASSIFIER_WORKFLOWS.has(workflow)) return null;
  if (typeof complexity !== 'string' || !CLASSIFIER_COMPLEXITY.has(complexity)) return null;
  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim().slice(0, 160) : 'classifier';
  return {
    workflow: workflow as ClassifierVerdict['workflow'],
    complexity: complexity as ClassifierVerdict['complexity'],
    reason,
  };
}

/**
 * The classifier may suggest an expensive workflow; it only gets one when the
 * heuristics also see size or stakes. Otherwise it is stepped down.
 */
export function gateClassifierVerdict(verdict: ClassifierVerdict, signals: WorkflowSignals): AutoWorkflow {
  const engineering = signals.codeTask || signals.deepCode || signals.codeContext > 0 || signals.inCodeRepo;
  if (verdict.workflow === 'team') {
    if (verdict.complexity === 'high' && signals.bigProject) return 'team';
    return verdict.complexity !== 'low' && engineering ? 'plan' : 'direct';
  }
  if (verdict.workflow === 'compare') {
    return verdict.complexity !== 'low' && signals.compareExplicit ? 'compare' : 'direct';
  }
  if (verdict.workflow === 'design') return signals.design ? 'design' : 'direct';
  if (verdict.workflow === 'plan') return verdict.complexity !== 'low' && engineering ? 'plan' : 'direct';
  return 'direct';
}

async function runClassifier(
  provider: ChatProvider,
  text: string,
  timeoutMs: number,
): Promise<{ ok: true; verdict: ClassifierVerdict } | { ok: false; reason: string }> {
  const now = new Date().toISOString();
  const messages: SessionMessage[] = [
    { id: 'workflow-router-system', role: 'system', content: CLASSIFIER_SYSTEM_PROMPT, createdAt: now },
    { id: 'workflow-router-user', role: 'user', content: `Request:\n${text.slice(0, 4_000)}`, createdAt: now },
  ];
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; reason: string }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, reason: `classifier timeout after ${timeoutMs}ms` });
    }, timeoutMs);
  });
  const call = provider
    .complete(messages, { abortSignal: controller.signal, maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS })
    .then((response) => {
      const verdict = parseClassifierReply(response.text ?? '');
      return verdict
        ? { ok: true as const, verdict }
        : { ok: false as const, reason: 'classifier reply was not valid JSON' };
    })
    .catch((error: unknown) => ({
      ok: false as const,
      reason: `classifier failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 140)}`,
    }));
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Route one request. Never throws: any failure ends on the plain
 * single-agent path.
 */
export async function routeWorkflow(
  input: WorkflowRouteInput,
  options: RouteWorkflowOptions = {},
): Promise<WorkflowRoute> {
  const stripped = stripRetiredWorkflowSlash(input.text);
  const text = stripped.text;
  // Nothing but a retired slash word: pass the message on unchanged.
  if (!text) return makeRoute('direct', 'heuristic', 'empty request', input.text.trim(), stripped.retiredSlash);

  let signals: WorkflowSignals;
  try {
    signals = collectWorkflowSignals(input, text);
  } catch {
    return makeRoute('direct', 'fallback', 'signal error', text, stripped.retiredSlash);
  }

  // A retired slash word never forces a workflow and never leads to Saga:
  // the rest goes through every gate. Only the cheap planning hint of /niko
  // is honoured, and only for an engineering request.
  // Any other slash command ("/run …") is never a Saga offer either.
  if (stripped.retiredSlash || text.startsWith('/')) signals = { ...signals, saga: false };
  const verdict = classifyWorkflowHeuristically(signals);
  if (
    stripped.hint === 'plan' &&
    verdict.kind === 'clear' && verdict.workflow === 'direct' &&
    !signals.question && !signals.casual && !signals.followUp &&
    (signals.codeTask || signals.bug || signals.deepCode)
  ) {
    return makeRoute('plan', 'slash-hint', `hint from ${stripped.retiredSlash}`, text, stripped.retiredSlash);
  }
  if (verdict.kind === 'clear') {
    return makeRoute(verdict.workflow, 'heuristic', verdict.reason, text, stripped.retiredSlash);
  }
  // A long continuation of the conversation is not a new task.
  if (CONTINUATION_START_RE.test(text)) {
    return makeRoute('direct', 'heuristic', 'follow-up', text, stripped.retiredSlash);
  }

  let provider: ChatProvider | undefined;
  try {
    provider = await options.getClassifier?.();
  } catch (error) {
    options.onInfo?.(`[workflow-router] classifier unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!provider) {
    return makeRoute('direct', 'fallback', 'ambiguous request, no classifier', text, stripped.retiredSlash);
  }

  const result = await runClassifier(provider, text, options.timeoutMs ?? CLASSIFIER_TIMEOUT_MS);
  if (!result.ok) {
    options.onInfo?.(`[workflow-router] ${result.reason}; using the direct path`);
    return makeRoute('direct', 'fallback', result.reason, text, stripped.retiredSlash);
  }
  const workflow = gateClassifierVerdict(result.verdict, signals);
  const gated = workflow !== result.verdict.workflow ? ` (classifier said ${result.verdict.workflow}/${result.verdict.complexity})` : '';
  return makeRoute(workflow, 'classifier', `${result.verdict.reason}${gated}`, text, stripped.retiredSlash);
}

// ── Playbooks and budgets ────────────────────────────────────────────────────

const SAGA_PLAYBOOK = [
  '[Workflow: long video]',
  'The user asked for a long, multi-segment video. Produce it with generate_long_video, not generate_video.',
  '- When you talk to the user, call it 「制作长视频」 / "making your long video". Never mention workflow, tool, engine, model or provider names.',
  "- Treat a script or timecoded brief the user wrote as authoritative (preserveUserScript: true); otherwise expand the idea into a brief yourself.",
  '- Take the total duration, aspect ratio and subtitle wishes from the request; ask one short question only when a required choice is missing and cannot be defaulted.',
  '- Report the output file path and any segment that failed; never claim a video exists without the tool result.',
].join('\n');

function describeBudget(workflow: AutoWorkflow, budget: WorkflowBudget): string {
  const lines = [
    `[Workflow budget — ${workflow}]`,
    `- At most ${budget.maxSubAgents} sub-agent(s) (delegate_task / spawn_background_workflow / approve_builder_execution) in this run; the runtime refuses more.`,
  ];
  if (budget.maxCandidates) lines.push(`- Weigh at most ${budget.maxCandidates} candidate solutions; one critique round, then recommend one. Build it only if the user asked for an implementation; otherwise ask.`);
  if (budget.maxRounds > 0 && !budget.maxCandidates) lines.push(`- At most ${budget.maxRounds} review round(s); then finish.`);
  lines.push('- Where sub-agents are unavailable, do the same steps yourself in this thread. Never invent a review or critique that did not run.');
  return lines.join('\n');
}

/** Playbook text for a routed workflow, or '' for the plain path. */
export function buildRoutedWorkflowHint(
  workflow: AutoWorkflow,
  context: { cwd: string; userPrompt: string; reason?: string },
): string {
  if (workflow === 'direct') return '';
  const header = `[Artemis chose this workflow automatically${context.reason ? `: ${context.reason}` : ''}. The user did not name it. Never mention workflow, playbook, tool, model or provider names to the user; describe what you do in plain words.]`;
  if (workflow === 'saga') return `${header}\n\n${SAGA_PLAYBOOK}`;
  const hint = buildWorkflowHint(AUTO_WORKFLOW_MODE[workflow], { cwd: context.cwd, userPrompt: context.userPrompt });
  return `${header}\n\n${hint}\n\n${describeBudget(workflow, WORKFLOW_BUDGETS[workflow])}`;
}

/** Output of the use_workflow tool: the playbook the model switches to mid-task. */
export function buildEscalationPlaybook(workflow: EscalationWorkflow, cwd: string, reason?: string): string {
  const hint = buildWorkflowHint(AUTO_WORKFLOW_MODE[workflow], { cwd, userPrompt: reason ?? '' });
  return [
    `Switched to the ${workflow} workflow${reason ? ` (${reason})` : ''}. Follow this playbook for the rest of the task.`,
    '',
    hint,
    '',
    describeBudget(workflow, WORKFLOW_BUDGETS[workflow]),
  ].join('\n');
}

// ── Delegation budget (enforced by core/agent.ts) ───────────────────────────

export interface DelegationBudget {
  workflow: AutoWorkflow;
  limit: number;
  used: number;
}

export function createDelegationBudget(workflow: AutoWorkflow): DelegationBudget {
  return {
    workflow,
    limit: Math.min(MAX_SUB_AGENTS_PER_RUN, WORKFLOW_BUDGETS[workflow].maxSubAgents),
    used: 0,
  };
}

/**
 * Called before every tool action of a run that has a budget. Counts
 * sub-agent launches and returns a refusal once the budget is used up;
 * use_workflow raises the budget to the chosen workflow's cap (never above
 * MAX_SUB_AGENTS_PER_RUN). Undefined means the action may run.
 */
export function checkDelegationBudget(action: AgentAction, budget: DelegationBudget | undefined): string | undefined {
  if (!budget) return undefined;
  if (action.type === 'use_workflow') {
    // A Saga run makes a video; it never grows into a multi-agent workflow.
    if (budget.workflow === 'saga') return undefined;
    const cap = Math.min(MAX_SUB_AGENTS_PER_RUN, WORKFLOW_BUDGETS[action.workflow]?.maxSubAgents ?? 0);
    if (cap > budget.limit) {
      budget.limit = cap;
      budget.workflow = action.workflow;
    }
    return undefined;
  }
  // Every child agent run counts: delegated specialists, detached workflows
  // and builder execution passes.
  if (
    action.type !== 'delegate_task' &&
    action.type !== 'spawn_background_workflow' &&
    action.type !== 'approve_builder_execution'
  ) return undefined;
  if (budget.used >= budget.limit) {
    return `Sub-agent budget used up (${budget.used} of ${budget.limit} for the ${budget.workflow} workflow). Do not start more sub-agents in this run; finish the remaining work yourself in this thread.`;
  }
  budget.used += 1;
  return undefined;
}

const HEURISTIC_REASONS_ZH: Readonly<Record<string, string>> = {
  'clear request for a long multi-segment video': '明确要求多段长视频',
  'asked for several candidate solutions and the best one': '明确要求产出多个方案并选出最优',
  'question': '提问',
  'follow-up': '追问',
  'builds or restyles a website / UI': '要做或改网站 / 界面',
  'large multi-part build or change': '多模块的大型构建或改动',
  'engineering task that needs investigation first': '需要先调查的工程任务',
  'non-trivial engineering task': '有一定复杂度的工程任务',
};

/** The route's reason for the user, in their language where it is a known heuristic reason. */
export function describeRouteReason(route: Pick<WorkflowRoute, 'reason' | 'retiredSlash'>, locale: 'zh-CN' | 'en' | string): string {
  const zh = locale === 'zh-CN' || locale === 'zh';
  if (route.reason.startsWith('hint from ')) {
    return zh ? `按 ${route.retiredSlash ?? '斜杠词'} 提示` : route.reason;
  }
  return zh ? HEURISTIC_REASONS_ZH[route.reason] ?? route.reason : route.reason;
}

export function describeAutoWorkflow(workflow: AutoWorkflow, locale: 'zh-CN' | 'en' | string): string {
  const zh = locale === 'zh-CN' || locale === 'zh';
  switch (workflow) {
    case 'plan': return zh ? '深度规划：先调查再实现并验证' : 'Deep planning: investigate, then implement and verify';
    case 'team': return zh ? '并行分工：拆成独立部分并行处理（有上限）' : 'Parallel team: independent parts in parallel (bounded)';
    case 'compare': return zh ? '多方案对比：最多 3 个候选，评审后实施最优' : 'Compare: up to 3 candidates, critique, build the best';
    case 'design': return zh ? '设计：视觉系统、素材、实现与截图验收' : 'Design: visual system, assets, build, screenshot check';
    case 'saga': return zh ? '长视频' : 'Long video';
    default: return zh ? '直接处理' : 'Direct';
  }
}
