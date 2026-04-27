import type { RunAgentOptions } from './agent.js';
import { runAgent } from './agent.js';
import { buildWorkflowHint } from './workflowHints.js';
import {
  recordOdinWorkflowFailure,
  recordOdinWorkflowSuccess,
} from '../odin/runtime.js';
import { appendTaskRuntime, createTaskRuntimeRecord, updateTaskRuntime } from './taskRuntime.js';
import { runPluginHooks } from '../extensions/hooks.js';
import type { RunResult, SessionRecord } from './types.js';
import { truncate } from '../utils/fs.js';
import {
  prepareHeimdallThreadState,
  finalizeHeimdallThreadState,
  recordHeimdallEvent,
  recordHeimdallStage,
} from './heimdall.js';

export type WorkflowMode = 'direct' | 'niko' | 'contest' | 'athena' | 'design' | 'nidhogg';
type WorkflowModeLabel = WorkflowMode | 'brainstorm';

export function getWorkflowDisplayName(
  mode: WorkflowModeLabel,
  options?: {
    capitalize?: boolean;
  },
): string {
  const label =
    mode === 'niko' || mode === 'brainstorm'
      ? 'niko'
      : mode === 'athena'
      ? 'athena'
      : mode === 'nidhogg'
      ? 'nidhogg'
      : mode;
  if (!options?.capitalize) {
    return label;
  }

  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function isReadOnlyWorkflow(mode: WorkflowModeLabel): boolean {
  return false;
}

export function isSelfImprovingWorkflow(mode: WorkflowMode): boolean {
  return mode === 'nidhogg';
}

export function getWorkflowSessionTitle(
  mode: WorkflowMode,
  cwd: string,
): string | undefined {
  if (mode === 'niko') {
    return `${getWorkflowDisplayName(mode, { capitalize: true })} in ${cwd}`;
  }

  if (mode === 'contest') {
    return `${getWorkflowDisplayName(mode, { capitalize: true })} in ${cwd}`;
  }

  if (mode === 'athena') {
    return `${getWorkflowDisplayName(mode, { capitalize: true })} in ${cwd}`;
  }

  if (mode === 'design') {
    return `${getWorkflowDisplayName(mode, { capitalize: true })} in ${cwd}`;
  }

  if (mode === 'nidhogg') {
    return `${getWorkflowDisplayName(mode, { capitalize: true })} in ${cwd}`;
  }

  return undefined;
}

export async function runWorkflowMode(
  mode: WorkflowMode,
  session: SessionRecord,
  userPrompt: string,
  options: RunAgentOptions,
): Promise<RunResult> {
  const changedFilesBefore = new Set(session.changedFiles ?? []);
  const verificationCommandsBefore = session.verificationCommands?.length ?? 0;
  let rootRuntime =
    options.rootRuntimeId
      ? (session.taskRuntimes ?? []).find(
          (runtime) => runtime.id === options.rootRuntimeId,
        )
      : undefined;

  if (rootRuntime) {
    rootRuntime =
      updateTaskRuntime(session, rootRuntime.id, {
        label: `${getWorkflowDisplayName(mode)} :: ${truncate(userPrompt.trim(), 140)}`,
        workflowMode: mode,
        status: 'running',
        lastOutput: `Workflow started: ${getWorkflowDisplayName(mode)}`,
      }) ?? rootRuntime;
  } else {
    rootRuntime = createTaskRuntimeRecord({
      id: options.rootRuntimeId,
      label: `${getWorkflowDisplayName(mode)} :: ${truncate(userPrompt.trim(), 140)}`,
      workflowMode: mode,
      status: 'running',
    });
    appendTaskRuntime(session, rootRuntime);
  }
  await options.sessionStore.save(session);
  const heimdallThreadState =
    options.heimdallThreadState ??
    (await prepareHeimdallThreadState({
      cwd: options.cwd,
      session,
      permissionMode: options.permissionManager.getMode(),
      workflowMode: mode,
      runtimeId: rootRuntime.id,
    }));
  const shouldOwnHeimdallState = options.heimdallThreadState === undefined;
  await recordHeimdallStage(
    options.sessionStore,
    session,
    heimdallThreadState,
    'before_thread_bind',
    {
      runtimeId: rootRuntime.id,
      workflowMode: mode,
      status: 'running',
      summary: 'Heimdall thread state prepared for workflow runtime.',
    },
  );
  await recordHeimdallEvent(options.sessionStore, session, {
    kind: 'workflow_started',
    summary: `${getWorkflowDisplayName(mode, { capitalize: true })} workflow started.`,
    runtimeId: rootRuntime.id,
    sessionId: session.id,
    workflowMode: mode,
    status: 'running',
    metadata: {
      prompt: truncate(userPrompt.trim(), 220),
    },
  });
  options.onInfo?.(
    `[${getWorkflowDisplayName(mode)}] workflow strength contract active: specialist phases, dynamic task-specific assets, portable verification, failure recovery`,
  );

  try {
    await recordHeimdallStage(
      options.sessionStore,
      session,
      heimdallThreadState,
      'before_workflow',
      {
        runtimeId: rootRuntime.id,
        workflowMode: mode,
        status: 'running',
        summary: 'Heimdall workflow lifecycle entered pre-run stage.',
      },
    );
    const beforeHooks = await runPluginHooks({
      cwd: options.cwd,
      event: 'beforeWorkflow',
      permissionManager: options.permissionManager,
    });
    if (beforeHooks.results.length > 0) {
      await options.sessionStore.appendWorkflowEntry(
        session,
        'Plugin Hooks Before Workflow',
        beforeHooks.results.map((result) =>
          `${result.plugin.id} outcome=${result.outcome} command=${result.command} summary=${truncate(result.summary, 160)}`,
        ),
      );
    }

    // All workflow modes (niko/contest/athena/design/nidhogg/direct) now
    // route through `runAgent` with a mode-specific system-prompt hint.
    // The old phase-based pipelines (plan→critic→judge→execute) have been
    // replaced with this Claude Code style flow: hint injects domain bias
    // into the agent's context, then the agent's normal tool loop handles
    // execution end-to-end.
    const hint = mode === 'direct'
      ? ''
      : buildWorkflowHint(mode, { cwd: options.cwd, userPrompt });
    const hintedPrompt = hint
      ? `${hint}\n\n--- USER REQUEST ---\n\n${userPrompt}`
      : userPrompt;

    const result: RunResult = await runAgent(session, hintedPrompt, {
      ...options,
      heimdallThreadState,
      profile: 'main',
      completionContract: 'requires_execution_evidence',
    });

    updateTaskRuntime(session, rootRuntime.id, {
      status: 'completed',
      processId: undefined,
      processStartedAt: undefined,
      processToken: undefined,
      lastOutput: result.reply,
    });
    const afterHooks = await runPluginHooks({
      cwd: options.cwd,
      event: 'afterWorkflow',
      permissionManager: options.permissionManager,
    });
    if (afterHooks.results.length > 0) {
      await options.sessionStore.appendWorkflowEntry(
        session,
        'Plugin Hooks After Workflow',
        afterHooks.results.map((hookResult) =>
          `${hookResult.plugin.id} outcome=${hookResult.outcome} command=${hookResult.command} summary=${truncate(hookResult.summary, 160)}`,
        ),
      );
    }
    await recordOdinWorkflowSuccess({
      cwd: options.cwd,
      mode,
      prompt: userPrompt,
      reply: result.reply,
      turns: result.turns,
      changedFiles: (session.changedFiles ?? []).filter(
        (filePath) => !changedFilesBefore.has(filePath),
      ),
      verificationCommands: (session.verificationCommands ?? []).slice(
        verificationCommandsBefore,
      ),
    });
    await recordHeimdallStage(
      options.sessionStore,
      session,
      heimdallThreadState,
      'after_workflow',
      {
        runtimeId: rootRuntime.id,
        workflowMode: mode,
        status: 'completed',
        summary: 'Heimdall workflow lifecycle completed.',
      },
    );
    await recordHeimdallEvent(options.sessionStore, session, {
      kind: 'workflow_completed',
      summary: `${getWorkflowDisplayName(mode, { capitalize: true })} workflow completed.`,
      runtimeId: rootRuntime.id,
      sessionId: session.id,
      workflowMode: mode,
      status: 'completed',
      metadata: {
        turns: String(result.turns),
        reply: truncate(result.reply.trim(), 220),
      },
    });
    await options.sessionStore.save(session);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTaskRuntime(session, rootRuntime.id, {
      status: 'failed',
      processId: undefined,
      processStartedAt: undefined,
      processToken: undefined,
      lastOutput: message,
    });
    await recordOdinWorkflowFailure({
      cwd: options.cwd,
      mode,
      prompt: userPrompt,
      error: message,
    });
    await recordHeimdallStage(
      options.sessionStore,
      session,
      heimdallThreadState,
      'on_workflow_error',
      {
        runtimeId: rootRuntime.id,
        workflowMode: mode,
        status: 'failed',
        summary: 'Heimdall workflow lifecycle captured an error.',
        metadata: {
          error: truncate(message, 220),
        },
      },
    );
    await recordHeimdallEvent(options.sessionStore, session, {
      kind: 'workflow_failed',
      summary: `${getWorkflowDisplayName(mode, { capitalize: true })} workflow failed.`,
      runtimeId: rootRuntime.id,
      sessionId: session.id,
      workflowMode: mode,
      status: 'failed',
      metadata: {
        error: truncate(message, 220),
      },
    });
    await options.sessionStore.save(session);
    throw error;
  } finally {
    if (shouldOwnHeimdallState) {
      await finalizeHeimdallThreadState(heimdallThreadState);
    }
  }
}
