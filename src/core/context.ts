import type { AgentRole, SessionMessage, SessionRecord } from './types.js';
import { truncate } from '../utils/fs.js';
import { resolveOdinSkillContext } from '../odin/runtime.js';

const MIN_RECENT_MESSAGES = 6;
const LARGE_CONTEXT_MESSAGE_LIMIT = 65_535;
const MAIN_RECENT_MESSAGE_CHAR_LIMIT = 24_000;
const TOOL_SUMMARY_LINE_CHAR_LIMIT = 1_500;

type ContextBudgetProfile = {
  recentMessageCharLimit: number;
  latestUserMessageCharLimit: number;
  summaryLineCharLimit: number;
  summaryCharLimit: number;
  contextCharBudget: number;
};

const MAIN_CONTEXT_BUDGET: ContextBudgetProfile = {
  recentMessageCharLimit: MAIN_RECENT_MESSAGE_CHAR_LIMIT,
  latestUserMessageCharLimit: LARGE_CONTEXT_MESSAGE_LIMIT,
  summaryLineCharLimit: 2_048,
  summaryCharLimit: 24_000,
  contextCharBudget: 72_000,
};

const SPECIALIST_CONTEXT_BUDGET: ContextBudgetProfile = {
  recentMessageCharLimit: 16_000,
  latestUserMessageCharLimit: 32_000,
  summaryLineCharLimit: 1_500,
  summaryCharLimit: 16_000,
  contextCharBudget: 48_000,
};

export type ContextWindowOptions = {
  cwd?: string;
  contextLength?: number;
};

type ContextStats = {
  totalMessages: number;
  includedMessages: number;
  summarizedMessages: number;
  approxChars: number;
};

export type ContextBuildResult = {
  summary: string;
  messages: SessionMessage[];
  stats: ContextStats;
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function compactToolContent(
  content: string,
  recentMessageCharLimit: number,
): string {
  try {
    const parsed = JSON.parse(content) as {
      action?: {
        type?: string;
        path?: string;
        command?: string;
        role?: string;
        serverId?: string;
        toolName?: string;
        uri?: string;
      };
      ok?: boolean;
      output?: string;
    };

    const actionType = parsed.action?.type ?? 'unknown';
    let parsedOutput: Record<string, unknown> | undefined;
    if (typeof parsed.output === 'string') {
      try {
        parsedOutput = JSON.parse(parsed.output) as Record<string, unknown>;
      } catch {
        parsedOutput = undefined;
      }
    }

    if (actionType === 'delegate_task' && parsedOutput) {
      const role =
        (typeof parsedOutput.role === 'string' ? parsedOutput.role : undefined) ??
        parsed.action?.role ??
        'unknown';
      const sessionId =
        typeof parsedOutput.sessionId === 'string'
          ? parsedOutput.sessionId
          : 'n/a';
      const delegateStatus =
        typeof parsedOutput.status === 'string'
          ? parsedOutput.status
          : parsed.ok === false
            ? 'failed'
            : 'ok';
      const reply =
        typeof parsedOutput.reply === 'string'
          ? parsedOutput.reply
          : parsed.output ?? '';
      const guidance =
        typeof parsedOutput.guidance === 'string'
          ? parsedOutput.guidance
          : '';

      return truncate(
        normalizeWhitespace(
          `delegate_task role=${role} status=${delegateStatus} sessionId=${sessionId} reply=${reply} ${guidance}`,
        ),
        Math.min(recentMessageCharLimit, TOOL_SUMMARY_LINE_CHAR_LIMIT),
      );
    }

    if (actionType === 'approve_builder_execution' && parsedOutput) {
      const sessionId =
        typeof parsedOutput.sessionId === 'string'
          ? parsedOutput.sessionId
          : 'n/a';
      const approvalStatus =
        typeof parsedOutput.status === 'string'
          ? parsedOutput.status
          : parsed.ok === false
            ? 'failed'
            : 'ok';
      const reply =
        typeof parsedOutput.reply === 'string'
          ? parsedOutput.reply
          : parsed.output ?? '';

      return truncate(
        normalizeWhitespace(
          `approve_builder_execution status=${approvalStatus} sessionId=${sessionId} reply=${reply}`,
        ),
        Math.min(recentMessageCharLimit, TOOL_SUMMARY_LINE_CHAR_LIMIT),
      );
    }

    const target =
      parsed.action?.path ??
      parsed.action?.command ??
      (parsed.action?.serverId && parsed.action?.toolName
        ? `${parsed.action.serverId}:${parsed.action.toolName}`
        : undefined) ??
      (parsed.action?.serverId && parsed.action?.uri
        ? `${parsed.action.serverId}:${parsed.action.uri}`
        : undefined) ??
      parsed.action?.role ??
      'n/a';
    const status = parsed.ok === false ? 'failed' : 'ok';
    const output = normalizeWhitespace(parsed.output ?? '');

    return truncate(
      `${actionType} target=${target} status=${status} result=${output}`,
      Math.min(recentMessageCharLimit, TOOL_SUMMARY_LINE_CHAR_LIMIT),
    );
  } catch {
    return truncate(normalizeWhitespace(content), Math.min(recentMessageCharLimit, TOOL_SUMMARY_LINE_CHAR_LIMIT));
  }
}

function compactMessageContent(
  message: SessionMessage,
  maxChars: number,
  budgets: ContextBudgetProfile,
): string {
  if (message.role === 'tool') {
    return truncate(
      compactToolContent(message.content, budgets.recentMessageCharLimit),
      maxChars,
    );
  }

  return truncate(normalizeWhitespace(message.content), maxChars);
}

function buildSummaryLine(
  message: SessionMessage,
  budgets: ContextBudgetProfile,
): string {
  const label = message.name ? `${message.role}:${message.name}` : message.role;
  return `- ${label}: ${compactMessageContent(
    message,
    budgets.summaryLineCharLimit,
    budgets,
  )}`;
}

function buildSummary(
  messages: SessionMessage[],
  budgets: ContextBudgetProfile,
): string {
  if (messages.length === 0) {
    return '';
  }

  const lines = messages.map((message) => buildSummaryLine(message, budgets));
  return truncate(lines.join('\n'), budgets.summaryCharLimit);
}

function appendWithinBudget(
  selected: SessionMessage[],
  message: SessionMessage,
  currentChars: number,
  budget: number,
  budgets: ContextBudgetProfile,
): { accepted: boolean; chars: number } {
  const maxChars =
    selected.length === 0 && message.role === 'user'
      ? budgets.latestUserMessageCharLimit
      : budgets.recentMessageCharLimit;
  const compacted = compactMessageContent(
    message,
    maxChars,
    budgets,
  );
  const nextChars = currentChars + compacted.length;

  if (selected.length >= MIN_RECENT_MESSAGES && nextChars > budget) {
    return {
      accepted: false,
      chars: currentChars,
    };
  }

  selected.unshift({
    ...message,
    content: compacted,
  });

  return {
    accepted: true,
    chars: nextChars,
  };
}

function trimSelectedMessages(
  selected: SessionMessage[],
  approxChars: number,
  budget: number,
): number {
  while (selected.length > MIN_RECENT_MESSAGES && approxChars > budget) {
    const removed = selected.shift();
    if (!removed) {
      break;
    }
    approxChars -= removed.content.length;
  }

  return approxChars;
}

function getContextBudgets(
  profile: 'main' | AgentRole,
  contextLength?: number,
): ContextBudgetProfile {
  const base = profile === 'main'
    ? MAIN_CONTEXT_BUDGET
    : SPECIALIST_CONTEXT_BUDGET;
  if (typeof contextLength !== 'number' || !Number.isFinite(contextLength) || contextLength <= 0) {
    return base;
  }

  const targetChars = Math.max(
    base.contextCharBudget,
    Math.min(480_000, Math.floor(contextLength * 2.2)),
  );
  if (targetChars === base.contextCharBudget) {
    return base;
  }

  const scale = targetChars / base.contextCharBudget;
  return {
    recentMessageCharLimit: Math.min(160_000, Math.floor(base.recentMessageCharLimit * Math.min(scale, 4))),
    latestUserMessageCharLimit: Math.min(240_000, Math.floor(base.latestUserMessageCharLimit * Math.min(scale, 4))),
    summaryLineCharLimit: Math.min(8_192, Math.floor(base.summaryLineCharLimit * Math.min(scale, 3))),
    summaryCharLimit: Math.min(120_000, Math.floor(base.summaryCharLimit * Math.min(scale, 4))),
    contextCharBudget: targetChars,
  };
}

export async function buildContextWindow(
  session: SessionRecord,
  profile: 'main' | AgentRole = 'main',
  optionsOrCwd?: ContextWindowOptions | string,
): Promise<ContextBuildResult> {
  const options = typeof optionsOrCwd === 'string' ? { cwd: optionsOrCwd } : optionsOrCwd;
  const budgets = getContextBudgets(profile, options?.contextLength);
  const selected: SessionMessage[] = [];
  let approxChars = 0;
  let cursor = session.messages.length - 1;

  while (cursor >= 0) {
    const message = session.messages[cursor];
    const outcome = appendWithinBudget(
      selected,
      message,
      approxChars,
      budgets.contextCharBudget,
      budgets,
    );

    if (!outcome.accepted) {
      break;
    }

    approxChars = outcome.chars;
    cursor -= 1;
  }

  const summarizedMessages = cursor + 1;
  const summarySource = summarizedMessages > 0
    ? session.messages.slice(0, summarizedMessages)
    : [];
  let summary = buildSummary(summarySource, budgets);

  // 查找用户的最新任务描述
  const userMessages = session.messages.filter(msg => msg.role === 'user');
  const latestUserMessage = userMessages[userMessages.length - 1];
  
  if (latestUserMessage && options?.cwd) {
    // 调用 resolveOdinSkillContext 查找匹配的技能
    try {
      const skillContext = await resolveOdinSkillContext({
        cwd: options.cwd,
        task: latestUserMessage.content,
        scope: 'local',
      });
      
      if (skillContext) {
        if (summary) {
          summary = `\n${skillContext}\n${summary}`;
        } else {
          summary = skillContext;
        }
      }
    } catch (error) {
      console.error('Failed to resolve Odin skills:', error);
    }
  }

  if (summary) {
    approxChars += summary.length;
  }

  approxChars = trimSelectedMessages(
    selected,
    approxChars,
    budgets.contextCharBudget,
  );

  return {
    summary,
    messages: selected,
    stats: {
      totalMessages: session.messages.length,
      includedMessages: selected.length,
      summarizedMessages,
      approxChars,
    },
  };
}
