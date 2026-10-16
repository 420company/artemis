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
  /**
   * Anthropic Extended Thinking + tool_use round-trip. When Claude responds
   * with thinking blocks (e.g. `[{type:'thinking',thinking,signature},
   * {type:'text',text}, {type:'tool_use',...}]`), the entire content array
   * MUST be passed back unmodified on the next turn — including the
   * signature — or Anthropic returns 400 for tool_use loops.
   *
   * Only populated by the Anthropic Messages provider. Other providers
   * ignore this field. Keeping it as `any[]` (raw block shape) is intentional
   * — the API requires bit-for-bit preservation, so we don't want to
   * normalize.
   */
  rawContentBlocks?: any[];
  /**
   * Digest of the request prefix this turn's thinking blocks were produced
   * against (providers/thinkingReplay.ts). On models that check it, the
   * blocks are replayed only while the prefix sent before them still has
   * this digest.
   */
  thinkingBinding?: string;
  /**
   * Set on the synthetic message that replaces summarized history after a
   * context compaction (see core/compaction). It always sits at index 0.
   */
  compaction?: CompactionBoundaryInfo;
  /**
   * Set when an old tool result was replaced by a one-line placeholder to
   * save context. The original output is kept at `savedTo` when it could be
   * written to disk.
   */
  contextCleared?: {
    chars: number;
    savedTo?: string;
    clearedAt: string;
  };
  /**
   * Set on the tool result of a delivered post_update: the chat history
   * shows it as an assistant message of its own (core/agentUpdates.ts).
   */
  agentUpdate?: { id: string; text: string };
};

export type CompactionBoundaryInfo = {
  kind: 'boundary';
  /** 1-based count of compactions this session has gone through. */
  index: number;
  /** The rolling summary; the next compaction folds new messages into it. */
  summary: string;
  /** 'summary' = written by the summarizer model; 'fallback' = mechanical. */
  mode: 'summary' | 'fallback';
  language: 'zh' | 'en';
  /** Append-only JSONL archive of every message removed from the history. */
  archivePath?: string;
  /** Messages folded into the summary by this compaction (cumulative). */
  summarizedMessages: number;
  /**
   * The current run's request when it is no longer in the live history:
   * carried (shortened if huge) by the boundary, and forward by the next
   * boundary while the same run goes on.
   */
  request?: { id: string; text: string };
  createdAt: string;
};

export type VerificationCommandRecord = {
  command: string;
  ok: boolean;
  createdAt: string;
};

export type { CanonicalPermissionMode as PermissionMode } from '../security/permissionModes.js';

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

// ── WP-15 Phase 1: extras-backed actions ─────────────────────────────────────
// Mirrors buildExtraToolDefs() in src/tools/extras.ts (48 tools). Field names and
// optionality MUST match each tool's input_schema: executeExtraTool() receives these
// fields verbatim. Parity is enforced at compile time by EXTRA_PARAM_SPECS
// (src/tools/extras-validators.ts) and at test time by tests/extras-parity.test.ts.
export type ExtraAgentAction =
  // File operations
  | {
      type: 'delete_file';
      path: string;
    }
  | {
      type: 'move_file';
      from: string;
      to: string;
    }
  | {
      type: 'copy_file';
      from: string;
      to: string;
    }
  | {
      type: 'create_directory';
      path: string;
    }
  | {
      type: 'delete_directory';
      path: string;
      force?: boolean;
    }
  | {
      type: 'file_info';
      path: string;
    }
  | {
      type: 'list_directory';
      path?: string;
    }
  // Git
  | {
      type: 'git_status';
    }
  | {
      type: 'git_diff';
      staged?: boolean;
      path?: string;
    }
  | {
      type: 'git_log';
      limit?: number;
    }
  | {
      type: 'git_add';
      // input_schema declares no JSON type here; its description says "string or array".
      paths?: string | string[];
    }
  | {
      type: 'git_commit';
      message: string;
    }
  | {
      type: 'git_branch';
      create?: string;
      checkout?: string;
    }
  // Text processing
  | {
      type: 'regex_match';
      text: string;
      pattern: string;
      flags?: string;
    }
  | {
      type: 'json_query';
      json: string;
      query: string;
    }
  | {
      type: 'format_json';
      text: string;
      indent?: number;
    }
  | {
      type: 'diff_text';
      original: string;
      modified: string;
    }
  | {
      type: 'sort_lines';
      text: string;
      direction?: string;
    }
  | {
      type: 'dedupe_lines';
      text: string;
    }
  | {
      type: 'count_lines';
      path: string;
    }
  // Encoding / crypto
  | {
      type: 'base64_encode';
      text: string;
    }
  | {
      type: 'base64_decode';
      text: string;
    }
  | {
      type: 'hash_text';
      text: string;
      algorithm?: string;
    }
  | {
      type: 'generate_uuid';
    }
  // System
  | {
      type: 'get_env';
      key?: string;
      keys?: string[];
    }
  | {
      type: 'which_command';
      command: string;
    }
  | {
      type: 'get_system_info';
    }
  | {
      type: 'date_now';
      format?: string;
    }
  | {
      type: 'calculate';
      expression: string;
    }
  // Network
  | {
      type: 'check_url';
      url: string;
    }
  | {
      type: 'download_file';
      url: string;
      destination?: string;
    }
  | {
      type: 'dns_lookup';
      hostname: string;
    }
  | {
      type: 'parse_url';
      url: string;
    }
  // Development
  | {
      type: 'npm_run';
      script?: string;
    }
  | {
      type: 'format_code';
      path: string;
    }
  | {
      type: 'get_imports';
      path: string;
    }
  | {
      type: 'path_info';
      path: string;
    }
  | {
      type: 'url_encode';
      text: string;
      mode?: string;
    }
  | {
      type: 'hash_file';
      path: string;
      algorithm?: string;
    }
  // Notebook
  | {
      type: 'notebook_create';
      title: string;
      content?: string;
      tags?: string[];
    }
  | {
      type: 'notebook_list';
    }
  | {
      type: 'notebook_update';
      id: string;
      title?: string;
      content?: string;
      tags?: string[];
    }
  | {
      type: 'notebook_delete';
      id: string;
    }
  | {
      type: 'notebook_view';
      id: string;
    }
  | {
      type: 'notebook_search';
      search: string;
    }
  | {
      type: 'notebook_addTag';
      id: string;
      tags: string[];
    }
  | {
      type: 'notebook_removeTag';
      id: string;
      tags: string[];
    }
  | {
      type: 'notebook_tree';
    };

/** Discriminants of the AgentAction variants that are executed by src/tools/extras.ts. */
export type ExtraAgentActionType = ExtraAgentAction['type'];


export type AgentAction =
  | {
      type: 'list_files';
      pattern?: string;
      maxResults?: number;
      includeHidden?: boolean;
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
      backend?: 'auto' | 'platform' | 'google' | 'duckduckgo' | 'wikipedia';
      /** Only results from the last day / week / month / year (platform backend). */
      freshness?: 'day' | 'week' | 'month' | 'year';
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
      background?: boolean;
      killOnTimeout?: boolean;
    }
  | {
      type: 'task_output';
      taskId: string;
      tail?: number;
    }
  | {
      /** Look at an image file: it is attached to the next model request. */
      type: 'view_image';
      path: string;
    }
  | {
      /**
       * Read a PDF / Word / PowerPoint / Excel file (older formats through
       * LibreOffice). Scanned PDF pages are shown as images.
       */
      type: 'read_document';
      path: string;
      /** PDF pages or slides: "3", "2-5", "1,4-6". */
      pages?: string;
      /** A spreadsheet's sheet: its name or 1-based number. */
      sheet?: string;
      /** Spreadsheet rows: "1-500". */
      rows?: string;
      /** Show PDF pages as images (charts, scans, layout). */
      as_images?: boolean;
    }
  | {
      type: 'kill_task';
      taskId: string;
    }
  | {
      type: 'delegate_task';
      role: AgentRole;
      task: string;
      maxTurns?: number;
      runInBackground?: boolean;
    }
  | {
      type: 'spawn_background_workflow';
      command: 'run' | 'athena' | 'design' | 'niko' | 'contest' | 'nidhogg';
      prompt: string;
      maxTurns?: number;
    }
  | {
      // Switch this task to a heavier workflow mid-run (see core/workflowRouter.ts).
      type: 'use_workflow';
      workflow: 'plan' | 'team' | 'compare' | 'design' | 'review';
      reason?: string;
    }
  | {
      type: 'approve_builder_execution';
      sessionId: string;
      summary?: string;
      maxTurns?: number;
    }
  | {
      type: 'generate_image';
      prompt: string;
      model?: string;
      size?: string;
      count?: number;
      outputPath?: string;
      watermark?: boolean;
      runInBackground?: boolean;
      /** Workspace image paths or http(s) URLs sent to the model as references (max 14). */
      referenceImages?: string[];
    }
  | {
      type: 'generate_video';
      prompt: string;
      model?: string;
      ratio?: string;
      duration?: number;
      // Output resolution ("480p" / "720p" / "1080p"). Omitted: BytePlus uses
      // the model's own default; custom/OpenAI providers use
      // visualProfile.video.defaultParams.resolution.
      resolution?: string;
      // Saga cleanDirect / raw passthrough: the prompt goes to the provider as
      // written (no Director, no prompt rewrite or provider-side prompt
      // extension), cut to the model's prompt limit.
      cleanDirect?: boolean;
      // Set by Saga outside raw mode: append the short rendering rules
      // (renderingGuardrails.ts) when the prompt limit allows.
      renderingGuardrails?: boolean;
      // Set by Saga on each segment: the compiled prompt is already the
      // user's script plus its locks, so no LLM rewrite (guide §7.7).
      sagaSegment?: boolean;
      // The Saga subtitle choice, so the Director does not forbid captions
      // the user asked for.
      subtitleMode?: 'auto' | 'always' | 'off';
      outputPath?: string;
      referenceImageUrls?: string[];
      referenceVideoUrls?: string[];
      referenceAudioUrls?: string[];
      referenceImagePaths?: string[];
      referenceVideoPaths?: string[];
      referenceAudioPaths?: string[];
      // role:"first_frame" — image-to-video literal first-frame anchor.
      // Provider may still apply content moderation; does NOT reliably
      // bypass real-person privacy filters (empirical testing showed
      // BytePlus rejects real-person photos regardless of role).
      firstFrameImageUrls?: string[];
      firstFrameImagePaths?: string[];
      lastFrameImageUrls?: string[];
      lastFrameImagePaths?: string[];
      generateAudio?: boolean;
      watermark?: boolean;
      maxPolls?: number;
      pollIntervalMs?: number;
      runInBackground?: boolean;
    }
  | {
      type: 'generate_long_video';
      prompt: string;
      title?: string;
      story?: string;
      referenceNotes?: string[];
      shots?: Array<{
        title?: string;
        duration?: number;
        storyBeat?: string;
        visualPrompt?: string;
        prompt?: string;
        camera?: string;
        continuity?: string;
        transition?: string;
        transitionKind?:
          | 'cut'
          | 'crossfade'
          | 'dissolve'
          | 'light-leak'
          | 'fade-black'
          | 'fade-white'
          | 'wipe-left'
          | 'wipe-right'
          | 'slide-up'
          | 'push-left'
          | 'push-right'
          | 'circle-open'
          | 'circle-close'
          | 'blur'
          | 'zoom-in'
          | 'zoom-out'
          | 'flash'
          | 'speed-ramp'
          | 'whip-pan'
          | 'whip-pan-left'
          | 'match-cut'
          | 'glitch'
          | 'cinematic-fade'
          | 'iris-pulse'
          | 'squeeze-h'
          | 'squeeze-v'
          | 'cover-down'
          | 'cover-up'
          | 'reveal-left'
          | 'shader-light-leak'
          | 'shader-whip-pan'
          | 'shader-glitch'
          | 'shader-cinematic-zoom'
          | 'shader-domain-warp'
          | 'shader-ridged-burn'
          | 'shader-sdf-iris'
          | 'shader-ripple-waves'
          | 'shader-gravitational-lens'
          | 'shader-chromatic-split'
          | 'shader-swirl-vortex'
          | 'shader-thermal-distortion'
          | 'shader-flash-through-white'
          | 'shader-cross-warp-morph';
      }>;
      continuity?: {
        characters?: string[];
        wardrobe?: string[];
        props?: string[];
        locations?: string[];
        palette?: string[];
        lighting?: string;
        cameraLanguage?: string;
        mood?: string;
      };
      model?: string;
      ratio?: string;
      duration?: number;
      totalDuration?: number;
      projectId?: string;
      outputPath?: string;
      assemblyMode?: 'auto' | 'ffmpeg' | 'hyperframes' | 'saga';
      resume?: boolean;
      preserveUserScript?: boolean;
      // Output resolution of every segment ("480p" / "720p" / "1080p"). Only
      // sent when the user asked for one; omitted, each provider uses its default.
      resolution?: string;
      // Guide §9.10 "原始质感 / 少滤镜 / raw-seedance / clean-direct": drop the
      // aesthetic dressing (style / aesthetic locks, Director, rendering
      // rules) but keep analysis, identity and continuity locks.
      cleanDirect?: boolean;
      // "[原样直传]": the script goes to the video model as written (no
      // analysis, Super Visual, keyframes or Director), within the model's
      // prompt limit.
      rawPassthrough?: boolean;
      chainReferenceFrames?: 'auto' | 'always' | 'off';
      crossfadeMs?: number;
      defaultTransition?:
        | 'cut'
        | 'crossfade'
        | 'dissolve'
        | 'light-leak'
        | 'fade-black'
        | 'fade-white'
        | 'wipe-left'
        | 'wipe-right'
        | 'slide-up'
        | 'push-left'
        | 'push-right'
        | 'circle-open'
        | 'circle-close'
        | 'blur'
        | 'zoom-in'
        | 'zoom-out'
        | 'flash'
        | 'speed-ramp'
        | 'whip-pan'
        | 'whip-pan-left'
        | 'match-cut'
        | 'glitch'
        | 'cinematic-fade'
        | 'iris-pulse'
        | 'squeeze-h'
        | 'squeeze-v'
        | 'cover-down'
        | 'cover-up'
        | 'reveal-left';
      continuityMode?: 'auto' | 'strong-vision' | 'text-only';
      colorMatch?: boolean;
      quality?: 'draft' | 'standard' | 'high';
      fps?: 24 | 30 | 60;
      gpu?: 'auto' | 'on' | 'off';
      videoBitrate?: string;
      crf?: number;
      referenceImageUrls?: string[];
      // Images explicitly supplied as complete storyboard / shot-board scripts.
      // These are director-intent references, not character identity anchors.
      storyboardImageUrls?: string[];
      referenceVideoUrls?: string[];
      referenceAudioUrls?: string[];
      referenceImagePaths?: string[];
      storyboardImagePaths?: string[];
      referenceVideoPaths?: string[];
      referenceAudioPaths?: string[];
      soundtrackPath?: string;
      soundtrackUrl?: string;
      soundtrackStartSec?: number;
      soundtrackVolumeDb?: number;
      environmentVolumeDb?: number;
      soundtrackFadeInSec?: number;
      soundtrackFadeOutSec?: number;
      // Literal "first frame of the video" image input. role:"first_frame"
      // in the BytePlus / Seedance request — pins the exact opening frame.
      // Provider may still apply content moderation; does NOT reliably
      // bypass real-person privacy filters. For real-person identity
      // locking the Saga long-video pipeline uses an illustrated
      // turnaround as role:"reference_image" with photoreal-output
      // prompt directives instead.
      firstFrameImageUrls?: string[];
      firstFrameImagePaths?: string[];
      // Optional last-frame anchor image. role:"last_frame".
      lastFrameImageUrls?: string[];
      lastFrameImagePaths?: string[];
      generateAudio?: boolean;
      subtitleMode?: 'auto' | 'always' | 'off';
      watermark?: boolean;
      maxPolls?: number;
      pollIntervalMs?: number;
      runInBackground?: boolean;
      // How character identity enters the pipeline. Set by the Saga three-step
      // menu so that generateLongVideo can route identity handling correctly.
      identitySource?: 'turnaround' | 'character_image' | 'direct_image' | 'text_only';
      narrativeEntities?: {
        protagonist?: { name?: string; type?: 'character' | 'product' | 'environment'; confidence?: number; evidence?: string; aliases?: string[] };
        supportingCharacters?: string[];
        props?: string[];
        environments?: string[];
        relationships?: string[];
        actions?: string[];
        protagonistAccessories?: string[];
        worldModel?: {
          weather?: string;
          lighting?: string;
          timeOfDay?: string;
          gravity?: string;
          occlusion?: string[];
          wardrobe?: { permanent?: string[]; variable?: string[] };
          distinguishingMarks?: string[];
          bodyProportions?: string;
          skinTone?: string;
          hair?: string;
          clutter?: string[];
          palette?: string[];
          mood?: string;
          soundscape?: string;
          cameraVocabulary?: string[];
          identityLockedProps?: string[];
          sceneVariableProps?: string[];
          visualRhymes?: string[];
          continuityRules?: string[];
          exclusions?: string[];
          spatialReality?: {
            groundSurface?: string;
            waterLine?: string;
            occlusionRules?: string[];
            perspectiveCues?: string;
            physicsRules?: string[];
            forbiddenSpatialErrors?: string[];
          };
        };
        mode?: 'character' | 'product' | 'environment' | 'mixed' | 'unclear';
        modeRationale?: string;
        source?: 'llm' | 'user-clarification' | 'keyword-fallback';
      };
    }
  | {
      type: 'synthesize_speech';
      text: string;
      voice?: string;
      language?: string;
      outputPath?: string;
      playAudio?: boolean;
      rate?: number;
      pitch?: number;
    }
  // ── Office documents (tools/officeDocuments.ts) ─────────────────────────
  | { type: 'create_presentation'; path?: string; spec?: Record<string, unknown>; edits?: Array<Record<string, unknown>>; pdf?: boolean; theme?: string }
  | { type: 'create_document'; path?: string; spec?: Record<string, unknown>; markdown?: string; edits?: Array<Record<string, unknown>>; pdf?: boolean; theme?: string }
  | { type: 'create_spreadsheet'; path?: string; spec?: Record<string, unknown>; edits?: Array<Record<string, unknown>>; pdf?: boolean; theme?: string }
  | {
      /** Phone someone for the owner; the owner approves each call first (tools/phoneCall). */
      type: 'place_call';
      to: string;
      goal: string;
      brief?: string;
      language?: 'zh' | 'en';
      allowedFacts?: string[];
      forbidden?: string[];
      mayAgreeTo?: string[];
      calleeName?: string;
      onBehalfOf?: string;
      maxMinutes?: number;
    }
  | {
      type: 'transcribe_audio';
      inputPath: string;
      language?: string;
      model?: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';
      modelPath?: string;
      engine?: 'auto' | 'whisper.cpp' | 'openai-whisper';
      command?: string;
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
    }
  // ── Spotify integration ─────────────────────────────────────────────────
  | { type: 'spotify_play_liked'; shuffle?: boolean; deviceHint?: string }
  | { type: 'spotify_search_and_play'; query: string; kind?: 'track' | 'playlist' | 'auto'; deviceHint?: string }
  | { type: 'spotify_play_playlist'; name: string; deviceHint?: string }
  | { type: 'spotify_resume'; deviceHint?: string }
  | { type: 'spotify_pause' }
  | { type: 'spotify_skip_next' }
  | { type: 'spotify_skip_previous' }
  | { type: 'spotify_set_volume'; volume: number }
  | { type: 'spotify_now_playing' }
  | { type: 'spotify_set_device'; deviceHint: string; startPlaying?: boolean }
  // ── Ambient agent: weather / time / currency / flight ──────────────────
  | { type: 'weather_current'; location: string }
  | { type: 'weather_forecast'; location: string; days?: number }
  | { type: 'world_clock'; cities: string[] }
  | { type: 'time_diff'; fromCity: string; toCity: string }
  | { type: 'currency_convert'; amount: number; from: string; to: string }
  | { type: 'currency_rates'; base: string; targets?: string[] }
  | { type: 'flight_lookup'; callsign: string }
  // ── Apple-native (macOS only): Calendar / Reminders ────────────────────
  | { type: 'calendar_list_today' }
  | { type: 'calendar_list_upcoming'; daysAhead?: number }
  | { type: 'calendar_add_event'; title: string; startISO: string; endISO?: string; notes?: string; calendarName?: string }
  | { type: 'reminders_list'; list?: string; includeCompleted?: boolean }
  | { type: 'reminders_add'; title: string; list?: string; dueISO?: string; notes?: string }
  | { type: 'reminders_complete'; title: string; list?: string }
  // ── Browser automation (Playwright headed Chromium) ─────────────────────
  | { type: 'browser_navigate'; url?: string; path?: string; waitFor?: 'load' | 'domcontentloaded' | 'networkidle'; extractText?: boolean }
  | { type: 'browser_screenshot'; fullPage?: boolean; width?: number; height?: number }
  | { type: 'browser_extract_text'; selector?: string }
  | { type: 'browser_click'; selector?: string; text?: string; x?: number; y?: number }
  | { type: 'browser_type'; selector: string; text: string; pressEnter?: boolean }
  | { type: 'browser_form_input'; selector: string; value?: string; values?: string[]; checked?: boolean }
  | { type: 'browser_evaluate'; script: string }
  | { type: 'browser_console'; pattern?: string; limit?: number; clear?: boolean }
  | { type: 'browser_requests'; pattern?: string; limit?: number; clear?: boolean }
  | { type: 'browser_tabs'; action: 'list' | 'new' | 'switch' | 'close'; index?: number; url?: string }
  | { type: 'browser_wait_for'; selector?: string; text?: string; timeoutMs?: number }
  | { type: 'browser_close' }
  | { type: 'browser_request_handoff'; reason: string; timeoutSeconds?: number }
  // ── Computer / desktop automation (macOS + Windows best effort) ──────
  | { type: 'computer_screenshot'; outputPath?: string }
  | { type: 'computer_click'; x: number; y: number }
  | { type: 'computer_move'; x: number; y: number }
  | { type: 'computer_drag'; fromX: number; fromY: number; toX: number; toY: number; durationMs?: number }
  | { type: 'computer_type'; text: string }
  | { type: 'computer_key'; key: string }
  | { type: 'computer_hotkey'; keys: string[] }
  | { type: 'computer_clipboard_get' }
  | { type: 'computer_clipboard_set'; text: string }
  | { type: 'computer_open_app'; name: string }
  | { type: 'computer_active_window' }
  | { type: 'computer_doctor' }
  // ── MCP self-management ────────────────────────────────────────────────
  | { type: 'mcp_list'; filter?: string; status?: 'all' | 'enabled' | 'disabled' }
  | { type: 'mcp_enable'; id: string }
  | { type: 'mcp_disable'; id: string }
  | { type: 'mcp_suggest'; intent: string }
  // ── Bragi mobile media bridge ──────────────────────────────────────────
  | { type: 'bridge_send_image'; imagePath: string; caption?: string; platform?: 'telegram' | 'discord' | 'wechat' | 'all'; targetId?: string }
  | { type: 'bridge_send_video'; videoPath: string; caption?: string; platform?: 'telegram' | 'discord' | 'wechat' | 'all'; targetId?: string }
  // ── Long-term memory (Mnemosyne v2) ─────────────────────────────────────
  | { type: 'memory'; action: 'save' | 'update' | 'delete' | 'list'; scope?: 'global' | 'project'; name?: string; description?: string; category?: 'preference' | 'feedback' | 'project' | 'reference' | 'skill' | 'architecture'; content?: string }
  // ── Learned skills (procedural memory) ──────────────────────────────────
  | {
      /**
       * A learned skill or a skill library entry by id (`file`: one of its
       * reference files), or a search of both (`query`).
       */
      type: 'load_skill';
      id?: string;
      query?: string;
      file?: string;
    }
  | { type: 'request_user_confirmation'; question: string; screenshotPath?: string; timeoutMs?: number }
  /** A short progress message shown to the user at once, while the run goes on (core/agentUpdates.ts). */
  | { type: 'post_update'; text: string }
  /** The run's plan as a checklist: the whole list each time (core/todoList.ts). */
  | { type: 'load_tools'; tools: string[] }
  | { type: 'todo'; todos: Array<{ id?: string; content: string; status?: TaskStatus }> }
  /** Keys, passwords, SSH bootstrap, VPN setup and checks for a server the agent set up (tools/serverSetup). */
  | ({ type: 'server_setup' } & Omit<import('../tools/serverSetup/serverSetup.js').ServerSetupAction, 'type'>)
  /** A one-time code sent to the agent's own mailbox or phone (tools/verificationCodes.ts). */
  | { type: 'get_verification_code'; channel?: 'email' | 'sms' | 'which'; sender?: string; timeoutSeconds?: number }
  // ── Agent identity on a hosted platform (tools/agentIdentity.ts) ────────
  | { type: 'agent_mail_address' }
  | { type: 'list_emails'; from_contains?: string; subject_contains?: string; limit?: number }
  | { type: 'wait_for_email'; from_contains?: string; subject_contains?: string; timeout_seconds?: number }
  | { type: 'read_email'; id: string }
  | { type: 'extract_verification'; id: string; site?: string }
  | { type: 'begin_signup'; site: string; purpose: string; free?: boolean; wait_seconds?: number }
  | { type: 'finish_signup'; signup_id: string; outcome: 'created' | 'failed' | 'abandoned'; username?: string; login_url?: string; note?: string }
  | { type: 'get_sms_number'; country: string; signup_id?: string; wait_seconds?: number }
  | { type: 'wait_for_sms'; sender_contains?: string; timeout_seconds?: number }
  | { type: 'ask_owner_for_code'; site: string; channel?: 'sms' | 'email' | 'authenticator' | 'other'; hint?: string; timeout_seconds?: number }
  | {
      type: 'edit_timeline';
      /** import_saga is a hidden alias of import_long_video, kept for older calls. */
      action: 'list_segments' | 'replace_segment' | 'trim_segment' | 'add_subtitle' | 'remove_subtitle' | 'set_bgm' | 'render' | 'import_long_video' | 'import_saga';
      projectId?: string;
    }
  | ExtraAgentAction;

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
  'task_output',
  'view_image',
  'read_document',
  'kill_task',
  'delegate_task',
  'spawn_background_workflow',
  'use_workflow',
  'approve_builder_execution',
  'generate_image',
  'generate_video',
  'generate_long_video',
  'synthesize_speech',
  'transcribe_audio',
  'place_call',
  'create_presentation',
  'create_document',
  'create_spreadsheet',
  'agent',
  // ── Spotify integration ────────────────────────────────────────────────
  'spotify_play_liked',
  'spotify_search_and_play',
  'spotify_play_playlist',
  'spotify_resume',
  'spotify_pause',
  'spotify_skip_next',
  'spotify_skip_previous',
  'spotify_set_volume',
  'spotify_now_playing',
  'spotify_set_device',
  // ── Ambient agent integrations ─────────────────────────────────────────
  'weather_current',
  'weather_forecast',
  'world_clock',
  'time_diff',
  'currency_convert',
  'currency_rates',
  'flight_lookup',
  'calendar_list_today',
  'calendar_list_upcoming',
  'calendar_add_event',
  'reminders_list',
  'reminders_add',
  'reminders_complete',
  // ── Browser automation ─────────────────────────────────────────────────
  'browser_navigate',
  'browser_screenshot',
  'browser_extract_text',
  'browser_click',
  'browser_type',
  'browser_form_input',
  'browser_evaluate',
  'browser_console',
  'browser_requests',
  'browser_tabs',
  'browser_wait_for',
  'browser_close',
  'browser_request_handoff',
  // ── Computer / desktop automation ───────────────────────────────────
  'computer_screenshot',
  'computer_click',
  'computer_move',
  'computer_drag',
  'computer_type',
  'computer_key',
  'computer_hotkey',
  'computer_clipboard_get',
  'computer_clipboard_set',
  'computer_open_app',
  'computer_active_window',
  'computer_doctor',
  // ── MCP self-management ────────────────────────────────────────────────
  'mcp_list',
  'mcp_enable',
  'mcp_disable',
  'mcp_suggest',
  // ── Bragi mobile media bridge ──────────────────────────────────────────
  'bridge_send_image',
  'bridge_send_video',
  // ── Long-term memory ───────────────────────────────────────────────────
  'memory',
  'load_skill',
  'request_user_confirmation',
  'post_update',
  'todo',
  'load_tools',
  'server_setup',
  'get_verification_code',
  'agent_mail_address',
  'list_emails',
  'wait_for_email',
  'read_email',
  'extract_verification',
  'begin_signup',
  'finish_signup',
  'get_sms_number',
  'wait_for_sms',
  'ask_owner_for_code', 'edit_timeline',
  'delete_file',
  'move_file',
  'copy_file',
  'create_directory',
  'delete_directory',
  'file_info',
  'list_directory',
  'git_status',
  'git_diff',
  'git_log',
  'git_add',
  'git_commit',
  'git_branch',
  'regex_match',
  'json_query',
  'format_json',
  'diff_text',
  'sort_lines',
  'dedupe_lines',
  'count_lines',
  'base64_encode',
  'base64_decode',
  'hash_text',
  'generate_uuid',
  'get_env',
  'which_command',
  'get_system_info',
  'date_now',
  'calculate',
  'check_url',
  'download_file',
  'dns_lookup',
  'parse_url',
  'npm_run',
  'format_code',
  'get_imports',
  'path_info',
  'url_encode',
  'hash_file',
  'notebook_create',
  'notebook_list',
  'notebook_update',
  'notebook_delete',
  'notebook_view',
  'notebook_search',
  'notebook_addTag',
  'notebook_removeTag',
  'notebook_tree',
] as const satisfies readonly AgentActionType[];

export const RUNTIME_MANAGED_AGENT_ACTION_TYPES = [
  'mcp_call_tool',
  'mcp_read_resource',
  'mcp_get_prompt',
  'delegate_task',
  'spawn_background_workflow',
  'approve_builder_execution',
  // Writes the conversation's task board (core/todoList.ts).
  'todo',
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
  /** Approval requests of this conversation (security/approvals.ts); the latest 50. */
  approvals?: import('../security/approvals.js').PendingApproval[];
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
