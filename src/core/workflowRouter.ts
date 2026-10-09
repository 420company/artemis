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
import { isClearSagaLongVideoRequest } from '../tools/visual/sagaWorkflow.js';

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
const CLASSIFIER_MAX_OUTPUT_TOKENS = 120;

// ── Retired slash commands ───────────────────────────────────────────────────

/**
 * Old workflow slash words. A message that still starts with one is treated
 * as natural language: the word is removed and only used as a routing hint.
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

const CJK_RE = /[\u3400-\u9fff]/g;

/** Rough size of a request: a CJK character carries about three Latin characters of content. */
function weightedLength(text: string): number {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const rest = text.replace(CJK_RE, '').replace(/\s+/g, ' ').trim().length;
  return cjk * 3 + rest;
}

const SHORT_LENGTH = 60;
const SUBSTANTIAL_LENGTH = 240;
const LARGE_LENGTH = 900;

const CASUAL_RE = /^(?:hi|hello|hey|yo|thanks|thank you|thx|ok|okay|cool|nice|great|good (?:morning|night)|bye|你好|您好|嗨|哈喽|在吗|在不在|谢谢|多谢|好的|好|嗯|嗯嗯|哈哈+|晚安|早安|早上好|辛苦了|收到|明白了?)[\s!！.。~～?？]*$/i;

const CODE_TASK_RE = /(?:实现|重构|迁移|修复|修一下|修改|排查|调试|优化|改造|集成|接入|部署|编写|写(?:一个|个)?(?:脚本|函数|接口|测试|模块|插件)|加(?:一个|个)?功能|新增功能|\bimplement|\brefactor|\bmigrat|\bfix\b|\bdebug|\binvestigat|\boptimi[sz]e|\bintegrat|\bport\b|\badd (?:a |an )?(?:feature|endpoint|test|module)|\bwrite (?:a |an )?(?:test|script|function|module|parser))/i;
const DEEP_CODE_RE = /(?:重构|迁移|排查|调查|根因|性能|架构|改造|内存泄漏|竞态|并发|\brefactor|\bmigrat|\binvestigat|root cause|performance|architecture|memory leak|race condition|concurren)/i;
const CODE_CONTEXT_RE = /(?:```|\bstack ?trace\b|Traceback|\bat [\w.<>]+ \(|仓库|代码库|\brepo(?:sitory)?\b|\bcodebase\b|\bPR\b|pull request|\bcommit\b|分支|\bbranch\b)/i;
const FILE_REF_RE = /(?:[\w.-]+[/\\])*[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|css|scss|html|vue|svelte|yml|yaml|toml|java|kt|swift|rb|php|c|cc|cpp|h|sql|sh)\b/gi;

const BIG_PROJECT_RE = /(?:(?:完整的|一整套).{0,16}(?:项目|系统|应用|平台|网站|app|App|APP|产品)|从零(?:开始)?(?:搭建|做|构建|实现|开发|写)|端到端|全栈|整个(?:项目|代码库|仓库|系统|应用)|全仓|全量(?:迁移|重构|替换)|跨(?:多个)?模块|多个(?:模块|服务|子系统|包)|批量(?:修改|替换|迁移|重构)|所有(?:文件|模块|接口|页面)|前端.{0,20}后端|后端.{0,20}前端|\bwhole (?:repo|codebase|project|app)|across the (?:repo|codebase|project)|\bend[- ]to[- ]end\b|\bfull[- ]stack\b|from scratch|multiple (?:modules|services|packages|subsystems)|every (?:file|module|endpoint)|frontend.{0,40}backend|backend.{0,40}frontend|complete (?:\w+ ){0,3}(?:project|app|application|system|platform|product))/i;
const FULL_STACK_RE = /(?:前端.{0,20}后端|后端|全栈|数据库|接口|登录|鉴权|\bbackend\b|full[- ]stack|\bAPI\b|database|\bauth)/i;
const BUILD_INTENT_RE = /(?:做|搭建|构建|开发|实现|写|创建|建|迁移|重构|改造|替换|\bbuild|\bcreate|\bmake|\bdevelop|\bimplement|\bwrite|\bmigrate|\brefactor|\bport|\bship)/i;
const MANY_FILES_RE = /\b(\d{1,3})\s+(?:independent\s+)?files?\b|(\d{1,3})\s*个文件/i;

const COMPARE_EXPLICIT_RE = /(?:(?:两|三|四|五|几|多|2|3|4|5)\s*(?:个|种|套|版)\s*(?:不同的?)?\s*(?:方案|思路|做法|选项|候选)|(?:给我|列出|提供|出|想|设计|做|写|来)\s*(?:两|三|四|五|几|多|2|3|4|5)\s*(?:个|种|套|版)\s*(?:不同的?)?\s*(?:设计|实现|架构)|多方案|多种方案|方案(?:对比|比较|选型|PK|pk|评估)|(?:对比|比较|评估|权衡)(?:一下)?.{0,12}(?:方案|做法|实现方式|架构|选项|技术栈)|技术选型|best[- ]of[- ]?(?:n|\d)|(?:compare|evaluate|weigh|contrast)\b.{0,50}\b(?:approaches|options|designs|solutions|alternatives|architectures|proposals|implementations)|(?:give|propose|suggest|sketch|draft|offer|show|list|come up with|brainstorm)\b.{0,20}\b(?:two|three|four|several|multiple|a few|\d)\s+(?:\w+\s+)?(?:approaches|options|alternatives|designs|solutions|proposals|implementations|ideas)\b|\b(?:two|three|four|several|multiple|\d)\s+(?:different|alternative|competing)\s+(?:approaches|options|designs|solutions|proposals|implementations|architectures)\b|pros and cons|trade-?offs? (?:between|of)|which (?:approach|option|architecture|design) (?:is|would be) (?:best|better))/i;

const DESIGN_SURFACE_RE = /(?:网站|网页|官网|落地页|着陆页|首页|主页|界面|前端页面|页面设计|仪表盘|设计稿|视觉稿|组件库|设计系统|\bUI\b|\bUX\b|landing ?page|website|web ?page|homepage|home page|user interface|\bfrontend\b|front-end|dashboard|design system|web app)/i;
const DESIGN_VERB_RE = /(?:做|设计|搭建|创建|写|生成|制作|重新设计|美化|改版|重做|打造|\bbuild|\bdesign|\bcreate|\bmake|\bredesign|\bcraft|\brestyle|\bpolish)/i;
const BUG_WORDING_RE = /(?:bug|报错|错误|异常|崩溃|白屏|打不开|不显示|失败|\berror\b|\bcrash|\bbroken\b|not (?:working|loading|showing))/i;

const QUESTION_RE = /(?:[?？]\s*$|^(?:what|why|how|when|where|who|which|is|are|can|could|does|do|should)\b|^(?:什么|为什么|为啥|怎么|如何|哪个|哪些|是不是|能不能|可不可以|有没有)|(?:是什么|吗|呢|么)[?？。!！]?\s*$)/i;

export interface WorkflowSignals {
  length: number;
  casual: boolean;
  question: boolean;
  codeTask: boolean;
  deepCode: boolean;
  codeContext: number;
  inCodeRepo: boolean;
  bigProject: boolean;
  fullStack: boolean;
  compareExplicit: boolean;
  design: boolean;
  designSurface: boolean;
  bug: boolean;
  saga: boolean;
}

export function collectWorkflowSignals(input: WorkflowRouteInput, text = input.text.trim()): WorkflowSignals {
  const fileRefs = new Set((text.match(FILE_REF_RE) ?? []).map((ref) => ref.toLowerCase())).size;
  const manyFiles = MANY_FILES_RE.exec(text);
  const fileCount = Number.parseInt(manyFiles?.[1] ?? manyFiles?.[2] ?? '0', 10);
  const length = weightedLength(text) + (input.attachmentCount ?? 0) * 80;
  const designSurface = DESIGN_SURFACE_RE.test(text);
  const bug = BUG_WORDING_RE.test(text);
  const codeTask = CODE_TASK_RE.test(text);
  return {
    length,
    casual: CASUAL_RE.test(text),
    question: QUESTION_RE.test(text),
    codeTask,
    deepCode: DEEP_CODE_RE.test(text),
    codeContext: fileRefs + (CODE_CONTEXT_RE.test(text) ? 1 : 0),
    inCodeRepo: input.inCodeRepo === true,
    bigProject: (BIG_PROJECT_RE.test(text) || fileCount > 5 || fileRefs > 5) && BUILD_INTENT_RE.test(text),
    fullStack: FULL_STACK_RE.test(text),
    compareExplicit: COMPARE_EXPLICIT_RE.test(text),
    design: designSurface && DESIGN_VERB_RE.test(text) && !bug,
    designSurface,
    bug,
    saga: isClearSagaLongVideoRequest(text),
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

/** Heuristics only: a clear workflow, or "ambiguous" when the request is substantial but unclassified. */
export function classifyWorkflowHeuristically(signals: WorkflowSignals): HeuristicVerdict {
  if (signals.saga) return { kind: 'clear', workflow: 'saga', reason: 'clear request for a long multi-segment video' };
  if (signals.casual) return { kind: 'clear', workflow: 'direct', reason: 'casual chat' };
  if (signals.compareExplicit) return { kind: 'clear', workflow: 'compare', reason: 'explicit request to weigh several solutions' };
  // A full-stack product is a team job even when it has a UI; a website alone is design.
  if (signals.design && !(signals.bigProject && signals.fullStack)) {
    return { kind: 'clear', workflow: 'design', reason: 'builds or restyles a website / UI' };
  }
  if (signals.bigProject) return { kind: 'clear', workflow: 'team', reason: 'large multi-part build or change' };
  if (signals.codeTask && signals.deepCode && signals.length >= (signals.inCodeRepo ? SHORT_LENGTH : SHORT_LENGTH * 1.5)) {
    return { kind: 'clear', workflow: 'plan', reason: 'engineering task that needs investigation first' };
  }
  // Long prose with an editing verb ("修改这篇文章…") is not engineering: it
  // needs code context, else the classifier decides.
  if (signals.codeTask && (signals.codeContext >= 2 || (signals.length >= SUBSTANTIAL_LENGTH && (signals.codeContext >= 1 || signals.inCodeRepo)))) {
    return { kind: 'clear', workflow: 'plan', reason: 'non-trivial engineering task' };
  }
  if (signals.length < SUBSTANTIAL_LENGTH) {
    return { kind: 'clear', workflow: 'direct', reason: signals.question ? 'quick question' : 'small, clear request' };
  }
  if (signals.question && !signals.codeTask && signals.length < LARGE_LENGTH) {
    return { kind: 'clear', workflow: 'direct', reason: 'question' };
  }
  return { kind: 'ambiguous', reason: 'substantial request without a clear workflow signal' };
}

// ── Classifier (ambiguous, substantial requests only) ───────────────────────

const CLASSIFIER_SYSTEM_PROMPT = [
  'You route one user request to a workflow of a coding and creative agent.',
  'Reply with ONLY one JSON object, no prose, no code fence:',
  '{"workflow":"direct|plan|team|compare|design","complexity":"low|medium|high","reason":"<at most 12 words>"}',
  'direct: answer it or do it with normal tools. The default for anything simple or unclear.',
  'plan: non-trivial engineering that needs investigation and a plan before editing.',
  'team: a large build or change with several independent parts worth parallel sub-agents.',
  'compare: the user wants several alternative solutions weighed before one is chosen.',
  'design: building or restyling a website, app screen or other visual front end.',
  'When unsure, choose direct.',
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
  if (verdict.workflow === 'team') {
    if (verdict.complexity === 'high' && (signals.bigProject || signals.length >= LARGE_LENGTH)) return 'team';
    return verdict.complexity === 'low' ? 'direct' : 'plan';
  }
  if (verdict.workflow === 'compare') {
    if (verdict.complexity !== 'low' && signals.compareExplicit) return 'compare';
    return verdict.complexity === 'high' ? 'plan' : 'direct';
  }
  if (verdict.workflow === 'design') return signals.designSurface ? 'design' : 'direct';
  if (verdict.workflow === 'plan') return verdict.complexity === 'low' ? 'direct' : 'plan';
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

  // A retired slash word is a hint, not a command; a Saga request still wins.
  if (stripped.hint && !signals.saga) {
    return makeRoute(stripped.hint, 'slash-hint', `hint from ${stripped.retiredSlash}`, text, stripped.retiredSlash);
  }

  const verdict = classifyWorkflowHeuristically(signals);
  if (verdict.kind === 'clear') {
    return makeRoute(verdict.workflow, 'heuristic', verdict.reason, text, stripped.retiredSlash);
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
  '[Workflow: Saga long video]',
  'The user asked for a long, multi-segment video. Produce it with generate_long_video (the Saga engine), not generate_video.',
  "- Treat a script or timecoded brief the user wrote as authoritative (preserveUserScript: true); otherwise expand the idea into a brief yourself.",
  '- Take the total duration, aspect ratio and subtitle wishes from the request; ask one short question only when a required choice is missing and cannot be defaulted.',
  '- Report the output file path and any segment that failed; never claim a video exists without the tool result.',
].join('\n');

function describeBudget(workflow: AutoWorkflow, budget: WorkflowBudget): string {
  const lines = [
    `[Workflow budget — ${workflow}]`,
    `- At most ${budget.maxSubAgents} sub-agent(s) (delegate_task / spawn_background_workflow) in this run; the runtime refuses more.`,
  ];
  if (budget.maxCandidates) lines.push(`- Weigh at most ${budget.maxCandidates} candidate solutions; one critique round, then decide and build the winner.`);
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
  const header = `[Artemis chose this workflow automatically${context.reason ? `: ${context.reason}` : ''}. The user did not name it; do not mention workflow names unless asked.]`;
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
    const cap = Math.min(MAX_SUB_AGENTS_PER_RUN, WORKFLOW_BUDGETS[action.workflow]?.maxSubAgents ?? 0);
    if (cap > budget.limit) {
      budget.limit = cap;
      budget.workflow = action.workflow;
    }
    return undefined;
  }
  if (action.type !== 'delegate_task' && action.type !== 'spawn_background_workflow') return undefined;
  if (budget.used >= budget.limit) {
    return `Sub-agent budget used up (${budget.used} of ${budget.limit} for the ${budget.workflow} workflow). Do not start more sub-agents in this run; finish the remaining work yourself in this thread.`;
  }
  budget.used += 1;
  return undefined;
}

const HEURISTIC_REASONS_ZH: Readonly<Record<string, string>> = {
  'clear request for a long multi-segment video': '明确要求多段长视频',
  'explicit request to weigh several solutions': '明确要求比较多个方案',
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
    case 'saga': return zh ? 'Saga 长视频' : 'Saga long video';
    default: return zh ? '直接处理' : 'Direct';
  }
}
