import type { AgentAction } from '../core/types.js';
import {
  getProviderCallableActionTypes,
  getToolDefinition,
  renderDetailedToolManifest,
  renderToolManifest,
  validateToolAction,
} from './registry.js';
import type {
  ToolError,
  ToolExecutionContext,
  ToolExecutionResult,
} from './types.js';

export function getToolManifest(): string {
  return renderToolManifest();
}

export function getDetailedToolManifest(): string {
  return renderDetailedToolManifest();
}

function buildToolError(
  code: string,
  message: string,
  options: {
    retryable?: boolean;
    availableTools?: string[];
    details?: Record<string, unknown>;
  } = {},
): ToolError {
  return {
    code,
    message,
    retryable: options.retryable,
    ...(options.availableTools ? { availableTools: options.availableTools } : {}),
    ...(options.details ? { details: options.details } : {}),
  };
}

function buildRuntimeManagedFallbackResult(
  action: AgentAction,
): ToolExecutionResult {
  const message = [
    `Tool ${action.type} is runtime-managed and has no direct executor.`,
    'The action was rejected before executor dispatch.',
    'Route it through the agent runtime instead of calling tools/index.ts directly.',
  ].join('\n');

  return {
    action,
    ok: false,
    output: message,
    error: buildToolError('tool_runtime_managed', message, {
      retryable: false,
      availableTools: getProviderCallableActionTypes(),
    }),
  };
}

function buildUnknownToolFallbackResult(
  action: AgentAction,
  receivedType: unknown,
): ToolExecutionResult {
  const label =
    typeof receivedType === 'string' && receivedType.trim()
      ? receivedType
      : '<missing>';
  const message = [
    `Unknown tool type: ${label}`,
    'Reject the action or map it to a registered tool before executing it.',
  ].join('\n');

  return {
    action,
    ok: false,
    output: message,
    error: buildToolError('tool_unknown', message, {
      retryable: true,
      availableTools: getProviderCallableActionTypes(),
    }),
  };
}

function buildValidationFallbackResult(
  action: AgentAction,
  errors: string[],
): ToolExecutionResult {
  const message = [
    `Invalid arguments for tool ${action.type}:`,
    ...errors.map((error) => `- ${error}`),
  ].join('\n');

  return {
    action,
    ok: false,
    output: message,
    error: buildToolError('tool_invalid_arguments', message, {
      retryable: true,
      details: { errors },
    }),
  };
}

function buildExecutionErrorFallbackResult(
  action: AgentAction,
  error: unknown,
): ToolExecutionResult {
  const message = error instanceof Error ? error.message : String(error);
  const output = [
    `Tool execution failed for ${action.type}:`,
    `- ${message}`,
  ].join('\n');

  return {
    action,
    ok: false,
    output,
    error: buildToolError('tool_execution_failed', message, {
      retryable: false,
    }),
  };
}

function attachReportedFailureError(
  action: AgentAction,
  result: ToolExecutionResult,
): ToolExecutionResult {
  if (result.ok || result.error) {
    return result;
  }

  const message =
    result.output ||
    `Tool ${action.type} returned ok=false without a structured error.`;

  return {
    ...result,
    error: buildToolError('tool_reported_failure', message, {
      retryable: true,
    }),
  };
}

function buildMissingExecutorFallbackResult(
  action: AgentAction,
): ToolExecutionResult {
  const message = [
    `Tool ${action.type} is registered for direct execution but no executor is attached.`,
    'Fix the tool registry before attempting to execute this action.',
  ].join('\n');

  return {
    action,
    ok: false,
    output: message,
    error: buildToolError('tool_missing_executor', message, {
      retryable: false,
      availableTools: getProviderCallableActionTypes(),
    }),
  };
}

export async function executeAction(
  action: AgentAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const receivedType = (action as { type?: string }).type || '';
  const tool = getToolDefinition(receivedType);

  if (!tool) {
    return buildUnknownToolFallbackResult(action, receivedType);
  }

  const validationErrors = validateToolAction(action);
  if (validationErrors.length > 0) {
    return buildValidationFallbackResult(action, validationErrors);
  }

  if (tool.executionMode === 'non-blocking') {
    return buildRuntimeManagedFallbackResult(action);
  }

  if (!tool.execute) {
    return buildMissingExecutorFallbackResult(action);
  }

  try {
    return attachReportedFailureError(
      action,
      await tool.execute(action, context),
    );
  } catch (error) {
    return buildExecutionErrorFallbackResult(action, error);
  }
}
