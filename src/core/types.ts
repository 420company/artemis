export type Role = 'system' | 'user' | 'assistant' | 'tool';

export type SessionMessage = {
  id: string;
  role: Role;
  content: string;
  name?: string;
  createdAt: string;
  /** Raw Anthropic content blocks — stored when assistant response included tool_use blocks */
  contentBlocks?: unknown[];
  /** Tool use ID — set on 'tool' role messages linking back to the tool_use block (Anthropic & OpenAI) */
  toolUseId?: string;
  /** OpenAI-style tool calls on an assistant message */
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /**
   * DeepSeek-R1 and similar reasoning models emit a separate reasoning chain
   * before their final answer. This field stores that chain so it can be passed
   * back verbatim in subsequent API calls — the DeepSeek API requires it and
   * returns HTTP 400 if it is absent from the message history.
   */
  reasoningContent?: string;
};

export type VerificationCommandRecord = {
  command: string;
  ok: boolean;
  createdAt: string;
};

export type PermissionMode =
  | 'prompt'
  | 'read-only'
  | 'accept-edits'
  | 'accept-all';

export type SessionAutonomyMode = 'standard' | 'autodrive';

export type AgentRole =
  | 'planner'
  | 'researcher'
  | 'builder'
  | 'reviewer'
  | 'brainstormer'
  | 'arbiter'
  | 'architect'
  | 'designer'
  | 'qa';

export type AgentPhase = 'proposal' | 'execution';
export type ClaimStatus =
  | 'observed'
  | 'inferred'
  | 'unverified'
  | 'refuted';
export type EvidenceKind =
  | 'fact'
  | 'proposal'
  | 'risk'
  | 'decision'
  | 'result';
export type EvidenceEdgeType =
  | 'supports'
  | 'challenges'
  | 'derived_from';
export type EvidenceConflictReason =
  | 'status_conflict'
  | 'negation_conflict';

export type PlanStatus = 'pending' | 'in_progress' | 'done';
export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked';
export type TaskRuntimeStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type TaskRuntimeCommandType = 'interrupt' | 'notify';
export type TaskRuntimeCommandState = 'queued' | 'acknowledged';

export type TaskRuntimeCommandRecord = {
  id: string;
  type: TaskRuntimeCommandType;
  state: TaskRuntimeCommandState;
  createdAt: string;
  updatedAt: string;
  handledAt?: string;
  handledBySessionId?: string;
  summary?: string;
  metadata?: Record<string, string>;
};

export type HeimdallEventKind =
  | 'thread_bound'
  | 'lifecycle_stage'
  | 'upload_ingested'
  | 'workflow_started'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'delegate_bound'
  | 'delegate_completed'
  | 'approval_recorded'
  | 'takeover_requested'
  | 'takeover_completed'
  | 'runtime_reconciled'
  | 'action_authorized'
  | 'action_denied'
  | 'action_started'
  | 'action_completed'
  | 'action_failed';

export const HEIMDALL_EVENT_KINDS: HeimdallEventKind[] = [
  'thread_bound',
  'lifecycle_stage',
  'upload_ingested',
  'workflow_started',
  'workflow_completed',
  'workflow_failed',
  'delegate_bound',
  'delegate_completed',
  'approval_recorded',
  'takeover_requested',
  'takeover_completed',
  'runtime_reconciled',
  'action_authorized',
  'action_denied',
  'action_started',
  'action_completed',
  'action_failed',
];

export function isHeimdallEventKind(value: unknown): value is HeimdallEventKind {
  return (
    typeof value === 'string' &&
    (HEIMDALL_EVENT_KINDS as readonly string[]).includes(value)
  );
}

export type PlanItem = {
  id: string;
  content: string;
  status: PlanStatus;
};

export type TaskItem = {
  id: string;
  content: string;
  status: TaskStatus;
};

export type TaskRuntimeRecord = {
  id: string;
  taskId?: string;
  parentId?: string;
  label: string;
  processId?: number;
  processStartedAt?: string;
  processToken?: string;
  workflowMode?: 'direct' | 'niko' | 'contest' | 'athena' | 'design' | 'nidhogg';
  role?: AgentRole;
  phase?: AgentPhase;
  workerSessionId?: string;
  commandQueue?: TaskRuntimeCommandRecord[];
  status: TaskRuntimeStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  lastOutput?: string;
};

export type HeimdallEventRecord = {
  id: string;
  kind: HeimdallEventKind;
  createdAt: string;
  summary: string;
  runtimeId?: string;
  sessionId?: string;
  workerSessionId?: string;
  workflowMode?: 'direct' | 'niko' | 'contest' | 'athena' | 'design' | 'nidhogg';
  role?: AgentRole;
  phase?: AgentPhase;
  status?: TaskRuntimeStatus;
  metadata?: Record<string, string>;
};

export type HeimdallArtifactKind =
  | 'changed_file'
  | 'generated_output'
  | 'upload'
  | 'report';

export type HeimdallArtifactRecord = {
  id: string;
  path: string;
  kind: HeimdallArtifactKind;
  source: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  existsInWorkspace: boolean;
  metadata?: Record<string, string>;
};

export type HeimdallUploadRecord = {
  id: string;
  originalPath: string;
  storedPath: string;
  filename: string;
  sizeBytes?: number;
  mimeType?: string;
  createdAt: string;
  updatedAt: string;
  sessionId: string;
  metadata?: Record<string, string>;
};

export type AgentAction =
  | {
      type: 'list_files';
      pattern?: string;
      maxResults?: number;
    }
  | {
      type: 'read_file';
      path: string;
      startLine?: number;
      endLine?: number;
    }
  | {
      type: 'search_files';
      pattern?: string;
      query?: string;
      maxResults?: number;
    }
  | {
      type: 'lookup_docs';
      query: string;
      library?: string;
      version?: string;
      maxResults?: number;
    }
  | {
      type: 'search_web';
      query: string;
      limit?: number;
      backend?: 'auto' | 'bing' | 'google' | 'duckduckgo' | 'wikipedia';
    }
  | {
      type: 'deep_research';
      query: string;
      systemInstruction?: string;
      maxPolls?: number;
      pollIntervalMs?: number;
    }
  | {
      type: 'mcp_call_tool';
      serverId: string;
      toolName: string;
      args?: Record<string, unknown>;
      readOnly?: boolean;
      timeoutMs?: number;
    }
  | {
      type: 'mcp_read_resource';
      serverId: string;
      uri: string;
      timeoutMs?: number;
    }
  | {
      type: 'mcp_get_prompt';
      serverId: string;
      promptName: string;
      args?: Record<string, unknown>;
      timeoutMs?: number;
    }
  | {
      type: 'write_file';
      path: string;
      content: string;
    }
  | {
      type: 'insert_in_file';
      path: string;
      content: string;
      after?: string;
      before?: string;
      atLine?: number;
    }
  | {
      type: 'replace_in_file';
      path: string;
      find: string;
      replace: string;
      replaceAll?: boolean;
    }
  | {
      type: 'apply_patch';
      patch: string;
    }
  | {
      type: 'run_command';
      command: string;
      timeoutMs?: number;
    }
  | {
      type: 'delegate_task';
      role: AgentRole;
      task: string;
      maxTurns?: number;
    }
  | {
      type: 'spawn_background_workflow';
      command: 'run' | 'athena' | 'design' | 'niko' | 'contest' | 'nidhogg';
      prompt: string;
      maxTurns?: number;
    }
  | {
      type: 'approve_builder_execution';
      sessionId: string;
      summary?: string;
      maxTurns?: number;
    }
  | {
      type: 'odin_search_skills';
      query: string;
      scope?: 'local' | 'cloud' | 'all';
      limit?: number;
      autoImport?: boolean;
    }
  | {
      type: 'odin_execute_task';
      task: string;
      searchScope?: 'local' | 'cloud' | 'all';
      maxIterations?: number;
    }
  | {
      type: 'odin_fix_skill';
      skillId: string;
      errorContext?: string;
      summary?: string;
    }
  | {
      type: 'odin_upload_skill';
      skillId: string;
      visibility?: 'local' | 'private' | 'public';
      notes?: string;
    }
  | {
      type: 'odin_import_cloud_skills';
      query?: string;
      limit?: number;
    }
  | {
      type: 'generate_image';
      prompt: string;
      model?: string;
      size?: string;
      count?: number;
      outputPath?: string;
      watermark?: boolean;
    }
  | {
      type: 'generate_video';
      prompt: string;
      model?: string;
      ratio?: string;
      duration?: number;
      outputPath?: string;
      referenceImageUrls?: string[];
      generateAudio?: boolean;
      watermark?: boolean;
      maxPolls?: number;
      pollIntervalMs?: number;
    }
  | {
      type: 'request_freya_visual_asset';
      assetType: 'image' | 'video' | 'icon';
      contextDescription: string;
      preferredStyle?: string;
    }
  | {
      type: 'agent';
      action: 'create' | 'list' | 'run' | 'stop' | 'status' | 'result';
      id?: string;
      name?: string;
      description?: string;
      task?: string;
      context?: Record<string, unknown>;
      toolsets?: string[];
      timeout?: number;
      maxIterations?: number;
      priority?: 'low' | 'medium' | 'high';
    };

export type AgentActionType = AgentAction['type'];

export const ALL_AGENT_ACTION_TYPES = [
  'list_files',
  'read_file',
  'search_files',
  'lookup_docs',
  'search_web',
  'deep_research',
  'mcp_call_tool',
  'mcp_read_resource',
  'mcp_get_prompt',
  'write_file',
  'insert_in_file',
  'replace_in_file',
  'apply_patch',
  'run_command',
  'delegate_task',
  'spawn_background_workflow',
  'approve_builder_execution',
  'odin_search_skills',
  'odin_execute_task',
  'odin_fix_skill',
  'odin_upload_skill',
  'odin_import_cloud_skills',
  'generate_image',
  'generate_video',
  'request_freya_visual_asset',
  'agent',
] as const satisfies readonly AgentActionType[];

export const RUNTIME_MANAGED_AGENT_ACTION_TYPES = [
  'mcp_call_tool',
  'mcp_read_resource',
  'mcp_get_prompt',
  'delegate_task',
  'spawn_background_workflow',
  'approve_builder_execution',
  'odin_search_skills',
  'odin_execute_task',
  'odin_fix_skill',
  'odin_upload_skill',
  'odin_import_cloud_skills',
  'request_freya_visual_asset',
] as const satisfies readonly AgentActionType[];

export type AssistantEnvelope = {
  reply: string;
  done?: boolean;
  actions?: AgentAction[];
  plan?: PlanItem[];
  tasks?: TaskItem[];
  claims?: Array<{
    statement: string;
    status?: ClaimStatus;
    kind?: EvidenceKind;
  }>;
};

export type SessionRecord = {
  id: string;
  rootSessionId?: string;
  runtimeTaskId?: string;
  cwd: string;
  title: string;
  autonomyMode?: SessionAutonomyMode;
  kind?: 'main' | 'agent';
  parentSessionId?: string;
  agentRole?: AgentRole;
  agentPhase?: AgentPhase;
  delegatedTask?: string;
  plan?: PlanItem[];
  tasks?: TaskItem[];
  taskRuntimes?: TaskRuntimeRecord[];
  summary?: string;
  changedFiles?: string[];
  verificationCommands?: VerificationCommandRecord[];
  stickyNativeMcpTools?: string[];
  heimdallEvents?: HeimdallEventRecord[];
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
};

export type EvidenceClaim = {
  id: string;
  clusterKey: string;
  statement: string;
  status: ClaimStatus;
  kind: EvidenceKind;
  sourceSessionId: string;
  sourceProfile?: 'main' | AgentRole;
  createdAt: string;
};

export type EvidenceEdge = {
  id: string;
  fromClaimId: string;
  toClaimId: string;
  type: EvidenceEdgeType;
  createdAt: string;
};

export type EvidenceConflict = {
  id: string;
  claimIds: [string, string];
  reason: EvidenceConflictReason;
  summary: string;
  createdAt: string;
};

export type EvidenceGraph = {
  sessionId: string;
  updatedAt: string;
  claims: EvidenceClaim[];
  edges: EvidenceEdge[];
  conflicts: EvidenceConflict[];
};

export type RunResult = {
  reply: string;
  turns: number;
};

// 查询引擎类型
export interface QueryEngineConfig {
  /** 最大上下文窗口大小（字符数） */
  maxContextSize: number;
  /** 会话超时时间（毫秒） */
  sessionTimeout: number;
  /** 是否启用记忆压缩 */
  enableCompression: boolean;
  /** 是否启用会话管理 */
  enableSessionManagement: boolean;
}

export interface QueryResult {
  /** 查询结果内容 */
  content: string;
  /** 会话信息 */
  session: SessionRecord;
  /** 执行时间（毫秒） */
  executionTime: number;
  /** 是否需要更多信息 */
  needsMoreInfo: boolean;
}
