import type { PromptIO } from '../providers/types.js';
import type { SessionStore } from '../storage/sessions.js';
import type { EvidenceGraph } from './types.js';
import type { SessionRecord } from './types.js';
import { choosePromptBoolean } from '../cli/prompt.js';
import {
  getWorkflowDisplayName,
  type WorkflowMode,
} from './workflowMode.js';

type WorkflowAdvice = {
  recommended: WorkflowMode;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
};

type Trigger = {
  pattern: RegExp;
  reason: string;
  weight: number;
};

type WorkflowAdviceContext = {
  evidenceGraph?: EvidenceGraph;
  sessionMessageCount?: number;
};

const FILE_REFERENCE_PATTERN =
  /(?:[A-Za-z0-9_.-]+[/\\])*[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|css|html|yml|yaml|toml|java|kt|swift|rb|php|c|cpp|h)\b/gi;

function countFileReferences(prompt: string): number {
  const matches = prompt.match(FILE_REFERENCE_PATTERN) ?? [];
  return new Set(matches.map((match) => match.toLowerCase())).size;
}

function extractExplicitFileCount(prompt: string): number | undefined {
  const match = prompt.match(/\b(\d{1,3})\s+(?:independent\s+)?files?\b/i);
  if (!match) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const DUAL_MODEL_TRIGGERS: Trigger[] = [
  {
    pattern: /\b复杂任务|复杂问题|多步骤|集成系统|架构设计|性能优化\b/,
    reason: '任务复杂度高，需要双模型协作分析',
    weight: 5
  },
  {
    pattern: /\b代码重构|技术债务|系统优化|架构演变\b/,
    reason: '涉及系统级变更，需要双模型交叉验证',
    weight: 4
  },
  {
    pattern: /\b安全审计|代码审查|漏洞检测\b/,
    reason: '安全相关任务，需要双重验证',
    weight: 5
  },
  {
    pattern: /\b多语言|跨平台|兼容性问题\b/,
    reason: '跨领域任务，需要多模型协作',
    weight: 4
  },
  {
    pattern: /\b创新性|突破性|前沿技术\b/,
    reason: '需要创新思维，多模型协作提供更多思路',
    weight: 3
  }
];

const CONTEST_TRIGGERS: Trigger[] = [
  {
    pattern: /\b(vs|versus|trade[- ]?off|compare|comparison|pros and cons|pros\/cons)\b/i,
    reason: 'it asks for a choice across competing options',
    weight: 4,
  },
  {
    pattern: /\b(should i|should we|which approach|best approach|best path|recommend)\b/i,
    reason: 'it asks for a decision, not just execution',
    weight: 4,
  },
  {
    pattern: /\b(risk|safe|safest|rollback|reversible|regression|migration|rollout)\b/i,
    reason: 'it needs explicit risk analysis before action',
    weight: 3,
  },
  {
    pattern: /\b(refactor|architecture|design|redesign|strategy)\b/i,
    reason: 'it involves structural tradeoffs',
    weight: 2,
  },
  // Chinese triggers
  {
    pattern: /比较|对比|权衡|哪个方案|利弊|优缺点/,
    reason: 'it asks for a comparison or tradeoff analysis',
    weight: 4,
  },
  {
    pattern: /应该用|应该选|哪个好|推荐哪|怎么选/,
    reason: 'it asks for a decision, not just execution',
    weight: 4,
  },
  {
    pattern: /风险|安全吗|回滚|迁移方案/,
    reason: 'it needs explicit risk analysis before action',
    weight: 3,
  },
];

const NIKO_TRIGGERS: Trigger[] = [
  {
    pattern: /\b(brainstorm|ideas?|options?|approaches?)\b/i,
    reason: 'it asks for open-ended exploration',
    weight: 4,
  },
  {
    pattern: /\b(how should i|how should we|plan|planning|strategy)\b/i,
    reason: 'it needs framing before implementation',
    weight: 3,
  },
  {
    pattern: /\b(explore|direction|concept|shape the approach)\b/i,
    reason: 'it benefits from divergence before convergence',
    weight: 2,
  },
  // Chinese triggers
  {
    pattern: /想法|方案|思路|规划|怎么做比较好|有哪些做法/,
    reason: 'it asks for open-ended exploration',
    weight: 4,
  },
  {
    pattern: /怎么规划|怎么设计|怎么安排|计划一下/,
    reason: 'it needs framing before implementation',
    weight: 3,
  },
];

const DESIGN_TRIGGERS: Trigger[] = [
  {
    pattern: /\b(frontend|ui|ux|landing page|hero section|dashboard|design system|typography|color palette|responsive|mobile-first|motion design|visual design|delightful|master-level|composition|visual hierarchy)\b/i,
    reason: 'it is a Artemis master-level frontend or UI design request',
    weight: 4,
  },
  {
    pattern: /\b(css|styling|layout|spacing|animation|hover state|visual polish|brand|theme|negative space|visual pun|minimalism)\b/i,
    reason: 'it needs design-specific polish guidance based on Artemis master-design principles',
    weight: 3,
  },
  // Chinese triggers
  {
    pattern: /前端|界面|UI设计|设计稿|样式|布局|交互|视觉效果/,
    reason: 'it is primarily a frontend or UI design request',
    weight: 4,
  },
  {
    pattern: /动画|响应式|移动端适配|主题色|字体排版|间距调整/,
    reason: 'it needs design-specific polish guidance instead of a generic planning pass',
    weight: 3,
  },
];

const ATHENA_TRIGGERS: Trigger[] = [
  {
    pattern: /\b(fix|implement|add|finish|complete|continue|update|replace|rename|wire|ship)\b/i,
    reason: 'it asks for execution rather than just analysis',
    weight: 3,
  },
  {
    pattern: /\ball(?:\s+remaining)?\s+features|end-to-end|across multiple|across several|throughout the repo|whole repo|whole codebase\b/i,
    reason: 'it implies coordinated work across multiple code areas',
    weight: 3,
  },
  {
    pattern: /\b(refactor|migration|rename)\b/i,
    reason: 'it likely needs coordinated multi-file edits and validation',
    weight: 2,
  },
  // Chinese triggers
  {
    pattern: /实现|完成|修复|整个代码库|所有功能|帮我改|帮我写|帮我加/,
    reason: 'it asks for execution rather than just analysis',
    weight: 3,
  },
  {
    pattern: /跨多个文件|整个项目|全局替换|批量修改|端到端/,
    reason: 'it implies coordinated work across multiple code areas',
    weight: 3,
  },
  // New triggers for better recognition of complex tasks
  {
    pattern: /\bbug\b/i,
    reason: 'it involves debugging and fixing issues',
    weight: 2,
  },
  {
    pattern: /\b通讯软件|消息回复|消息不显示|图片不生成|网页生成|多 Agent|协作处理|复杂任务\b/,
    reason: 'it involves complex system integration or communication features',
    weight: 4,
  },
  {
    pattern: /\bTelegram|WeChat|CLI|网页|图片\b/,
    reason: 'it involves multiple platforms or UI components',
    weight: 3,
  },
  {
    pattern: /\b问题|解决|功能\b/,
    reason: 'it is a problem-solving or feature implementation task',
    weight: 2,
  },
];

const DIRECT_TRIGGERS: Trigger[] = [
  {
    pattern: /\b(fix|implement|add|create|write|update|replace|delete|rename|mkdir|cd|workspace)\b/i,
    reason: 'it is phrased as direct execution work',
    weight: 3,
  },
  {
    pattern: /[/\\][^/\s]+|[A-Za-z0-9_-]+\.(ts|tsx|js|jsx|json|md|py|go|rs|css|html)\b/i,
    reason: 'it references concrete files or code targets',
    weight: 2,
  },
  // Chinese triggers
  {
    pattern: /帮我|修改一下|添加|创建|删除|改一下|写一个|建立文件夹|创建文件夹|进入目录|设为工作区/i,
    reason: 'it is phrased as direct execution work',
    weight: 3,
  },
];

function collectMatches(
  prompt: string,
  triggers: Trigger[],
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  for (const trigger of triggers) {
    if (!trigger.pattern.test(prompt)) {
      continue;
    }

    score += trigger.weight;
    if (!reasons.includes(trigger.reason)) {
      reasons.push(trigger.reason);
    }
  }

  return { score, reasons };
}

function pickConfidence(score: number): 'low' | 'medium' | 'high' {
  if (score >= 6) {
    return 'high';
  }

  if (score >= 3) {
    return 'medium';
  }

  return 'low';
}

function pushReason(reasons: string[], reason: string): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function applyContextSignals(
  normalized: string,
  contest: { score: number; reasons: string[] },
  niko: { score: number; reasons: string[] },
  design: { score: number; reasons: string[] },
  athena: { score: number; reasons: string[] },
  direct: { score: number; reasons: string[] },
  context?: WorkflowAdviceContext,
): void {
  const explicitFileCount = extractExplicitFileCount(normalized);
  const referencedFiles = countFileReferences(normalized);
  const broadScope =
    (explicitFileCount ?? 0) > 5 ||
    referencedFiles > 5 ||
    /\b(codebase-wide|whole repo|across the repo|across the codebase|multiple directories|many files|all features|remaining features)\b/i.test(
      normalized,
    ) ||
    /整个代码库|整个项目|全局|跨多个文件|批量修改|所有功能|所有文件/.test(normalized);

  if ((explicitFileCount ?? 0) > 5 || referencedFiles > 5) {
    if (direct.score >= 2 || athena.score >= 3) {
      athena.score += 4;
      pushReason(
        athena.reasons,
        'the request spans many concrete files and should be split into coordinated slices',
      );
    } else {
      niko.score += 4;
      pushReason(
        niko.reasons,
        'the request spans many concrete files and should be split into specialist batches',
      );
    }
  }

  if (broadScope) {
    if (direct.score >= 2 || athena.score >= 3) {
      athena.score += 3;
      pushReason(
        athena.reasons,
        'the request is broad enough that automatic Athena execution will reduce context decay',
      );
    } else {
      niko.score += 3;
      pushReason(
        niko.reasons,
        'the request is broad enough that an Athena-style plan will reduce context decay',
      );
    }
  }

  if (normalized.trim().length >= 700) {
    niko.score += 1;
    pushReason(
      niko.reasons,
      'the request is large enough that a short planning pass can reduce churn',
    );
  }

  if (
    design.score > 0 &&
    /\b(app|page|screen|component|layout|hero|navbar|footer|landing)\b/i.test(normalized)
  ) {
    design.score += 1;
    pushReason(
      design.reasons,
      'the request references concrete interface surfaces that benefit from a design-specific brief',
    );
  }

  const evidenceGraph = context?.evidenceGraph;

  if (!evidenceGraph) {
    return;
  }

  const conflictCount = evidenceGraph.conflicts.length;
  const challengeCount = evidenceGraph.edges.filter(
    (edge) => edge.type === 'challenges',
  ).length;
  const openRiskCount = evidenceGraph.claims.filter(
    (claim) =>
      claim.kind === 'risk' &&
      (claim.status === 'unverified' || claim.status === 'refuted'),
  ).length;

  if (conflictCount > 0) {
    contest.score += Math.min(5, conflictCount + 2);
    pushReason(
      contest.reasons,
      'the current evidence graph already contains contradictions',
    );
  }

  if (challengeCount > 0) {
    contest.score += Math.min(3, challengeCount);
    pushReason(
      contest.reasons,
      'the current evidence already includes active challenges',
    );
  }

  if (openRiskCount >= 2) {
    contest.score += 2;
    pushReason(
      contest.reasons,
      'the current evidence still has multiple open risks to verify',
    );
  }

  if ((context?.sessionMessageCount ?? 0) >= 12 && contest.score === 0) {
    niko.score += 1;
    pushReason(
      niko.reasons,
      'the session is long enough that a structured synthesis pass may help',
    );
  }
}

export function adviseWorkflow(
  prompt: string,
  context?: WorkflowAdviceContext,
): WorkflowAdvice {
  const normalized = prompt.trim();
  const contest = collectMatches(normalized, CONTEST_TRIGGERS);
  const niko = collectMatches(normalized, NIKO_TRIGGERS);
  const design = collectMatches(normalized, DESIGN_TRIGGERS);
  const athena = collectMatches(normalized, ATHENA_TRIGGERS);
  const direct = collectMatches(normalized, DIRECT_TRIGGERS);
  const dualModel = collectMatches(normalized, DUAL_MODEL_TRIGGERS);
  
  applyContextSignals(normalized, contest, niko, design, athena, direct, context);
  
  // 检查是否需要双模型协作
  if (dualModel.score >= 4) {
    // 对于复杂任务，优先推荐双模型协作的 niko 工作流
    niko.score += dualModel.score;
    niko.reasons.push(...dualModel.reasons);
  }

  if (
    contest.score >= 4 &&
    contest.score >= niko.score &&
    contest.score >= athena.score
  ) {
    return {
      recommended: 'contest',
      reason: contest.reasons[0] ?? 'it benefits from proposal, critique, and verdict separation',
      confidence: pickConfidence(contest.score),
    };
  }

  if (athena.score >= 4 && athena.score >= niko.score) {
    return {
      recommended: 'athena',
      reason:
        athena.reasons[0] ??
        'it is a broad execution request that should be split into coordinated slices',
      confidence: pickConfidence(athena.score),
    };
  }

  if (
    design.score >= 4 &&
    design.score >= niko.score &&
    design.score > athena.score
  ) {
    return {
      recommended: 'design',
      reason:
        design.reasons[0] ??
        'it is primarily a frontend design request that benefits from a focused UI brief',
      confidence: pickConfidence(design.score),
    };
  }

  if (niko.score >= 3 && niko.score > direct.score) {
    return {
      recommended: 'niko',
      reason: niko.reasons[0] ?? 'it benefits from divergence before convergence',
      confidence: pickConfidence(niko.score),
    };
  }

  return {
    recommended: 'direct',
    reason:
      direct.reasons[0] ??
      'it looks concrete enough to execute directly without an exploration pass',
    confidence: pickConfidence(direct.score),
  };
}

function shouldPromptForUpgrade(advice: WorkflowAdvice): boolean {
  return (
    advice.recommended !== 'direct' &&
    (advice.confidence === 'medium' || advice.confidence === 'high')
  );
}

function isBroadExecutionPrompt(prompt: string): boolean {
  const explicitFileCount = extractExplicitFileCount(prompt) ?? 0;
  const referencedFiles = countFileReferences(prompt);
  const broadScope =
    explicitFileCount > 3 ||
    referencedFiles > 3 ||
    /\b(codebase-wide|whole repo|whole codebase|across the repo|across the codebase|across multiple|across several|multiple directories|many files|remaining features|all(?:\s+remaining)?\s+features)\b/i.test(
      prompt,
    ) ||
    /整个代码库|整个项目|全局|跨多个文件|批量修改|所有功能|所有文件/.test(prompt);
  const executionIntent =
    /\b(fix|implement|add|finish|complete|continue|update|replace|rename|wire|ship)\b/i.test(
      prompt,
    ) ||
    /实现|完成|修复|帮我改|帮我写|帮我加/.test(prompt);

  return broadScope && executionIntent;
}

function shouldAutoUpgradeAthenaInNonInteractive(
  prompt: string,
  advice: WorkflowAdvice,
): boolean {
  if (advice.recommended !== 'athena') {
    return false;
  }

  if (advice.confidence === 'high') {
    return true;
  }

  return advice.confidence === 'medium' && isBroadExecutionPrompt(prompt);
}

export async function maybeUpgradeWorkflow(
  prompt: string,
  promptIO: PromptIO | undefined,
  onInfo?: (message: string) => void,
  context?: WorkflowAdviceContext,
): Promise<{
  advice: WorkflowAdvice;
  selected: WorkflowMode;
}> {
  const advice = adviseWorkflow(prompt, context);

  if (!shouldPromptForUpgrade(advice)) {
    return {
      advice,
      selected: 'direct',
    };
  }

  if (!promptIO?.available) {
    if (shouldAutoUpgradeAthenaInNonInteractive(prompt, advice)) {
      onInfo?.(
        `[advisor] ${getWorkflowDisplayName(advice.recommended)} recommended: ${advice.reason}; auto-upgrading in non-interactive flow`,
      );
      return {
        advice,
        selected: 'athena',
      };
    }

    onInfo?.(
      `[advisor] ${getWorkflowDisplayName(advice.recommended)} recommended: ${advice.reason}; staying on direct mode in non-interactive flow`,
    );
    return {
      advice,
      selected: 'direct',
    };
  }

  const shouldUpgrade = await choosePromptBoolean(promptIO, {
    title: `This prompt looks better suited for ${getWorkflowDisplayName(advice.recommended)} mode because ${advice.reason}. Upgrade now?`,
    yesLabel: 'Yes, upgrade now',
    noLabel: 'No, stay on direct mode',
    defaultValue: true,
  });

  if (!shouldUpgrade) {
    onInfo?.(`[advisor] stayed on direct mode`);
    return {
      advice,
      selected: 'direct',
    };
  }

  onInfo?.(`[advisor] upgraded to ${getWorkflowDisplayName(advice.recommended)}`);
  return {
    advice,
    selected: advice.recommended,
  };
}

export async function recordWorkflowAdvice(
  sessionStore: SessionStore,
  session: SessionRecord,
  advice: WorkflowAdvice,
  selected: WorkflowMode,
): Promise<void> {
  if (advice.recommended === 'direct' && selected === 'direct') {
    return;
  }

  await sessionStore.appendWorkflowEntry(session, 'Workflow Advisor', [
    `recommended=${getWorkflowDisplayName(advice.recommended)}`,
    `selected=${getWorkflowDisplayName(selected)}`,
    `confidence=${advice.confidence}`,
    `reason=${advice.reason}`,
  ]);
}
