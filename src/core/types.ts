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
      runInBackground?: boolean;
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
      runInBackground?: boolean;
    }
  | {
      type: 'generate_video';
      prompt: string;
      model?: string;
      ratio?: string;
      duration?: number;
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
      cleanDirect?: boolean;
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
  | { type: 'browser_navigate'; url: string; waitFor?: 'load' | 'domcontentloaded' | 'networkidle'; extractText?: boolean }
  | { type: 'browser_screenshot'; fullPage?: boolean; width?: number; height?: number }
  | { type: 'browser_extract_text'; selector?: string }
  | { type: 'browser_click'; selector?: string; text?: string }
  | { type: 'browser_type'; selector: string; text: string; pressEnter?: boolean }
  | { type: 'browser_wait_for'; selector?: string; text?: string; timeoutMs?: number }
  | { type: 'browser_close' }
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
  | { type: 'request_user_confirmation'; question: string; screenshotPath?: string; timeoutMs?: number };

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
  'generate_long_video',
  'synthesize_speech',
  'transcribe_audio',
  'request_freya_visual_asset',
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
  'browser_wait_for',
  'browser_close',
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
  'request_user_confirmation',
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
