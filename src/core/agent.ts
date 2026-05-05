/* eslint-disable no-case-declarations, no-fallthrough, no-inner-declarations */
import path from 'node:path';
import type { ContextBuildResult } from './context.js';
import {
  getAllowedActionTypesForProfile,
  validateProfileAction,
} from './agentProfiles.js';
import type {
  ChatProvider,
  ProviderNativeToolOutput,
  ProviderTarget,
  ProviderResponse,
} from '../providers/types.js';
import { executeAction } from '../tools/index.js';
import type { WorkspaceSwitchRequest } from '../tools/types.js';
import {
  getToolDefinition,
  getToolPermissionCategory,
  isParallelReadOnlyAction,
  validateToolAction,
} from '../tools/registry.js';
import type { ToolError } from '../tools/types.js';
import { PermissionManager } from '../security/permissions.js';
import { isReadOnlyCommand } from '../security/commandPolicy.js';
import type {
  AgentAction,
  AgentPhase,
  AgentRole,
  AssistantEnvelope,
  ClaimStatus,
  EvidenceKind,
  PlanItem,
  PlanStatus,
  RunResult,
  SessionAutonomyMode,
  SessionMessage,
  SessionRecord,
  TaskRuntimeCommandRecord,
  TaskRuntimeRecord,
} from './types.js';
import {
  buildTaskVerificationNudge,
  didTaskBoardJustCloseWithoutVerification,
  normalizeTasks,
} from './tasks.js';
import {
  acknowledgeTaskRuntimeCommand,
  appendTaskRuntime,
  createTaskRuntimeRecord,
  getQueuedTaskRuntimeCommands,
  updateTaskRuntime,
} from './taskRuntime.js';
import {
  createDelegatedChildPermissionManager,
  getDelegatedChildPermissionMode,
} from './delegatedPermissions.js';
import { buildStableProviderSystemSections } from './promptCache.js';
import { buildContextWindow } from './context.js';
import { resolveExtensionRuntime } from '../extensions/runtime.js';
import {
  buildOdinRuntimeSection,
  executeOdinFixSkill,
  executeOdinSearchSkills,
  executeOdinUploadSkill,
  importOdinCloudSkills,
  recordOdinWorkflowFailure,
  recordOdinWorkflowSuccess,
  resolveOdinSkillContext,
} from '../odin/runtime.js';
import {
  McpDependencyError,
  callMcpServerTool,
  getMcpServerPrompt,
  getSuggestedMcpAuthState,
  readMcpServerResource,
} from '../mcp/client.js';
import { formatDependencyPrompt, installNpmMcpPackage } from '../mcp/installer.js';
import { McpServerStore, type McpServerConfig } from '../mcp/store.js';
import {
  applyMcpRuntimeFailure,
  applyMcpRuntimeSuccess,
  findMcpToolDescriptor,
} from '../mcp/runtime.js';
import {
  buildEvidenceDigest,
  deriveClaimStatement,
  scopeEvidenceGraphForSession,
} from './evidence.js';
import { recordHeimdallEvent } from './heimdall.js';
import {
  getBackgroundTaskRegistry,
  type BackgroundTaskKind,
} from './backgroundTasks.js';
import {
  finalizeHeimdallThreadState,
  persistHeimdallActionArtifact,
  prepareHeimdallThreadState,
  recordHeimdallStage,
  type HeimdallThreadState,
} from './heimdall.js';
import { pathExists, truncate } from '../utils/fs.js';
import { withRuntimeLogSink } from '../utils/log.js';
import { SessionStore } from '../storage/sessions.js';
import {
  buildVerificationReminder,
  getChangedFilesForAction,
  getVerificationSuggestions,
  isVerificationCommand,
  isWriteAction,
} from './verification.js';
import {
  buildProviderNativeFunctionTools,
  buildProviderNativeToolRuntime,
  mapProviderNativeToolCallToAction,
} from './providerNativeTools.js';
import {
  detectVisualGenerationNeed,
  describeVisualProvider,
  hasExplicitRemoteVisualFallback,
  resolveConfiguredVisualProvider,
} from '../utils/visualGenerationConfig.js';

/**
 * Some model families (notably ark/doubao, qwen-coder, glm) emit tool calls
 * as XML text (`<call call="write_file"><object><path>...</path>...</object></call>`
 * or Anthropic-style `<function_calls><invoke name="..."><parameter ...>` blocks)
 * even when the system prompt asks for a JSON envelope. Without this fallback
 * the runtime sees a pure-text reply with `actions: []`, the guard fires, and
 * the loop just narrates intent for N turns.
 *
 * This extractor normalises the common XML dialects back into AgentAction
 * shape so the loop can actually execute the work the model asked for.
 *
 * Some providers also emit "legacy" JSON action entries such as
 * `{ "tool_name": "read_file", "args": { "target": "package.json" } }`
 * or prepend a short prose sentence before the JSON envelope. The helpers
 * below recover those variants too, so the runtime stays tool-capable even
 * when the model drifts from the strict `actions[*].type` contract.
 */
function parseXmlArgsBlock(body: string): Record<string, string> {
  const out: Record<string, string> = {};

  const objectMatch = body.match(/<object>([\s\S]*?)<\/object>/i);
  const inner = objectMatch ? objectMatch[1] ?? '' : body;

  // Inline JSON inside <object>{...}</object> — some models prefer this.
  const trimmedInner = inner.trim();
  if (trimmedInner.startsWith('{') && trimmedInner.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmedInner) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        out[key.toLowerCase()] = typeof value === 'string' ? value : JSON.stringify(value);
      }
      return out;
    } catch {
      // Fall through to element-pair parsing.
    }
  }

  const pairPattern = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g;
  for (const match of inner.matchAll(pairPattern)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? '';
    if (!key) continue;
    out[key] = value.trim();
  }

  const parameterPattern = /<parameter\b[^>]*\bname=["']([a-zA-Z_][a-zA-Z0-9_]*)["'][^>]*>([\s\S]*?)<\/parameter>/gi;
  for (const match of inner.matchAll(parameterPattern)) {
    const key = match[1]?.toLowerCase();
    const value = match[2] ?? '';
    if (!key) continue;
    out[key] = value.trim();
  }

  return out;
}

function getLooseStringArg(
  args: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = getLooseArgValue(args, key);
    if (typeof value === 'string') {
      // Treat empty/whitespace-only as missing so we keep walking the alias
      // list. Otherwise a model that sets `{pattern: "", query: "memphis"}`
      // would lock onto pattern="" and search_files would reject the call.
      if (value.trim().length === 0) continue;
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
  }

  return undefined;
}

function getLooseArgValue(
  args: Record<string, unknown>,
  key: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(args, key)) {
    return args[key];
  }

  const normalizedKey = key.toLowerCase();
  const matchedKey = Object.keys(args).find(
    (candidate) => candidate.toLowerCase() === normalizedKey,
  );
  return matchedKey ? args[matchedKey] : undefined;
}

function getLooseIntegerArg(
  args: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = getLooseArgValue(args, key);
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }

  return undefined;
}

function getLooseNumberArg(
  args: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = getLooseArgValue(args, key);
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function getLooseBooleanArg(
  args: Record<string, unknown>,
  ...keys: string[]
): boolean | undefined {
  for (const key of keys) {
    const value = getLooseArgValue(args, key);
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (typeof value === 'string') {
      if (/^(true|1|yes)$/i.test(value)) return true;
      if (/^(false|0|no)$/i.test(value)) return false;
    }
  }

  return undefined;
}

function buildActionFromLooseArgs(
  toolName: string,
  args: Record<string, unknown>,
): AgentAction | null {
  const lower = toolName.toLowerCase();

  switch (lower) {
    case 'list_files':
    case 'ls':
    case 'list_dir':
    case 'list_directory':
      return {
        type: 'list_files',
        pattern: getLooseStringArg(
          args,
          'pattern',
          'path',
          'target',
          'target_directory',
          'targetDirectory',
          'directory_path',
          'directoryPath',
          'glob',
          'dir',
          'directory',
          'folder',
        )?.trim() || '*',
        maxResults: getLooseIntegerArg(args, 'maxResults', 'maxresults', 'max_results', 'limit'),
      };
    case 'read_file':
    case 'read':
    case 'cat':
    case 'view_file':
    case 'open_file': {
      const path = getLooseStringArg(args, 'path', 'target', 'file', 'filename', 'filepath', 'file_path');
      if (!path?.trim()) return null;
      return {
        type: 'read_file',
        path,
        startLine: getLooseIntegerArg(args, 'startLine', 'startline', 'start_line', 'start', 'from', 'fromLine', 'from_line'),
        endLine: getLooseIntegerArg(args, 'endLine', 'endline', 'end_line', 'end', 'to', 'toLine', 'to_line'),
      };
    }
    case 'search_files':
    case 'search':
    case 'grep':
    case 'find':
    case 'find_in_files':
      return {
        type: 'search_files',
        pattern: getLooseStringArg(args, 'pattern', 'glob', 'include', 'files', 'path', 'dir', 'directory', 'folder'),
        query: getLooseStringArg(args, 'query', 'q', 'text', 'regex', 'search', 'keyword', 'term', 'needle', 'match', 'string', 'content'),
        maxResults: getLooseIntegerArg(args, 'maxResults', 'maxresults', 'max_results', 'limit'),
      };
    case 'lookup_docs': {
      const query = getLooseStringArg(args, 'query', 'q');
      if (!query?.trim()) return null;
      return {
        type: 'lookup_docs',
        query,
        library: getLooseStringArg(args, 'library'),
        version: getLooseStringArg(args, 'version'),
        maxResults: getLooseIntegerArg(args, 'maxResults', 'maxresults', 'max_results', 'limit'),
      };
    }
    case 'write_file':
    case 'create_file':
    case 'write':
    case 'save_file':
    case 'new_file': {
      const path = getLooseStringArg(args, 'path', 'target', 'file', 'filename', 'filepath', 'file_path');
      const content = getLooseStringArg(args, 'content', 'body', 'text', 'data', 'source');
      if (!path?.trim() || content === undefined) {
        return null;
      }
      return {
        type: 'write_file',
        path,
        content,
      };
    }
    case 'insert_in_file': {
      const path = getLooseStringArg(args, 'path', 'target');
      const content = getLooseStringArg(args, 'content');
      if (!path?.trim() || content === undefined) {
        return null;
      }
      return {
        type: 'insert_in_file',
        path,
        content,
        after: getLooseStringArg(args, 'after'),
        before: getLooseStringArg(args, 'before'),
        atLine: getLooseIntegerArg(args, 'atLine', 'atline', 'at_line', 'line'),
      };
    }
    case 'replace_in_file':
    {
      const path = getLooseStringArg(args, 'path', 'target');
      const find = getLooseStringArg(args, 'find', 'old', 'search');
      const replace = getLooseStringArg(args, 'replace', 'new', 'replacement');
      if (!path?.trim() || find === undefined || replace === undefined) {
        return null;
      }
      return {
        type: 'replace_in_file',
        path,
        find,
        replace,
        replaceAll: getLooseBooleanArg(args, 'replaceAll', 'replaceall', 'replace_all'),
      };
    }
    case 'apply_patch':
      if (!getLooseStringArg(args, 'patch', 'diff', 'content')) return null;
      return { type: 'apply_patch', patch: getLooseStringArg(args, 'patch', 'diff', 'content')! };
    case 'run_command':
    case 'shell':
    case 'bash':
    case 'execute':
    case 'exec':
    case 'sh': {
      const command = getLooseStringArg(args, 'command', 'cmd', 'shell', 'script', 'code');
      if (!command?.trim()) return null;
      return {
        type: 'run_command',
        command,
        timeoutMs: getLooseIntegerArg(args, 'timeoutMs', 'timeout_ms', 'timeout'),
      };
    }
    case 'delegate_task': {
      const role = getLooseStringArg(args, 'role');
      const task = getLooseStringArg(args, 'task', 'prompt');
      if (!role?.trim() || !task?.trim() || !isAgentRole(role)) return null;
      return {
        type: 'delegate_task',
        role,
        task,
        maxTurns: getLooseIntegerArg(args, 'maxTurns', 'max_turns'),
        runInBackground: getLooseBooleanArg(args, 'runInBackground', 'run_in_background'),
      };
    }
    case 'approve_builder_execution': {
      const sessionId = getLooseStringArg(args, 'sessionId', 'session_id');
      if (!sessionId?.trim()) return null;
      return {
        type: 'approve_builder_execution',
        sessionId,
        summary: getLooseStringArg(args, 'summary'),
        maxTurns: getLooseIntegerArg(args, 'maxTurns', 'max_turns'),
      };
    }
    case 'generate_image':
    case 'image':
    case 'create_image':
    case 'generate_picture': {
      const prompt = getLooseStringArg(args, 'prompt', 'description', 'text');
      if (!prompt?.trim()) return null;
      return {
        type: 'generate_image',
        prompt,
        model: getLooseStringArg(args, 'model'),
        size: getLooseStringArg(args, 'size', 'resolution'),
        count: getLooseIntegerArg(args, 'count', 'n'),
        outputPath: getLooseStringArg(
          args,
          'outputPath',
          'output_path',
          'destination',
          'dest',
          'path',
          'file',
          'filepath',
          'file_path',
        ),
        watermark: getLooseBooleanArg(args, 'watermark'),
        runInBackground: getLooseBooleanArg(args, 'runInBackground', 'run_in_background'),
      };
    }
    case 'generate_video':
    case 'video':
    case 'create_video': {
      const prompt = getLooseStringArg(args, 'prompt', 'description', 'text');
      if (!prompt?.trim()) return null;
      return {
        type: 'generate_video',
        prompt,
        model: getLooseStringArg(args, 'model'),
        ratio: getLooseStringArg(args, 'ratio', 'aspectRatio', 'aspect_ratio'),
        duration: getLooseIntegerArg(args, 'duration', 'durationSeconds', 'duration_seconds'),
        outputPath: getLooseStringArg(
          args,
          'outputPath',
          'output_path',
          'destination',
          'dest',
          'path',
          'file',
          'filepath',
          'file_path',
        ),
        generateAudio: getLooseBooleanArg(args, 'generateAudio', 'generate_audio', 'audio'),
        watermark: getLooseBooleanArg(args, 'watermark'),
        runInBackground: getLooseBooleanArg(args, 'runInBackground', 'run_in_background'),
      };
    }
    case 'synthesize_speech':
    case 'tts':
    case 'text_to_speech': {
      const text = getLooseStringArg(args, 'text', 'prompt', 'message');
      if (!text?.trim()) return null;
      return {
        type: 'synthesize_speech',
        text,
        voice: getLooseStringArg(args, 'voice'),
        language: getLooseStringArg(args, 'language', 'lang'),
        outputPath: getLooseStringArg(args, 'outputPath', 'output_path', 'path', 'file'),
        playAudio: getLooseBooleanArg(args, 'playAudio', 'play_audio'),
        rate: getLooseNumberArg(args, 'rate'),
        pitch: getLooseNumberArg(args, 'pitch'),
      };
    }
    case 'transcribe_audio':
    case 'stt':
    case 'speech_to_text': {
      const inputPath = getLooseStringArg(args, 'inputPath', 'input_path', 'path', 'file', 'audio');
      if (!inputPath?.trim()) return null;
      const model = getLooseStringArg(args, 'model') as Extract<AgentAction, { type: 'transcribe_audio' }>['model'];
      const engine = getLooseStringArg(args, 'engine') as Extract<AgentAction, { type: 'transcribe_audio' }>['engine'];
      return {
        type: 'transcribe_audio',
        inputPath,
        language: getLooseStringArg(args, 'language', 'lang'),
        model,
        modelPath: getLooseStringArg(args, 'modelPath', 'model_path'),
        engine,
        command: getLooseStringArg(args, 'command', 'cmd'),
      };
    }
    default:
      return null;
  }
}

function extractXmlToolCalls(text: string): AgentAction[] {
  const actions: AgentAction[] = [];

  // ark / doubao / pseudo-MCP dialects:
  // <call call="tool_name">...</call> and <call name="tool_name">...</call>
  const callPattern = /<call\b([^>]*)>([\s\S]*?)<\/call>/gi;
  for (const match of text.matchAll(callPattern)) {
    const attributes = match[1] ?? '';
    const tool =
      attributes.match(/\b(?:call|name|tool|tool_name)=["']([a-zA-Z_][a-zA-Z0-9_]*)["']/i)?.[1] ?? '';
    if (!tool) continue;
    const body = match[2] ?? '';
    const args = parseXmlArgsBlock(body);
    const action = buildActionFromLooseArgs(tool, args);
    if (action) actions.push(action);
  }

  // Anthropic-style: <invoke name="tool_name"><parameter name="x">val</parameter>...</invoke>
  const invokePattern = /<invoke\b[^>]*\bname=["']([a-zA-Z_][a-zA-Z0-9_]*)["'][^>]*>([\s\S]*?)<\/invoke>/gi;
  for (const match of text.matchAll(invokePattern)) {
    const tool = match[1] ?? '';
    const body = match[2] ?? '';
    const args = parseXmlArgsBlock(body);
    const action = buildActionFromLooseArgs(tool, args);
    if (action) actions.push(action);
  }

  // Legacy workflow dialect:
  // <actions><action name="write_file"><path>...</path><content>...</content></action></actions>
  const actionPattern = /<action\b[^>]*\bname=["']([a-zA-Z_][a-zA-Z0-9_]*)["'][^>]*>([\s\S]*?)<\/action>/gi;
  for (const match of text.matchAll(actionPattern)) {
    const tool = match[1] ?? '';
    const body = match[2] ?? '';
    const args = parseXmlArgsBlock(body);
    const action = buildActionFromLooseArgs(tool, args);
    if (action) actions.push(action);
  }

  // OpenAI/Codex-style text fallback:
  // <function name="run_command"><parameter name="command">...</parameter></function>
  const functionPattern = /<function\b[^>]*\bname=["']([a-zA-Z_][a-zA-Z0-9_]*)["'][^>]*>([\s\S]*?)<\/function>/gi;
  for (const match of text.matchAll(functionPattern)) {
    const tool = match[1] ?? '';
    const body = match[2] ?? '';
    const args = parseXmlArgsBlock(body);
    const action = buildActionFromLooseArgs(tool, args);
    if (action) actions.push(action);
  }

  // Some BytePlus / Ark runs wrap a JSON tool request in <toolcall>...</toolcall>
  // instead of the <call call="..."> dialect we already parse above.
  const toolcallPattern = /<toolcall>\s*([\s\S]*?)\s*<\/toolcall>/gi;
  for (const match of text.matchAll(toolcallPattern)) {
    const body = match[1]?.trim() ?? '';
    if (!body) continue;

    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const tool =
        typeof parsed.name === 'string'
          ? parsed.name
          : typeof parsed.tool === 'string'
            ? parsed.tool
            : typeof parsed.tool_name === 'string'
              ? parsed.tool_name
              : '';
      const args = parsed.parameters;
      if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) {
        continue;
      }
      const action = buildActionFromLooseArgs(tool, args as Record<string, unknown>);
      if (action) actions.push(action);
    } catch {
      continue;
    }
  }

  // <toolcall name="run_command">{...}</toolcall> — emitted by DeepSeek/BytePlus coding models
  // and wrapped in optional <toolcalls>...</toolcalls>. JSON body may be the args directly
  // or contain a nested "parameters" / "args" key.
  const namedToolcallPattern = /<toolcall\b[^>]*\bname=["']([a-zA-Z_][a-zA-Z0-9_]*)["'][^>]*>([\s\S]*?)<\/toolcall>/gi;
  for (const match of text.matchAll(namedToolcallPattern)) {
    const tool = match[1] ?? '';
    const body = match[2]?.trim() ?? '';
    if (!tool || !body) continue;

    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      // Body may be the args object directly, or wrapped under a "parameters"/"args" key.
      const argsRaw =
        parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters)
          ? parsed.parameters as Record<string, unknown>
          : parsed.args && typeof parsed.args === 'object' && !Array.isArray(parsed.args)
            ? parsed.args as Record<string, unknown>
            : parsed;
      const action = buildActionFromLooseArgs(tool, argsRaw as Record<string, unknown>);
      if (action) actions.push(action);
    } catch {
      // Body is not JSON — try XML element parsing.
      const args = parseXmlArgsBlock(body);
      const action = buildActionFromLooseArgs(tool, args);
      if (action) actions.push(action);
    }
  }

  return actions;
}

function stripXmlToolCalls(text: string): string {
  return text
    .replace(/<call\b[^>]*>[\s\S]*?<\/call>/gi, '')
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
    .replace(/<actions>[\s\S]*?<\/actions>/gi, '')
    .replace(/<\/?tool_calls>/gi, '')
    .replace(/<invoke\b[^>]*\bname=["'][^"']+["'][^>]*>[\s\S]*?<\/invoke>/gi, '')
    .replace(/<action\b[^>]*\bname=["'][^"']+["'][^>]*>[\s\S]*?<\/action>/gi, '')
    .replace(/<function\b[^>]*\bname=["'][^"']+["'][^>]*>[\s\S]*?<\/function>/gi, '')
    .replace(/<toolcalls>[\s\S]*?<\/toolcalls>/gi, '')
    .replace(/<toolcall\b[^>]*>[\s\S]*?<\/toolcall>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isAssistantEnvelopeLike(
  value: unknown,
): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ['reply', 'actions', 'done', 'plan', 'tasks', 'claims'].some(
      (key) => key in (value as Record<string, unknown>),
    )
  );
}

function buildEnvelopeFromParsedObject(
  parsed: Record<string, unknown>,
  fallbackReply: string,
): AssistantEnvelope {
  const baseReply =
    typeof parsed.reply === 'string' ? parsed.reply : fallbackReply;
  const baseActions = normalizeActions(parsed.actions);

  // Guard: if model produced a JSON envelope but with no actions AND the
  // reply prose contains an XML tool call, hoist those calls into actions.
  // Some models do this hybrid output ("here is my reply, and oh by the way
  // I will <call call="write_file">..."). Without this hoist the call text
  // never executes.
  if (baseActions.length === 0) {
    const xmlActions = extractXmlToolCalls(baseReply);
    if (xmlActions.length > 0) {
      return {
        reply: stripXmlToolCalls(baseReply) || baseReply,
        done: false,
        actions: xmlActions,
        plan: 'plan' in parsed ? normalizePlan(parsed.plan) : undefined,
        tasks: 'tasks' in parsed ? normalizeTasks(parsed.tasks) : undefined,
        claims: 'claims' in parsed ? normalizeClaims(parsed.claims) : undefined,
      };
    }
  }

  return {
    reply: baseReply,
    done: parsed.done === false ? false : true,
    actions: baseActions,
    plan: 'plan' in parsed ? normalizePlan(parsed.plan) : undefined,
    tasks: 'tasks' in parsed ? normalizeTasks(parsed.tasks) : undefined,
    claims: 'claims' in parsed ? normalizeClaims(parsed.claims) : undefined,
  };
}

type EmbeddedEnvelopeCandidate = {
  jsonText: string;
  prefix: string;
};

function extractBalancedJsonCandidates(
  text: string,
): EmbeddedEnvelopeCandidate[] {
  const candidates: EmbeddedEnvelopeCandidate[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;

    if (start === -1) {
      if (char === '{') {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char !== '}') {
      continue;
    }

    depth -= 1;
    if (depth !== 0) {
      continue;
    }

    const jsonText = text.slice(start, index + 1).trim();
    if (/"(?:reply|actions|done|plan|tasks|claims)"/.test(jsonText)) {
      candidates.push({
        jsonText,
        prefix: text.slice(0, start).trim(),
      });
    }
    start = -1;
  }

  return candidates;
}

function extractEmbeddedEnvelopeCandidates(
  raw: string,
): EmbeddedEnvelopeCandidate[] {
  const candidates: EmbeddedEnvelopeCandidate[] = [];
  const seen = new Set<string>();
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi;

  for (const match of raw.matchAll(fencePattern)) {
    const jsonText = (match[1] ?? '').trim();
    if (!jsonText || seen.has(jsonText)) continue;
    seen.add(jsonText);
    candidates.push({
      jsonText,
      prefix: raw.slice(0, match.index ?? 0).trim(),
    });
  }

  for (const candidate of extractBalancedJsonCandidates(raw)) {
    if (seen.has(candidate.jsonText)) continue;
    seen.add(candidate.jsonText);
    candidates.push(candidate);
  }

  return candidates;
}

function tryParseEnvelope(raw: string): AssistantEnvelope {
  const trimmed = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isAssistantEnvelopeLike(parsed)) {
      return buildEnvelopeFromParsedObject(parsed, raw.trim());
    }
  } catch {
    // Fall through to embedded JSON / XML recovery below.
  }

  for (const candidate of extractEmbeddedEnvelopeCandidates(raw)) {
    try {
      const parsed = JSON.parse(candidate.jsonText) as unknown;
      if (isAssistantEnvelopeLike(parsed)) {
        return buildEnvelopeFromParsedObject(
          parsed,
          candidate.prefix || raw.trim(),
        );
      }
    } catch {
      continue;
    }
  }

  // JSON failed entirely. Try XML tool-call dialects before giving up.
  const xmlActions = extractXmlToolCalls(raw);
  if (xmlActions.length > 0) {
    const cleaned = stripXmlToolCalls(raw);
    return {
      reply: cleaned || raw.trim(),
      done: false,
      actions: xmlActions,
      plan: undefined,
      tasks: undefined,
      claims: undefined,
    };
  }
  return {
    reply: raw.trim(),
    done: true,
    actions: [],
    plan: undefined,
    tasks: undefined,
    claims: undefined,
  };
}

export function parseAssistantEnvelopeForSmoke(raw: string): AssistantEnvelope {
  return tryParseEnvelope(raw);
}

export function replyLooksLikeDeferredWork(reply: string): boolean {
  const normalized = reply.trim();
  if (!normalized) {
    return false;
  }

  return [
    /\b(continuing|initiating|follow-up|next step|will continue)\b/i,
    /\b(cannot|unable to|blocked)\b[\s\S]{0,120}\b(truncated|missing|need|requires)\b/i,
    /\b(requires?|needs?)\b[\s\S]{0,120}\b(reads?|search(?:es)?|listings?|verification|evidence|inspection|follow-up)\b/i,
    /\btruncated\b[\s\S]{0,120}\b(blocks?|prevent|prevents|requires?)\b/i,
    /\b(unresolved|unverified|unassessed)\b[\s\S]{0,160}\btruncated at line \d+\b/i,
    /\btruncated at line \d+\b/i,
    /\btruncated\b[\s\S]{0,160}\b(?:[A-Za-z0-9_.-]+[/\\])+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+\b/i,
    /\bunread\b[\s\S]{0,120}\b(section|sections|line|lines|range|ranges)\b/i,
    /\bunassessed\b[\s\S]{0,120}\b(section|sections|line|lines|logic|guardrail|guardrails|risk|risks)\b/i,
    /\bremaining\b[\s\S]{0,120}\b(section|sections|line|lines)\b/i,
    /\bonly\s+lines?\s+\d+\s*(?:-|to)\s*\d+\b[\s\S]{0,80}?\bread\b/i,
    /(?:^|[。！？]\s*)(?:检查|查看|读取|确认|分析)[^。！？\n]{0,80}(?:以了解|来了解|以确认|来确认)[^。！？\n]*[。！？]?$/u,
    /(?:接下来|下一步)[^。！？\n]{0,40}(?:检查|查看|读取|确认|分析)/u,
  ].some((pattern) => pattern.test(normalized));
}

function replyContainsCompletionMarkers(reply: string): boolean {
  const normalized = reply.trim();
  if (!normalized) {
    return false;
  }

  return [
    /\b(created|wrote|added|ran|executed|verified|implemented|installed|finished|completed|generated|saved|built)\b/i,
    /\bthe\s+(file|files|change|changes|implementation|script|test|tests|directory|folder)s?\s+(was|were|has been|have been|are now)\b/i,
    /(?:已经|已)\s*(?:创建|写入|添加|运行|执行|验证|实现|安装|完成|生成|保存|搭建|改动|改写)/,
    /(?:文件|改动|实现|脚本|测试|目录).*?(?:已经?(?:创建|完成|生成|保存|添加|改动|改写))/,
  ].some((pattern) => pattern.test(normalized));
}

function replyLooksStructurallyIncomplete(reply: string): boolean {
  const normalized = reply.trim();
  if (!normalized) {
    return false;
  }

  if (
    [
      /\b(?:now|next|then)\s+(?:creating|writing|building|implementing|adding|updating|generating|editing|checking|reading|verifying|scaffolding)\b/i,
      /^(?:creating|writing|building|implementing|adding|updating|generating|editing|checking|reading|verifying|scaffolding)\b/i,
      /(?:现在|正在|接下来|下一步)[^。！？\n]{0,24}(?:创建|编写|实现|生成|添加|修改|检查|查看|读取|验证|搭建)/u,
    ].some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }

  if (
    /(?:[:：]|\.{3}|…)\s*$/.test(normalized) &&
    /(?:create|write|build|implement|add|update|generate|edit|check|read|verify|scaffold|creating|writing|building|implementing|adding|updating|generating|editing|checking|reading|verifying|scaffolding|创建|编写|实现|生成|添加|修改|检查|查看|读取|验证|搭建)/i.test(
      normalized,
    )
  ) {
    return true;
  }

  return false;
}

function replyLooksLikeContinuationRequest(reply: string): boolean {
  const normalized = reply.trim();
  if (!normalized) {
    return false;
  }

  return [
    /\b(let me know|tell me|say the word|should i|shall i|would you like me to|do you want me to)\b[\s\S]{0,80}\b(continue|proceed|keep going|move on|implement|apply|execute|finish)\b/i,
    /\bready to\b[\s\S]{0,40}\b(continue|proceed|implement|apply|execute)\b/i,
    /\bif you want\b[\s\S]{0,80}\b(i can|i'll)\b[\s\S]{0,40}\b(continue|proceed|implement|apply|execute)\b/i,
    /(?:是否继续|要我继续|要不要我继续|是否要我继续|是否进入下一步|是否开始实现|是否开始实施)/,
  ].some((pattern) => pattern.test(normalized));
}

function replyLooksLikeExecutionBlocker(reply: string): boolean {
  const normalized = reply.trim();
  if (!normalized) {
    return false;
  }

  return [
    /\b(blocked|cannot|can't|unable to|read-only|permission)\b/i,
    /\b(requires?|needs?)\b[\s\S]{0,120}\b(approval|permission|access|credentials)\b/i,
    /\bnext action\b/i,
    /\bwould take next\b/i,
    /\bif permission mode blocks\b/i,
    /(?:已被阻止|没有权限|只读模式|下一步会执行)/,
  ].some((pattern) => pattern.test(normalized));
}

/* */
function replyLooksLikeIntentWithoutCompletion(reply: string): boolean {
  const normalized = reply.trim();
  if (!normalized) {
    return false;
  }

  const futureIntent = [
    /\bi['']?ll\s+(check|create|implement|set up|build|start|add|write|run|verify|first|now|begin|make|generate)\b/i,
    /\bi will\s+(check|create|implement|set up|build|start|add|write|run|verify|now|begin|make|generate)\b/i,
    /\b(?:going|gonna)\s+to\s+(check|create|implement|set up|build|start|add|write|run|verify|now|begin|make|generate)\b/i,
    /\b(?:first|then|next|now),?\s+i['']?ll\b/i,
    /\blet\s+me\s+(check|create|implement|set up|build|start|add|write|run|verify|first|now|begin|make|generate)\b/i,
    /(?:我(?:会|要|将|准备|打算))\s*(?:先|去|来)?\s*(?:检查|创建|实现|生成|设置|搭建|开始|执行|写|运行|验证|做)/,
    /(?:首先|然后|接下来|下一步)[\s，,。.]*我?(?:会|要|将|准备|打算)/,
  ];

  if (!futureIntent.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  return !replyContainsCompletionMarkers(normalized);
}

const READ_ONLY_EVIDENCE_SAFE_COMMANDS = new Set([
  'cat', 'head', 'tail', 'less', 'more',
  'ls', 'dir', 'tree',
  'echo', 'printf',
  'pwd', 'cd',
  'find', 'locate',
  'grep', 'rg', 'ag', 'ack',
  'sed', 'awk',
  'sort', 'uniq', 'wc', 'cut', 'tr',
  'jq', 'yq',
  'which', 'where', 'whereis', 'type',
  'whoami', 'id', 'hostname',
  'date', 'uname',
  'env', 'printenv',
  'file',
  'stat',
  'diff', 'diff3',
  'md5', 'md5sum', 'sha256sum',
]);

const READ_ONLY_EVIDENCE_GIT_SUBCOMMANDS = new Set([
  'blame', 'branch', 'diff', 'diff-tree', 'grep', 'log',
  'ls-files', 'ls-tree', 'remote', 'rev-parse', 'show',
  'shortlog', 'status', 'stash', 'tag', 'describe', 'config',
]);

function tokenizeCommandSegment(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

function stripCommandTokenQuotes(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"')) ||
    (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1);
  }

  return token;
}

function isEnvironmentAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function isReadOnlyCommandSegmentForExecutionEvidence(segment: string): boolean {
  const tokens = tokenizeCommandSegment(segment)
    .map(stripCommandTokenQuotes)
    .filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }

  let index = 0;
  while (index < tokens.length && isEnvironmentAssignmentToken(tokens[index]!)) {
    index += 1;
  }

  const command = tokens[index]?.toLowerCase();
  if (!command) {
    return false;
  }

  if (READ_ONLY_EVIDENCE_SAFE_COMMANDS.has(command)) {
    return true;
  }

  if (command !== 'git') {
    return false;
  }

  let subIndex = index + 1;
  while (subIndex < tokens.length) {
    const token = tokens[subIndex]!;
    if (!token.startsWith('-')) {
      break;
    }
    if (
      token === '-C' ||
      token === '-c' ||
      token === '--git-dir' ||
      token === '--work-tree'
    ) {
      subIndex += 2;
      continue;
    }
    subIndex += 1;
  }

  const subcommand = tokens[subIndex]?.toLowerCase();
  return Boolean(
    subcommand && READ_ONLY_EVIDENCE_GIT_SUBCOMMANDS.has(subcommand),
  );
}

function runCommandLooksReadOnlyForExecutionEvidence(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) {
    return false;
  }

  if (isReadOnlyCommand(normalized)) {
    return true;
  }

  const segments = normalized
    .split(/\|\||&&|;|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) {
    return false;
  }

  return segments.every(isReadOnlyCommandSegmentForExecutionEvidence);
}

function isConcreteExecutionAction(action: AgentAction): boolean {
  switch (action.type) {
    case 'write_file':
    case 'insert_in_file':
    case 'replace_in_file':
    case 'apply_patch':
    case 'generate_image':
    case 'generate_video':
    case 'synthesize_speech':
    case 'transcribe_audio':
      return true;
    case 'run_command':
      return !runCommandLooksReadOnlyForExecutionEvidence(action.command);
    default:
      return false;
  }
}

function getActionTextPayload(action: AgentAction): string {
  switch (action.type) {
    case 'write_file':
    case 'insert_in_file':
      return action.content;
    case 'replace_in_file':
      return action.replace;
    case 'apply_patch':
      return action.patch;
    case 'run_command':
      return action.command;
    default:
      return '';
  }
}

function getActionPathPayload(action: AgentAction): string {
  switch (action.type) {
    case 'write_file':
    case 'insert_in_file':
    case 'replace_in_file':
      return action.path;
    default:
      return '';
  }
}

function summarizeVisualPlaceholderSubstitute(action: AgentAction): string | undefined {
  const text = getActionTextPayload(action);
  const actionPath = getActionPathPayload(action);
  const normalizedPath = actionPath.replace(/\\/g, '/').toLowerCase();
  const lowerText = text.toLowerCase();

  if (normalizedPath.endsWith('.svg')) {
    return `wrote SVG asset placeholder instead of calling generate_image: ${actionPath}`;
  }

  if (
    /\bgenerate-assets\.(?:js|mjs|cjs|ts|py|sh)$/i.test(normalizedPath) &&
    (lowerText.includes('<svg') || lowerText.includes('.svg') || lowerText.includes('createelementns'))
  ) {
    return `wrote procedural visual asset generator instead of calling generate_image: ${actionPath}`;
  }

  if (
    (action.type === 'write_file' || action.type === 'insert_in_file' || action.type === 'replace_in_file') &&
    (lowerText.includes('<svg') || lowerText.includes('data:image/svg+xml')) &&
    /(?:asset|image|photo|product|hero|gallery|lookbook|visual|素材|图片|配图)/i.test(actionPath)
  ) {
    return `embedded SVG placeholder visual instead of calling generate_image: ${actionPath}`;
  }

  if (
    action.type === 'run_command' &&
    /\b(node|python3?|bash|sh)\b/i.test(text) &&
    /generate-assets\.(?:js|mjs|cjs|ts|py|sh)/i.test(text)
  ) {
    return `ran procedural visual asset generator instead of calling generate_image: ${truncate(text, 160)}`;
  }

  return undefined;
}

function extractOriginalRequestFromExecutionPrompt(input: string): string {
  const match = input.match(/^Original request:\s*(.+)$/m);
  return match?.[1]?.trim() || input.trim();
}

function parseSmallIntegerWord(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric) && numeric > 0) {
    return numeric;
  }

  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    一: 1,
    一个: 1,
    兩: 2,
    两: 2,
    二: 2,
    两个: 2,
    二个: 2,
    三: 3,
    三个: 3,
    四: 4,
    四个: 4,
    五: 5,
    五个: 5,
    六: 6,
    六个: 6,
    七: 7,
    七个: 7,
    八: 8,
    八个: 8,
    九: 9,
    九个: 9,
    十: 10,
    十个: 10,
  };

  return words[normalized];
}

function inferExpectedChangedFileCount(input: string): number | undefined {
  const normalized = extractOriginalRequestFromExecutionPrompt(input);
  const englishNumber =
    String.raw`(\d+|one|two|three|four|five|six|seven|eight|nine|ten)`;
  const englishMutation =
    String.raw`(?:create|write|add|generate|scaffold|make|update|modify|edit)`;
  const englishPatterns = [
    new RegExp(
      String.raw`\b${englishMutation}\b[\s\S]{0,40}\b${englishNumber}\b[\s\S]{0,24}\bfiles?\b`,
      'i',
    ),
    new RegExp(
      String.raw`\b${englishNumber}\b[\s\S]{0,24}\bfiles?\b[\s\S]{0,40}\b${englishMutation}\b`,
      'i',
    ),
  ];

  for (const pattern of englishPatterns) {
    const match = normalized.match(pattern);
    const parsed = match?.[1] ? parseSmallIntegerWord(match[1]) : undefined;
    if (parsed) {
      return parsed;
    }
  }

  const chinesePatterns = [
    /(?:创建|新建|写入|生成|新增|添加|修改|更新)[\s\S]{0,20}?(\d+|一|一个|兩|两|二|两个|二个|三|三个|四|四个|五|五个|六|六个|七|七个|八|八个|九|九个|十|十个)\s*个?文件/u,
    /(\d+|一|一个|兩|两|二|两个|二个|三|三个|四|四个|五|五个|六|六个|七|七个|八|八个|九|九个|十|十个)\s*个?文件[\s\S]{0,20}?(?:创建|新建|写入|生成|新增|添加|修改|更新)/u,
  ];

  for (const pattern of chinesePatterns) {
    const match = normalized.match(pattern);
    const parsed = match?.[1] ? parseSmallIntegerWord(match[1]) : undefined;
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function windowHasMutationIntent(windowText: string): boolean {
  return [
    /\b(create|write|add|generate|scaffold|make|implement|modify|update|edit|fix|patch|refactor|rename|delete|remove)\b/i,
    /(?:创建|新建|写入|生成|新增|添加|实现|修改|更新|编辑|修复|补丁|重构|重命名|删除|移除)/u,
  ].some((pattern) => pattern.test(windowText));
}

function inferExpectedMutationPaths(input: string): string[] {
  const normalized = extractOriginalRequestFromExecutionPrompt(input);
  const paths = new Set<string>();

  for (const match of normalized.matchAll(TARGET_FILE_PATH_PATTERN)) {
    const rawPath = match[0] ?? '';
    const index = match.index ?? 0;
    const start = Math.max(0, index - 100);
    const end = Math.min(normalized.length, index + rawPath.length + 100);
    const windowText = normalized.slice(start, end);

    if (!windowHasMutationIntent(windowText)) {
      continue;
    }

    paths.add(normalizeReferencedPath(rawPath));
  }

  return [...paths].slice(0, 16);
}

function taskExplicitlyRequiresVerification(input: string): boolean {
  const normalized = extractOriginalRequestFromExecutionPrompt(input);
  if (!normalized) {
    return false;
  }

  return [
    /\b(run|execute|perform|do)\b[\s\S]{0,80}\b(tests?|test suite|typecheck|type-check|lint|build|verification|checks?)\b/i,
    /\b(with|including)\b[\s\S]{0,30}\b(tests?|verification|typecheck|type-check|lint|build)\b/i,
    /\b(verif(?:y|ication)|validate)\b[\s\S]{0,80}\b(pass(?:es|ed)?|works?|result|changes?|implementation|build|tests?)\b/i,
    /\bmake sure\b[\s\S]{0,80}\b(pass(?:es)?|works?|tests?|builds?)\b/i,
    /(?:运行|执行|跑)[\s\S]{0,40}(?:测试|检查|验证|构建|类型检查|lint)/u,
    /(?:测试|验证|构建|类型检查|检查)[\s\S]{0,40}(?:通过|结果|运行|执行|跑)/u,
  ].some((pattern) => pattern.test(normalized));
}

export function taskLikelyRequiresImageGeneration(input: string): boolean {
  const normalized = extractOriginalRequestFromExecutionPrompt(input);
  if (!normalized) {
    return false;
  }

  return [
    /\b(generate.*image|image.*generate|create.*image|image.*create|draw.*image|image.*draw|make.*image|image.*make|design.*image|image.*design|produce.*image|image.*produce|render.*image|image.*render|generate.*picture|picture.*generate|create.*picture|picture.*create|draw.*picture|picture.*draw|make.*picture|picture.*make|design.*picture|picture.*design|produce.*picture|picture.*produce|render.*picture|picture.*render)\b/i,
    /(?:生成.*图片|图片.*生成|创建.*图片|图片.*创建|绘制.*图片|图片.*绘制|制作.*图片|图片.*制作|设计.*图片|图片.*设计|产生.*图片|图片.*产生|渲染.*图片|图片.*渲染|生成.*图画|图画.*生成|创建.*图画|图画.*创建|绘制.*图画|图画.*绘制|制作.*图画|图画.*制作|设计.*图画|图画.*设计|产生.*图画|图画.*产生|渲染.*图画|图画.*渲染)/,
  ].some((pattern) => pattern.test(normalized));
}

function taskLikelyRequiresWorkspaceMutation(input: string): boolean {
  const normalized = extractOriginalRequestFromExecutionPrompt(input);
  if (!normalized) {
    return false;
  }

  return [
    /\b(create|build|implement|write|edit|modify|update|fix|add|scaffold|setup|generate|refactor|patch|install|ship)\b/i,
    /(?:创建|新建|制作|做一个|做个|搭建|实现|编写|写|修改|更新|修复|新增|添加|生成|落地|重构|安装|开发)/,
  ].some((pattern) => pattern.test(normalized));
}

function isWorkspaceVerificationFollowupAction(action: AgentAction): boolean {
  switch (action.type) {
    case 'list_files':
    case 'read_file':
    case 'search_files':
    case 'write_file':
    case 'insert_in_file':
    case 'replace_in_file':
    case 'apply_patch':
      return true;
    case 'run_command':
      return (
        isVerificationCommand(action.command) ||
        runCommandLooksReadOnlyForExecutionEvidence(action.command)
      );
    default:
      return false;
  }
}

const DEFAULT_ACTION_BATCH_BUDGET = 6;
const AUTODRIVE_ACTION_BATCH_BUDGET = 4;
const MAX_WORKFLOW_ACTION_SUMMARY = 6;
const MAX_WORKFLOW_REPLY_CHARS = 65_535;

function clipForUi(
  text: string,
): { body: string; truncated: boolean; totalLines: number } {
  const MAX_UI_OUTPUT_CHARS = 2_400;
  const MAX_UI_OUTPUT_LINES = 14;
  const rawLines = text.length === 0 ? [] : text.split('\n');
  const totalLines = rawLines.length;
  const byChars =
    text.length > MAX_UI_OUTPUT_CHARS
      ? text.slice(0, MAX_UI_OUTPUT_CHARS)
      : text;
  const lines = byChars.length === 0 ? [] : byChars.split('\n');
  if (lines.length <= MAX_UI_OUTPUT_LINES && byChars.length === text.length) {
    return {
      body: byChars,
      truncated: false,
      totalLines,
    };
  }

  const headCount = Math.min(8, lines.length);
  const tailCount = Math.min(4, Math.max(0, lines.length - headCount));
  const hiddenLineCount = Math.max(0, lines.length - headCount - tailCount);
  const clipped = [
    ...lines.slice(0, headCount),
    ...(hiddenLineCount > 0 ? [`... (${hiddenLineCount} more lines)`] : []),
    ...lines.slice(lines.length - tailCount),
  ].join('\n');

  return {
    body: clipped,
    truncated: true,
    totalLines,
  }
}

// Compact JSON payload describing what a tool actually did, for the workflow
// progress UI. Each action contributes the user-facing-relevant fields only
// (path, command, line counts, etc.) so the renderer can build Claude-style
// "⏺ Write(birthday.html)" + "⎿ 写入 234 行" displays. For write/run we also
// ship a head snippet so the user can actually read what was written or
// produced — the whole point is learning from the agent's work.
function buildToolUiPayload(
  action: AgentAction,
  ok: boolean,
  output: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  switch (action.type) {
    case 'write_file': {
      // Don't dump the full file body — for a 500-line HTML page that's pure
      // noise. Just the summary (path + size + line count); the user can read
      // the file on disk if they want the contents.
      payload.path = action.path;
      const content = action.content ?? '';
      payload.bytes = Buffer.byteLength(content, 'utf8');
      payload.lines = content.length > 0 ? content.split('\n').length : 0;
      break;
    }
    case 'insert_in_file': {
      payload.path = action.path;
      const inserted = action.content ?? '';
      if (inserted.length > 0) {
        payload.added = inserted;
        payload.added_lines = inserted.split('\n').length;
      }
      if (typeof action.atLine === 'number') {
        payload.at_line = action.atLine;
      } else if (typeof action.after === 'string' && action.after.length > 0) {
        payload.position = `after: ${truncate(action.after, 80)}`;
      } else if (typeof action.before === 'string' && action.before.length > 0) {
        payload.position = `before: ${truncate(action.before, 80)}`;
      }
      break;
    }
    case 'replace_in_file': {
      payload.path = action.path;
      const removed = action.find ?? '';
      const added = action.replace ?? '';
      if (removed.length > 0) {
        payload.removed = removed;
        payload.removed_lines = removed.split('\n').length;
      }
      if (added.length > 0) {
        payload.added = added;
        payload.added_lines = added.split('\n').length;
      }
      break;
    }
    case 'apply_patch': {
      const files = getChangedFilesForAction(action);
      if (files.length > 0) payload.files = files;
      const diff = ('patch' in action && typeof (action as { patch?: unknown }).patch === 'string')
        ? (action as { patch: string }).patch
        : '';
      if (diff.length > 0) {
        payload.patch = diff;
        let added = 0;
        let removed = 0;
        for (const line of diff.split('\n')) {
          if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
          else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
        }
        if (added > 0) payload.added_lines = added;
        if (removed > 0) payload.removed_lines = removed;
      }
      break;
    }
    case 'run_command': {
      payload.command = action.command;
      const exitMatch = output.match(/exit_code:\s*(-?\d+)/i);
      if (exitMatch) payload.exit = Number(exitMatch[1]);
      // Strip the runtime's own preamble lines so the output snippet is the
      // command's actual stdout / stderr.
      const cleaned = output
        .replace(/^command:[\s\S]*?\n/m, '')
        .replace(/^exit_code:.*\n?/m, '')
        .trim();
      if (cleaned.length > 0) {
        payload.output_head = clipForUi(cleaned).body;
      }
      break;
    }
    case 'read_file':
      payload.path = action.path;
      if (action.startLine || action.endLine) {
        payload.range = `${action.startLine ?? 1}-${action.endLine ?? 'end'}`;
      }
      break;
    case 'list_files':
      if (action.pattern) payload.pattern = action.pattern;
      break;
    case 'search_files':
      if (action.pattern) payload.pattern = action.pattern;
      if (action.query) payload.query = action.query;
      break;
    case 'delegate_task':
      payload.role = action.role;
      payload.task = action.task;
      break;
    case 'generate_image':
    case 'generate_video':
      if ('prompt' in action && typeof action.prompt === 'string') {
        payload.prompt = action.prompt;
      }
      break;
    case 'synthesize_speech':
      payload.text = action.text;
      break;
    case 'transcribe_audio':
      payload.path = action.inputPath;
      break;
    default:
      break;
  }
  if (!ok) {
    payload.reason = output || 'no error message';
  }
  return payload;
}

function summarizeActionForWorkflow(action: AgentAction): string {
  switch (action.type) {
    case 'list_files':
      return `list_files pattern=${action.pattern ?? '*'} max=${action.maxResults ?? 'default'}`;
    case 'read_file':
      return `read_file ${action.path}${action.startLine || action.endLine ? ` lines=${action.startLine ?? 1}-${action.endLine ?? 'end'}` : ''}`;
    case 'search_files':
      return `search_files pattern=${action.pattern ?? '*'} query=${action.query ?? ''}`.trim();
    case 'lookup_docs':
      return `lookup_docs query=${action.query}${action.library ? ` library=${action.library}` : ''}${action.version ? ` version=${action.version}` : ''}`;
    case 'deep_research':
      return `deep_research query=${truncate(action.query, 120)}`;
    case 'mcp_call_tool':
      return `mcp_call_tool ${action.serverId}/${action.toolName}`;
    case 'mcp_read_resource':
      return `mcp_read_resource ${action.serverId}/${action.uri}`;
    case 'mcp_get_prompt':
      return `mcp_get_prompt ${action.serverId}/${action.promptName}`;
    case 'write_file':
      return `write_file ${action.path}`;
    case 'insert_in_file':
      return `insert_in_file ${action.path}`;
    case 'replace_in_file':
      return `replace_in_file ${action.path}`;
    case 'apply_patch':
      return `apply_patch files=${getChangedFilesForAction(action).join(',') || 'unknown'}`;
    case 'run_command':
      return `run_command ${truncate(action.command, 140)}`;
    case 'delegate_task':
      return `delegate_task role=${action.role} task=${truncate(action.task, 120)}`;
    case 'approve_builder_execution':
      return `approve_builder_execution session=${action.sessionId}`;
    case 'odin_search_skills':
      return `odin_search_skills query=${truncate(action.query, 120)} scope=${action.scope ?? 'all'}`;
    case 'odin_execute_task':
      return `odin_execute_task task=${truncate(action.task, 120)}`;
    case 'odin_fix_skill':
      return `odin_fix_skill skillId=${action.skillId}`;
    case 'odin_upload_skill':
      return `odin_upload_skill skillId=${action.skillId} visibility=${action.visibility ?? 'local'}`;
    case 'odin_import_cloud_skills':
      return `odin_import_cloud_skills query=${action.query ?? ''} limit=${action.limit ?? 10}`;
    case 'generate_image':
      return `generate_image model=${action.model ?? 'seedream-5-0-260128'} prompt=${truncate(action.prompt, 120)}`;
    case 'generate_video':
      return `generate_video model=${action.model ?? 'seedance-1-5-pro-251215'} duration=${action.duration ?? 5}s prompt=${truncate(action.prompt, 120)}`;
    case 'synthesize_speech':
      return `synthesize_speech voice=${action.voice ?? 'configured'} text=${truncate(action.text, 120)}`;
    case 'transcribe_audio':
      return `transcribe_audio engine=${action.engine ?? 'configured'} path=${truncate(action.inputPath, 120)}`;
    case 'spawn_background_workflow':
      return `spawn_background_workflow command=${action.command} prompt=${truncate(action.prompt, 120)}`;
    case 'request_freya_visual_asset':
      return `request_freya_visual_asset type=${action.assetType} style=${action.preferredStyle ?? 'default'} context=${truncate(action.contextDescription, 120)}`;
    case 'agent':
      const agentSummary = `agent action=${action.action}`;
      if (action.id) {
        return `${agentSummary} id=${action.id}`;
      }
      if (action.name) {
        return `${agentSummary} name=${action.name}`;
      }
      return agentSummary;
    case 'search_web':
      const searchSummary = `search_web query=${truncate(action.query, 120)}`;
      if (action.backend && action.backend !== 'auto') {
        return `${searchSummary} backend=${action.backend}`;
      }
      if (action.limit && action.limit !== 5) {
        return `${searchSummary} limit=${action.limit}`;
      }
      return searchSummary;
    // ── Spotify integration ──────────────────────────────────────────────
    case 'spotify_play_liked':
      return `spotify_play_liked${action.shuffle === false ? '' : ' shuffle=true'}${action.deviceHint ? ` device=${action.deviceHint}` : ''}`;
    case 'spotify_search_and_play':
      return `spotify_search_and_play query=${truncate(action.query, 80)}${action.kind ? ` kind=${action.kind}` : ''}`;
    case 'spotify_play_playlist':
      return `spotify_play_playlist name=${truncate(action.name, 80)}`;
    case 'spotify_resume':
      return `spotify_resume${action.deviceHint ? ` device=${action.deviceHint}` : ''}`;
    case 'spotify_pause':
      return 'spotify_pause';
    case 'spotify_skip_next':
      return 'spotify_skip_next';
    case 'spotify_skip_previous':
      return 'spotify_skip_previous';
    case 'spotify_set_volume':
      return `spotify_set_volume volume=${action.volume}`;
    case 'spotify_now_playing':
      return 'spotify_now_playing';
    case 'spotify_set_device':
      return `spotify_set_device device=${truncate(action.deviceHint, 80)}${action.startPlaying ? ' start=true' : ''}`;
    // ── Ambient agent integrations ──────────────────────────────────────
    case 'weather_current':
      return `weather_current location=${truncate(action.location, 60)}`;
    case 'weather_forecast':
      return `weather_forecast location=${truncate(action.location, 60)} days=${action.days ?? 3}`;
    case 'world_clock':
      return `world_clock cities=[${action.cities.slice(0, 5).join(',')}]`;
    case 'time_diff':
      return `time_diff ${action.fromCity}→${action.toCity}`;
    case 'currency_convert':
      return `currency_convert ${action.amount} ${action.from}→${action.to}`;
    case 'currency_rates':
      return `currency_rates base=${action.base}`;
    case 'flight_lookup':
      return `flight_lookup callsign=${action.callsign}`;
    case 'calendar_list_today':
      return 'calendar_list_today';
    case 'calendar_list_upcoming':
      return `calendar_list_upcoming days=${action.daysAhead ?? 7}`;
    case 'calendar_add_event':
      return `calendar_add_event "${truncate(action.title, 60)}" at ${action.startISO}`;
    case 'reminders_list':
      return `reminders_list${action.list ? ` list=${action.list}` : ''}`;
    case 'reminders_add':
      return `reminders_add "${truncate(action.title, 60)}"`;
    case 'reminders_complete':
      return `reminders_complete "${truncate(action.title, 60)}"`;
    // ── Browser automation ──────────────────────────────────────────────
    case 'browser_navigate':
      return `browser_navigate ${truncate(action.url, 100)}`;
    case 'browser_screenshot':
      return `browser_screenshot${action.fullPage ? ' fullPage=true' : ''}`;
    case 'browser_extract_text':
      return `browser_extract_text${action.selector ? ` selector=${truncate(action.selector, 60)}` : ''}`;
    case 'browser_click':
      return `browser_click ${action.selector ? `selector=${truncate(action.selector, 60)}` : `text=${truncate(action.text ?? '', 60)}`}`;
    case 'browser_type':
      return `browser_type into=${truncate(action.selector, 50)} text=${truncate(action.text, 50)}`;
    case 'browser_wait_for':
      return `browser_wait_for ${action.selector ?? action.text ?? '?'}`;
    case 'browser_close':
      return 'browser_close';
    // ── MCP self-management ─────────────────────────────────────────────
    case 'mcp_list':
      return `mcp_list${action.filter ? ` filter=${action.filter}` : ''}${action.status ? ` status=${action.status}` : ''}`;
    case 'mcp_enable':
      return `mcp_enable ${action.id}`;
    case 'mcp_disable':
      return `mcp_disable ${action.id}`;
    case 'mcp_suggest':
      return `mcp_suggest "${truncate(action.intent, 80)}"`;
    case 'bridge_send_image':
      return `bridge_send_image ${truncate(action.imagePath, 100)}${action.platform ? ` platform=${action.platform}` : ''}`;
    case 'request_user_confirmation':
      return `request_user_confirmation "${truncate(action.question, 100)}"${action.screenshotPath ? ` screenshot=${truncate(action.screenshotPath, 80)}` : ''}`;
    default: {
      const exhaustive: never = action;
      return String(exhaustive);
    }
  }
}

function getActionBatchBudget(
  session: SessionRecord,
): number {
  return session.autonomyMode === 'autodrive'
    ? AUTODRIVE_ACTION_BATCH_BUDGET
    : DEFAULT_ACTION_BATCH_BUDGET;
}

async function recordEnvelopeWorkflowEntry(
  session: SessionRecord,
  options: RunAgentOptions,
  turn: number,
  envelope: AssistantEnvelope,
  actions: AgentAction[],
  originalActionCount: number,
): Promise<void> {
  const lines = [
    `done=${envelope.done !== false}`,
    `reply=${truncate(envelope.reply || '(empty)', 280)}`,
    `actions=${actions.length}/${originalActionCount}`,
    `autonomy=${session.autonomyMode ?? 'standard'}`,
  ];
  if (actions.length > 0) {
    lines.push(
      ...actions
        .slice(0, MAX_WORKFLOW_ACTION_SUMMARY)
        .map((action) => `action=${summarizeActionForWorkflow(action)}`),
    );
    if (originalActionCount > MAX_WORKFLOW_ACTION_SUMMARY) {
      lines.push(`action_summary_truncated=${originalActionCount - MAX_WORKFLOW_ACTION_SUMMARY}`);
    }
  }
  if (Array.isArray(envelope.tasks) && envelope.tasks.length > 0) {
    lines.push(`tasks=${envelope.tasks.length}`);
  }
  if (Array.isArray(envelope.plan) && envelope.plan.length > 0) {
    lines.push(`plan=${envelope.plan.length}`);
  }
  if (Array.isArray(envelope.claims) && envelope.claims.length > 0) {
    lines.push(`claims=${envelope.claims.length}`);
  }

  await recordWorkflowEntry(
    session,
    options,
    `${profileLabel(options.profile ?? 'main')} Turn ${turn} Planned`,
    lines,
  );
}

async function recordOutcomeWorkflowEntry(
  session: SessionRecord,
  options: RunAgentOptions,
  turn: number,
  outcomes: ActionOutcome[],
): Promise<void> {
  if (outcomes.length === 0) {
    return;
  }

  await recordWorkflowEntry(
    session,
    options,
    `${profileLabel(options.profile ?? 'main')} Turn ${turn} Outcomes`,
    outcomes.map((outcome) =>
      `${outcome.ok ? 'ok' : 'failed'} ${summarizeActionForWorkflow(outcome.action)} :: ${truncate(outcome.output, 220)}`,
    ),
  );
}

function profileLabel(profile: 'main' | AgentRole): string {
  return profile === 'main' ? 'Agent' : `[${profile}]`;
}

const FILE_PATH_PATTERN =
  /(?:[A-Za-z0-9_.-]+[/\\])+[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+/g;
const TARGET_FILE_PATH_PATTERN =
  /(?:[A-Za-z0-9_.-]+[/\\])*[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9_-]*/g;
const CONTINUE_START_LINE_PATTERN = /Continue with startLine=(\d+)/gi;
const INITIAL_FALLBACK_READ_BUDGET = 2;
const CONTINUATION_FALLBACK_READ_BUDGET = 1;
const PATH_THEN_RANGE_PATTERN = new RegExp(
  `(${FILE_PATH_PATTERN.source})[^\\n]{0,80}?lines?\\s+(\\d+)\\s*(?:-|to)\\s*(\\d+)`,
  'gi',
);
const RANGE_THEN_PATH_PATTERN = new RegExp(
  `lines?\\s+(\\d+)\\s*(?:-|to)\\s*(\\d+)[^\\n]{0,40}?(?:of|in)\\s+(${FILE_PATH_PATTERN.source})`,
  'gi',
);
const PATH_THEN_SINGLE_LINE_PATTERN = new RegExp(
  `(${FILE_PATH_PATTERN.source})[^\\n]{0,120}?\\b(?:at|near)\\s+line\\s+(\\d+)`,
  'gi',
);
const SINGLE_LINE_THEN_PATH_PATTERN = new RegExp(
  `(?:at|near)\\s+line\\s+(\\d+)[^\\n]{0,40}?(?:of|in)\\s+(${FILE_PATH_PATTERN.source})`,
  'gi',
);
const PATH_THEN_READ_RANGE_PATTERN = new RegExp(
  `(${FILE_PATH_PATTERN.source})[^\\n]{0,160}?\\bonly\\s+lines?\\s+(\\d+)\\s*(?:-|to)\\s*(\\d+)[^\\n]{0,60}?\\bread\\b`,
  'gi',
);
const READ_RANGE_THEN_PATH_PATTERN = new RegExp(
  `\\bonly\\s+lines?\\s+(\\d+)\\s*(?:-|to)\\s*(\\d+)[^\\n]{0,60}?\\bread\\b[^\\n]{0,80}?(?:of|in)\\s+(${FILE_PATH_PATTERN.source})`,
  'gi',
);
const DEFAULT_TARGETED_READ_SPAN = 160;

function normalizeReferencedPath(input: string): string {
  return input
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim()
    .replace(/[),.;:'"\]]+$/g, '');
}

function extractReferencedFilePaths(text: string): string[] {
  const matches = text.match(FILE_PATH_PATTERN) ?? [];
  const unique = new Set<string>();

  for (const match of matches) {
    unique.add(normalizeReferencedPath(match));
  }

  return [...unique];
}

function getPreviouslyReadPaths(session: SessionRecord): Set<string> {
  const readPaths = new Set<string>();

  for (const message of session.messages) {
    if (message.role !== 'tool' || message.name !== 'read_file') {
      continue;
    }

    try {
      const parsed = JSON.parse(message.content) as {
        action?: { path?: string };
      };
      const path = parsed.action?.path;
      if (typeof path === 'string' && path.trim()) {
        readPaths.add(normalizeReferencedPath(path));
      }
    } catch {
      continue;
    }
  }

  return readPaths;
}

type PendingReadContinuation = {
  path: string;
  startLine: number;
};

type TargetedReadRange = {
  path: string;
  startLine: number;
  endLine: number;
};

function extractContinuationStartLine(output: unknown): number | undefined {
  if (typeof output !== 'string') {
    return undefined;
  }

  let lastMatch: number | undefined;

  for (const match of output.matchAll(CONTINUE_START_LINE_PATTERN)) {
    const startLine = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(startLine) && startLine > 0) {
      lastMatch = startLine;
    }
  }

  return lastMatch;
}

function getPendingReadContinuations(
  session: SessionRecord,
): PendingReadContinuation[] {
  const pendingByPath = new Map<string, number>();

  for (const message of session.messages) {
    if (message.role !== 'tool' || message.name !== 'read_file') {
      continue;
    }

    try {
      const parsed = JSON.parse(message.content) as {
        action?: { path?: string; startLine?: number };
        output?: string;
      };
      const rawPath = parsed.action?.path;
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        continue;
      }

      const path = normalizeReferencedPath(rawPath);
      const requestedStartLine =
        typeof parsed.action?.startLine === 'number' &&
        Number.isInteger(parsed.action.startLine) &&
        parsed.action.startLine > 0
          ? parsed.action.startLine
          : 1;
      const pendingStartLine = pendingByPath.get(path);

      if (
        typeof pendingStartLine === 'number' &&
        requestedStartLine >= pendingStartLine
      ) {
        pendingByPath.delete(path);
      }

      const suggestedStartLine = extractContinuationStartLine(parsed.output);
      if (
        typeof suggestedStartLine === 'number' &&
        suggestedStartLine > requestedStartLine
      ) {
        pendingByPath.set(path, suggestedStartLine);
      }
    } catch {
      continue;
    }
  }

  return [...pendingByPath.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([path, startLine]) => ({ path, startLine }));
}

function extractTargetedReadRanges(text: string): TargetedReadRange[] {
  const ranges = new Map<string, TargetedReadRange>();

  for (const match of text.matchAll(PATH_THEN_RANGE_PATTERN)) {
    const path = normalizeReferencedPath(match[1] ?? '');
    const startLine = Number.parseInt(match[2] ?? '', 10);
    const endLine = Number.parseInt(match[3] ?? '', 10);
    if (
      !path ||
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine <= 0 ||
      endLine < startLine
    ) {
      continue;
    }

    ranges.set(`${path}:${startLine}:${endLine}`, {
      path,
      startLine,
      endLine,
    });
  }

  for (const match of text.matchAll(RANGE_THEN_PATH_PATTERN)) {
    const startLine = Number.parseInt(match[1] ?? '', 10);
    const endLine = Number.parseInt(match[2] ?? '', 10);
    const path = normalizeReferencedPath(match[3] ?? '');
    if (
      !path ||
      !Number.isInteger(startLine) ||
      !Number.isInteger(endLine) ||
      startLine <= 0 ||
      endLine < startLine
    ) {
      continue;
    }

    ranges.set(`${path}:${startLine}:${endLine}`, {
      path,
      startLine,
      endLine,
    });
  }

  for (const match of text.matchAll(PATH_THEN_SINGLE_LINE_PATTERN)) {
    const path = normalizeReferencedPath(match[1] ?? '');
    const lineNumber = Number.parseInt(match[2] ?? '', 10);
    if (!path || !Number.isInteger(lineNumber) || lineNumber <= 0) {
      continue;
    }

    const startLine = lineNumber + 1;
    const endLine = startLine + DEFAULT_TARGETED_READ_SPAN - 1;
    ranges.set(`${path}:${startLine}:${endLine}`, {
      path,
      startLine,
      endLine,
    });
  }

  for (const match of text.matchAll(SINGLE_LINE_THEN_PATH_PATTERN)) {
    const lineNumber = Number.parseInt(match[1] ?? '', 10);
    const path = normalizeReferencedPath(match[2] ?? '');
    if (!path || !Number.isInteger(lineNumber) || lineNumber <= 0) {
      continue;
    }

    const startLine = lineNumber + 1;
    const endLine = startLine + DEFAULT_TARGETED_READ_SPAN - 1;
    ranges.set(`${path}:${startLine}:${endLine}`, {
      path,
      startLine,
      endLine,
    });
  }

  for (const match of text.matchAll(PATH_THEN_READ_RANGE_PATTERN)) {
    const path = normalizeReferencedPath(match[1] ?? '');
    const endLine = Number.parseInt(match[3] ?? '', 10);
    if (!path || !Number.isInteger(endLine) || endLine <= 0) {
      continue;
    }

    const startLine = endLine + 1;
    const rangeEnd = startLine + DEFAULT_TARGETED_READ_SPAN - 1;
    ranges.set(`${path}:${startLine}:${rangeEnd}`, {
      path,
      startLine,
      endLine: rangeEnd,
    });
  }

  for (const match of text.matchAll(READ_RANGE_THEN_PATH_PATTERN)) {
    const endLine = Number.parseInt(match[2] ?? '', 10);
    const path = normalizeReferencedPath(match[3] ?? '');
    if (!path || !Number.isInteger(endLine) || endLine <= 0) {
      continue;
    }

    const startLine = endLine + 1;
    const rangeEnd = startLine + DEFAULT_TARGETED_READ_SPAN - 1;
    ranges.set(`${path}:${startLine}:${rangeEnd}`, {
      path,
      startLine,
      endLine: rangeEnd,
    });
  }

  return [...ranges.values()];
}

function getPreviouslyReadRanges(
  session: SessionRecord,
): Array<{ path: string; startLine?: number; endLine?: number }> {
  const reads: Array<{ path: string; startLine?: number; endLine?: number }> = [];

  for (const message of session.messages) {
    if (message.role !== 'tool' || message.name !== 'read_file') {
      continue;
    }

    try {
      const parsed = JSON.parse(message.content) as {
        action?: { path?: string; startLine?: number; endLine?: number };
      };
      const rawPath = parsed.action?.path;
      if (typeof rawPath !== 'string' || !rawPath.trim()) {
        continue;
      }

      reads.push({
        path: normalizeReferencedPath(rawPath),
        startLine:
          typeof parsed.action?.startLine === 'number' &&
          Number.isInteger(parsed.action.startLine) &&
          parsed.action.startLine > 0
            ? parsed.action.startLine
            : undefined,
        endLine:
          typeof parsed.action?.endLine === 'number' &&
          Number.isInteger(parsed.action.endLine) &&
          parsed.action.endLine > 0
            ? parsed.action.endLine
            : undefined,
      });
    } catch {
      continue;
    }
  }

  return reads;
}

function getRecentTargetedReadRanges(
  session: SessionRecord,
): TargetedReadRange[] {
  const ranges = new Map<string, TargetedReadRange>();

  for (const message of [...session.messages].reverse()) {
    if (message.role !== 'assistant' && message.role !== 'user') {
      continue;
    }

    for (const range of extractTargetedReadRanges(message.content)) {
      const key = `${range.path}:${range.startLine}:${range.endLine}`;
      if (!ranges.has(key)) {
        ranges.set(key, range);
      }
    }

    if (ranges.size >= 6) {
      break;
    }
  }

  return [...ranges.values()];
}

function getRecentFocusPaths(session: SessionRecord): string[] {
  const paths = new Set<string>();

  for (const message of [...session.messages].reverse()) {
    if (message.role !== 'assistant' && message.role !== 'user') {
      continue;
    }

    for (const path of extractReferencedFilePaths(message.content)) {
      paths.add(path);
    }

    if (paths.size >= 6) {
      break;
    }
  }

  return [...paths];
}

function getRecentTruncatedPaths(session: SessionRecord): string[] {
  const paths = new Set<string>();

  for (const message of [...session.messages].reverse()) {
    if (message.role !== 'assistant' && message.role !== 'user') {
      continue;
    }

    if (!/\btruncated\b/i.test(message.content)) {
      continue;
    }

    for (const path of extractReferencedFilePaths(message.content)) {
      paths.add(path);
    }

    if (paths.size >= 4) {
      break;
    }
  }

  return [...paths];
}

function deriveFallbackReadActions(
  taskText: string,
  session: SessionRecord,
): AgentAction[] {
  const focusedPaths = new Set(getRecentFocusPaths(session));
  const pendingContinuations = getPendingReadContinuations(session);
  const fallbackBudget = pendingContinuations.length > 0
    ? CONTINUATION_FALLBACK_READ_BUDGET
    : INITIAL_FALLBACK_READ_BUDGET;
  const continuations = pendingContinuations
    .sort((left, right) => {
      const leftFocused = focusedPaths.has(left.path) ? 1 : 0;
      const rightFocused = focusedPaths.has(right.path) ? 1 : 0;
      if (leftFocused !== rightFocused) {
        return rightFocused - leftFocused;
      }

      return left.startLine - right.startLine;
    })
    .slice(0, fallbackBudget);
  const continuationActions = continuations.map<AgentAction>(
    ({ path, startLine }) => ({
      type: 'read_file',
      path,
      startLine,
    }),
  );
  const reservedPaths = new Set(
    continuations.map(({ path }) => normalizeReferencedPath(path)),
  );
  const previouslyRead = getPreviouslyReadPaths(session);
  const previousRanges = getPreviouslyReadRanges(session);
  const targetedRanges = getRecentTargetedReadRanges(session)
    .filter(
      (range) =>
        !reservedPaths.has(range.path) &&
        !previousRanges.some(
          (entry) =>
            entry.path === range.path &&
            entry.startLine === range.startLine &&
            entry.endLine === range.endLine,
        ),
    )
    .slice(0, Math.max(fallbackBudget - continuationActions.length, 0));
  const targetedActions = targetedRanges.map<AgentAction>((range) => ({
    type: 'read_file',
    path: range.path,
    startLine: range.startLine,
    endLine: range.endLine,
  }));
  const truncatedPaths = getRecentTruncatedPaths(session)
    .filter(
      (path) =>
        !reservedPaths.has(path) &&
        !targetedRanges.some((range) => range.path === path) &&
        !previousRanges.some(
          (entry) =>
            entry.path === path &&
            entry.startLine === undefined &&
            entry.endLine === undefined,
        ),
    )
    .slice(0, Math.max(fallbackBudget - continuationActions.length - targetedActions.length, 0));
  const truncatedActions = truncatedPaths.map<AgentAction>((path) => ({
    type: 'read_file',
    path,
  }));
  const candidates = extractReferencedFilePaths(taskText)
    .filter(
      (path) =>
        !previouslyRead.has(path) &&
        !reservedPaths.has(path) &&
        !truncatedPaths.includes(path),
    )
    .slice(
      0,
      Math.max(
        fallbackBudget - continuationActions.length - targetedActions.length - truncatedActions.length,
        0,
      ),
    );

  return [
    ...continuationActions,
    ...targetedActions,
    ...truncatedActions,
    ...candidates.map<AgentAction>((path) => ({
      type: 'read_file',
      path,
    })),
  ];
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function isAgentRole(value: unknown): value is AgentRole {
  return (
    value === 'planner' ||
    value === 'researcher' ||
    value === 'builder' ||
    value === 'reviewer' ||
    value === 'brainstormer' ||
    value === 'arbiter'
  );
}

function asUnknownRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function loadMcpServerState(
  cwd: string,
  serverId: string,
): Promise<{
  store: McpServerStore;
  data: Awaited<ReturnType<McpServerStore['load']>>;
  server?: McpServerConfig;
}> {
  const store = new McpServerStore(cwd);
  const data = await store.load();
  return {
    store,
    data,
    server: data.servers.find((entry) => entry.id === serverId),
  };
}

async function saveUpdatedMcpServer(
  store: McpServerStore,
  data: Awaited<ReturnType<McpServerStore['load']>>,
  nextServer: McpServerConfig,
): Promise<void> {
  await store.save({
    servers: data.servers
      .map((entry) => (entry.id === nextServer.id ? nextServer : entry))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
}

async function hydrateRuntimeManagedAction(
  action: AgentAction,
  cwd: string,
): Promise<AgentAction> {
  if (action.type !== 'mcp_call_tool' || action.readOnly !== undefined) {
    return action;
  }

  const { server } = await loadMcpServerState(cwd, action.serverId);
  const descriptor = server
    ? findMcpToolDescriptor(server, action.toolName)
    : undefined;
  if (descriptor?.readOnly === undefined) {
    return action;
  }

  return {
    ...action,
    readOnly: descriptor.readOnly,
  };
}

function normalizeActions(input: unknown): AgentAction[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const actions: AgentAction[] = [];

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const commonAction = (() => {
      if ('type' in entry && typeof entry.type === 'string') {
        return buildActionFromLooseArgs(
          entry.type,
          entry as Record<string, unknown>,
        );
      }

      // Different model dialects name the tool field differently:
      //   ark / codex / MCP-ish:  { tool: "list_files", args: {...} }
      //   anthropic native:        { name: "list_files", input: {...} }
      //   openai-compat:           { function: "list_files", arguments: {...} }
      //   snake/camel variants:    { tool_name | toolName | function_name | functionName }
      // Accept all of them — anything missing turns the action into a silent
      // drop, which used to surface to the user as "agent didn't do anything".
      const looseEntry = entry as Record<string, unknown>;
      const toolNameCandidates = [
        'tool',
        'tool_name',
        'toolName',
        'name',
        'function',
        'function_name',
        'functionName',
        'action',
        'action_name',
      ];
      let toolName: string | undefined;
      for (const key of toolNameCandidates) {
        const value = looseEntry[key];
        if (typeof value === 'string' && value.trim()) {
          toolName = value;
          break;
        }
      }
      // Args bag aliases. OpenAI's function calling can pass `arguments` as a
      // JSON-encoded string instead of an object — handle both shapes.
      const argsBagCandidates: ReadonlyArray<string> = [
        'args',
        'input',
        'parameters',
        'params',
        'object',
        'arguments',
        'arg',
        'payload',
      ];
      let legacyArgs: Record<string, unknown> = {};
      for (const key of argsBagCandidates) {
        if (!(key in looseEntry)) continue;
        const raw = looseEntry[key];
        const asRecord = asUnknownRecord(raw);
        if (asRecord) {
          legacyArgs = asRecord;
          break;
        }
        if (typeof raw === 'string') {
          const trimmed = raw.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
              const parsed = JSON.parse(trimmed) as unknown;
              const parsedRecord = asUnknownRecord(parsed);
              if (parsedRecord) {
                legacyArgs = parsedRecord;
                break;
              }
            } catch {
              // fall through to next candidate
            }
          }
        }
      }

      const args =
        Object.keys(legacyArgs).length > 0
          ? legacyArgs
          : looseEntry;

      return toolName
        ? buildActionFromLooseArgs(toolName, args)
        : null;
    })();

    if (commonAction) {
      actions.push(commonAction);
      continue;
    }

    if (!('type' in entry) || typeof entry.type !== 'string') {
      continue;
    }

    switch (entry.type) {
      case 'list_files':
        break;
      case 'read_file':
        break;
      case 'search_files':
        break;
      case 'lookup_docs':
        break;
      case 'mcp_call_tool':
        if (
          typeof entry.serverId === 'string' &&
          typeof entry.toolName === 'string'
        ) {
          actions.push({
            type: 'mcp_call_tool',
            serverId: entry.serverId,
            toolName: entry.toolName,
            args: asUnknownRecord(entry.args),
            readOnly:
              typeof entry.readOnly === 'boolean' ? entry.readOnly : undefined,
            timeoutMs: asPositiveInteger(entry.timeoutMs),
          });
        }
        break;
      case 'mcp_read_resource':
        if (
          typeof entry.serverId === 'string' &&
          typeof entry.uri === 'string'
        ) {
          actions.push({
            type: 'mcp_read_resource',
            serverId: entry.serverId,
            uri: entry.uri,
            timeoutMs: asPositiveInteger(entry.timeoutMs),
          });
        }
        break;
      case 'mcp_get_prompt':
        if (
          typeof entry.serverId === 'string' &&
          typeof entry.promptName === 'string'
        ) {
          actions.push({
            type: 'mcp_get_prompt',
            serverId: entry.serverId,
            promptName: entry.promptName,
            args: asUnknownRecord(entry.args),
            timeoutMs: asPositiveInteger(entry.timeoutMs),
          });
        }
        break;
      case 'write_file':
        break;
      case 'insert_in_file':
        break;
      case 'replace_in_file':
        break;
      case 'apply_patch':
        break;
      case 'run_command':
        break;
      case 'spawn_background_workflow':
      case 'delegate_task':
        break;
      case 'approve_builder_execution':
        break;
      default:
        break;
    }
  }

  return actions;
}

function isPlanStatus(value: string): value is PlanStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}

function isClaimStatus(value: unknown): value is ClaimStatus {
  return (
    value === 'observed' ||
    value === 'inferred' ||
    value === 'unverified' ||
    value === 'refuted'
  );
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return (
    value === 'fact' ||
    value === 'proposal' ||
    value === 'risk' ||
    value === 'decision' ||
    value === 'result'
  );
}

function normalizeClaims(input: unknown): AssistantEnvelope['claims'] {
  if (!Array.isArray(input)) {
    return [];
  }

  const claims: NonNullable<AssistantEnvelope['claims']> = [];

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    if (!('statement' in entry) || typeof entry.statement !== 'string') {
      continue;
    }

    const statement = entry.statement.trim();
    if (!statement) {
      continue;
    }

    claims.push({
      statement: deriveClaimStatement(statement, 240),
      status:
        'status' in entry && isClaimStatus(entry.status)
          ? entry.status
          : undefined,
      kind:
        'kind' in entry && isEvidenceKind(entry.kind)
          ? entry.kind
          : undefined,
    });
  }

  return claims;
}

function normalizePlan(input: unknown): PlanItem[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const id =
        'id' in entry && typeof entry.id === 'string'
          ? entry.id
          : String(index + 1);
      const content =
        'content' in entry && typeof entry.content === 'string'
          ? entry.content.trim()
          : '';
      const status =
        'status' in entry &&
        typeof entry.status === 'string' &&
        isPlanStatus(entry.status)
          ? entry.status
          : 'pending';

      if (!content) {
        return null;
      }

      return {
        id,
        content,
        status,
      };
    })
    .filter((entry): entry is PlanItem => entry !== null);
}

async function buildProviderMessages(
  context: ContextBuildResult,
  cwd: string,
  permissionMode: ReturnType<PermissionManager['getMode']>,
  autonomyMode: SessionAutonomyMode,
  profile: 'main' | AgentRole,
  evidenceDigest?: string,
  nativeToolRuntime = false,
  extensionSections: string[] = [],
): Promise<SessionMessage[]> {
  const systemSections = await buildStableProviderSystemSections({
    cwd,
    permissionMode,
    autonomyMode,
    profile,
    nativeToolRuntime,
  });
  const { MemoryStore } = await import('../storage/memoryStore.js');
  const globalInsights = await new MemoryStore(cwd).load().catch(() => []);

  if (globalInsights && globalInsights.length > 0) {
    systemSections.push('🧠 [Project Mnemosyne: Learned User Preferences]');
    systemSections.push(...globalInsights.map((i: any) => `- ${i.content}`));
    systemSections.push('');
  }

  try {
    const latestUserMessage = [...context.messages]
      .reverse()
      .find((message) => message.role === 'user' && message.content.trim())?.content.trim();
    if (latestUserMessage) {
      const { getMemoryProfile, MemoryEnhancementFactory } = await import('./memoryEnhancement.js');
      const memoryProfile = await getMemoryProfile(cwd);
      if (memoryProfile.enabled) {
        const memory = await MemoryEnhancementFactory.create(memoryProfile, cwd);
        await memory.initialize();
        const memories = await memory.searchMemories(latestUserMessage, 5);
        if (memories.length > 0) {
          systemSections.push('🧠 [Enhanced Memory: Relevant Retrieved Context]');
          systemSections.push(...memories.map((entry) => `- ${entry.text}`));
          systemSections.push('');
        }
      }
    }
  } catch {
    // Enhanced memory is opportunistic context; retrieval failures must not block the turn.
  }

  if (extensionSections.length > 0) {
    systemSections.push(...extensionSections);
  }

  if (context.summary) {
    systemSections.push('Conversation summary:');
    systemSections.push(context.summary);
  }

  if (evidenceDigest) {
    systemSections.push('Repository evidence:');
    systemSections.push(evidenceDigest);
  }

  return [
    {
      id: 'system',
      role: 'system',
      content: systemSections.join('\n\n'),
      createdAt: new Date().toISOString(),
    },
    ...context.messages,
  ];
}

function extractLatestUserRequest(
  messages: SessionMessage[],
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') {
      continue;
    }

    const content = message.content.trim();
    if (content) {
      return content;
    }
  }

  return undefined;
}

function mergeStickyNativeMcpTools(
  current: string[] | undefined,
  next: string[] | undefined,
): string[] {
  const merged = [
    ...(current ?? []).map((entry) => entry.trim()).filter(Boolean),
    ...(next ?? []).map((entry) => entry.trim()).filter(Boolean),
  ].filter((entry) => /^mcp(__|_prompt__|_resource__)/.test(entry));

  return [...new Set(merged)].slice(-64);
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

class AgentRuntimeInterruptedError extends Error {
  readonly runtimeId: string;
  readonly reason: string;

  constructor(runtimeId: string, reason: string) {
    super(`Runtime ${runtimeId} was interrupted: ${reason}`);
    this.name = 'AgentRuntimeInterruptedError';
    this.runtimeId = runtimeId;
    this.reason = reason;
  }
}

function isAgentRuntimeInterruptedError(
  error: unknown,
): error is AgentRuntimeInterruptedError {
  return error instanceof AgentRuntimeInterruptedError;
}

function buildRuntimeManagedFailure(
  code: string,
  message: string,
  options: {
    retryable?: boolean;
    details?: Record<string, unknown>;
  } = {},
): { ok: false; output: string; error: ToolError } {
  return {
    ok: false,
    output: message,
    error: buildToolError(code, message, options),
  };
}

function isNonRetryableNpmPublishFailure(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    /\bnpm\b/.test(normalized) &&
    /\bpublish\b/.test(normalized) &&
    (
      /\be404\b/.test(normalized) ||
      /\b404\s+not\s+found\b/.test(normalized) ||
      /you do not have permission/i.test(output) ||
      /not authorized/i.test(normalized) ||
      /forbidden/i.test(normalized)
    )
  );
}

function classifyActionOutcomeFailure(outcome: ActionOutcome): ActionOutcome {
  if (
    outcome.ok ||
    !outcome.error ||
    outcome.error.retryable === false ||
    outcome.action.type !== 'run_command'
  ) {
    return outcome;
  }

  const command = 'command' in outcome.action && typeof outcome.action.command === 'string'
    ? outcome.action.command
    : '';
  const combined = [command, outcome.output, outcome.error.message].join('\n');
  if (!isNonRetryableNpmPublishFailure(combined)) {
    return outcome;
  }

  const message = [
    outcome.error.message,
    '',
    'Classified as non-retryable: npm publish 404/permission failures require package ownership, access, or registry configuration changes; repeating the same command will not recover automatically.',
  ].join('\n');

  return {
    ...outcome,
    output: outcome.output,
    error: buildToolError(outcome.error.code, message, {
      retryable: false,
      details: {
        ...outcome.error.details,
        classification: 'npm_publish_not_found_or_permission',
      },
    }),
  };
}

function serializeToolPayload(input: {
  ok: boolean;
  action?: AgentAction;
  toolName?: string;
  output: string;
  error?: ToolError;
  maxChars?: number;
}): string {
  return JSON.stringify(
    {
      ok: input.ok,
      ...(input.action ? { action: input.action } : {}),
      ...(input.toolName ? { toolName: input.toolName } : {}),
      output: truncate(input.output, input.maxChars ?? 10_000),
      ...(input.error ? { error: input.error } : {}),
    },
    null,
    2,
  );
}

function formatToolResult(
  action: AgentAction,
  ok: boolean,
  output: string,
  error?: ToolError,
): string {
  const maxChars =
    action.type === 'read_file' ||
    action.type === 'mcp_read_resource' ||
    action.type === 'mcp_get_prompt'
      ? 24_000
      : 10_000;

  return serializeToolPayload({
    action,
    ok,
    output,
    error,
    maxChars,
  });
}

type VerificationState = {
  pending: boolean;
  taskNudgePending: boolean;
  reminderSent: boolean;
  commandEvidencePending: boolean;
};

type CompletionContract = 'standard' | 'requires_execution_evidence';
const MAX_PARALLEL_DELEGATE_TASKS = 4;

type RuntimeCompletionChecklist = {
  requiresWorkspaceMutation: boolean;
  requiresLocalImageGeneration: boolean;
  requiresLocalVideoGeneration: boolean;
  imageGenerationObserved: boolean;
  videoGenerationObserved: boolean;
  visualPlaceholderViolation?: string;
  expectedMutationPaths: string[];
  expectedChangedFileCount?: number;
  expectedVerificationRequired: boolean;
  mutationEvidenceObserved: boolean;
  verificationObserved: boolean;
  blockerAccepted: boolean;
  unresolvedToolFailure?: {
    actionType: AgentAction['type'];
    code?: string;
    output: string;
  };
};

function getNativeAllowedActionTypesForRuntime(
  profile: 'main' | AgentRole,
  permissionMode: ReturnType<PermissionManager['getMode']>,
): AgentAction['type'][] {
  const profileAllowedTypes = getAllowedActionTypesForProfile(profile);
  if (permissionMode !== 'read-only') {
    return profileAllowedTypes;
  }

  return profileAllowedTypes.filter(
    (type) => getToolPermissionCategory(type) === 'read',
  );
}

function buildRuntimeCompletionChecklist(
  userInput: string,
  profile: 'main' | AgentRole,
  session: SessionRecord,
  visualPolicy?: {
    imageRequired: boolean;
    videoRequired: boolean;
  },
): RuntimeCompletionChecklist {
  const canOwnWorkspaceMutation =
    profile === 'main' ||
    (profile === 'builder' && session.agentPhase === 'execution');

  return {
    requiresWorkspaceMutation:
      canOwnWorkspaceMutation && taskLikelyRequiresWorkspaceMutation(userInput),
    requiresLocalImageGeneration: canOwnWorkspaceMutation && (visualPolicy?.imageRequired ?? false),
    requiresLocalVideoGeneration: canOwnWorkspaceMutation && (visualPolicy?.videoRequired ?? false),
    imageGenerationObserved: false,
    videoGenerationObserved: false,
    expectedMutationPaths: canOwnWorkspaceMutation
      ? inferExpectedMutationPaths(userInput)
      : [],
    expectedChangedFileCount: canOwnWorkspaceMutation
      ? inferExpectedChangedFileCount(userInput)
      : undefined,
    expectedVerificationRequired:
      canOwnWorkspaceMutation && taskExplicitlyRequiresVerification(userInput),
    mutationEvidenceObserved: false,
    verificationObserved: false,
    blockerAccepted: false,
  };
}

function summarizeToolFailureOutcome(
  outcome: ActionOutcome,
): RuntimeCompletionChecklist['unresolvedToolFailure'] {
  return {
    actionType: outcome.action.type,
    code: outcome.error?.code,
    output: truncate(outcome.error?.message ?? outcome.output, 500),
  };
}

function getFreshChangedFiles(
  session: SessionRecord,
  baselineChangedFiles: Set<string>,
): string[] {
  return [
    ...new Set(
      (session.changedFiles ?? [])
        .map((filePath) => normalizeReferencedPath(filePath))
        .filter(Boolean)
        .filter((filePath) => !baselineChangedFiles.has(filePath)),
    ),
  ];
}

function resolveExpectedWorkspacePath(
  cwd: string,
  expectedPath: string,
): string | undefined {
  const cwdRoot = path.resolve(cwd);
  const absolute = path.resolve(cwdRoot, expectedPath);
  if (absolute !== cwdRoot && !absolute.startsWith(`${cwdRoot}${path.sep}`)) {
    return undefined;
  }

  return absolute;
}

async function getMissingExpectedMutationPaths(options: {
  checklist: RuntimeCompletionChecklist;
  session: SessionRecord;
  baselineChangedFiles: Set<string>;
  cwd: string;
  concreteExecutionSignals: number;
}): Promise<string[]> {
  if (options.checklist.expectedMutationPaths.length === 0) {
    return [];
  }

  const changed = new Set(
    getFreshChangedFiles(options.session, options.baselineChangedFiles),
  );
  const missing: string[] = [];

  for (const expectedPath of options.checklist.expectedMutationPaths) {
    const normalized = normalizeReferencedPath(expectedPath);
    if (changed.has(normalized)) {
      continue;
    }

    if (options.concreteExecutionSignals > 0) {
      const absolute = resolveExpectedWorkspacePath(options.cwd, normalized);
      if (absolute && await pathExists(absolute)) {
        continue;
      }
    }

    missing.push(normalized);
  }

  return missing;
}

function replyAcknowledgesToolFailure(reply: string): boolean {
  const normalized = reply.trim();
  if (!normalized) {
    return false;
  }

  return [
    /\b(failed|failure|error|errored|denied|denial|blocked|interrupted|interruption|cannot|can't|unable|invalid|missing|not found|permission)\b/i,
    /(?:失败|错误|报错|拒绝|被拒绝|阻止|已被阻止|中断|已中断|不能|无法|没有权限|缺少|未找到|不存在)/,
  ].some((pattern) => pattern.test(normalized));
}

async function getNextDelegatedRuntimeCommandSignal(
  session: SessionRecord,
  options: RunAgentOptions,
): Promise<{
  runtime: TaskRuntimeRecord;
  command: TaskRuntimeCommandRecord;
  reason: string;
} | undefined> {
  if (!session.parentSessionId || !session.runtimeTaskId) {
    return undefined;
  }

  try {
    const parentSession = await options.sessionStore.load(session.parentSessionId);
    const runtime = (parentSession.taskRuntimes ?? []).find(
      (entry) => entry.id === session.runtimeTaskId,
    );
    const queuedCommand = runtime
      ? getQueuedTaskRuntimeCommands(runtime)[0]
      : undefined;

    if (runtime && queuedCommand) {
      const handledCommand = acknowledgeTaskRuntimeCommand(
        parentSession,
        runtime.id,
        queuedCommand.id,
        {
          handledBySessionId: session.id,
        },
      );
      if (handledCommand) {
        await options.sessionStore.save(parentSession);
      }
      const refreshedRuntime = (parentSession.taskRuntimes ?? []).find(
        (entry) => entry.id === runtime.id,
      ) ?? runtime;
      return {
        runtime: refreshedRuntime,
        command: handledCommand ?? queuedCommand,
        reason:
          handledCommand?.summary ??
          queuedCommand.summary ??
          refreshedRuntime.lastOutput ??
          'Parent queued a runtime command.',
      };
    }

    if (runtime?.status !== 'interrupted') {
      return undefined;
    }

    return {
      runtime,
      command: {
        id: `legacy-interrupt:${runtime.id}:${runtime.updatedAt}`,
        type: 'interrupt',
        state: 'acknowledged',
        createdAt: runtime.updatedAt,
        updatedAt: runtime.updatedAt,
        handledAt: runtime.updatedAt,
        handledBySessionId: session.id,
        summary: runtime.lastOutput,
      },
      reason:
        runtime.lastOutput ??
        'Runtime was interrupted by the parent control surface.',
    };
  } catch (error) {
    options.onInfo?.(
      `[agent] interrupt_poll_failed=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

function buildDelegatedRuntimeCommandMessage(signal: {
  runtime: TaskRuntimeRecord;
  command: TaskRuntimeCommandRecord;
  reason: string;
}): {
  toolName: string;
  content: string;
} {
  switch (signal.command.type) {
    case 'notify':
      return {
        toolName: 'runtime_command_notify',
        content: [
          'Runtime command:',
          `runtime=${signal.runtime.id}`,
          `command=${signal.command.id}`,
          `type=${signal.command.type}`,
          `summary=${signal.reason}`,
          'Parent note acknowledged. Continue execution with this context.',
        ].join('\n'),
      };
    case 'interrupt':
      return {
        toolName: 'runtime_interrupt',
        content: [
          'Runtime interrupt:',
          `runtime=${signal.runtime.id}`,
          `command=${signal.command.id}`,
          `reason=${signal.reason}`,
          'Stop this delegated child immediately and return control to the parent.',
        ].join('\n'),
      };
    default: {
      const exhaustive: never = signal.command.type;
      return exhaustive;
    }
  }
}

export async function processDelegatedRuntimeCommands(
  session: SessionRecord,
  options: RunAgentOptions,
): Promise<void> {
  for (;;) {
    const signal = await getNextDelegatedRuntimeCommandSignal(session, options);
    if (!signal) {
      return;
    }

    const message = buildDelegatedRuntimeCommandMessage(signal);
    options.onInfo?.(
      signal.command.type === 'interrupt'
        ? `[agent] runtime_interrupted id=${signal.runtime.id} command=${signal.command.id}`
        : `[agent] runtime_command type=${signal.command.type} id=${signal.runtime.id} command=${signal.command.id}`,
    );
    options.sessionStore.appendMessage(
      session,
      'tool',
      message.content,
      message.toolName,
    );
    await options.sessionStore.save(session);

    if (signal.command.type === 'interrupt') {
      throw new AgentRuntimeInterruptedError(
        signal.runtime.id,
        signal.reason,
      );
    }
  }
}

async function recordVerificationOutcome(
  session: SessionRecord,
  action: Extract<AgentAction, { type: 'run_command' }>,
  outcome: ActionOutcome,
  options: RunAgentOptions,
  profile: 'main' | AgentRole,
): Promise<void> {
  const title = outcome.ok
    ? 'Verification Command Passed'
    : 'Verification Command Failed';
  await recordWorkflowEntry(session, options, title, [
    `command=${action.command}`,
    `ok=${outcome.ok}`,
    `output=${truncate(outcome.output, 300)}`,
  ]);
  await options.sessionStore.upsertEvidenceClaim(session, {
    statement: deriveClaimStatement(
      `${outcome.ok ? 'Verification command passed' : 'Verification command failed'}: ${action.command}`,
    ),
    status: outcome.ok ? 'observed' : 'refuted',
    kind: 'result',
    sourceSessionId: session.id,
    sourceProfile: profile,
  });
}

async function handleVerificationReminder(
  session: SessionRecord,
  options: RunAgentOptions,
  state: VerificationState,
): Promise<void> {
  const suggestions = await getVerificationSuggestions(
    options.cwd,
    session.changedFiles ?? [],
  );
  const reminder = [
    state.pending ? buildVerificationReminder(suggestions) : null,
    state.taskNudgePending ? buildTaskVerificationNudge(session.tasks ?? []) : null,
  ]
    .filter(Boolean)
    .join('\n');
  options.sessionStore.appendMessage(session, 'user', reminder);
  await options.sessionStore.save(session);
  state.reminderSent = true;
  await recordWorkflowEntry(session, options, 'Verification Required', [
    suggestions.length > 0
      ? `suggestions=${suggestions.join(' | ')}`
      : 'suggestions=none_detected',
  ]);
  options.onInfo?.('[verification] reminder injected');
}

export type RunAgentOptions = {
  cwd: string;
  provider: ChatProvider;
  sessionStore: SessionStore;
  permissionManager: PermissionManager;
  maxTurns: number;
  rootRuntimeId?: string;
  profile?: 'main' | AgentRole;
  delegationDepth?: number;
  maxDelegationDepth?: number;
  appendUserMessage?: boolean;
  ensureSpecialistProvider?: (roles: AgentRole[]) => Promise<void>;
  resolveProvider?: (target: ProviderTarget) => ChatProvider;
  onInfo?: (message: string) => void;
  heimdallThreadState?: HeimdallThreadState;
  completionContract?: CompletionContract;
  /**
   * Images to attach to the first user turn.
   * Passed directly to the provider if it supports images.
   * Ignored on subsequent turns and by providers without supportsImages.
   */
  imageAttachments?: import('../providers/types.ts').ImageAttachment[];
  /**
   * Absolute file paths to reference images for the Nidhogg visual critic (Phase 2).
   * Forwarded to NidhoggConfig.images when the workflow mode is 'nidhogg'.
   */
  nidhoggImages?: string[];
  /**
   * Absolute file paths to reference videos for the Nidhogg video critic (Phase 3).
   * Forwarded to NidhoggConfig.videos when the workflow mode is 'nidhogg'.
   */
  nidhoggVideos?: string[];
  /**
   * Whether Hoder input enhancement is active for this GAN session.
   * Set by the GAN + Hoder activation gate before entering the Nidhogg workflow.
   */
  hoderEnabled?: boolean;
  /**
   * Active input protocol for this session.
   * 'hoder' = Hoder attachment anchor + role enhancement.
   * 'standard' = default multi-modal model behaviour.
   */
  inputProtocol?: 'hoder' | 'standard';
  onWorkspaceSwitchRequest?: (request: WorkspaceSwitchRequest) => Promise<boolean>;
  pollRunningUserMessages?: () => string[];
  onRunningUserMessageAccepted?: (text: string) => void;
};

function clampTurns(value: number): number {
  return Math.min(Math.max(value, 1), 50);
}

function compactTitle(input: string): string {
  const normalized = input.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 72) {
    return normalized;
  }
  return `${normalized.slice(0, 69)}...`;
}

type SpecialistRun = {
  role: AgentRole;
  session: SessionRecord;
  result: RunResult;
};

function buildBuilderProposalTask(task: string): string {
  return [
    `Parent delegated build task: ${task.trim()}`,
    '',
    'Current phase: proposal only.',
    '- Treat the delegated build task as your highest priority.',
    '- Investigate the code path, resolve ambiguity where possible, and form a concrete implementation plan.',
    '- Return the exact files you would change, the intended edits, and the primary risk.',
    '- Do not write files or run destructive commands in this phase.',
    '- Wait for explicit parent approval before execution.',
  ].join('\n');
}

function buildBuilderExecutionTask(
  task: string,
  summary?: string,
): string {
  return [
    'Parent approved execution for this builder task.',
    `Original task: ${task.trim()}`,
    summary ? `Approved guidance: ${summary.trim()}` : '',
    '',
    'Execution rules:',
    '- Implement the approved change now.',
    '- Keep edits precise and minimal.',
    '- If a blocking ambiguity remains, stop and explain it instead of guessing.',
  ]
    .filter(Boolean)
    .join('\n');
}

async function recordWorkflowEntry(
  session: SessionRecord,
  options: RunAgentOptions,
  title: string,
  lines: string[],
): Promise<void> {
  await options.sessionStore.appendWorkflowEntry(session, title, lines);
  options.onInfo?.(`[workflow] ${title}`);
}

async function syncSessionRecordInPlace(
  session: SessionRecord,
  sessionStore: SessionStore,
): Promise<SessionRecord> {
  const latest = await sessionStore.load(session.id);
  if (latest !== session) {
    Object.assign(session, latest);
  }
  return session;
}

async function recordDelegatedChildBinding(
  childSession: SessionRecord,
  parentSession: SessionRecord,
  options: RunAgentOptions,
  role: AgentRole,
  phase: AgentPhase,
): Promise<void> {
  const parentMode = options.permissionManager.getMode();
  const childMode = getDelegatedChildPermissionMode(role, parentMode, phase);
  await options.sessionStore.appendWorkflowEntry(
    childSession,
    'Delegated Child Runtime Bound',
    [
      `role=${role}`,
      `phase=${phase}`,
      `parent_session=${parentSession.id}`,
      `parent_permission_mode=${parentMode}`,
      `child_permission_mode=${childMode}`,
    ],
  );
  await recordHeimdallEvent(options.sessionStore, parentSession, {
    kind: 'delegate_bound',
    summary: `${role} child bound in ${phase} phase.`,
    runtimeId: childSession.runtimeTaskId,
    sessionId: parentSession.id,
    workerSessionId: childSession.id,
    role,
    phase,
    status: phase === 'proposal' ? 'waiting_approval' : 'running',
    metadata: {
      parent_session: parentSession.id,
      child_session: childSession.id,
      parent_permission_mode: parentMode,
      child_permission_mode: childMode,
    },
  });
}

export async function runBuilderProposalAgent(
  parentSession: SessionRecord,
  task: string,
  options: RunAgentOptions,
  overrides?: {
    title?: string;
    runtimeTaskId?: string;
    parentRuntimeId?: string;
  },
): Promise<SpecialistRun> {
  const delegationDepth = options.delegationDepth ?? 0;
  const maxDelegationDepth = options.maxDelegationDepth ?? 2;
  const managedByParent = Boolean(overrides?.runtimeTaskId);

  if (delegationDepth >= maxDelegationDepth) {
    throw new Error('Delegation depth limit reached at role=builder.');
  }

  let runtimeTaskId = overrides?.runtimeTaskId;
  if (!runtimeTaskId) {
    const runtime = createTaskRuntimeRecord({
      label: `[builder proposal] ${compactTitle(task)}`,
      parentId: overrides?.parentRuntimeId,
      role: 'builder',
      phase: 'proposal',
      status: 'running',
    });
    appendTaskRuntime(parentSession, runtime);
    await options.sessionStore.save(parentSession);
    runtimeTaskId = runtime.id;
  }

  const childSession = options.sessionStore.createSession({
    title: overrides?.title ?? `[builder] ${compactTitle(task)}`,
    kind: 'agent',
    parentSessionId: parentSession.id,
    rootSessionId: parentSession.rootSessionId ?? parentSession.id,
    runtimeTaskId,
    agentRole: 'builder',
    agentPhase: 'proposal',
    delegatedTask: task,
  });
  await options.sessionStore.save(childSession);

  await recordDelegatedChildBinding(
    childSession,
    parentSession,
    options,
    'builder',
    'proposal',
  );
  const childPermissionManager = createDelegatedChildPermissionManager(
    options.permissionManager,
    'builder',
    'proposal',
  );
  const childMaxTurns = clampTurns(Math.max(options.maxTurns, 15));

  options.onInfo?.('[agent:builder] proposal running');

  try {
    const result = await runAgent(
      childSession,
      buildBuilderProposalTask(task),
      {
        ...options,
        permissionManager: childPermissionManager,
        maxTurns: childMaxTurns,
        profile: 'builder',
        delegationDepth: delegationDepth + 1,
        maxDelegationDepth,
        appendUserMessage: true,
        onInfo: (message) => options.onInfo?.(`[agent:builder] ${message}`),
      },
    );

    await syncSessionRecordInPlace(parentSession, options.sessionStore);
    if (!managedByParent) {
      updateTaskRuntime(parentSession, runtimeTaskId, {
        workerSessionId: childSession.id,
        status: 'waiting_approval',
        lastOutput: result.reply,
      });
      await options.sessionStore.save(parentSession);
    }

    options.onInfo?.('[agent:builder] proposal done');

    return {
      role: 'builder',
      session: childSession,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = isAgentRuntimeInterruptedError(error);
    await syncSessionRecordInPlace(parentSession, options.sessionStore);
    if (!managedByParent) {
      updateTaskRuntime(parentSession, runtimeTaskId, {
        workerSessionId: childSession.id,
        status: interrupted ? 'interrupted' : 'failed',
        lastOutput: message,
      });
      await options.sessionStore.save(parentSession);
    }
    await recordHeimdallEvent(options.sessionStore, parentSession, {
      kind: 'delegate_completed',
      summary: interrupted
        ? 'Builder proposal interrupted.'
        : 'Builder proposal failed.',
      runtimeId: runtimeTaskId,
      sessionId: parentSession.id,
      workerSessionId: childSession.id,
      role: 'builder',
      phase: 'proposal',
      status: interrupted ? 'interrupted' : 'failed',
      metadata: {
        error: truncate(message, 220),
      },
    });
    throw error;
  }
}

export async function approveBuilderExecution(
  parentSession: SessionRecord,
  action: Extract<AgentAction, { type: 'approve_builder_execution' }>,
  options: RunAgentOptions,
): Promise<{ ok: boolean; output: string; error?: ToolError }> {
  let childSession: SessionRecord;
  try {
    childSession = await options.sessionStore.load(action.sessionId);
  } catch (error) {
    const message = `Builder session ${action.sessionId} was not found: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return buildRuntimeManagedFailure('builder_session_not_found', message, {
      retryable: false,
    });
  }

  if (childSession.parentSessionId !== parentSession.id) {
    return buildRuntimeManagedFailure(
      'builder_session_parent_mismatch',
      'Builder session does not belong to the active parent session.',
      {
        retryable: false,
        details: {
          requestedSessionId: action.sessionId,
          activeParentSessionId: parentSession.id,
          actualParentSessionId: childSession.parentSessionId,
        },
      },
    );
  }

  if (childSession.agentRole !== 'builder') {
    return buildRuntimeManagedFailure(
      'builder_session_role_mismatch',
      'approve_builder_execution only works with builder sessions.',
      {
        retryable: false,
        details: {
          requestedSessionId: action.sessionId,
          actualRole: childSession.agentRole,
        },
      },
    );
  }

  const delegatedTask = childSession.delegatedTask ?? childSession.title;
  const proposalText =
    [...childSession.messages]
      .reverse()
      .find((entry) => entry.role === 'assistant')?.content ?? delegatedTask;
  const proposalClaim = await options.sessionStore.upsertEvidenceClaim(
    parentSession,
    {
      statement: deriveClaimStatement(proposalText),
      status: 'inferred',
      kind: 'proposal',
      sourceSessionId: childSession.id,
      sourceProfile: 'builder',
    },
  );
  childSession.agentPhase = 'execution';
  await options.sessionStore.save(childSession);
  if (childSession.runtimeTaskId) {
    await syncSessionRecordInPlace(parentSession, options.sessionStore);
    updateTaskRuntime(parentSession, childSession.runtimeTaskId, {
      status: 'completed',
      workerSessionId: childSession.id,
      lastOutput: action.summary ?? 'Builder proposal approved for execution.',
    });
    await options.sessionStore.save(parentSession);
  }
  await recordDelegatedChildBinding(
    childSession,
    parentSession,
    options,
    'builder',
    'execution',
  );

  await recordWorkflowEntry(parentSession, options, 'Builder Execution Approved', [
    `builder_session=${childSession.id}`,
    `task=${delegatedTask}`,
    `approval=${action.summary ?? 'approved for execution'}`,
  ]);
  await recordHeimdallEvent(options.sessionStore, parentSession, {
    kind: 'approval_recorded',
    summary: 'Builder proposal approved for execution.',
    runtimeId: childSession.runtimeTaskId,
    sessionId: parentSession.id,
    workerSessionId: childSession.id,
    role: 'builder',
    phase: 'execution',
    status: 'running',
    metadata: {
      builder_session: childSession.id,
      task: truncate(delegatedTask, 180),
      approval: truncate(action.summary ?? 'approved for execution', 180),
    },
  });
  const approvalClaim = await options.sessionStore.upsertEvidenceClaim(
    parentSession,
    {
      statement: deriveClaimStatement(
        action.summary ?? 'Builder proposal approved for execution.',
      ),
      status: 'inferred',
      kind: 'decision',
      sourceSessionId: parentSession.id,
      sourceProfile: 'main',
    },
  );
  await options.sessionStore.addEvidenceEdge(
    parentSession,
    approvalClaim.id,
    proposalClaim.id,
    'supports',
  );
  const executionRuntime = createTaskRuntimeRecord({
    label: `[builder execution] ${compactTitle(delegatedTask)}`,
    parentId: childSession.runtimeTaskId,
    role: 'builder',
    phase: 'execution',
    workerSessionId: childSession.id,
    status: 'running',
  });
  appendTaskRuntime(parentSession, executionRuntime);
  await options.sessionStore.save(parentSession);

  let result;
  try {
    result = await runAgent(
      childSession,
      buildBuilderExecutionTask(delegatedTask, action.summary),
      {
        ...options,
        permissionManager: createDelegatedChildPermissionManager(
          options.permissionManager,
          'builder',
          'execution',
        ),
        maxTurns: clampTurns(action.maxTurns ?? Math.max(options.maxTurns, 15)),
        profile: 'builder',
        appendUserMessage: true,
        onInfo: (message) => options.onInfo?.(`[agent:builder] ${message}`),
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = isAgentRuntimeInterruptedError(error);
    await syncSessionRecordInPlace(parentSession, options.sessionStore);
    updateTaskRuntime(parentSession, executionRuntime.id, {
      status: interrupted ? 'interrupted' : 'failed',
      lastOutput: message,
    });
    await options.sessionStore.save(parentSession);
    return {
      ok: false,
      output: buildDelegatedChildPayload({
        role: 'builder',
        session: childSession,
        status: interrupted ? 'interrupted' : 'failed',
        phase: 'execution',
        summary: message,
      }),
      error: buildToolError(interrupted ? 'agent_child_interrupted' : 'agent_child_failed', message, {
        retryable: !interrupted,
      }),
    };
  }

  await syncSessionRecordInPlace(parentSession, options.sessionStore);
  await recordWorkflowEntry(parentSession, options, 'Builder Execution Completed', [
    `builder_session=${childSession.id}`,
    `turns=${result.turns}`,
    `result=${truncate(result.reply, 400)}`,
  ]);
  await recordHeimdallEvent(options.sessionStore, parentSession, {
    kind: 'delegate_completed',
    summary: 'Builder execution completed.',
    runtimeId: executionRuntime.id,
    sessionId: parentSession.id,
    workerSessionId: childSession.id,
    role: 'builder',
    phase: 'execution',
    status: 'completed',
    metadata: {
      turns: String(result.turns),
      result: truncate(result.reply, 220),
    },
  });
  const resultClaim = await options.sessionStore.upsertEvidenceClaim(
    parentSession,
    {
      statement: deriveClaimStatement(result.reply),
      status: 'observed',
      kind: 'result',
      sourceSessionId: childSession.id,
      sourceProfile: 'builder',
    },
  );
  await syncSessionRecordInPlace(parentSession, options.sessionStore);
  await options.sessionStore.addEvidenceEdge(
    parentSession,
    resultClaim.id,
    approvalClaim.id,
    'derived_from',
  );
  if ((childSession.changedFiles?.length ?? 0) > 0) {
    options.sessionStore.recordChangedFiles(
      parentSession,
      childSession.changedFiles ?? [],
    );
  }
  for (const command of childSession.verificationCommands ?? []) {
    options.sessionStore.recordVerificationCommand(
      parentSession,
      command.command,
      command.ok,
    );
  }
  updateTaskRuntime(parentSession, executionRuntime.id, {
    status: 'completed',
    lastOutput: result.reply,
  });
  await options.sessionStore.save(parentSession);

  return {
    ok: true,
    output: buildDelegatedChildPayload({
        role: 'builder',
        status: 'executed',
        phase: 'execution',
        session: childSession,
        turns: result.turns,
        summary: result.reply,
    }),
  };
}

export async function runSpecialistAgent(
  parentSession: SessionRecord,
  role: AgentRole,
  task: string,
  options: RunAgentOptions,
  overrides?: {
    title?: string;
    runtimeTaskId?: string;
    parentRuntimeId?: string;
  },
): Promise<SpecialistRun> {
  const delegationDepth = options.delegationDepth ?? 0;
  const maxDelegationDepth = options.maxDelegationDepth ?? 2;
  const managedByParent = Boolean(overrides?.runtimeTaskId);

  if (delegationDepth >= maxDelegationDepth) {
    throw new Error(`Delegation depth limit reached at role=${role}.`);
  }

  let runtimeTaskId = overrides?.runtimeTaskId;
  if (!runtimeTaskId) {
    const runtime = createTaskRuntimeRecord({
      label: `[${role}] ${compactTitle(task)}`,
      parentId: overrides?.parentRuntimeId,
      role,
      phase: 'execution',
      status: 'running',
    });
    appendTaskRuntime(parentSession, runtime);
    await options.sessionStore.save(parentSession);
    runtimeTaskId = runtime.id;
  }

  const childSession = options.sessionStore.createSession({
    title: overrides?.title ?? `[${role}] ${compactTitle(task)}`,
    kind: 'agent',
    parentSessionId: parentSession.id,
    rootSessionId: parentSession.rootSessionId ?? parentSession.id,
    runtimeTaskId,
    agentRole: role,
    delegatedTask: task,
  });
  await options.sessionStore.save(childSession);

  await recordDelegatedChildBinding(
    childSession,
    parentSession,
    options,
    role,
    'execution',
  );
  const childPermissionManager = createDelegatedChildPermissionManager(
    options.permissionManager,
    role,
    'execution',
  );
  const childMaxTurns = clampTurns(
    Math.max(options.maxTurns, 15),
  );

  options.onInfo?.(`[agent:${role}] running`);

  try {
    const result = await runAgent(childSession, task, {
      ...options,
      permissionManager: childPermissionManager,
      maxTurns: childMaxTurns,
      profile: role,
      delegationDepth: delegationDepth + 1,
      maxDelegationDepth,
      appendUserMessage: options.appendUserMessage ?? true,
      onInfo: (message) => options.onInfo?.(`[agent:${role}] ${message}`),
    });

    await syncSessionRecordInPlace(parentSession, options.sessionStore);
    if (!managedByParent) {
      updateTaskRuntime(parentSession, runtimeTaskId, {
        workerSessionId: childSession.id,
        status: 'completed',
        lastOutput: result.reply,
      });
      await options.sessionStore.save(parentSession);
    }
    await recordHeimdallEvent(options.sessionStore, parentSession, {
      kind: 'delegate_completed',
      summary: `${role} delegation completed.`,
      runtimeId: runtimeTaskId,
      sessionId: parentSession.id,
      workerSessionId: childSession.id,
      role,
      phase: 'execution',
      status: 'completed',
      metadata: {
        result: truncate(result.reply, 220),
        turns: String(result.turns),
      },
    });

    options.onInfo?.(`[agent:${role}] done`);

    return {
      role,
      session: childSession,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const interrupted = isAgentRuntimeInterruptedError(error);
    await syncSessionRecordInPlace(parentSession, options.sessionStore);
    if (!managedByParent) {
      updateTaskRuntime(parentSession, runtimeTaskId, {
        workerSessionId: childSession.id,
        status: interrupted ? 'interrupted' : 'failed',
        lastOutput: message,
      });
      await options.sessionStore.save(parentSession);
    }
    await recordHeimdallEvent(options.sessionStore, parentSession, {
      kind: 'delegate_completed',
      summary: interrupted
        ? `${role} delegation interrupted.`
        : `${role} delegation failed.`,
      runtimeId: runtimeTaskId,
      sessionId: parentSession.id,
      workerSessionId: childSession.id,
      role,
      phase: 'execution',
      status: interrupted ? 'interrupted' : 'failed',
      metadata: {
        error: truncate(message, 220),
      },
    });
    throw error;
  }
}

async function executeMcpToolAction(
  action: Extract<AgentAction, { type: 'mcp_call_tool' }>,
  options: RunAgentOptions,
): Promise<{ ok: boolean; output: string; error?: ToolError }> {
  const { store, data, server } = await loadMcpServerState(
    options.cwd,
    action.serverId,
  );

  if (!server) {
    const message = `Configured MCP server ${action.serverId} was not found.`;
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_server_not_found', message, {
        retryable: false,
      }),
    };
  }

  if (!server.enabled) {
    const message = `MCP server ${action.serverId} is disabled.`;
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_server_disabled', message, {
        retryable: false,
      }),
    };
  }

  try {
    const result = await callMcpServerTool({
      server,
      cwd: options.cwd,
      toolName: action.toolName,
      args: action.args,
      timeoutMs: action.timeoutMs,
    });
    const nextServer = applyMcpRuntimeSuccess({
      server: result.server,
      authState: result.authState,
      surface: result.surface,
      notes: [`Last MCP tool call succeeded: ${action.toolName}`],
    });
    await saveUpdatedMcpServer(store, data, nextServer);

    return {
      ok: true,
      output: result.output,
    };
  } catch (error) {
    // Dependency missing: stop immediately, surface install prompt to user
    if (error instanceof McpDependencyError) {
      const info = error.dependencyInfo;
      const prompt = formatDependencyPrompt(info, 'zh');

      // Auto-install npm packages silently if canAutoInstall
      if (info.canAutoInstall && info.requirement.kind === 'npm') {
        try {
          options.onInfo?.(`[mcp] installing ${info.requirement.package}...`);
          await installNpmMcpPackage(info.requirement.package);
          options.onInfo?.(`[mcp] ${info.requirement.package} installed, retrying...`);
          // Retry once after successful install
          const result = await callMcpServerTool({
            server,
            cwd: options.cwd,
            toolName: action.toolName,
            args: action.args,
            timeoutMs: action.timeoutMs,
          });
          return { ok: true, output: result.output };
        } catch {
          // Install failed — fall through to prompt
        }
      }

      return {
        ok: false,
        output: prompt,
        error: buildToolError('mcp_dependency_missing', prompt, {
          retryable: false,
          details: {
            serverId: info.serverId,
            requirementKind: info.requirement.kind,
            canAutoInstall: info.canAutoInstall,
          },
        }),
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    const latestData = await store.load();
    const latestServer =
      latestData.servers.find((entry) => entry.id === server.id) ?? server;
    const nextServer = applyMcpRuntimeFailure({
      server: latestServer,
      authState: getSuggestedMcpAuthState(latestServer, error),
      message,
    });
    await saveUpdatedMcpServer(store, latestData, nextServer);
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_tool_call_failed', message, {
        retryable: true,
      }),
    };
  }
}

async function executeMcpReadResourceAction(
  action: Extract<AgentAction, { type: 'mcp_read_resource' }>,
  options: RunAgentOptions,
): Promise<{ ok: boolean; output: string; error?: ToolError }> {
  const { store, data, server } = await loadMcpServerState(
    options.cwd,
    action.serverId,
  );

  if (!server) {
    const message = `Configured MCP server ${action.serverId} was not found.`;
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_server_not_found', message, {
        retryable: false,
      }),
    };
  }

  if (!server.enabled) {
    const message = `MCP server ${action.serverId} is disabled.`;
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_server_disabled', message, {
        retryable: false,
      }),
    };
  }

  try {
    const result = await readMcpServerResource({
      server,
      cwd: options.cwd,
      uri: action.uri,
      timeoutMs: action.timeoutMs,
    });
    const nextServer = applyMcpRuntimeSuccess({
      server: result.server,
      authState: result.authState,
      surface: result.surface,
      notes: [`Last MCP resource read succeeded: ${action.uri}`],
    });
    await saveUpdatedMcpServer(store, data, nextServer);

    return {
      ok: true,
      output: result.output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latestData = await store.load();
    const latestServer =
      latestData.servers.find((entry) => entry.id === server.id) ?? server;
    const nextServer = applyMcpRuntimeFailure({
      server: latestServer,
      authState: getSuggestedMcpAuthState(latestServer, error),
      message,
    });
    await saveUpdatedMcpServer(store, latestData, nextServer);
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_read_resource_failed', message, {
        retryable: true,
      }),
    };
  }
}

async function executeMcpGetPromptAction(
  action: Extract<AgentAction, { type: 'mcp_get_prompt' }>,
  options: RunAgentOptions,
): Promise<{ ok: boolean; output: string; error?: ToolError }> {
  const { store, data, server } = await loadMcpServerState(
    options.cwd,
    action.serverId,
  );

  if (!server) {
    const message = `Configured MCP server ${action.serverId} was not found.`;
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_server_not_found', message, {
        retryable: false,
      }),
    };
  }

  if (!server.enabled) {
    const message = `MCP server ${action.serverId} is disabled.`;
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_server_disabled', message, {
        retryable: false,
      }),
    };
  }

  try {
    const result = await getMcpServerPrompt({
      server,
      cwd: options.cwd,
      promptName: action.promptName,
      args: action.args,
      timeoutMs: action.timeoutMs,
    });
    const nextServer = applyMcpRuntimeSuccess({
      server: result.server,
      authState: result.authState,
      surface: result.surface,
      notes: [`Last MCP prompt retrieval succeeded: ${action.promptName}`],
    });
    await saveUpdatedMcpServer(store, data, nextServer);

    return {
      ok: true,
      output: result.output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const latestData = await store.load();
    const latestServer =
      latestData.servers.find((entry) => entry.id === server.id) ?? server;
    const nextServer = applyMcpRuntimeFailure({
      server: latestServer,
      authState: getSuggestedMcpAuthState(latestServer, error),
      message,
    });
    await saveUpdatedMcpServer(store, latestData, nextServer);
    return {
      ok: false,
      output: message,
      error: buildToolError('mcp_get_prompt_failed', message, {
        retryable: true,
      }),
    };
  }
}

function mapPermissionModeForToolContext(
  mode: ReturnType<PermissionManager['getMode']>,
): 'ask' | 'accept-all' | 'read' | 'write' {
  switch (mode) {
    case 'PRODUCER':
    case 'accept-all':
      return 'accept-all';
    case 'WRITER':
    case 'accept-edits':
      return 'write';
    case 'read-only':
      return 'read';
    case 'GHOSTWRITER':
    case 'prompt':
    default:
      return 'ask';
  }
}

async function executeAgentAction(
  session: SessionRecord,
  action: AgentAction,
  options: RunAgentOptions,
): Promise<{ action?: AgentAction; ok: boolean; output: string; error?: ToolError }> {
  const tool = getToolDefinition(action.type);
  const validationErrors = validateToolAction(action);

  if (validationErrors.length > 0) {
    const message = [
      `Invalid arguments for tool ${action.type}:`,
      ...validationErrors.map((error) => `- ${error}`),
    ].join('\n');
    return {
      ok: false,
      output: message,
      error: buildToolError('tool_invalid_arguments', message, {
        retryable: true,
        details: {
          errors: validationErrors,
        },
      }),
    };
  }

  if (tool?.execute) {
    const result = await withRuntimeLogSink(
      (entry) => {
        options.onInfo?.(`[log:${entry.level}] ${entry.message}`);
      },
      () => executeAction(action, {
        cwd: options.cwd,
        updateCwd: async (newCwd) => {
          options.cwd = newCwd;
          session.cwd = newCwd;
        },
        requestWorkspaceSwitch: options.onWorkspaceSwitchRequest,
        permissionMode: mapPermissionModeForToolContext(
          options.permissionManager.getMode(),
        ),
        sessionId: session.id,
        context: {
          profile: options.profile ?? 'main',
          runtimeId: options.rootRuntimeId,
          heimdallThreadState: options.heimdallThreadState,
        },
      }),
    );
    return {
      action: result.action,
      ok: result.ok,
      output: result.output,
      error: result.error,
    };
  }

  switch (action.type) {
    case 'mcp_call_tool':
      return executeMcpToolAction(action, options);
    case 'mcp_read_resource':
      return executeMcpReadResourceAction(action, options);
    case 'mcp_get_prompt':
      return executeMcpGetPromptAction(action, options);
    case 'approve_builder_execution':
      return approveBuilderExecution(session, action, options);
    case 'spawn_background_workflow': {
      try {
        const { spawnDetachedWorkflow } = await import('../services/detachedWorkflow.js');
        const result = await spawnDetachedWorkflow({
          cwd: options.cwd,
          sessionStore: options.sessionStore,
          prompt: action.prompt,
          command: action.command,
          maxTurns: action.maxTurns ?? options.maxTurns,
          permissionMode: options.permissionManager.getMode() as any,
          permissionModeExplicit: false,
          providerConfig: {
            protocol: (process.env.ARTEMIS_PROVIDER_PROTOCOL || 'openai') as any,
            model: process.env.ARTEMIS_MODEL || 'gpt-4o',
            baseUrl: process.env.ARTEMIS_BASE_URL || '',
            apiKey: process.env.ARTEMIS_API_KEY || ''
          },
        });
        return {
          ok: true,
          output: `🟢 Background workflow spawned successfully!
Workflow Mode: ${result.workflow}
Session ID: ${result.sessionId}
Runtime ID: ${result.runtimeId}
Process ID: ${result.processId}
Log Path: ${result.logPath}

You can continue executing your current tasks. The background workflow will run independently. To check its status, you can read the log file anytime.`,
        };
      } catch (error) {
        const message = `Background workflow spawn failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return buildRuntimeManagedFailure(
          'spawn_background_workflow_failed',
          message,
          {
            retryable: true,
          },
        );
      }
    }
    case 'request_freya_visual_asset': {
      try {
        const { showFreyaMenu } = await import('../cli/freyaPrompt.js')
        const { FreyaVisualAgent } = await import('../agents/freyaAgent.js')
        const { FreyaSearch } = await import('../tools/visual/freyaSearch.js')
        const { ProviderStore } = await import('../providers/store.js')

        // Get current visual model config
        const providerStore = new ProviderStore(options.cwd)
        const storeData = await providerStore.load()
        const visualConfig = providerStore.getVisualProfile(storeData)

        // Show Freya menu and get user choice
        const menuResult = await showFreyaMenu(action, undefined, 'en', {
          messages: session.messages,
          astState: {},
          taskContext: {}
        })

        switch (menuResult.assetPath) {
          case 'configure':
            options.onInfo?.('[log:info] ✅ Freya: 会话已成功挂起。请运行 /config visual（或命令行 artemis config visual）配置视觉模型，然后重新启动会话以恢复任务。')
            process.exit(0)
            
          case 'generate':
            if (!visualConfig?.enabled) {
              options.onInfo?.('[log:warn] ⚠️ Freya: 视觉模型尚未配置。请运行 /config visual（或 artemis config visual）进行配置。')
              return buildRuntimeManagedFailure(
                'freya_visual_model_not_configured',
                'Visual model not configured. Please run /config visual (or artemis config visual) first.',
                {
                  retryable: false,
                },
              );
            }

            const agent = new FreyaVisualAgent(visualConfig)
            const expandedPrompt = await agent.expandPrompt(action.contextDescription, action.assetType)
            const generationResult = await agent.generateAsset(expandedPrompt, action.assetType)
            
            if (generationResult.success && generationResult.assetPath) {
              return {
                ok: true,
                output: `Visual asset generated successfully: ${generationResult.assetPath}`
              }
            }
            return buildRuntimeManagedFailure(
              'freya_visual_generation_failed',
              `Visual asset generation failed: ${generationResult.error ?? 'unknown error'}`,
              {
                retryable: true,
              },
            );

          case 'search': {
            const expandedSearchPrompt = await (new FreyaVisualAgent(visualConfig || {
              enabled: false,
              image: {
                provider: 'mock',
                apiKey: '',
                baseUrl: '',
                model: 'mock',
                defaultParams: {
                  size: '2K',
                  quality: 'standard',
                  style: 'realistic',
                  watermark: false
                }
              },
              video: {
                enabled: false,
                provider: 'mock',
                apiKey: '',
                baseUrl: '',
                model: 'mock',
                defaultParams: {
                  duration: '10s',
                  resolution: '1080p',
                  quality: 'standard',
                  style: 'realistic',
                  format: 'mp4',
                  framerate: '30fps'
                }
              }
            })).expandPrompt(action.contextDescription, action.assetType)

            const searchDestPath = `.artemis/assets/searched_${Date.now()}.${action.assetType === 'video' ? 'mp4' : 'png'}`
            const searchResult = await FreyaSearch.deepSearchSimilarImage(expandedSearchPrompt, searchDestPath)
            
            if (searchResult.success && searchResult.downloadedPath) {
              return {
                ok: true,
                output: `Visual asset searched and downloaded successfully: ${searchResult.downloadedPath}`
              }
            }
            return buildRuntimeManagedFailure(
              'freya_visual_search_failed',
              `Visual asset search failed: ${searchResult.error ?? 'unknown error'}`,
              {
                retryable: true,
              },
            );
          }

          case 'cancel':
          default:
            return {
              ok: true,
              output: 'User cancelled visual generation. Please continue without the visual asset.'
            }
        }
      } catch (error) {
        const message = `Freya visual asset request failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        return buildRuntimeManagedFailure('freya_visual_asset_failed', message, {
          retryable: true,
        });
      }
    }
    case 'delegate_task':
      if (action.role === 'builder') {
        await recordWorkflowEntry(session, options, 'Builder Task Assigned', [
          `role=${action.role}`,
          `task=${action.task}`,
        ]);

        let builderProposal: SpecialistRun;
        try {
          builderProposal = await runBuilderProposalAgent(
            session,
            action.task,
            {
              ...options,
              maxTurns: clampTurns(action.maxTurns ?? Math.max(options.maxTurns, 15)),
            },
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const interrupted = isAgentRuntimeInterruptedError(error);
          await recordWorkflowEntry(session, options, 'Builder Proposal Failed', [
            `task=${action.task}`,
            `error=${truncate(message, 400)}`,
          ]);
          return {
            ok: false,
            output: buildDelegatedChildPayload({
              role: 'builder',
              status: interrupted ? 'interrupted' : 'failed',
              phase: 'proposal',
              summary: message,
            }),
            error: buildToolError(interrupted ? 'agent_child_interrupted' : 'agent_child_failed', message, {
              retryable: !interrupted,
            }),
          };
        }

        await recordWorkflowEntry(session, options, 'Builder Proposal Returned', [
          `builder_session=${builderProposal.session.id}`,
          `task=${action.task}`,
          `proposal=${truncate(builderProposal.result.reply, 600)}`,
        ]);
        await options.sessionStore.upsertEvidenceClaim(session, {
          statement: deriveClaimStatement(builderProposal.result.reply),
          status: 'inferred',
          kind: 'proposal',
          sourceSessionId: builderProposal.session.id,
          sourceProfile: 'builder',
        });

        return {
          ok: true,
          output: buildDelegatedChildPayload({
              role: builderProposal.role,
              session: builderProposal.session,
              status: 'approval_required',
              phase: 'proposal',
              turns: builderProposal.result.turns,
              summary: builderProposal.result.reply,
              guidance:
                'Review the builder proposal, record your decision, and use approve_builder_execution only if the plan is sound.',
              nextAction: {
                type: 'approve_builder_execution',
                sessionId: builderProposal.session.id,
              },
          }),
        };
      }

      await recordWorkflowEntry(session, options, 'Specialist Task Assigned', [
        `role=${action.role}`,
        `task=${action.task}`,
      ]);

      let specialist: SpecialistRun;
      try {
        specialist = await runSpecialistAgent(
          session,
          action.role,
          action.task,
          {
            ...options,
            maxTurns: clampTurns(action.maxTurns ?? Math.max(options.maxTurns, 15)),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const interrupted = isAgentRuntimeInterruptedError(error);
        await recordWorkflowEntry(session, options, 'Specialist Task Failed', [
          `role=${action.role}`,
          `task=${action.task}`,
          `error=${truncate(message, 400)}`,
        ]);
        return {
          ok: false,
          output: buildDelegatedChildPayload({
            role: action.role,
            status: interrupted ? 'interrupted' : 'failed',
            phase: 'execution',
            summary: message,
          }),
          error: buildToolError(interrupted ? 'agent_child_interrupted' : 'agent_child_failed', message, {
            retryable: !interrupted,
          }),
        };
      }

      await recordWorkflowEntry(session, options, 'Specialist Task Completed', [
        `role=${specialist.role}`,
        `session=${specialist.session.id}`,
        `turns=${specialist.result.turns}`,
        `reply=${truncate(specialist.result.reply, 400)}`,
      ]);

      return {
        ok: true,
        output: buildDelegatedChildPayload({
            role: specialist.role,
            session: specialist.session,
            status: 'completed',
            phase: 'execution',
            turns: specialist.result.turns,
            summary: specialist.result.reply,
        }),
      };
    case 'odin_search_skills':
      return executeOdinSearchSkills({
        cwd: options.cwd,
        query: action.query,
        scope: action.scope,
        limit: action.limit,
      });
    case 'odin_execute_task': {
      const skillContext = await resolveOdinSkillContext({
        cwd: options.cwd,
        task: action.task,
        scope: action.searchScope,
      });
      const taskWithContext = skillContext
        ? `${action.task}\n\n${skillContext}`
        : action.task;
      let specialist;
      try {
        specialist = await runSpecialistAgent(
          session,
          'researcher',
          taskWithContext,
          {
            ...options,
            maxTurns: clampTurns(
              action.maxIterations ?? Math.max(options.maxTurns, 15),
            ),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await recordOdinWorkflowFailure({
          cwd: options.cwd,
          mode: 'direct',
          prompt: action.task,
          error: message,
        });
        return buildRuntimeManagedFailure(
          'odin_execute_task_failed',
          `Odin task execution failed: ${message}`,
          {
            retryable: true,
          },
        );
      }
      await recordOdinWorkflowSuccess({
        cwd: options.cwd,
        mode: 'direct',
        prompt: action.task,
        reply: specialist.result.reply,
        turns: specialist.result.turns,
      });
      return {
        ok: true,
        output: JSON.stringify(
          {
            reply: specialist.result.reply,
            sessionId: specialist.session.id,
            turns: specialist.result.turns,
          },
          null,
          2,
        ),
      };
    }
    case 'odin_fix_skill':
      return executeOdinFixSkill({
        cwd: options.cwd,
        skillId: action.skillId,
        errorContext: action.errorContext,
        summary: action.summary,
      });
    case 'odin_upload_skill':
      return executeOdinUploadSkill({
        cwd: options.cwd,
        skillId: action.skillId,
        visibility: action.visibility,
        notes: action.notes,
      });
    case 'odin_import_cloud_skills':
      return importOdinCloudSkills({
        cwd: options.cwd,
        query: action.query,
        limit: action.limit,
      });
    default:
      const message = [
        `Tool ${action.type} is marked as runtime-managed but has no runtime handler.`,
        'Add a handler in executeAgentAction before enabling this tool in the registry.',
      ].join('\n');
      return {
        ok: false,
        output: message,
        error: buildToolError('tool_missing_runtime_handler', message, {
          retryable: false,
        }),
      };
  }
}

type ActionOutcome = {
  action: AgentAction;
  ok: boolean;
  output: string;
  error?: ToolError;
};

type DelegatedChildStatus =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'interrupted'
  | 'approval_required'
  | 'executed';

function buildDelegatedChildPayload(input: {
  role: AgentRole;
  session?: SessionRecord;
  status: DelegatedChildStatus;
  summary: string;
  turns?: number;
  phase?: AgentPhase;
  guidance?: string;
  nextRecommendedActions?: unknown[];
  nextAction?: unknown;
}): string {
  return JSON.stringify(
    {
      role: input.role,
      ...(input.session ? { sessionId: input.session.id } : {}),
      status: input.status,
      ...(input.phase ? { phase: input.phase } : {}),
      ...(typeof input.turns === 'number' ? { turns: input.turns } : {}),
      changedFiles: input.session?.changedFiles ?? [],
      verificationCommands: input.session?.verificationCommands ?? [],
      summary: input.summary,
      nextRecommendedActions: input.nextRecommendedActions ?? [],
      ...(input.guidance ? { guidance: input.guidance } : {}),
      ...(input.nextAction ? { nextAction: input.nextAction } : {}),
    },
    null,
    2,
  );
}

function buildHeimdallActionMetadata(
  action: AgentAction,
): Record<string, string | undefined> {
  switch (action.type) {
    case 'write_file':
    case 'read_file':
    case 'insert_in_file':
      return {
        action_type: action.type,
        path: action.path,
      };
    case 'run_command':
      return {
        action_type: action.type,
        command: truncate(action.command, 120),
      };
    case 'mcp_call_tool':
      return {
        action_type: action.type,
        server_id: action.serverId,
        tool_name: action.toolName,
      };
    case 'mcp_read_resource':
      return {
        action_type: action.type,
        server_id: action.serverId,
        uri: action.uri,
      };
    case 'mcp_get_prompt':
      return {
        action_type: action.type,
        server_id: action.serverId,
        prompt_name: action.promptName,
      };
    case 'delegate_task':
      return {
        action_type: action.type,
        role: action.role,
        task: truncate(action.task, 120),
      };
    case 'approve_builder_execution':
      return {
        action_type: action.type,
        session_id: action.sessionId,
      };
    default:
      return {
        action_type: action.type,
      };
  }
}

function buildHeimdallActionSummary(
  kind:
    | 'action_authorized'
    | 'action_denied'
    | 'action_started'
    | 'action_completed'
    | 'action_failed',
  action: AgentAction,
): string {
  const target =
    action.type === 'mcp_call_tool'
      ? `${action.serverId}/${action.toolName}`
      : action.type === 'mcp_read_resource'
        ? `${action.serverId}/${action.uri}`
        : action.type === 'mcp_get_prompt'
          ? `${action.serverId}/${action.promptName}`
          : action.type === 'delegate_task'
            ? `${action.role}:${truncate(action.task, 80)}`
            : action.type === 'approve_builder_execution'
              ? action.sessionId
              : 'path' in action && typeof action.path === 'string'
                ? action.path
                : 'command' in action && typeof action.command === 'string'
                  ? truncate(action.command, 80)
                  : action.type;

  switch (kind) {
    case 'action_authorized':
      return `Heimdall authorized ${action.type} :: ${target}`;
    case 'action_denied':
      return `Heimdall denied ${action.type} :: ${target}`;
    case 'action_started':
      return `Heimdall started ${action.type} :: ${target}`;
    case 'action_completed':
      return `Heimdall completed ${action.type} :: ${target}`;
    case 'action_failed':
      return `Heimdall failed ${action.type} :: ${target}`;
  }
}

async function recordHeimdallActionEvent(
  session: SessionRecord,
  options: RunAgentOptions,
  kind:
    | 'action_authorized'
    | 'action_denied'
    | 'action_started'
    | 'action_completed'
    | 'action_failed',
  action: AgentAction,
  extraMetadata?: Record<string, string | undefined>,
): Promise<void> {
  await recordHeimdallEvent(options.sessionStore, session, {
    kind,
    summary: buildHeimdallActionSummary(kind, action),
    sessionId: session.id,
    role: options.profile && options.profile !== 'main' ? options.profile : undefined,
    status:
      kind === 'action_denied' || kind === 'action_failed'
        ? 'failed'
        : kind === 'action_completed'
          ? 'completed'
          : 'running',
    metadata: {
      ...buildHeimdallActionMetadata(action),
      ...extraMetadata,
    },
  });
}

function buildGuardrailFailureOutcome(
  action: AgentAction,
  error: unknown,
): ActionOutcome {
  const message = error instanceof Error ? error.message : String(error);
  const output = `Guardrail failure: ${message}`;

  return {
    action,
    ok: false,
    output,
    error: buildToolError('tool_guardrail_failure', message, {
      retryable: false,
    }),
  };
}

/**
 * Decide whether an action should run in the background (fire-and-forget),
 * letting the agent loop continue with other work while the slow tool
 * progresses asynchronously. Completion is delivered as a `system` message in
 * a later turn.
 *
 * Conservative whitelist — only tools that:
 *   (a) routinely take >10s to complete,
 *   (b) produce a self-contained artifact (file path / text result), and
 *   (c) the model is unlikely to need to gate the *current* turn on,
 * are eligible. Adding more types here is a deliberate decision per tool.
 */
function isBackgroundEligibleAction(action: AgentAction): boolean {
  if ((action as { runInBackground?: unknown }).runInBackground !== true) {
    return false;
  }
  if (action.type === 'generate_image' || action.type === 'generate_video') {
    return true;
  }
  if (action.type === 'delegate_task') {
    const tool = getToolDefinition(action.type);
    return tool?.parallelSafe === true;
  }
  return false;
}

function describeBackgroundTaskLabel(action: AgentAction): string {
  if (action.type === 'generate_image' || action.type === 'generate_video') {
    const promptText =
      typeof (action as { prompt?: unknown }).prompt === 'string'
        ? truncate((action as { prompt: string }).prompt, 60)
        : '(no prompt)';
    const noun = action.type === 'generate_image' ? 'image' : 'video';
    return `${noun}: ${promptText}`;
  }
  if (action.type === 'delegate_task') {
    const role = typeof action.role === 'string' ? action.role : 'agent';
    const taskText =
      typeof action.task === 'string' ? truncate(action.task, 60) : 'task';
    return `delegate(${role}): ${taskText}`;
  }
  return action.type;
}

/**
 * Fork a background-eligible action into the registry and synthesize an
 * immediate "started" outcome so the agent loop can proceed. The real result
 * is appended to the session as a `system` message when the runner resolves.
 */
function startBackgroundAction(
  session: SessionRecord,
  hydratedAction: AgentAction,
  options: RunAgentOptions,
): ActionOutcome {
  const registry = getBackgroundTaskRegistry();
  const kind = hydratedAction.type as BackgroundTaskKind;
  const label = describeBackgroundTaskLabel(hydratedAction);

  const taskId = registry.start({
    kind,
    label,
    runner: () => executeAgentAction(session, hydratedAction, options),
    isFailureResult: (result) => result.ok !== true,
    onComplete: async (result, record) => {
      const elapsedSec = Math.max(
        1,
        Math.floor(
          ((record.completedAtMs ?? Date.now()) - record.startedAtMs) / 1000,
        ),
      );
      const outputExcerpt = truncate(result.output ?? '', 600);
      const tag = result.ok ? '完成' : '失败';
      const message =
        `[background_task ${record.id}] ${kind} ${tag}（耗时 ${elapsedSec}s）\n` +
        outputExcerpt;
      try {
        options.sessionStore.appendMessage(session, 'system', message);
        await options.sessionStore.save(session);
      } catch {
        /* best-effort */
      }
      options.onInfo?.(
        `[background] ${kind} ${record.id} ${result.ok ? 'ok' : 'failed'} in ${elapsedSec}s`,
      );
      try {
        await recordHeimdallActionEvent(
          session,
          options,
          result.ok ? 'action_completed' : 'action_failed',
          hydratedAction,
          {
            background_task_id: record.id,
            elapsed_sec: String(elapsedSec),
            result_ok: String(result.ok),
            output_excerpt: truncate(result.output ?? '', 160),
          },
        );
      } catch {
        /* heimdall failures must never break the foreground flow */
      }
    },
    onError: async (error, record) => {
      const elapsedSec = Math.max(
        1,
        Math.floor(
          ((record.completedAtMs ?? Date.now()) - record.startedAtMs) / 1000,
        ),
      );
      const message =
        `[background_task ${record.id}] ${kind} 异常（耗时 ${elapsedSec}s）\n` +
        truncate(error.message, 600);
      try {
        options.sessionStore.appendMessage(session, 'system', message);
        await options.sessionStore.save(session);
      } catch {
        /* best-effort */
      }
      options.onInfo?.(
        `[background] ${kind} ${record.id} threw: ${error.message}`,
      );
      try {
        await recordHeimdallActionEvent(
          session,
          options,
          'action_failed',
          hydratedAction,
          {
            background_task_id: record.id,
            elapsed_sec: String(elapsedSec),
            error: truncate(error.message, 160),
          },
        );
      } catch {
        /* swallow */
      }
    },
  });

  options.onInfo?.(
    `[background] ${kind} ${taskId} started: ${label}`,
  );

  const startedNotice =
    `Background task started.\n` +
    `task_id: ${taskId}\n` +
    `kind: ${kind}\n` +
    `label: ${label}\n\n` +
    `这个工具已经在后台启动；你不需要等它完成。请继续做其它工作（例如调用其它工具、规划下一步、或者答复用户）。\n` +
    `任务完成后，结果会以一条独立的 [background_task ${taskId}] system 消息出现在后续 turn 的上下文里。届时再读取并使用结果。`;

  return {
    action: hydratedAction,
    ok: true,
    output: startedNotice,
  };
}

async function executeAuthorizedAction(
  session: SessionRecord,
  action: AgentAction,
  options: RunAgentOptions,
  preAuthorized = false,
): Promise<ActionOutcome> {
  try {
    const hydratedAction = await hydrateRuntimeManagedAction(action, options.cwd);
    const profile = options.profile ?? 'main';
    const profilePolicy = validateProfileAction(profile, hydratedAction);
    if (!profilePolicy.allowed) {
      options.onInfo?.(`[tool:${hydratedAction.type}] blocked by profile policy`);
      await recordHeimdallActionEvent(
        session,
        options,
        'action_denied',
        hydratedAction,
        {
          reason:
            profilePolicy.reason ?? 'runtime policy denied the requested action.',
          denied_by: 'profile_policy',
        },
      );
      const message = `Action blocked for profile ${profile}: ${profilePolicy.reason ?? 'runtime policy denied the requested action.'}`;
      return {
        action: hydratedAction,
        ok: false,
        output: message,
        error: buildToolError('tool_profile_blocked', message, {
          retryable: false,
        }),
      };
    }

    if (!preAuthorized) {
      const decision = await options.permissionManager.authorize(hydratedAction);
      if (!decision.allowed) {
        options.onInfo?.(`[tool:${hydratedAction.type}] denied`);
        await recordHeimdallActionEvent(
          session,
          options,
          'action_denied',
          hydratedAction,
          {
            reason: decision.reason,
            denied_by: 'permission_manager',
          },
        );
        const message = `Permission denied: ${decision.reason}`;
        return {
          action: hydratedAction,
          ok: false,
          output: message,
          error: buildToolError('tool_permission_denied', message, {
            retryable: false,
          }),
        };
      }

      await recordHeimdallActionEvent(
        session,
        options,
        'action_authorized',
        hydratedAction,
        {
          authorized_by: 'permission_manager',
        },
      );
    }

    options.onInfo?.(`[tool:${hydratedAction.type}] running`);
    await recordHeimdallActionEvent(
      session,
      options,
      'action_started',
      hydratedAction,
      {
        pre_authorized: String(preAuthorized),
      },
    );

    // Background dispatch for slow, self-contained tools — see
    // isBackgroundEligibleAction. The real runner is detached; we return
    // immediately so the foreground turn can proceed in parallel.
    if (isBackgroundEligibleAction(hydratedAction)) {
      return startBackgroundAction(session, hydratedAction, options);
    }

    const result = await executeAgentAction(session, hydratedAction, options);
    const completedAction = result.action ?? hydratedAction;
    let actionArtifactPath: string | undefined;
    if (options.heimdallThreadState) {
      try {
        const actionArtifact = await persistHeimdallActionArtifact({
          state: options.heimdallThreadState,
          session,
          action: completedAction,
          ok: result.ok,
          output: result.output,
        });
        actionArtifactPath = actionArtifact?.path;
      } catch (artifactError) {
        options.onInfo?.(
          `[tool:${hydratedAction.type}] heimdall_artifact_error=${
            artifactError instanceof Error
              ? artifactError.message
              : String(artifactError)
          }`,
        );
      }
    }
    {
      const uiPayload = buildToolUiPayload(
        completedAction,
        result.ok,
        result.output ?? '',
      );
      options.onInfo?.(
        `[tool:${hydratedAction.type}] ${result.ok ? 'ok' : 'failed'} ${JSON.stringify(uiPayload)}`,
      );
    }
    await recordHeimdallActionEvent(
      session,
      options,
      result.ok ? 'action_completed' : 'action_failed',
      completedAction,
      {
        ...(actionArtifactPath ? { artifact_path: actionArtifactPath } : {}),
        result_ok: String(result.ok),
        output_excerpt: truncate(result.output, 160),
      },
    );
    return classifyActionOutcomeFailure({
      action: completedAction,
      ok: result.ok,
      output: result.output,
      error: result.error,
    });
  } catch (error) {
    options.onInfo?.(`[tool:${action.type}] error`);
    await recordHeimdallActionEvent(
      session,
      options,
      'action_failed',
      action,
      {
        error:
          error instanceof Error ? truncate(error.message, 160) : truncate(String(error), 160),
      },
    );
    return buildGuardrailFailureOutcome(action, error);
  }
}

async function resolveActionPermissions<TAction extends AgentAction>(
  session: SessionRecord,
  actions: TAction[],
  options: RunAgentOptions,
): Promise<{
  allowed: TAction[];
  denied: ActionOutcome[];
}> {
  const allowed: TAction[] = [];
  const denied: ActionOutcome[] = [];
  const profile = options.profile ?? 'main';

  for (const action of actions) {
    const hydratedAction = await hydrateRuntimeManagedAction(action, options.cwd);
    const profilePolicy = validateProfileAction(profile, hydratedAction);
    if (!profilePolicy.allowed) {
      options.onInfo?.(`[tool:${hydratedAction.type}] blocked by profile policy`);
      await recordHeimdallActionEvent(
        session,
        options,
        'action_denied',
        hydratedAction,
        {
          reason:
            profilePolicy.reason ?? 'runtime policy denied the requested action.',
          denied_by: 'profile_policy',
        },
      );
      const message = `Action blocked for profile ${profile}: ${profilePolicy.reason ?? 'runtime policy denied the requested action.'}`;
      denied.push({
        action: hydratedAction,
        ok: false,
        output: message,
        error: buildToolError('tool_profile_blocked', message, {
          retryable: false,
        }),
      });
      continue;
    }

    try {
      const decision = await options.permissionManager.authorize(hydratedAction);
      if (!decision.allowed) {
        options.onInfo?.(`[tool:${hydratedAction.type}] denied`);
        await recordHeimdallActionEvent(
          session,
          options,
          'action_denied',
          hydratedAction,
          {
            reason: decision.reason,
            denied_by: 'permission_manager',
          },
        );
        const message = `Permission denied: ${decision.reason}`;
        denied.push({
          action: hydratedAction,
          ok: false,
          output: message,
          error: buildToolError('tool_permission_denied', message, {
            retryable: false,
          }),
        });
        continue;
      }

      await recordHeimdallActionEvent(
        session,
        options,
        'action_authorized',
        hydratedAction,
        {
          authorized_by: 'permission_manager',
        },
      );
      allowed.push(hydratedAction as TAction);
    } catch (error) {
      options.onInfo?.(`[tool:${hydratedAction.type}] authorize_error`);
      await recordHeimdallActionEvent(
        session,
        options,
        'action_failed',
        hydratedAction,
        {
          error:
            error instanceof Error ? truncate(error.message, 160) : truncate(String(error), 160),
          denied_by: 'permission_manager',
        },
      );
      denied.push(buildGuardrailFailureOutcome(hydratedAction, error));
    }
  }

  return { allowed, denied };
}

type ActionPermissionResolution<TAction extends AgentAction> =
  | { ok: true; action: TAction }
  | { ok: false; outcome: ActionOutcome };

async function resolveSingleActionPermission<TAction extends AgentAction>(
  session: SessionRecord,
  action: TAction,
  options: RunAgentOptions,
): Promise<ActionPermissionResolution<TAction>> {
  const { allowed, denied } = await resolveActionPermissions(
    session,
    [action],
    options,
  );

  if (allowed[0]) {
    return { ok: true, action: allowed[0] };
  }

  if (denied[0]) {
    return { ok: false, outcome: denied[0] };
  }

  const message = `Action ${action.type} was neither authorized nor denied.`;
  return {
    ok: false,
    outcome: {
      action,
      ok: false,
      output: message,
      error: buildToolError('tool_permission_denied', message, {
        retryable: false,
      }),
    },
  };
}

async function executeActionBatch(
  session: SessionRecord,
  actions: AgentAction[],
  options: RunAgentOptions,
): Promise<ActionOutcome[]> {
  const outcomes: ActionOutcome[] = [];
  let readOnlyBatch: AgentAction[] = [];
  let delegateBatch: Extract<AgentAction, { type: 'delegate_task' }>[] = [];

  async function flushReadOnlyBatch(): Promise<void> {
    if (readOnlyBatch.length === 0) {
      return;
    }

    const batch = readOnlyBatch;
    readOnlyBatch = [];
    const resolutions: ActionPermissionResolution<AgentAction>[] = [];

    // Authorization stays sequential so prompt-mode runtimes never open
    // multiple permission dialogs at once. Only already-authorized reads run
    // concurrently.
    for (const action of batch) {
      resolutions.push(
        await resolveSingleActionPermission(session, action, options),
      );
    }

    const allowed = resolutions
      .map((resolution, index) =>
        resolution.ok ? { index, action: resolution.action } : undefined,
      )
      .filter(
        (entry): entry is { index: number; action: AgentAction } =>
          entry !== undefined,
      );

    const executedByIndex = new Map<number, ActionOutcome>();
    if (allowed.length > 0) {
      if (allowed.length > 1) {
        options.onInfo?.(
          `[tool-batch] running ${allowed.length} read-only tools in parallel`,
        );
      }

      const results = await Promise.all(
        allowed.map((entry) =>
          executeAuthorizedAction(session, entry.action, options, true),
        ),
      );
      allowed.forEach((entry, index) => {
        executedByIndex.set(entry.index, results[index]!);
      });
    }

    for (let index = 0; index < resolutions.length; index += 1) {
      const resolution = resolutions[index]!;
      outcomes.push(
        resolution.ok
          ? executedByIndex.get(index)!
          : resolution.outcome,
      );
    }
  }

  async function flushDelegateBatch(): Promise<void> {
    if (delegateBatch.length === 0) {
      return;
    }

    const batch = delegateBatch;
    delegateBatch = [];
    const resolutions: ActionPermissionResolution<
      Extract<AgentAction, { type: 'delegate_task' }>
    >[] = [];

    for (const action of batch) {
      resolutions.push(
        await resolveSingleActionPermission(session, action, options),
      );
    }

    const allowed = resolutions
      .map((resolution, index) =>
        resolution.ok ? { index, action: resolution.action } : undefined,
      )
      .filter(
        (
          entry,
        ): entry is {
          index: number;
          action: Extract<AgentAction, { type: 'delegate_task' }>;
        } => entry !== undefined,
      );
    const executedByIndex = new Map<number, ActionOutcome>();

    if (allowed.length === 0) {
      for (const resolution of resolutions) {
        if (!resolution.ok) {
          outcomes.push(resolution.outcome);
        }
      }
      return;
    }

    try {
      await options.ensureSpecialistProvider?.(
        allowed.map((entry) => entry.action.role),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const entry of allowed) {
        executedByIndex.set(entry.index, {
          action: entry.action,
          ok: false,
          output: `Specialist provider bootstrap failed: ${message}`,
          error: buildToolError(
            'specialist_provider_bootstrap_failed',
            `Specialist provider bootstrap failed: ${message}`,
            {
              retryable: false,
            },
          ),
        });
      }
      for (let index = 0; index < resolutions.length; index += 1) {
        const resolution = resolutions[index]!;
        outcomes.push(
          resolution.ok
            ? executedByIndex.get(index)!
            : resolution.outcome,
        );
      }
      return;
    }

    if (allowed.length === 1) {
      const onlyAllowed = allowed[0]!;
      executedByIndex.set(
        onlyAllowed.index,
        await executeAuthorizedAction(session, onlyAllowed.action, options, true),
      );
    } else {
      options.onInfo?.(
        `[agent-batch] running ${allowed.length} delegated tasks in parallel`,
      );

      const batchResults = await Promise.all(
        allowed.map((entry) =>
          executeAuthorizedAction(session, entry.action, options, true),
        ),
      );
      allowed.forEach((entry, index) => {
        executedByIndex.set(entry.index, batchResults[index]!);
      });
    }

    for (let index = 0; index < resolutions.length; index += 1) {
      const resolution = resolutions[index]!;
      outcomes.push(
        resolution.ok
          ? executedByIndex.get(index)!
          : resolution.outcome,
      );
    }
  }

  for (const action of actions) {
    const tool = getToolDefinition(action.type);
    const canParallelize =
      action.type === 'delegate_task' && tool?.parallelSafe === true;

    if (isParallelReadOnlyAction(action)) {
      await flushDelegateBatch();
      readOnlyBatch.push(action);
      continue;
    }

    if (canParallelize) {
      await flushReadOnlyBatch();
      delegateBatch.push(action);
      if (delegateBatch.length >= MAX_PARALLEL_DELEGATE_TASKS) {
        await flushDelegateBatch();
      }
      continue;
    }

    await flushReadOnlyBatch();
    await flushDelegateBatch();

    const { allowed, denied } = await resolveActionPermissions(
      session,
      [action],
      options,
    );
    outcomes.push(...denied);

    if (allowed.length === 0) {
      continue;
    }

    outcomes.push(
      await executeAuthorizedAction(session, allowed[0], options, true),
    );
  }

  await flushReadOnlyBatch();
  await flushDelegateBatch();
  return outcomes;
}

export async function runAgent(
  session: SessionRecord,
  userInput: string,
  options: RunAgentOptions,
): Promise<RunResult> {
  if (options.appendUserMessage !== false) {
    options.sessionStore.appendMessage(session, 'user', userInput);
    await options.sessionStore.save(session);
  }

  let finalReply = '';
  const profile = options.profile ?? 'main';
  const shouldOwnHeimdallState = options.heimdallThreadState === undefined;
  const heimdallThreadState =
    options.heimdallThreadState ??
    (await prepareHeimdallThreadState({
      cwd: options.cwd,
      session,
      permissionMode: options.permissionManager.getMode(),
      runtimeId: options.rootRuntimeId,
    }));
  const runOptions: RunAgentOptions = {
    ...options,
    heimdallThreadState,
  };
  if (shouldOwnHeimdallState) {
    await recordHeimdallStage(
      options.sessionStore,
      session,
      heimdallThreadState,
      'before_thread_bind',
      {
        runtimeId: options.rootRuntimeId,
        summary: 'Heimdall thread bound for agent run.',
        metadata: {
          profile,
          cwd: options.cwd,
        },
      },
    );
  }
  const verificationState: VerificationState = {
    pending: false,
    taskNudgePending: false,
    reminderSent: false,
    commandEvidencePending: false,
  };
  const completionContract = options.completionContract ?? 'standard';
  const baselineChangedFiles = new Set(
    (session.changedFiles ?? [])
      .map((filePath) => normalizeReferencedPath(filePath))
      .filter(Boolean),
  );
  const baselineVerificationCount = session.verificationCommands?.length ?? 0;
  let groundedExecutionSignals = 0;
  let concreteExecutionSignals = 0;
  const taskNeedsMaterialExecution =
    completionContract === 'requires_execution_evidence' &&
    taskLikelyRequiresWorkspaceMutation(userInput);
  const visualNeed = detectVisualGenerationNeed(userInput);
  let localImageGenerationRequired = false;
  let localVideoGenerationRequired = false;
  if (visualNeed.image || visualNeed.video) {
    const configuredImage = visualNeed.image
      ? await resolveConfiguredVisualProvider(options.cwd, 'image')
      : null;
    const configuredVideo = visualNeed.video
      ? await resolveConfiguredVisualProvider(options.cwd, 'video')
      : null;
    const configured = [configuredImage, configuredVideo]
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => describeVisualProvider(entry.config, entry.assetKind));
    const remoteFallbackRequested = hasExplicitRemoteVisualFallback(userInput);
    localImageGenerationRequired = Boolean(configuredImage && !remoteFallbackRequested);
    localVideoGenerationRequired = Boolean(configuredVideo && !remoteFallbackRequested);

    options.onInfo?.(
      configured.length > 0
        ? `[visual] task needs visual assets; configured local visual API available: ${configured.join(', ')}. ${remoteFallbackRequested ? 'User requested web/search fallback.' : 'Local generate_image/generate_video is required before completion.'}`
        : '[visual] task needs visual assets; no configured local visual API found. Use Freya/web-search fallback if image assets are required.',
    );
  }
  const completionChecklist = buildRuntimeCompletionChecklist(
    userInput,
    profile,
    session,
    {
      imageRequired: localImageGenerationRequired,
      videoRequired: localVideoGenerationRequired,
    },
  );
  // Continuation guard for the requires_execution_evidence contract: count how
  // many consecutive turns the model produced only intent text without tool
  // actions, then inject stronger runtime guidance instead of ending early.
  let consecutiveMissingExecutionEvidenceTurns = 0;
  // Second guard for material-execution tasks: count consecutive turns where
  // the model only ran read-only ops (ls/cat/find/list_files/read_file/etc.)
  // and never produced a concrete write/run. This catches a different failure
  // mode than the "intent-only" counter: the model keeps invoking tools, so
  // actions.length > 0 every turn and the missing-evidence branch never
  // fires, but it never transitions from "investigating" to "building".
  let readOnlyOnlyTurnsWithoutWrites = 0;
  let readOnlyTurnsNudgeSent = false;
  let pendingTrimmedActionFollowup = false;
  const extensionRuntime = await resolveExtensionRuntime(options.cwd, userInput);
  const odinRuntimeSection = await buildOdinRuntimeSection({
    cwd: options.cwd,
    prompt: userInput,
    profile,
  });

  try {
    if (extensionRuntime.activeSkills.length > 0) {
      options.onInfo?.(
        `[skills] active=${extensionRuntime.activeSkills
          .map((entry) => entry.skill.id)
          .join(',')}`,
      );
    }
    if (extensionRuntime.missingSkillSelectors.length > 0) {
      options.onInfo?.(
        `[skills] missing=${extensionRuntime.missingSkillSelectors.join(',')}`,
      );
    }
    if (extensionRuntime.pluginPolicies.length > 0) {
      options.onInfo?.(
        `[plugins] advisory=${extensionRuntime.pluginPolicies
          .map((entry) => entry.plugin.id)
          .join(',')}`,
      );
    }
    if (odinRuntimeSection) {
      options.onInfo?.('[odin] matched reusable skills for the current request');
    }
    if (extensionRuntime.gatedPlugins.length > 0) {
      options.onInfo?.(
        `[plugins] gated=${extensionRuntime.gatedPlugins
          .map((plugin) => plugin.id)
          .join(',')}`,
      );
    }

  async function recordOutcomes(outcomes: Awaited<ReturnType<typeof executeActionBatch>>): Promise<void> {
    for (const outcome of outcomes) {
      options.sessionStore.appendMessage(
        session,
        'tool',
        formatToolResult(
          outcome.action,
          outcome.ok,
          outcome.output,
          outcome.error,
        ),
        outcome.action.type,
      );

      if (
        outcome.ok &&
        verificationState.commandEvidencePending &&
        isWorkspaceVerificationFollowupAction(outcome.action)
      ) {
        verificationState.commandEvidencePending = false;
        verificationState.reminderSent = false;
      }

      if (outcome.ok && isWriteAction(outcome.action)) {
        options.sessionStore.recordChangedFiles(
          session,
          getChangedFilesForAction(outcome.action),
        );
        verificationState.pending = true;
        verificationState.commandEvidencePending = false;
        verificationState.reminderSent = false;
      }

      if (outcome.ok) {
        groundedExecutionSignals += 1;
        if (
          completionChecklist.unresolvedToolFailure &&
          (
            outcome.action.type === completionChecklist.unresolvedToolFailure.actionType ||
            isConcreteExecutionAction(outcome.action) ||
            isWorkspaceVerificationFollowupAction(outcome.action)
          )
        ) {
          completionChecklist.unresolvedToolFailure = undefined;
        }
      } else {
        completionChecklist.unresolvedToolFailure =
          summarizeToolFailureOutcome(outcome);
      }

      if (outcome.ok && isConcreteExecutionAction(outcome.action)) {
        concreteExecutionSignals += 1;
        completionChecklist.mutationEvidenceObserved = true;
      }

      if (outcome.ok && outcome.action.type === 'generate_image') {
        completionChecklist.imageGenerationObserved = true;
        if (
          completionChecklist.unresolvedToolFailure?.actionType === 'generate_image'
        ) {
          completionChecklist.unresolvedToolFailure = undefined;
        }
      }

      if (outcome.ok && outcome.action.type === 'generate_video') {
        completionChecklist.videoGenerationObserved = true;
        if (
          completionChecklist.unresolvedToolFailure?.actionType === 'generate_video'
        ) {
          completionChecklist.unresolvedToolFailure = undefined;
        }
      }

      if (
        outcome.ok &&
        (completionChecklist.requiresLocalImageGeneration || completionChecklist.requiresLocalVideoGeneration)
      ) {
        const violation = summarizeVisualPlaceholderSubstitute(outcome.action);
        if (violation) {
          completionChecklist.visualPlaceholderViolation = violation;
        }
      }

      if (
        outcome.action.type === 'run_command' &&
        isVerificationCommand(outcome.action.command)
      ) {
        options.sessionStore.recordVerificationCommand(
          session,
          outcome.action.command,
          outcome.ok,
        );
        await recordVerificationOutcome(
          session,
          outcome.action,
          outcome,
          options,
          profile,
        );

        if (outcome.ok) {
          completionChecklist.verificationObserved = true;
          verificationState.pending = false;
          verificationState.taskNudgePending = false;
          verificationState.commandEvidencePending = false;
          verificationState.reminderSent = false;
        }
      } else if (
        outcome.ok &&
        outcome.action.type === 'run_command' &&
        taskNeedsMaterialExecution &&
        isConcreteExecutionAction(outcome.action)
      ) {
        verificationState.commandEvidencePending = true;
        verificationState.reminderSent = false;
      }
    }
  }

  async function runNativeToolLoop(
    provider: ChatProvider,
    providerMessages: SessionMessage[],
    completion: ProviderResponse,
    nativeToolRuntime: Awaited<ReturnType<typeof buildProviderNativeToolRuntime>> | undefined,
  ): Promise<ProviderResponse> {
    if (!provider.supportsNativeToolCalls) {
      return completion;
    }

    const nativeFunctionTools =
      nativeToolRuntime?.tools ?? buildProviderNativeFunctionTools();
    let currentCompletion = completion;

    for (let nativeRound = 1; nativeRound <= 6; nativeRound += 1) {
      const nativeCalls = currentCompletion.nativeToolCalls ?? [];
      if (nativeCalls.length === 0) {
        return currentCompletion;
      }

      if (!currentCompletion.responseId) {
        // Regular chat-completions provider (not stateful Responses API).
        // Convert native tool calls to the <toolcall name="...">JSON</toolcall>
        // format so extractXmlToolCalls picks them up in the normal agent loop.
        const xmlParts = nativeCalls.map(
          (call) => `<toolcall name="${call.name}">${call.arguments}</toolcall>`,
        );
        const combinedText = [currentCompletion.text?.trim() ?? '', ...xmlParts]
          .filter(Boolean)
          .join('\n');
        return { ...currentCompletion, text: combinedText, nativeToolCalls: undefined };
      }

      options.onInfo?.(
        `[provider-native-tools] round=${nativeRound} calls=${nativeCalls.length}`,
      );

      const outcomes: ActionOutcome[] = [];
      const toolOutputs: ProviderNativeToolOutput[] = [];

      for (const call of nativeCalls) {
        const mapped = mapProviderNativeToolCallToAction(
          call,
          nativeToolRuntime?.projectedMcpTools,
        );
        if (!mapped.ok) {
          toolOutputs.push({
            callId: call.callId,
            output: serializeToolPayload({
              ok: false,
              toolName: call.name,
              output: mapped.error.message,
              error: mapped.error,
            }),
          });
          continue;
        }

        const outcome = await executeAuthorizedAction(
          session,
          mapped.action,
          options,
        );
        outcomes.push(outcome);
        toolOutputs.push({
          callId: call.callId,
          output: serializeToolPayload({
            ok: outcome.ok,
            action: mapped.action,
            output: outcome.output,
            error: outcome.error,
          }),
        });
      }

      if (outcomes.length > 0) {
        await recordOutcomes(outcomes);
        await options.sessionStore.save(session);
      }

      currentCompletion = await provider.complete(providerMessages, {
        previousResponseId: currentCompletion.responseId,
        toolOutputs,
        nativeFunctionTools,
      });
    }

    throw new Error(
      'Responses provider exceeded the maximum native tool rounds without producing a final reply.',
    );
  }

  for (let turn = 1; turn <= options.maxTurns; turn += 1) {
    await processDelegatedRuntimeCommands(session, runOptions);

    const runningUserMessages = options.pollRunningUserMessages?.() ?? [];
    for (const runningUserMessage of runningUserMessages) {
      const cleanMessage = runningUserMessage.trim();
      if (!cleanMessage) {
        continue;
      }
      session.messages.push({
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        role: 'user',
        content: cleanMessage,
        createdAt: new Date().toISOString(),
      });
      options.onRunningUserMessageAccepted?.(cleanMessage);
    }
    if (runningUserMessages.length > 0) {
      await options.sessionStore.save(session);
    }

    if (turn === 1) {
      await recordHeimdallStage(
        options.sessionStore,
        session,
        heimdallThreadState,
        'before_context_build',
        {
          runtimeId: options.rootRuntimeId,
          summary: 'Heimdall context-build stage entered.',
          status: 'running',
          metadata: {
            profile,
            turn: String(turn),
          },
        },
      );
    }
    const context = await buildContextWindow(session, profile, options.cwd);
    session.summary = context.summary;
    options.onInfo?.(
      `[context] included=${context.stats.includedMessages}/${context.stats.totalMessages} summarized=${context.stats.summarizedMessages} chars~${context.stats.approxChars}`,
    );
    const evidenceGraph = await options.sessionStore.loadEvidenceGraph(
      session.rootSessionId ?? session.id,
    );
    const scopedEvidenceGraph = scopeEvidenceGraphForSession(
      evidenceGraph,
      session,
    );
    const evidenceDigest = buildEvidenceDigest(
      scopedEvidenceGraph,
      profile === 'main' ? 1_800 : 900,
      profile === 'main' ? 'full' : 'compact',
    );
    if (evidenceDigest) {
      options.onInfo?.(
        `[evidence] digest claims=${scopedEvidenceGraph.claims.length} edges=${scopedEvidenceGraph.edges.length}`,
      );
    }

    const activeProvider =
      options.resolveProvider?.(profile) ?? options.provider;
    const providerMessages = await buildProviderMessages(
      context,
      options.cwd,
      options.permissionManager.getMode(),
      session.autonomyMode ?? 'standard',
      profile,
      evidenceDigest,
      activeProvider.supportsNativeToolCalls === true,
      [
        ...extensionRuntime.sections,
        ...(odinRuntimeSection ? [odinRuntimeSection] : []),
      ],
    );
    const latestUserRequest = extractLatestUserRequest(context.messages);
    if (turn === 1) {
      await recordHeimdallStage(
        options.sessionStore,
        session,
        heimdallThreadState,
        'before_tool_projection',
        {
          runtimeId: options.rootRuntimeId,
          summary: 'Heimdall tool-projection stage entered.',
          status: 'running',
          metadata: {
            profile,
            request: truncate(latestUserRequest ?? '', 180),
          },
        },
      );
    }
    const nativeToolRuntime =
      activeProvider.supportsNativeToolCalls === true
        ? await buildProviderNativeToolRuntime(options.cwd, {
          requestContext: latestUserRequest,
          stickyProjectedToolNames: session.stickyNativeMcpTools,
          allowedActionTypes: getNativeAllowedActionTypesForRuntime(
            profile,
            options.permissionManager.getMode(),
          ),
          allowReadOnlyMcpToolCalls: true,
        })
        : undefined;
    if (turn === 1) {
      await recordHeimdallStage(
        options.sessionStore,
        session,
        heimdallThreadState,
        'after_tool_projection',
        {
          runtimeId: options.rootRuntimeId,
          summary: 'Heimdall tool-projection stage completed.',
          status: 'running',
          metadata: {
            profile,
            total_projected: String(nativeToolRuntime?.totalProjectedTools ?? 0),
            selected_projected: String(
              nativeToolRuntime?.selectedProjectedTools ?? 0,
            ),
          },
        },
      );
    }
    if (
      nativeToolRuntime &&
      nativeToolRuntime.totalProjectedTools > 0
    ) {
      session.stickyNativeMcpTools = mergeStickyNativeMcpTools(
        session.stickyNativeMcpTools,
        nativeToolRuntime.selectedProjectedToolNames,
      );
      options.onInfo?.(
        [
          '[provider-native-tools:mcp]',
          `selected=${nativeToolRuntime.selectedProjectedTools}/${nativeToolRuntime.totalProjectedTools}`,
          `alwaysLoad=${nativeToolRuntime.alwaysLoadedProjectedTools}`,
          `sticky=${nativeToolRuntime.stickyProjectedTools}`,
          latestUserRequest ? `query=${JSON.stringify(latestUserRequest.slice(0, 120))}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
    const nativeFunctionTools = nativeToolRuntime?.tools;
    const providerCallOptions = {
      nativeFunctionTools,
      imageAttachments:
        turn === 1 && options.imageAttachments?.length && activeProvider.supportsImages
          ? options.imageAttachments
          : undefined,
    };
    // Stream the model output live to the workflow UI when the provider
    // supports it. We forward each delta as a `[stream-chunk]` info line,
    // which the workflow renderer accumulates into a per-stage live buffer
    // and shows as it arrives in the terminal UI.
    let completion: ProviderResponse;
    if (typeof activeProvider.completeStream === 'function' && options.onInfo) {
      const onInfoCallback = options.onInfo;
      onInfoCallback(`[stream-start] profile=${profile} turn=${turn}`);
      try {
        completion = await activeProvider.completeStream(
          providerMessages,
          (delta) => {
            if (!delta) return;
            // Encode newlines so the receiver can rebuild the text.
            onInfoCallback(
              `[stream-chunk] profile=${profile} turn=${turn} delta=${JSON.stringify(delta)}`,
            );
          },
          providerCallOptions,
        );
      } finally {
        onInfoCallback(`[stream-end] profile=${profile} turn=${turn}`);
      }
    } else {
      completion = await activeProvider.complete(providerMessages, providerCallOptions);
    }
    completion = await runNativeToolLoop(
      activeProvider,
      providerMessages,
      completion,
      nativeToolRuntime,
    );
    // Surface per-turn token usage so the workflow progress UI can attribute
    // tokens to the currently-active stage (researcher / reviewer / synthesis
    // / execute). The string format is what applyWorkflowProgressInfo parses.
    if (completion.usage) {
      const usageBits: string[] = [];
      if (typeof completion.usage.promptTokens === 'number') {
        usageBits.push(`prompt=${completion.usage.promptTokens}`);
      }
      if (typeof completion.usage.completionTokens === 'number') {
        usageBits.push(`completion=${completion.usage.completionTokens}`);
      }
      if (typeof completion.usage.totalTokens === 'number') {
        usageBits.push(`total=${completion.usage.totalTokens}`);
      }
      if (typeof completion.usage.durationMs === 'number') {
        usageBits.push(`duration_ms=${completion.usage.durationMs}`);
      }
      if (usageBits.length > 0) {
        options.onInfo?.(`[usage] profile=${profile} ${usageBits.join(' ')}`);
      }
    }
    const envelope = tryParseEnvelope(completion.text);
    // Surface a short snippet of the model reply so the workflow UI can stream
    // it under the active stage. Long replies are truncated; the panel can
    // request more if needed.
    if (envelope.reply && envelope.reply.trim().length > 0) {
      const workflowReply = truncate(envelope.reply.trim(), MAX_WORKFLOW_REPLY_CHARS);
      options.onInfo?.(
        `[reply] profile=${profile} turn=${turn} text_json=${JSON.stringify(workflowReply)}`,
      );
    }
    if (Array.isArray(envelope.tasks)) {
      const previousTasks = session.tasks ?? [];
      const nextTasks = envelope.tasks;
      session.tasks = nextTasks;
      verificationState.taskNudgePending =
        (options.profile ?? 'main') === 'main' &&
        didTaskBoardJustCloseWithoutVerification(previousTasks, nextTasks);
      if (nextTasks.length > 0) {
        options.onInfo?.('[tasks] updated');
      }
    }
    if (Array.isArray(envelope.plan)) {
      const nextPlan = envelope.plan;
      session.plan = nextPlan;
      if (nextPlan.length > 0) {
        options.onInfo?.('[plan] updated');
      }
    }

    const originalActions = envelope.actions ?? [];
    const actionBatchBudget = getActionBatchBudget(session);
    const actions =
      originalActions.length > actionBatchBudget
        ? originalActions.slice(0, actionBatchBudget)
        : originalActions;
    const actionBatchTrimmed = actions.length !== originalActions.length;

    options.sessionStore.appendMessage(session, 'assistant', envelope.reply);
    finalReply = envelope.reply || finalReply;
    if (envelope.claims && envelope.claims.length > 0) {
      for (const claim of envelope.claims) {
        await options.sessionStore.upsertEvidenceClaim(session, {
          statement: claim.statement,
          status: claim.status ?? 'inferred',
          kind: claim.kind ?? 'fact',
          sourceSessionId: session.id,
          sourceProfile: profile,
        });
      }
      options.onInfo?.(`[evidence] added ${envelope.claims.length} claim(s)`);
    }
    await recordEnvelopeWorkflowEntry(
      session,
      options,
      turn,
      envelope,
      actions,
      originalActions.length,
    );
    await options.sessionStore.save(session);
    const continuationPromptInAutodrive =
      session.autonomyMode === 'autodrive' &&
      actions.length === 0 &&
      replyLooksLikeContinuationRequest(envelope.reply);
    const awaitingTrimmedActionFollowup = pendingTrimmedActionFollowup;
    if (actions.length > 0 && awaitingTrimmedActionFollowup) {
      pendingTrimmedActionFollowup = false;
    }
    const completionMarkedDoneWithActions =
      actions.length > 0 &&
      envelope.done !== false;
    const replyLooksComplete = replyContainsCompletionMarkers(envelope.reply);
    const replyLooksIncomplete = replyLooksStructurallyIncomplete(envelope.reply);
    const trimmedBatchNeedsFollowup =
      awaitingTrimmedActionFollowup &&
      actions.length === 0 &&
      !replyLooksComplete &&
      !replyLooksLikeExecutionBlocker(envelope.reply);
    const commandEvidenceNeedsFollowup =
      verificationState.commandEvidencePending &&
      actions.length === 0 &&
      !replyLooksLikeExecutionBlocker(envelope.reply);
    const missingRequiredActions =
      actions.length === 0 &&
      (
        envelope.done === false ||
        replyLooksLikeDeferredWork(envelope.reply) ||
        continuationPromptInAutodrive ||
        replyLooksIncomplete ||
        trimmedBatchNeedsFollowup ||
        commandEvidenceNeedsFollowup
      );
    const freshChangedFiles = getFreshChangedFiles(
      session,
      baselineChangedFiles,
    );
    const hasFreshExecutionEvidence =
      groundedExecutionSignals > 0 ||
      (session.verificationCommands?.length ?? 0) > baselineVerificationCount ||
      freshChangedFiles.length > 0;
    const hasFreshMaterialExecutionEvidence =
      (session.verificationCommands?.length ?? 0) > baselineVerificationCount ||
      freshChangedFiles.length > 0 ||
      concreteExecutionSignals > 0;
    completionChecklist.mutationEvidenceObserved =
      completionChecklist.mutationEvidenceObserved || hasFreshMaterialExecutionEvidence;
    completionChecklist.verificationObserved =
      completionChecklist.verificationObserved ||
      (session.verificationCommands?.length ?? 0) > baselineVerificationCount;
    completionChecklist.blockerAccepted =
      completionChecklist.blockerAccepted ||
      replyLooksLikeExecutionBlocker(envelope.reply);
    const replyIsPureIntent = replyLooksLikeIntentWithoutCompletion(envelope.reply);
    const unresolvedToolFailure = completionChecklist.unresolvedToolFailure;
    const deterministicChecklistUnresolvedToolFailure =
      actions.length === 0 &&
      envelope.done !== false &&
      unresolvedToolFailure !== undefined &&
      !completionChecklist.blockerAccepted &&
      !replyAcknowledgesToolFailure(envelope.reply);
    const missingExpectedMutationPaths =
      await getMissingExpectedMutationPaths({
        checklist: completionChecklist,
        session,
        baselineChangedFiles,
        cwd: options.cwd,
        concreteExecutionSignals,
      });
    const expectedChangedFileCount =
      completionChecklist.expectedChangedFileCount;
    const deterministicChecklistMissingExpectedPaths =
      actions.length === 0 &&
      envelope.done !== false &&
      missingExpectedMutationPaths.length > 0 &&
      !completionChecklist.blockerAccepted;
    const deterministicChecklistMissingExpectedFileCount =
      actions.length === 0 &&
      envelope.done !== false &&
      completionChecklist.expectedMutationPaths.length === 0 &&
      typeof expectedChangedFileCount === 'number' &&
      expectedChangedFileCount > 0 &&
      freshChangedFiles.length < expectedChangedFileCount &&
      !completionChecklist.blockerAccepted;
    const deterministicChecklistMissingExpectedVerification =
      actions.length === 0 &&
      envelope.done !== false &&
      completionChecklist.expectedVerificationRequired &&
      !completionChecklist.verificationObserved &&
      !completionChecklist.blockerAccepted;
    const deterministicChecklistMissingMutationEvidence =
      completionChecklist.requiresWorkspaceMutation &&
      actions.length === 0 &&
      envelope.done !== false &&
      !completionChecklist.mutationEvidenceObserved &&
      !completionChecklist.blockerAccepted;
    const missingLocalVisualTools = [
      completionChecklist.requiresLocalImageGeneration && !completionChecklist.imageGenerationObserved
        ? 'generate_image'
        : '',
      completionChecklist.requiresLocalVideoGeneration && !completionChecklist.videoGenerationObserved
        ? 'generate_video'
        : '',
    ].filter(Boolean);
    const deterministicChecklistMissingLocalVisualGeneration =
      actions.length === 0 &&
      envelope.done !== false &&
      missingLocalVisualTools.length > 0 &&
      !completionChecklist.blockerAccepted;
    const deterministicChecklistVisualPlaceholderViolation =
      actions.length === 0 &&
      envelope.done !== false &&
      completionChecklist.visualPlaceholderViolation !== undefined &&
      !completionChecklist.blockerAccepted;
    const missingConcreteExecutionEvidence =
      completionContract === 'requires_execution_evidence' &&
      actions.length === 0 &&
      envelope.done !== false &&
      (
        (taskNeedsMaterialExecution
          ? !hasFreshMaterialExecutionEvidence
          : !hasFreshExecutionEvidence) ||
        replyIsPureIntent
      ) &&
      !replyLooksLikeExecutionBlocker(envelope.reply) &&
      // 对于简单的创建文件/文件夹任务，放松检查
      !envelope.reply.includes('创建') &&
      !envelope.reply.includes('建立') &&
      !envelope.reply.includes('创建了') &&
      !envelope.reply.includes('已创建');

    if (completionMarkedDoneWithActions) {
      options.onInfo?.(
        '[agent] reply marked complete but still requested actions; executing them before finalizing',
      );
      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Runtime guard:',
          'Your previous reply marked the task complete but still requested tool actions.',
          'The runtime will execute those actions first, then ask for a final answer grounded in the results.',
        ].join('\n'),
        'runtime_guard',
      );
      await options.sessionStore.save(session);
    }

    if (
      deterministicChecklistVisualPlaceholderViolation &&
      completionChecklist.visualPlaceholderViolation
    ) {
      options.onInfo?.(
        `[completion-checklist] visual placeholder substitute blocked: ${completionChecklist.visualPlaceholderViolation}`,
      );
      if (turn >= options.maxTurns) {
        return {
          reply: [
            'Execution blocked by deterministic completion checklist: local visual generation was required, but the run produced SVG/procedural placeholder visuals instead of real generate_image/generate_video assets.',
            '',
            `Violation: ${completionChecklist.visualPlaceholderViolation}`,
            '',
            `Last model reply: "${truncate(envelope.reply, 240)}"`,
          ].join('\n'),
          turns: turn,
        };
      }

      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Deterministic visual-generation checklist:',
          `Blocked placeholder substitute: ${completionChecklist.visualPlaceholderViolation}`,
          'The current task requires real local visual generation. You MUST call generate_image/generate_video directly for the required visual assets.',
          'Do not write SVG files, generate-assets scripts, canvas/procedural drawings, or CSS-only placeholders as final product/editorial photography.',
          'Continue with done=false and concrete generate_image/generate_video actions, or return a clear blocker that explicitly says the visual generation tool failed.',
        ].join('\n'),
        'runtime_visual_checklist',
      );
      completionChecklist.visualPlaceholderViolation = undefined;
      await options.sessionStore.save(session);
      continue;
    }

    if (deterministicChecklistMissingLocalVisualGeneration) {
      options.onInfo?.(
        `[completion-checklist] required visual generation missing: ${missingLocalVisualTools.join(', ')}`,
      );
      if (turn >= options.maxTurns) {
        return {
          reply: [
            'Execution blocked by deterministic completion checklist: configured local visual generation was required, but the required visual tool was never called successfully.',
            '',
            `Missing tool call(s): ${missingLocalVisualTools.join(', ')}`,
            '',
            `Last model reply: "${truncate(envelope.reply, 240)}"`,
          ].join('\n'),
          turns: turn,
        };
      }

      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Deterministic visual-generation checklist:',
          `The task requires local visual generation, but these tool calls have not succeeded yet: ${missingLocalVisualTools.join(', ')}`,
          'Continue with done=false and call the required visual tool(s) directly. Do not substitute SVG, scripted drawings, CSS art, or web-search unless the user explicitly requested that fallback.',
          'If the visual tool fails, report that exact blocker instead of claiming the assets are ready.',
        ].join('\n'),
        'runtime_visual_checklist',
      );
      await options.sessionStore.save(session);
      continue;
    }

    if (deterministicChecklistUnresolvedToolFailure && unresolvedToolFailure) {
      options.onInfo?.(
        `[completion-checklist] unresolved tool failure before final: ${unresolvedToolFailure.actionType}`,
      );
      if (turn >= options.maxTurns) {
        return {
          reply: [
            'Execution blocked by deterministic completion checklist: a tool failed and the final reply did not recover from or acknowledge that failure.',
            '',
            `Failed action: ${unresolvedToolFailure.actionType}`,
            unresolvedToolFailure.code
              ? `Error code: ${unresolvedToolFailure.code}`
              : '',
            `Failure: ${truncate(unresolvedToolFailure.output, 240)}`,
            '',
            `Last model reply: "${truncate(envelope.reply, 240)}"`,
          ].filter(Boolean).join('\n'),
          turns: turn,
        };
      }

      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Deterministic completion checklist:',
          `The previous ${unresolvedToolFailure.actionType} tool call failed.`,
          unresolvedToolFailure.code
            ? `Error code: ${unresolvedToolFailure.code}`
            : '',
          `Failure: ${truncate(unresolvedToolFailure.output, 500)}`,
          'Do not claim completion while this failure is unresolved.',
          'Continue with concrete recovery actions, or return a clear blocker that explicitly acknowledges the failed tool result.',
        ].filter(Boolean).join('\n'),
        'runtime_completion_checklist',
      );
      await options.sessionStore.save(session);
      continue;
    }

    if (deterministicChecklistMissingExpectedPaths) {
      options.onInfo?.(
        `[completion-checklist] expected mutation paths missing: ${missingExpectedMutationPaths.join(', ')}`,
      );
      if (turn >= options.maxTurns) {
        return {
          reply: [
            'Execution blocked by deterministic completion checklist: the request named target files that were not changed or observed after execution.',
            '',
            `Missing target files: ${missingExpectedMutationPaths.join(', ')}`,
            `Observed changed files: ${freshChangedFiles.join(', ') || 'none'}`,
            '',
            `Last model reply: "${truncate(envelope.reply, 240)}"`,
          ].join('\n'),
          turns: turn,
        };
      }

      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Deterministic completion checklist:',
          `The original request named target files that are not yet changed or observed: ${missingExpectedMutationPaths.join(', ')}`,
          `Observed changed files this run: ${freshChangedFiles.join(', ') || 'none'}`,
          'Continue with concrete write_file/insert_in_file/replace_in_file/apply_patch/run_command actions for the missing target files, or return a clear blocker.',
        ].join('\n'),
        'runtime_completion_checklist',
      );
      await options.sessionStore.save(session);
      continue;
    }

    if (
      deterministicChecklistMissingExpectedFileCount &&
      typeof expectedChangedFileCount === 'number'
    ) {
      options.onInfo?.(
        `[completion-checklist] expected changed file count missing: expected=${expectedChangedFileCount} observed=${freshChangedFiles.length}`,
      );
      if (turn >= options.maxTurns) {
        return {
          reply: [
            'Execution blocked by deterministic completion checklist: the request asked for a specific number of file changes, but fewer changed files were recorded.',
            '',
            `Expected changed files: ${expectedChangedFileCount}`,
            `Observed changed files: ${freshChangedFiles.length}`,
            freshChangedFiles.length > 0
              ? `Observed paths: ${freshChangedFiles.join(', ')}`
              : 'Observed paths: none',
            '',
            `Last model reply: "${truncate(envelope.reply, 240)}"`,
          ].join('\n'),
          turns: turn,
        };
      }

      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Deterministic completion checklist:',
          `The original request asked for ${expectedChangedFileCount} changed file(s), but only ${freshChangedFiles.length} changed file(s) were recorded this run.`,
          `Observed changed files: ${freshChangedFiles.join(', ') || 'none'}`,
          'Continue with concrete file mutation actions until the requested count is satisfied, or return a clear blocker.',
        ].join('\n'),
        'runtime_completion_checklist',
      );
      await options.sessionStore.save(session);
      continue;
    }

    // 优化验证检查逻辑 - 对于设计工作流，放松对验证命令的严格要求
    if (deterministicChecklistMissingExpectedVerification) {
      // 从会话消息中获取用户的初始请求
      const initialUserIntent = session.messages.find(msg => msg.role === 'user')?.content || '';
      
      // 检查是否是设计工作流的任务（如创建网站、设计页面等）
      const isDesignTask = 
        (initialUserIntent.toLowerCase().includes('设计') || 
         initialUserIntent.toLowerCase().includes('网页') || 
         initialUserIntent.toLowerCase().includes('网站') || 
         initialUserIntent.toLowerCase().includes('ui') || 
         initialUserIntent.toLowerCase().includes('ux') ||
         initialUserIntent.toLowerCase().includes('css') ||
         initialUserIntent.toLowerCase().includes('html'));
      
      // 如果是设计任务，并且已经有文件变更，则不阻塞执行
      if (isDesignTask && freshChangedFiles.length > 0) {
        options.onInfo?.('[completion-checklist] design task completed with file changes, skipping strict verification');
      } else {
        options.onInfo?.(
          '[completion-checklist] expected verification command missing before final',
        );
        if (turn >= options.maxTurns) {
          return {
            reply: [
              'Execution blocked by deterministic completion checklist: the request explicitly asked for verification, but no verification command was recorded.',
              '',
              `Last model reply: "${truncate(envelope.reply, 240)}"`,
            ].join('\n'),
            turns: turn,
          };
        }

        options.sessionStore.appendMessage(
          session,
          'tool',
          [
            'Deterministic completion checklist:',
            'The original request explicitly asked for verification, but no verification command has been recorded.',
            'Run an appropriate run_command verification such as tests, typecheck, lint, build, or a concrete check command.',
            'If verification cannot run, return a clear blocker that explains why.',
          ].join('\n'),
          'runtime_completion_checklist',
        );
        await options.sessionStore.save(session);
        continue;
      }
    }

    if (deterministicChecklistMissingMutationEvidence) {
      options.onInfo?.(
        '[completion-checklist] workspace mutation required but no mutation evidence recorded',
      );
      if (turn >= options.maxTurns) {
        return {
          reply: [
            'Execution blocked by deterministic completion checklist: the request appears to require workspace changes, but no changed files or concrete mutation actions were recorded.',
            '',
            `Last model reply: "${truncate(envelope.reply, 240)}"`,
          ].join('\n'),
          turns: turn,
        };
      }

      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Deterministic completion checklist:',
          'The original request appears to require workspace mutation, but no changed files, write actions, or concrete mutation commands have been recorded.',
          'Do not finish with intent text. Continue with done=false and concrete write_file/insert_in_file/replace_in_file/apply_patch/run_command actions.',
          'If execution is impossible, return a clear blocker instead of claiming completion.',
        ].join('\n'),
        'runtime_completion_checklist',
      );
      await options.sessionStore.save(session);
      continue;
    }

    if (
      missingRequiredActions &&
      turn < options.maxTurns
    ) {
      if (completionContract !== 'requires_execution_evidence') {
        const fallbackReadActions = deriveFallbackReadActions(userInput, session);
        if (fallbackReadActions.length > 0) {
          options.onInfo?.(
            `[agent] synthesizing ${fallbackReadActions.length} fallback read_file action(s) from the active task context`,
          );
          const fallbackOutcomes = await executeActionBatch(
            session,
            fallbackReadActions,
            runOptions,
          );
          await recordOutcomes(fallbackOutcomes);
          await options.sessionStore.save(session);
          continue;
        }
      }

      options.onInfo?.(
        completionContract === 'requires_execution_evidence'
          ? '[agent] reply described unfinished work without tool actions during execution; requesting another turn'
          : '[agent] reply described unfinished work without tool actions; requesting another turn',
      );
      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Runtime guard:',
          'Your previous reply described unfinished work but did not request tool actions.',
          ...(continuationPromptInAutodrive
            ? [
                'Autodrive is active for this session. Do not ask the user whether to continue or proceed to the next phase.',
              ]
            : []),
          ...(trimmedBatchNeedsFollowup
            ? [
                'The previous turn exceeded the action batch budget, so some requested work was intentionally deferred.',
                'Continue with the remaining concrete actions, or explicitly summarize why the deferred work is no longer needed.',
              ]
            : []),
          ...(commandEvidenceNeedsFollowup
            ? [
                'A non-read-only shell/build command already ran, but you have not yet verified what it actually changed in the workspace.',
                'Before finishing, inspect the generated artifacts (for example with list_files/read_file or a read-only shell check) or run a relevant verification command.',
              ]
            : []),
          'If more evidence or file reads are required, continue immediately with done=false and concrete actions.',
          'Only finish when the work is actually complete or you have a hard blocker that tools cannot resolve.',
        ].join('\n'),
        'runtime_guard',
      );
      await options.sessionStore.save(session);
      continue;
    }

    if (missingConcreteExecutionEvidence) {
      consecutiveMissingExecutionEvidenceTurns += 1;
      const escalated = consecutiveMissingExecutionEvidenceTurns >= 2;
      options.onInfo?.(
        escalated
          ? '[agent] execution still hallucinating; escalating guard before fail-fast'
          : '[agent] execution summary lacked concrete evidence; requesting real follow-through',
      );
      options.sessionStore.appendMessage(
        session,
        'tool',
        escalated
          ? [
              '⛔ 必须继续执行 ⛔',
              `你已经连续 ${consecutiveMissingExecutionEvidenceTurns} 轮只写了意图文本，没有调用任何工具。`,
              '本轮必须直接输出包含 actions 的 JSON：',
              '{"reply": "...", "done": false, "actions": [{"type": "write_file", "path": "...", "content": "..."}]}',
              '只允许 write_file / insert_in_file / replace_in_file / apply_patch / run_command 之一。',
              '不要再描述"将要做什么"。立即调用工具；如果确实无法执行，必须明确返回 blocker 并说明不可恢复原因。',
            ].join('\n')
          : [
              'Execution contract:',
              'This run cannot finish yet because no concrete execution evidence was recorded.',
              ...(taskNeedsMaterialExecution
                ? [
                    'This task asks for real workspace changes, so read-only inspection commands do not count as completion evidence.',
                    'You hallucinated that the files were created, but you NEVER ACTUALLY INVOKED ANY FILE WRITING TOOLS.',
                  ]
                : [
                    'You claimed progress without grounding it in real tool execution results.',
                  ]),
              'Do not attempt to read files you never wrote. Stop hallucinating success.',
              'Continue immediately with done=false and concrete write_file/insert_in_file/replace_in_file/apply_patch/run_command actions, or explain the exact blocked next action and why it cannot run.',
            ].join('\n'),
        'runtime_guard',
      );
      await options.sessionStore.save(session);
      continue;
    }

    // Reset the fail-fast counter whenever the model produced any actions —
    // even read-only ones count as making progress instead of pure narration.
    if (actions.length > 0) {
      consecutiveMissingExecutionEvidenceTurns = 0;
    }

    // Second guard: when the task requires material output (write_file etc.),
    // detect the "only reads, never writes" loop. The intent-only counter
    // above is reset by *any* action, so a model that keeps running ls/cat/
    // find/list_files turn after turn will burn through every turn without
    // ever building anything. Track a streak of action-bearing turns that
    // requested zero concrete writes/runs and bail before maxTurns.
    if (taskNeedsMaterialExecution && actions.length > 0) {
      const turnRequestsConcreteExecution = actions.some((candidate) =>
        isConcreteExecutionAction(candidate),
      );
      if (turnRequestsConcreteExecution) {
        readOnlyOnlyTurnsWithoutWrites = 0;
        readOnlyTurnsNudgeSent = false;
      } else {
        readOnlyOnlyTurnsWithoutWrites += 1;
        if (readOnlyOnlyTurnsWithoutWrites >= 2 && !readOnlyTurnsNudgeSent) {
          readOnlyTurnsNudgeSent = true;
          options.onInfo?.(
            '[agent] read-only streak detected; nudging model to start writing',
          );
          options.sessionStore.appendMessage(
            session,
            'tool',
            [
              '⛔ 调研够了 ⛔',
              `你已经连续 ${readOnlyOnlyTurnsWithoutWrites} 轮只调用读/查询类工具，没有写入任何文件、也没有执行任何构建命令。`,
              '本轮立刻输出包含 write_file (或 run_command 真正构建命令) 的 actions：',
              '{"reply": "...", "done": false, "actions": [{"type": "write_file", "path": "...", "content": "..."}]}',
              '不要再 ls / cat / read_file 了。直接动手写文件。',
              '如果不知道写什么，根据用户最初的请求和已经读到的项目结构，直接产出最直接的实现方案。',
            ].join('\n'),
            'runtime_guard',
          );
          await options.sessionStore.save(session);
        }
      }
    }

    if (actions.length === 0) {
      if (
        (verificationState.pending || verificationState.taskNudgePending) &&
        !verificationState.reminderSent
      ) {
        await handleVerificationReminder(session, options, verificationState);
        continue;
      }

      return {
        reply: finalReply,
        turns: turn,
      };
    }

    if (actionBatchTrimmed) {
      pendingTrimmedActionFollowup = true;
      options.onInfo?.(
        `[agent] trimmed action batch ${originalActions.length} -> ${actions.length} to keep the loop evidence-driven`,
      );
      options.sessionStore.appendMessage(
        session,
        'tool',
        [
          'Runtime guard:',
          `The previous turn requested ${originalActions.length} actions; the runtime executed only the first ${actions.length} to keep the loop short and evidence-driven.`,
          'Re-evaluate the next step from the new tool results instead of assuming the deferred actions are still correct.',
        ].join('\n'),
        'runtime_guard',
      );
      await recordWorkflowEntry(
        session,
        options,
        `${profileLabel(profile)} Turn ${turn} Action Budget`,
        [
          `budget=${actions.length}`,
          `requested=${originalActions.length}`,
          `autonomy=${session.autonomyMode ?? 'standard'}`,
        ],
      );
    }

    const outcomes = await executeActionBatch(session, actions, runOptions);
    await recordOutcomes(outcomes);
    await recordOutcomeWorkflowEntry(session, options, turn, outcomes);

    await options.sessionStore.save(session);
  }

    const maxTurnReply =
      finalReply ||
      `Stopped after reaching max turns (${options.maxTurns}) without a final answer.`;

    return {
      reply: maxTurnReply,
      turns: options.maxTurns,
    };
  } finally {
    try {
      const { compressTrajectory } = await import('./memory.js');
      compressTrajectory(options.cwd, session, '').catch(() => {});
    } catch {}

    if (shouldOwnHeimdallState) {
      await finalizeHeimdallThreadState(heimdallThreadState);
    }
  }
}
