import type { AgentRole, SessionMessage, SessionRecord } from './types.js';
import { truncate } from '../utils/fs.js';
import { resolveOdinSkillContext } from '../odin/runtime.js';

const MIN_RECENT_MESSAGES = 6;
const LARGE_CONTEXT_MESSAGE_LIMIT = 65_535;

type ContextBudgetProfile = {
  recentMessageCharLimit: number;
  latestUserMessageCharLimit: number;
  summaryLineCharLimit: number;
  summaryCharLimit: number;
  contextCharBudget: number;
};

const MAIN_CONTEXT_BUDGET: ContextBudgetProfile = {
  recentMessageCharLimit: LARGE_CONTEXT_MESSAGE_LIMIT,
  latestUserMessageCharLimit: LARGE_CONTEXT_MESSAGE_LIMIT,
  summaryLineCharLimit: 4_096,
  summaryCharLimit: LARGE_CONTEXT_MESSAGE_LIMIT,
  contextCharBudget: LARGE_CONTEXT_MESSAGE_LIMIT * 2,
};

const SPECIALIST_CONTEXT_BUDGET: ContextBudgetProfile = {
  recentMessageCharLimit: LARGE_CONTEXT_MESSAGE_LIMIT,
  latestUserMessageCharLimit: LARGE_CONTEXT_MESSAGE_LIMIT,
  summaryLineCharLimit: 4_096,
  summaryCharLimit: LARGE_CONTEXT_MESSAGE_LIMIT,
  contextCharBudget: LARGE_CONTEXT_MESSAGE_LIMIT * 2,
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
        recentMessageCharLimit,
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
        recentMessageCharLimit,
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
      recentMessageCharLimit,
    );
  } catch {
    return truncate(normalizeWhitespace(content), recentMessageCharLimit);
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
): ContextBudgetProfile {
  return profile === 'main'
    ? MAIN_CONTEXT_BUDGET
    : SPECIALIST_CONTEXT_BUDGET;
}

export async function buildContextWindow(
  session: SessionRecord,
  profile: 'main' | AgentRole = 'main',
  cwd?: string,
): Promise<ContextBuildResult> {
  const budgets = getContextBudgets(profile);
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
  
  if (latestUserMessage && cwd) {
    // 调用 resolveOdinSkillContext 查找匹配的技能
    try {
      const skillContext = await resolveOdinSkillContext({
        cwd,
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
