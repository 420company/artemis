import type { AgentAction } from '../core/types.js';
import type { ToolPermissionCategory as NewToolPermissionCategory } from '../core/toolDef.js';
import type { ToolExecutionMode as NewToolExecutionMode } from '../core/toolDef.js';

export type ToolPermissionCategory = NewToolPermissionCategory
export type ToolExecutionMode = NewToolExecutionMode

export type WorkspaceSwitchRequest = {
  requestedPath: string;
  workspacePath: string;
  usedNearestExistingParent: boolean;
  source: 'tool-path' | 'run_command';
  toolName: string;
  originalPath?: string;
  switchNow: boolean;
};

export type ToolExecutionContext = {
  cwd: string;
  /**
   * Callback a tool can invoke to persist a new working directory back to the
   * caller. Used by run_command to track `cd` across subprocess boundaries
   * (children can't mutate their parent's cwd, so we harvest $PWD after each
   * shell invocation and forward it here). The brain's tool loop uses this to
   * keep subsequent tool calls in the same directory the user/model expects.
   */
  updateCwd?: (newCwd: string) => void | Promise<void>;
  /**
   * Optional hook for runtime-managed workspace trust checks. Tools call this
   * before switching to a path outside the current workspace root.
   */
  requestWorkspaceSwitch?: (request: WorkspaceSwitchRequest) => Promise<boolean>;
  /**
   * Permission mode context for tool execution
   */
  permissionMode?: 'ask' | 'accept-all' | 'read' | 'write';
  /**
   * Whether the user has admin privileges
   */
  isAdmin?: boolean;
  /**
   * Session context for tracking
   */
  sessionId?: string;
  /**
   * Contextual information for the tool execution
   */
  context?: any;
};

export type ToolError = {
  code: string;
  message: string;
  retryable?: boolean;
  availableTools?: string[];
  details?: Record<string, unknown>;
};

export type ToolExecutionResult = {
  action: AgentAction;
  ok: boolean;
  output: string;
  error?: ToolError;
  data?: any;
  metadata?: {
    executionTime?: number;
    memoryUsage?: number;
    toolName?: string;
    toolKind?: string;
  };
};
