import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { processDelegatedRuntimeCommands, runAgent, runSpecialistAgent, type RunAgentOptions } from './agent.js';
import { deriveClaimStatement } from './evidence.js';
import { buildWorkflowStrengthContract } from './workflowStrength.js';
import type { AgentRole, PlanItem, RunResult, SessionRecord } from './types.js';
import type { ImageAttachment, ImageMediaType } from '../providers/types.js';
import { truncate } from '../utils/fs.js';

type CriticKind =
  | 'spec'
  | 'test_adversary'
  | 'security'
  | 'architecture'
  | 'visual';

type CriticVerdict = 'approved' | 'needs_improvement' | 'rejected';

type HarnessResult = {
  executed: boolean;
  passed: boolean;
  passRate: number;
  output: string;
};

type CriticResult = {
  kind: CriticKind;
  score: number;
  issues: string[];
  verdict: CriticVerdict;
  sessionId: string;
  turns: number;
};

type JudgeVerdict = {
  overallScore: number;
  approved: boolean;
  verdict: CriticVerdict;
  scoreBreakdown: Record<string, number>;
  priorityIssues: string[];
  continueIteration: boolean;
  marginalGainExpected: boolean;
};

type NidhoggRound = {
  roundIndex: number;
  generatorReply: string;
  generatorTurns: number;
  generatorSessionId: string;
  harnessResult: HarnessResult;
  criticResults: CriticResult[];
  judgeVerdict: JudgeVerdict;
};

export type NidhoggConfig = {
  maxRounds?: number;
  passThreshold?: number;
  rejectThreshold?: number;
  marginalGainMin?: number;
  critics?: CriticKind[];
  images?: string[];
  videos?: string[];
};

type ResolvedNidhoggConfig = Required<
  Pick<NidhoggConfig, 'maxRounds' | 'passThreshold' | 'rejectThreshold' | 'marginalGainMin'>
> & {
  critics: CriticKind[];
  images: string[];
  videos: string[];
};

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_PASS_THRESHOLD = 0.8;
const DEFAULT_REJECT_THRESHOLD = 0.2;
const DEFAULT_MARGINAL_GAIN_MIN = 0.04;
const DEFAULT_CRITICS: CriticKind[] = ['spec', 'test_adversary', 'security', 'architecture'];

const SCORE_WEIGHTS: Record<string, number> = {
  spec: 0.28,
  test_adversary: 0.24,
  security: 0.24,
  harness: 0.24,
  architecture: 0.22,
  visual: 0.2,
};

const GENERATOR_SOFT_TIMEOUT_MS = 300_000;
const CRITIC_SOFT_TIMEOUT_MS = 180_000;
const JUDGE_SOFT_TIMEOUT_MS = 120_000;

function buildHarnessEngineeringContract(): string {
  return [
    'Nidhogg harness engineering contract:',
    '- Treat repo-local instructions, docs, tests, schemas, and existing implementation as the source of truth.',
    '- Keep context legible: start from a small map, load deeper files only when needed, and pass compact evidence to reviewers.',
    '- Build or select a verification harness before claiming success: static checks, focused tests, runtime smoke, logs/metrics, or visual evidence as the task requires.',
    '- Prefer deterministic controls over prose: scripts, lint, typecheck, tests, permission boundaries, read-only critics, and architecture fitness checks.',
    '- Make the result inspectable by future agents: changed files, commands run, pass/fail evidence, unresolved risks, and any stale docs or cleanup discovered.',
  ].join('\n');
}

type TimedResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true; error?: string };

async function withSoftTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<TimedResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    timer.unref?.();

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          timedOut: true,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function normalizeConfig(config?: NidhoggConfig): ResolvedNidhoggConfig {
  const critics = (config?.critics?.length ? config.critics : DEFAULT_CRITICS)
    .filter((critic, index, list) => list.indexOf(critic) === index);

  return {
    maxRounds: Math.max(1, Math.min(8, Math.floor(config?.maxRounds ?? DEFAULT_MAX_ROUNDS))),
    passThreshold: clamp01(config?.passThreshold ?? DEFAULT_PASS_THRESHOLD),
    rejectThreshold: clamp01(config?.rejectThreshold ?? DEFAULT_REJECT_THRESHOLD),
    marginalGainMin: Math.max(0, Math.min(0.5, config?.marginalGainMin ?? DEFAULT_MARGINAL_GAIN_MIN)),
    critics,
    images: config?.images ?? [],
    videos: config?.videos ?? [],
  };
}

async function loadImageAttachment(filePath: string): Promise<ImageAttachment> {
  const ext = path.extname(filePath).toLowerCase();
  const mediaType: ImageMediaType =
    ext === '.png'
      ? 'image/png'
      : ext === '.gif'
      ? 'image/gif'
      : ext === '.webp'
      ? 'image/webp'
      : 'image/jpeg';
  const data = await readFile(filePath);
  return {
    data: data.toString('base64'),
    mediaType,
    label: path.basename(filePath),
  };
}

function buildGeneratorTask(
  userPrompt: string,
  round: number,
  priorityIssues?: string[],
): string {
  const lines = [
    `Task: ${userPrompt.trim()}`,
    '',
    'Parent approval: execute this builder task now. You are authorized to edit files and run focused verification commands for this delegated Nidhogg round.',
    '',
  ];

  if (round === 1) {
    lines.push(
      'Instructions:',
      buildWorkflowStrengthContract(),
      buildHarnessEngineeringContract(),
      '- Implement a complete, correct, production-quality solution.',
      '- Start by gathering enough local context to avoid blind edits.',
      '- Before editing, identify the smallest useful harness for this task and prefer existing repo commands.',
      '- Make precise code changes; avoid unrelated refactors.',
      '- Run the most relevant verification commands you can reasonably run.',
      '- Report changed files, verification commands, pass/fail evidence, and any blocker.',
    );
  } else {
    lines.push(
      `Revision round ${round}: address these priority issues from adversarial review:`,
      ...(priorityIssues?.length
        ? priorityIssues.map((issue) => `- ${issue}`)
        : ['- The previous round did not reach the quality threshold. Improve robustness and verification evidence.']),
      '',
      'Instructions:',
      buildWorkflowStrengthContract(),
      buildHarnessEngineeringContract(),
      '- Fix the listed issues directly. Do not introduce unrelated changes.',
      '- Re-run the relevant verification commands after repairs.',
      '- Report updated changed files and verification evidence.',
    );
  }

  return lines.join('\n');
}

function buildCriticTask(
  kind: CriticKind,
  userPrompt: string,
  generatorReply: string,
  round: number,
  imageLabels?: string[],
): string {
  const focus =
    kind === 'spec'
      ? [
          'You are the Spec Critic.',
          'Focus on requirement alignment and behavioral correctness.',
          '- Did the builder use repo-local source of truth instead of assumptions?',
          '- Does the solution fully satisfy the user request?',
          '- Are edge cases, error paths, and boundaries handled?',
          '- Did the implementation preserve existing contracts?',
        ]
      : kind === 'test_adversary'
      ? [
          'You are the Test Adversary.',
          'Focus on how this solution could break.',
          '- What inputs, states, races, or environments would expose bugs?',
          '- What critical test coverage is missing?',
          '- Is the verification evidence strong enough?',
          '- Would the reported harness actually catch the highest-risk regressions?',
        ]
      : kind === 'architecture'
      ? [
          'You are the Architecture Critic.',
          'Focus on structure, coupling, maintainability, and operational risk.',
          '- Are module boundaries and abstractions appropriate?',
          '- Does the change fit established local patterns?',
          '- Are there performance, concurrency, or migration risks?',
          '- Does this add legibility for future agents, or should stale docs/dead workflow paths be cleaned up?',
        ]
      : kind === 'visual'
      ? [
          'You are the Visual Critic.',
          imageLabels?.length ? `Reference images: ${imageLabels.join(', ')}` : '',
          'Focus on visual correctness and design fidelity against the attached reference images.',
        ].filter(Boolean)
      : [
          'You are the Security Critic.',
          'Focus on security and safety.',
          '- Are there injection, auth, permission, path, SSRF, or secret-handling risks?',
          '- Is input validation sufficient?',
          '- Is error handling safe and non-leaky?',
        ];

  return [
    'ANALYSIS PHASE. Do not edit files and do not run mutation tools.',
    'Your job is to review the proposed solution and return strict JSON.',
    '',
    `Original task: ${userPrompt.trim()}`,
    '',
    `Proposed solution report, round ${round}:`,
    generatorReply.trim() || '[No generator output captured]',
    '',
    ...focus,
    '',
    'Reply with one JSON object on a single line:',
    '{"score": <0.0-1.0>, "issues": ["<specific issue>"], "verdict": "<approved|needs_improvement|rejected>"}',
    '',
    'Be tough but fair. score=1 means no material issue; score=0 means critical failure.',
    'Keep the JSON compact and concrete.',
  ].join('\n');
}

function buildJudgeTask(
  userPrompt: string,
  generatorReply: string,
  harnessResult: HarnessResult,
  criticResults: CriticResult[],
  round: number,
  previousScore: number | undefined,
): string {
  const scoreLines = criticResults.map(
    (critic) =>
      `- ${critic.kind}: score=${critic.score.toFixed(2)} verdict=${critic.verdict} issues=${critic.issues.slice(0, 3).join(' | ') || 'none'}`,
  );
  const harnessLine = harnessResult.executed
    ? `- harness: ${harnessResult.passed ? 'passed' : 'failed'} pass_rate=${harnessResult.passRate.toFixed(2)}`
    : '- harness: not executed or not reported';

  return [
    'JUDGMENT PHASE. Do not edit files and do not run mutation tools.',
    'You are the arbiter for a Nidhogg adversarial programming loop.',
    '',
    `Original task: ${userPrompt.trim()}`,
    `Round: ${round}`,
    previousScore !== undefined ? `Previous overall score: ${previousScore.toFixed(2)}` : '',
    '',
    'Evidence:',
    harnessLine,
    ...scoreLines,
    '',
    'Generator output preview:',
    truncate(generatorReply.trim(), 500),
    '',
    'Return one JSON object on a single line:',
    '{"overall_score": <0.0-1.0>, "approved": <true|false>, "verdict": "<approved|needs_improvement|rejected>", "score_breakdown": {"spec": <0-1>, "test_adversary": <0-1>, "security": <0-1>, "architecture": <0-1>, "harness": <0-1>}, "priority_issues": ["<top fix>"], "continue_iteration": <true|false>, "marginal_gain_expected": <true|false>}',
    '',
    'approved=true only when the solution is production-ready, architecture-safe, and verification evidence is adequate.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function parseHarnessFromGeneratorOutput(output: string): HarnessResult {
  const lower = output.toLowerCase();
  const ranVerification =
    /\b(test|spec|jest|vitest|mocha|pytest|tsc|typecheck|lint|eslint|check|build)\b/.test(lower) &&
    /\b(pass(?:ing|ed)?|fail(?:ing|ed)?|error|ok|success|result|completed)\b/.test(lower);

  if (!ranVerification) {
    return { executed: false, passed: false, passRate: 0, output: '' };
  }

  const passMatch = output.match(/(\d+)\s+pass(?:ing|ed)?/i);
  const failMatch = output.match(/(\d+)\s+fail(?:ing|ed)?/i);
  const passing = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
  const failing = failMatch ? Number.parseInt(failMatch[1], 10) : 0;
  if (passing + failing > 0) {
    return {
      executed: true,
      passed: failing === 0,
      passRate: passing / (passing + failing),
      output: truncate(output, 500),
    };
  }

  const hasSuccess =
    /\b(all tests pass|tests passed|passed|no errors|0 errors|0 failures|success|succeeded|green)\b/i.test(output);
  const hasFailure =
    /\b(failed|failure|error|exception|assertion|red)\b/i.test(output) &&
    !/\b(no error|0 error|0 fail|0 failure)\b/i.test(output);

  return {
    executed: true,
    passed: hasSuccess && !hasFailure,
    passRate: hasSuccess && !hasFailure ? 1 : hasFailure ? 0 : 0.5,
    output: truncate(output, 500),
  };
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j += 1) {
      if (text[j] === '{') depth += 1;
      if (text[j] === '}') {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const parsed = JSON.parse(text.slice(i, j + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

function normalizeVerdict(value: unknown, score: number): CriticVerdict {
  if (value === 'approved' || value === 'needs_improvement' || value === 'rejected') {
    return value;
  }
  if (score >= 0.8) return 'approved';
  if (score <= 0.3) return 'rejected';
  return 'needs_improvement';
}

export function parseCriticReply(raw: string): {
  verdict: CriticVerdict;
  feedback: string;
} {
  const parsed = extractJsonObject(raw);
  if (parsed) {
    const score = typeof parsed.score === 'number' ? clamp01(parsed.score) : 0.5;
    return {
      verdict: normalizeVerdict(parsed.verdict, score),
      feedback:
        typeof parsed.feedback === 'string'
          ? parsed.feedback.trim()
          : truncate(raw.trim(), 300),
    };
  }

  const lower = raw.toLowerCase();
  if (/\bapproved\b/.test(lower) && !/\bnot approved\b/.test(lower)) {
    return { verdict: 'approved', feedback: truncate(raw.trim(), 300) };
  }
  if (/\brejected\b/.test(lower)) {
    return { verdict: 'rejected', feedback: truncate(raw.trim(), 300) };
  }
  return { verdict: 'needs_improvement', feedback: truncate(raw.trim(), 300) };
}

function parseCriticScore(raw: string, kind: CriticKind): CriticResult {
  const parsed = extractJsonObject(raw);
  if (parsed) {
    const score = typeof parsed.score === 'number' ? clamp01(parsed.score) : 0.5;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((item): item is string => typeof item === 'string')
      : [];
    return {
      kind,
      score,
      issues,
      verdict: normalizeVerdict(parsed.verdict, score),
      sessionId: '',
      turns: 0,
    };
  }

  const { verdict, feedback } = parseCriticReply(raw);
  const score = verdict === 'approved' ? 0.85 : verdict === 'rejected' ? 0.15 : 0.5;
  return {
    kind,
    score,
    issues: feedback ? [feedback] : [],
    verdict,
    sessionId: '',
    turns: 0,
  };
}

function buildFallbackBreakdown(
  criticResults: CriticResult[],
  harnessResult: HarnessResult,
): Record<string, number> {
  const breakdown: Record<string, number> = {
    harness: harnessResult.executed ? harnessResult.passRate : 0.5,
  };
  for (const critic of criticResults) {
    breakdown[critic.kind] = critic.score;
  }
  for (const critic of DEFAULT_CRITICS) {
    if (breakdown[critic] === undefined) {
      breakdown[critic] = 0.5;
    }
  }
  return breakdown;
}

function computeWeightedScore(
  criticResults: CriticResult[],
  harnessResult: HarnessResult,
): number {
  let total = 0;
  let totalWeight = 0;
  for (const critic of criticResults) {
    const weight = SCORE_WEIGHTS[critic.kind] ?? 0;
    total += weight * critic.score;
    totalWeight += weight;
  }
  const harnessWeight = SCORE_WEIGHTS.harness;
  total += harnessWeight * (harnessResult.executed ? harnessResult.passRate : 0.5);
  totalWeight += harnessWeight;
  return totalWeight > 0 ? clamp01(total / totalWeight) : 0.5;
}

function parseJudgeVerdict(
  raw: string,
  criticResults: CriticResult[],
  harnessResult: HarnessResult,
  previousScore: number | undefined,
  config: ResolvedNidhoggConfig,
): JudgeVerdict {
  const parsed = extractJsonObject(raw);
  if (parsed && 'overall_score' in parsed) {
    const overallScore =
      typeof parsed.overall_score === 'number'
        ? clamp01(parsed.overall_score)
        : computeWeightedScore(criticResults, harnessResult);
    const approved =
      typeof parsed.approved === 'boolean'
        ? parsed.approved && overallScore >= config.passThreshold
        : overallScore >= config.passThreshold;
    const priorityIssues = Array.isArray(parsed.priority_issues)
      ? parsed.priority_issues.filter((item): item is string => typeof item === 'string')
      : [];
    const breakdown =
      parsed.score_breakdown &&
      typeof parsed.score_breakdown === 'object' &&
      !Array.isArray(parsed.score_breakdown)
        ? Object.fromEntries(
            Object.entries(parsed.score_breakdown as Record<string, unknown>)
              .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
              .map(([key, value]) => [key, clamp01(value)]),
          )
        : buildFallbackBreakdown(criticResults, harnessResult);

    return {
      overallScore,
      approved,
      verdict: normalizeVerdict(parsed.verdict, overallScore),
      scoreBreakdown: breakdown,
      priorityIssues,
      continueIteration:
        typeof parsed.continue_iteration === 'boolean'
          ? parsed.continue_iteration
          : !approved,
      marginalGainExpected:
        typeof parsed.marginal_gain_expected === 'boolean'
          ? parsed.marginal_gain_expected
          : true,
    };
  }

  const overallScore = computeWeightedScore(criticResults, harnessResult);
  const approved = overallScore >= config.passThreshold;
  const marginalGain =
    previousScore !== undefined
      ? overallScore - previousScore
      : config.marginalGainMin + 1;
  return {
    overallScore,
    approved,
    verdict:
      overallScore >= config.passThreshold
        ? 'approved'
        : overallScore <= config.rejectThreshold
        ? 'rejected'
        : 'needs_improvement',
    scoreBreakdown: buildFallbackBreakdown(criticResults, harnessResult),
    priorityIssues: criticResults.flatMap((critic) => critic.issues.slice(0, 1)),
    continueIteration: !approved,
    marginalGainExpected: marginalGain >= config.marginalGainMin,
  };
}

function buildInitialPlan(): PlanItem[] {
  return [
    { id: '1', content: 'Preflight: choose Nidhogg critics and load optional assets', status: 'done' },
    { id: '2', content: 'Round 1: builder implementation + harness evidence', status: 'in_progress' },
    { id: '3', content: 'Round 1: adversarial critic pool', status: 'pending' },
    { id: '4', content: 'Round 1: judge aggregation', status: 'pending' },
    { id: '5', content: 'Iterate repairs until convergence or stop condition', status: 'pending' },
    { id: '6', content: 'Final synthesis', status: 'pending' },
  ];
}

function buildRoundPlan(
  round: number,
  maxRounds: number,
  phase: 'gen' | 'critics' | 'judge',
): PlanItem[] {
  return [
    { id: '1', content: 'Preflight: choose Nidhogg critics and load optional assets', status: 'done' },
    {
      id: '2',
      content: `Round ${round}/${maxRounds}: builder implementation + harness evidence`,
      status: phase === 'gen' ? 'in_progress' : 'done',
    },
    {
      id: '3',
      content: `Round ${round}/${maxRounds}: adversarial critic pool`,
      status: phase === 'critics' ? 'in_progress' : phase === 'gen' ? 'pending' : 'done',
    },
    {
      id: '4',
      content: `Round ${round}/${maxRounds}: judge aggregation`,
      status: phase === 'judge' ? 'in_progress' : phase === 'gen' || phase === 'critics' ? 'pending' : 'done',
    },
    {
      id: '5',
      content: 'Iterate repairs until convergence or stop condition',
      status: round < maxRounds ? 'pending' : 'in_progress',
    },
    { id: '6', content: 'Final synthesis', status: 'pending' },
  ];
}

function buildCompletedPlan(): PlanItem[] {
  return [
    { id: '1', content: 'Preflight: choose Nidhogg critics and load optional assets', status: 'done' },
    { id: '2', content: 'Builder implementation rounds', status: 'done' },
    { id: '3', content: 'Adversarial critic pool evaluations', status: 'done' },
    { id: '4', content: 'Judge aggregation', status: 'done' },
    { id: '5', content: 'Convergence or stop condition reached', status: 'done' },
    { id: '6', content: 'Final synthesis', status: 'done' },
  ];
}

function formatDelegationResult(
  role: AgentRole,
  label: string,
  score: number | undefined,
  reply: string,
): string {
  return JSON.stringify(
    {
      action: { type: 'delegate_task', role, label },
      ok: true,
      score: score ?? null,
      output: reply,
    },
    null,
    2,
  );
}

function sanitizeReadOnlyFailure(raw: string): string {
  return /权限受限|read.?only|切换到可写|切换到 write|write 模式|can.?t.*write|无法.*写入|无法.*创建文件/i.test(raw)
    ? '{"score":0.5,"issues":["critic did not produce usable read-only analysis"],"verdict":"needs_improvement"}'
    : raw;
}

export async function runNidhoggWorkflow(
  session: SessionRecord,
  userPrompt: string,
  options: RunAgentOptions,
  config?: NidhoggConfig,
): Promise<RunResult> {
  let activeUserPrompt = userPrompt;
  const absorbNidhoggUserMessages = async (phase: string): Promise<number> => {
    const updates = options.pollRunningUserMessages?.() ?? [];
    const accepted: string[] = [];
    for (const raw of updates) {
      const text = raw.trim();
      if (!text) continue;
      accepted.push(text);
      options.sessionStore.appendMessage(
        session,
        'user',
        [
          '[New user message received while Nidhogg was running]',
          text,
          '',
          'Treat this as the latest correction for the adversarial loop. Re-scope the remaining generator, critic, judge, and synthesis work before continuing.',
        ].join('\n'),
      );
      options.onRunningUserMessageAccepted?.(text);
    }
    if (accepted.length === 0) return 0;
    activeUserPrompt = [
      activeUserPrompt.trim(),
      '',
      'Latest in-progress user correction(s):',
      ...accepted.map((text) => `- ${text}`),
      '',
      'Apply these corrections immediately to all remaining Nidhogg work.',
    ].join('\n');
    await options.sessionStore.save(session);
    options.onInfo?.(`[nidhogg] accepted ${accepted.length} running user message(s) at ${phase}; updated remaining task scope`);
    return accepted.length;
  };

  const resolvedConfig = normalizeConfig(config);
  const imageAttachments: ImageAttachment[] = [];
  const imageLabels: string[] = [];

  if (resolvedConfig.images.length > 0 && options.provider.supportsImages) {
    for (const imagePath of resolvedConfig.images) {
      try {
        const image = await loadImageAttachment(imagePath);
        imageAttachments.push(image);
        imageLabels.push(image.label ?? path.basename(imagePath));
      } catch (error) {
        options.onInfo?.(
          `[nidhogg] warning: failed to load image ${path.basename(imagePath)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (resolvedConfig.videos.length > 0) {
    options.onInfo?.('[nidhogg] video critic requested but not restored yet; continuing with code/image critics');
  }

  let criticKinds = resolvedConfig.critics;
  if (imageAttachments.length > 0 && !criticKinds.includes('visual')) {
    criticKinds = [...criticKinds, 'visual'];
  }
  if (criticKinds.length === 0) {
    criticKinds = DEFAULT_CRITICS;
  }

  options.onInfo?.(
    `[nidhogg] adversarial loop enabled: rounds=${resolvedConfig.maxRounds} critics=${criticKinds.join(',')}`,
  );

  session.plan = buildInitialPlan();
  await options.sessionStore.save(session);
  await options.sessionStore.appendWorkflowEntry(session, 'Nidhogg Started', [
    `task=${truncate(activeUserPrompt, 300)}`,
    `max_rounds=${resolvedConfig.maxRounds}`,
    `pass_threshold=${resolvedConfig.passThreshold}`,
    `critics=${criticKinds.join(',')}`,
    imageLabels.length > 0 ? `images=${imageLabels.join(',')}` : 'images=none',
  ]);
  await options.ensureSpecialistProvider?.(['builder', 'reviewer', 'arbiter']);

  const rounds: NidhoggRound[] = [];
  let lastGeneratorReply = '';
  let lastGeneratorSessionId = '';
  let finalJudgeVerdict: JudgeVerdict | undefined;
  let previousOverallScore: number | undefined;
  let totalTurns = 0;

  const checkInterrupt = async (phase: string): Promise<void> => {
    await processDelegatedRuntimeCommands(session, options);
    await absorbNidhoggUserMessages(phase);
    options.onInfo?.(`[nidhogg] interrupt check passed: ${phase}`);
  };

  for (let round = 1; round <= resolvedConfig.maxRounds; round += 1) {
    await checkInterrupt(`round ${round} generator start`);
    options.onInfo?.(`[nidhogg] round ${round}/${resolvedConfig.maxRounds} - generator`);
    session.plan = buildRoundPlan(round, resolvedConfig.maxRounds, 'gen');
    await options.sessionStore.save(session);

    const generatorOutcome = await withSoftTimeout(
      runSpecialistAgent(
        session,
        'builder',
        buildGeneratorTask(activeUserPrompt, round, finalJudgeVerdict?.priorityIssues),
        {
          ...options,
          appendUserMessage: true,
          imageAttachments: round === 1 ? imageAttachments : undefined,
          onInfo: (message) => options.onInfo?.(`[nidhogg:builder:r${round}] ${message}`),
        },
        { title: `[nidhogg:builder:r${round}] ${truncate(activeUserPrompt, 60)}` },
      ),
      GENERATOR_SOFT_TIMEOUT_MS,
    );

    let generatorTurns = 0;
    if (generatorOutcome.timedOut) {
      options.onInfo?.(
        `[nidhogg] round ${round} builder soft-failed: ${generatorOutcome.error ?? 'timeout'}`,
      );
    } else {
      lastGeneratorReply = generatorOutcome.value.result.reply;
      lastGeneratorSessionId = generatorOutcome.value.session.id;
      generatorTurns = generatorOutcome.value.result.turns;
      totalTurns += generatorTurns;
    }

    const harnessResult = parseHarnessFromGeneratorOutput(lastGeneratorReply);
    await options.sessionStore.upsertEvidenceClaim(session, {
      statement: deriveClaimStatement(lastGeneratorReply || 'Nidhogg builder produced no usable report.'),
      status: 'inferred',
      kind: 'proposal',
      sourceSessionId: lastGeneratorSessionId || session.id,
      sourceProfile: 'builder',
    });
    options.sessionStore.appendMessage(
      session,
      'tool',
      formatDelegationResult('builder', `r${round}:builder`, undefined, lastGeneratorReply),
      'delegate_task',
    );
    await options.sessionStore.appendWorkflowEntry(session, `Nidhogg Round ${round} Builder`, [
      `session=${lastGeneratorSessionId || 'none'}`,
      `turns=${generatorTurns}`,
      `soft_failed=${generatorOutcome.timedOut}`,
      `harness_executed=${harnessResult.executed}`,
      `harness_pass_rate=${harnessResult.passRate.toFixed(2)}`,
      `reply=${truncate(lastGeneratorReply, 300)}`,
    ]);
    if (!generatorOutcome.timedOut) {
      options.onInfo?.(`[nidhogg] round ${round}/${resolvedConfig.maxRounds} - generator done`);
    }

    await checkInterrupt(`round ${round} critic start`);
    options.onInfo?.(`[nidhogg] round ${round}/${resolvedConfig.maxRounds} - critic pool (${criticKinds.join(',')})`);
    session.plan = buildRoundPlan(round, resolvedConfig.maxRounds, 'critics');
    await options.sessionStore.save(session);

    const criticRuns = await Promise.all(
      criticKinds.map(async (kind) => {
        options.onInfo?.(`[nidhogg] round ${round} - critic:${kind} starting`);
        const outcome = await withSoftTimeout(
          runSpecialistAgent(
            session,
            'reviewer',
            buildCriticTask(kind, activeUserPrompt, lastGeneratorReply, round, imageLabels),
            {
              ...options,
              appendUserMessage: true,
              permissionManager: options.permissionManager.fork('read-only'),
              imageAttachments: kind === 'visual' ? imageAttachments : undefined,
              onInfo: (message) => options.onInfo?.(`[nidhogg:${kind}:r${round}] ${message}`),
            },
            { title: `[nidhogg:${kind}:r${round}] ${truncate(activeUserPrompt, 50)}` },
          ),
          CRITIC_SOFT_TIMEOUT_MS,
        );

        if (outcome.timedOut) {
          options.onInfo?.(`[nidhogg] round ${round} - critic:${kind} soft timeout`);
          return {
            kind,
            result: {
              kind,
              score: 0.5,
              issues: [`critic unavailable: ${outcome.error ?? 'soft timeout'}`],
              verdict: 'needs_improvement' as CriticVerdict,
              sessionId: '',
              turns: 0,
            },
            reply: `[critic unavailable: ${outcome.error ?? 'soft timeout'}]`,
            timedOut: true,
          };
        }

        const reply = sanitizeReadOnlyFailure(outcome.value.result.reply);
        const result = parseCriticScore(reply, kind);
        result.sessionId = outcome.value.session.id;
        result.turns = outcome.value.result.turns;
        options.onInfo?.(
          `[nidhogg] round ${round} - critic:${kind} done (score ${result.score.toFixed(2)})`,
        );
        return { kind, result, reply, timedOut: false };
      }),
    );

    const criticResults: CriticResult[] = [];
    for (const criticRun of criticRuns) {
      criticResults.push(criticRun.result);
      totalTurns += criticRun.result.turns;
      options.sessionStore.appendMessage(
        session,
        'tool',
        formatDelegationResult('reviewer', `r${round}:${criticRun.kind}`, criticRun.result.score, criticRun.reply),
        'delegate_task',
      );
      await options.sessionStore.appendWorkflowEntry(
        session,
        `Nidhogg Round ${round} Critic:${criticRun.kind}`,
        [
          `session=${criticRun.result.sessionId || 'timeout'}`,
          `score=${criticRun.result.score.toFixed(2)}`,
          `verdict=${criticRun.result.verdict}`,
          `timed_out=${criticRun.timedOut}`,
          `issues=${criticRun.result.issues.slice(0, 3).join(' | ') || 'none'}`,
        ],
      );
    }
    options.onInfo?.(`[nidhogg] round ${round}/${resolvedConfig.maxRounds} - critic pool done`);

    await checkInterrupt(`round ${round} judge start`);
    options.onInfo?.(`[nidhogg] round ${round}/${resolvedConfig.maxRounds} - judge`);
    session.plan = buildRoundPlan(round, resolvedConfig.maxRounds, 'judge');
    await options.sessionStore.save(session);
    const judgeOutcome = await withSoftTimeout(
      runSpecialistAgent(
        session,
        'arbiter',
        buildJudgeTask(activeUserPrompt, lastGeneratorReply, harnessResult, criticResults, round, previousOverallScore),
        {
          ...options,
          appendUserMessage: true,
          permissionManager: options.permissionManager.fork('read-only'),
          onInfo: (message) => options.onInfo?.(`[nidhogg:judge:r${round}] ${message}`),
        },
        { title: `[nidhogg:judge:r${round}] ${truncate(activeUserPrompt, 50)}` },
      ),
      JUDGE_SOFT_TIMEOUT_MS,
    );

    const judgeReply = judgeOutcome.timedOut
      ? ''
      : sanitizeReadOnlyFailure(judgeOutcome.value.result.reply);
    const judgeSessionId = judgeOutcome.timedOut ? '' : judgeOutcome.value.session.id;
    if (!judgeOutcome.timedOut) {
      totalTurns += judgeOutcome.value.result.turns;
    }
    const judgeVerdict = parseJudgeVerdict(
      judgeReply,
      criticResults,
      harnessResult,
      previousOverallScore,
      resolvedConfig,
    );
    finalJudgeVerdict = judgeVerdict;

    const isImproved =
      previousOverallScore !== undefined &&
      judgeVerdict.overallScore > previousOverallScore;
    options.onInfo?.(
      `[nidhogg] round ${round} finished. score: ${judgeVerdict.overallScore.toFixed(2)} (${isImproved ? 'up' : 'flat'})`,
    );
    options.sessionStore.appendMessage(
      session,
      'tool',
      formatDelegationResult('arbiter', `r${round}:judge`, judgeVerdict.overallScore, judgeReply),
      'delegate_task',
    );
    await options.sessionStore.upsertEvidenceClaim(session, {
      statement: deriveClaimStatement(judgeReply || `Nidhogg judge score ${judgeVerdict.overallScore.toFixed(2)}.`),
      status: judgeVerdict.approved ? 'observed' : 'unverified',
      kind: judgeVerdict.approved ? 'result' : 'risk',
      sourceSessionId: judgeSessionId || session.id,
      sourceProfile: 'arbiter',
    });
    await options.sessionStore.appendWorkflowEntry(session, `Nidhogg Round ${round} Judge`, [
      `session=${judgeSessionId || 'fallback'}`,
      `overall_score=${judgeVerdict.overallScore.toFixed(2)}`,
      `verdict=${judgeVerdict.verdict}`,
      `approved=${judgeVerdict.approved}`,
      `timed_out=${judgeOutcome.timedOut}`,
      `continue=${judgeVerdict.continueIteration}`,
      `priority_issues=${judgeVerdict.priorityIssues.slice(0, 3).join(' | ') || 'none'}`,
    ]);

    rounds.push({
      roundIndex: round,
      generatorReply: lastGeneratorReply,
      generatorTurns,
      generatorSessionId: lastGeneratorSessionId,
      harnessResult,
      criticResults,
      judgeVerdict,
    });
    await options.sessionStore.save(session);

    await checkInterrupt(`round ${round} complete`);

    if (judgeVerdict.approved) {
      options.onInfo?.(
        `[nidhogg] judge approved at round ${round} (score=${judgeVerdict.overallScore.toFixed(2)})`,
      );
      break;
    }
    if (!judgeVerdict.continueIteration || judgeVerdict.verdict === 'rejected') {
      options.onInfo?.(`[nidhogg] stopping after judge verdict=${judgeVerdict.verdict}`);
      break;
    }
    const marginalGain =
      previousOverallScore !== undefined
        ? judgeVerdict.overallScore - previousOverallScore
        : resolvedConfig.marginalGainMin + 1;
    if (previousOverallScore !== undefined && marginalGain < resolvedConfig.marginalGainMin) {
      options.onInfo?.(
        `[nidhogg] stopping: marginal gain ${marginalGain.toFixed(3)} < ${resolvedConfig.marginalGainMin}`,
      );
      break;
    }
    previousOverallScore = judgeVerdict.overallScore;
  }

  session.plan = buildCompletedPlan();
  await options.sessionStore.save(session);

  const finalScore = finalJudgeVerdict?.overallScore ?? 0;
  const finalVerdict = finalJudgeVerdict?.verdict ?? 'needs_improvement';
  const approved = finalJudgeVerdict?.approved ?? false;
  const breakdown = finalJudgeVerdict
    ? Object.entries(finalJudgeVerdict.scoreBreakdown)
        .map(([key, value]) => `${key}: ${value.toFixed(2)}`)
        .join(', ')
    : 'none';

  const synthesisPrompt = [
    `Original task: ${activeUserPrompt.trim()}`,
    '',
    `Nidhogg adversarial loop completed after ${rounds.length} round(s).`,
    `Final verdict: ${finalVerdict}`,
    `Final score: ${finalScore.toFixed(2)}`,
    `Approved: ${approved}`,
    `Score breakdown: ${breakdown}`,
    finalJudgeVerdict?.priorityIssues.length
      ? `Remaining priority issues: ${finalJudgeVerdict.priorityIssues.join('; ')}`
      : '',
    '',
    'Final builder report:',
    lastGeneratorReply.trim(),
    '',
    approved
      ? 'Return a concise final answer confirming what was changed and verified.'
      : 'Return a concise final answer explaining what was changed, what was verified, and what risk remains.',
  ]
    .filter(Boolean)
    .join('\n');

  options.onInfo?.('[nidhogg] synthesizing final output');
  const finalResult = await runAgent(session, synthesisPrompt, {
    ...options,
    profile: 'main',
    appendUserMessage: true,
  });
  totalTurns += finalResult.turns;

  await options.sessionStore.appendWorkflowEntry(session, 'Nidhogg Completed', [
    `rounds=${rounds.length}`,
    `final_verdict=${finalVerdict}`,
    `final_score=${finalScore.toFixed(2)}`,
    `approved=${approved}`,
    `total_turns=${totalTurns}`,
    `reply=${truncate(finalResult.reply, 300)}`,
  ]);

  return {
    reply: finalResult.reply,
    turns: totalTurns,
  };
}
