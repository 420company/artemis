import type { ChatProvider } from '../providers/types.js';
import type { SessionMessage } from './types.js';
import type { WorkflowMode } from './workflowMode.js';
import type { UiLocale } from '../cli/locale.js';

// /team is the auto-router: the user types `/team <task>` when they don't know
// which workflow to pick, and a lightweight LLM call decides among:
//   direct     — no workflow needed, default chat handles it
//   niko       — general complex work needing research/risk review before execution
//   design     — UI / visual / frontend; design must precede implementation
//   athena     — broad multi-slice work needing coordinated parallel execution
//   nidhogg    — correctness-critical / highest-quality requirement
//
// Manual entrypoints (/niko /design /athena /nidhogg) remain available for
// users who already know which workflow they want.

export type TeamChoice = WorkflowMode;

export type TeamRoute = {
  choice: TeamChoice;
  reason: string;
};

const ROUTER_SYSTEM_PROMPT = `You are a routing dispatcher for the Artemis multi-agent CLI. Pick ONE workflow that best fits the user's task.

Choices (pick exactly one):
- direct:     Simple, narrowly-scoped task with clear intent. Examples: a one-line fix, a single-file edit, a quick question, renaming a variable. The default chat agent handles it without any workflow overhead.
- niko:       General complex engineering task that needs investigation, risk review, then execution. Examples: codebase modification, bug investigation, migration, performance optimization, moderately complex feature work. This is the default workflow for non-trivial tasks that are not clearly one of the specialized higher modes.
- design:     UI / visual / frontend layout work. Anything where look-and-feel or component design must be planned before implementation.
- athena:     Broad multi-slice execution across many files/modules/subsystems, especially when independent slices can run in parallel. Examples: repo-wide refactor, feature touching several independent modules, batch migration.
- nidhogg:    Correctness-critical or highest-quality requirement. Examples: harness engineering, security-sensitive code, complex algorithm needing iterative review, production hardening, anything where bugs are very costly. Slow but most reliable (adversarial harness loop).
- contest:    Decision-making with competing options. Examples: comparing approaches, trade-off analysis, risk evaluation, choosing between design alternatives. Proposes, critiques, and judges multiple solutions.

Output exactly one line of JSON, nothing else:
{"choice":"<direct|niko|design|athena|nidhogg|contest>","reason":"<one short sentence in the SAME LANGUAGE as the user's task>"}

Be decisive. Default to "direct" for clearly simple tasks; default to "niko" for non-trivial engineering tasks that do not clearly match design/athena/nidhogg/contest.`;

const VALID_CHOICES: ReadonlySet<WorkflowMode> = new Set<WorkflowMode>([
  'direct',
  'niko',
  'design',
  'athena',
  'nidhogg',
  'contest',
]);

// Routing is a one-line JSON classification on a cheap provider; the
// deterministic keyword fallback below covers timeouts, so keep this short.
const ROUTER_TIMEOUT_MS = 20_000;

type DeterministicRoute = TeamRoute & {
  score: number;
};

function scoreWorkflowIntent(prompt: string): Record<TeamChoice, number> {
  const text = prompt.toLowerCase();
  const score: Record<TeamChoice, number> = {
    direct: 0,
    niko: 0,
    design: 0,
    athena: 0,
    nidhogg: 0,
    contest: 0,
  };

  const add = (choice: TeamChoice, points: number, patterns: readonly RegExp[]) => {
    for (const pattern of patterns) {
      if (pattern.test(text)) score[choice] += points;
    }
  };

  add('direct', 3, [
    /^(解释|说明|看看|查一下|帮我看|what|why|how)\b/i,
    /(?:一行|小改|简单|quick|small|minor|single[-\s]?file|one[-\s]?line)/i,
  ]);
  add('niko', 4, [
    /(?:不知道|不确定|想法|脑暴|头脑风暴|探索方向|帮我想|从零|做一个|build me|brainstorm|ideate|explore)/i,
    /(?:需求不清|还没想好|产品想法|创意|概念|mvp)/i,
    /(?:调查|排查|研究|分析|迁移|改造|性能优化|bug|修复|实现|功能|codebase|debug|investigate|migration|optimi[sz]e|feature)/i,
  ]);
  add('design', 5, [
    /(?:设计|网页|网站|界面|前端|页面|组件|视觉|ui|ux|交互|样式|landing\s*page|website|web\s*app|frontend|layout|component|figma|brand|logo)/i,
    /(?:整站|官网|商城|电商|dashboard|仪表盘|storefront)/i,
  ]);
  add('athena', 5, [
    /(?:长任务|大型|全量|全局|跨模块|多模块|架构|重构整个|系统性|子系统|端到端|多文件|多步骤|迁移|改造|framework|architecture|large[-\s]?scale|multi[-\s]?(module|file|step)|end[-\s]?to[-\s]?end)/i,
    /(?:实现.*测试.*文档|后端.*前端|cli.*bridge|provider.*runtime)/i,
  ]);
  add('nidhogg', 6, [
    /(?:高质量|必须正确|不能出错|生产级|安全|权限|加密|支付|数据丢失|回归|稳定性|可靠性|性能瓶颈|并发|竞态|内存泄漏|漏洞|审计|hardening|security|correctness|reliability|production|race\s*condition|regression|harness)/i,
    /(?:修复.*根因|彻底解决|验证闭环|质量门禁|无回归)/i,
  ]);
  add('contest', 5, [
    /(?:对比|比较|评估|权衡|选择方案|哪个方案|最佳方案|决策|评审|利弊|trade[-\s]?off|compare|evaluate|choose|decision|proposal|option)/i,
  ]);

  if (prompt.length > 900) score.athena += 2;
  if (prompt.length >= 120 && Math.max(score.design, score.athena, score.nidhogg, score.contest, score.niko) === 0) score.niko += 2;
  if (prompt.length < 120 && Math.max(score.design, score.athena, score.nidhogg, score.contest, score.niko) === 0) score.direct += 2;

  return score;
}

function determineFallbackRoute(prompt: string, cause?: string): DeterministicRoute {
  const score = scoreWorkflowIntent(prompt);
  const priority: TeamChoice[] = ['nidhogg', 'contest', 'athena', 'design', 'niko', 'direct'];
  let choice: TeamChoice = 'direct';
  let best = Number.NEGATIVE_INFINITY;
  for (const candidate of priority) {
    if (score[candidate] > best) {
      best = score[candidate];
      choice = candidate;
    }
  }

  if (best <= 0) {
    choice = 'direct';
    best = score.direct;
  }

  const zh = /[\u3400-\u9fff]/.test(prompt);
  const reasonCore = zh
    ? choice === 'nidhogg'
      ? '任务包含正确性/可靠性/安全或生产级风险，需要对抗式验证闭环。'
      : choice === 'athena'
      ? '任务涉及大范围多切片协作，适合并行切片研究与协调执行。'
      : choice === 'design'
      ? '任务明显涉及界面、视觉、前端或整站体验，需要先设计再实现。'
      : choice === 'contest'
      ? '任务核心是多方案比较、权衡或决策，适合走方案竞赛评审。'
      : choice === 'niko'
      ? '任务有一定复杂度，适合先研究和风险检查，再落地执行。'
      : '任务范围较窄且意图清晰，直接对话处理成本最低。'
    : choice === 'nidhogg'
    ? 'The task carries correctness, reliability, security, or production risk and needs an adversarial verification loop.'
    : choice === 'athena'
    ? 'The task needs broad multi-slice coordination and parallelizable execution.'
    : choice === 'design'
    ? 'The task is clearly about UI, visual design, frontend, or site experience and should be designed before implementation.'
    : choice === 'contest'
    ? 'The task is mainly about comparing options or making a trade-off decision.'
    : choice === 'niko'
    ? 'The task is non-trivial and benefits from investigation plus risk review before execution.'
    : 'The task is narrow and clear enough for the default chat agent.';

  return {
    choice,
    score: best,
    reason: cause ? `${reasonCore} (${cause})` : reasonCore,
  };
}

function maybeOverrideWeakRoute(userPrompt: string, parsed: TeamRoute): TeamRoute {
  const fallback = determineFallbackRoute(userPrompt);
  if (fallback.choice === parsed.choice) return parsed;
  if (fallback.score >= 5 && parsed.choice === 'direct') {
    return { choice: fallback.choice, reason: fallback.reason };
  }
  if (fallback.choice === 'nidhogg' && fallback.score >= 6 && parsed.choice !== 'nidhogg') {
    return { choice: 'nidhogg', reason: fallback.reason };
  }
  if (fallback.choice === 'design' && fallback.score >= 5 && (parsed.choice === 'athena' || parsed.choice === 'niko')) {
    return { choice: 'design', reason: fallback.reason };
  }
  return parsed;
}

export function routeTeamRequestFallback(userPrompt: string, cause?: string): TeamRoute {
  const fallback = determineFallbackRoute(userPrompt, cause);
  return { choice: fallback.choice, reason: fallback.reason };
}

export async function routeTeamRequest(
  userPrompt: string,
  provider: ChatProvider,
): Promise<TeamRoute> {
  const now = new Date().toISOString();
  const messages: SessionMessage[] = [
    { id: 'team-router-sys', role: 'system', content: ROUTER_SYSTEM_PROMPT, createdAt: now },
    { id: 'team-router-usr', role: 'user', content: `Task:\n${userPrompt.trim()}`, createdAt: now },
  ];

  // Race the LLM call against a soft timeout so /team can't hang the UI.
  type RaceResult =
    | { kind: 'ok'; text: string }
    | { kind: 'timeout' }
    | { kind: 'error'; message: string };

  const completionPromise: Promise<RaceResult> = provider
    .complete(messages)
    .then((response) => ({ kind: 'ok' as const, text: response.text ?? '' }))
    .catch((err) => ({
      kind: 'error' as const,
      message: err instanceof Error ? err.message : String(err),
    }));

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise: Promise<RaceResult> = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve({ kind: 'timeout' }), ROUTER_TIMEOUT_MS);
    timeoutHandle.unref?.();
  });

  const result = await Promise.race([completionPromise, timeoutPromise]);
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
  }

  if (result.kind === 'timeout') {
    return routeTeamRequestFallback(userPrompt, `router timeout after ${ROUTER_TIMEOUT_MS / 1000}s`);
  }
  if (result.kind === 'error') {
    return routeTeamRequestFallback(userPrompt, `router failed: ${truncate(result.message, 140)}`);
  }
  if (!result.text) {
    return routeTeamRequestFallback(userPrompt, 'router returned empty text');
  }
  const parsed = parseRouteReply(result.text);
  if (!parsed) {
    return routeTeamRequestFallback(userPrompt, 'router returned invalid JSON');
  }
  return maybeOverrideWeakRoute(userPrompt, parsed);
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

export function parseRouteReply(raw: string): TeamRoute | null {
  // Find first { ... } block and try to parse it.
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    let j = i;
    while (j < raw.length) {
      if (raw[j] === '{') depth += 1;
      else if (raw[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
      j += 1;
    }
    if (depth !== 0) continue;
    try {
      const parsed = JSON.parse(raw.slice(i, j + 1)) as Record<string, unknown>;
      const choiceRaw = parsed['choice'];
      const reasonRaw = parsed['reason'];
      if (typeof choiceRaw === 'string' && VALID_CHOICES.has(choiceRaw as TeamChoice)) {
        const reason =
          typeof reasonRaw === 'string' && reasonRaw.trim().length > 0
            ? reasonRaw.trim()
            : 'No reason given.';
        return { choice: choiceRaw as TeamChoice, reason };
      }
    } catch {
      // try next opening brace
    }
  }
  return null;
}

export function describeChoice(choice: TeamChoice, locale: UiLocale): string {
  if (locale === 'zh-CN') {
    return choice === 'direct'
      ? '默认对话直接处理'
      : choice === 'niko'
      ? 'Niko 研究与风险检查 → 落地'
      : choice === 'design'
      ? 'Design 设计 → 实现'
      : choice === 'athena'
      ? 'Athena 切片研究 → 协调执行'
      : choice === 'nidhogg'
      ? 'Nidhogg GAN 对抗 → 高质量收敛'
      : 'Contest 方案对比 → 决策评审';
  }
  return choice === 'direct'
    ? 'Default chat'
    : choice === 'niko'
    ? 'Niko research + risk review → execute'
    : choice === 'design'
    ? 'Design → implement'
    : choice === 'athena'
    ? 'Athena slice research → coordinated execution'
    : choice === 'nidhogg'
    ? 'Nidhogg GAN adversarial loop → high-quality convergence'
    : 'Contest proposal → critique → verdict';
}
