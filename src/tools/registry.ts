/**
 * tools/registry.ts — runtime tool registry
 *
 * The registry is the single source of truth for tool metadata exposed to the
 * CLI runtime. Provider-native tool manifests, permission checks, validation,
 * and doctor/integrity reporting should all derive from this file.
 */

import {
  ALL_AGENT_ACTION_TYPES,
  RUNTIME_MANAGED_AGENT_ACTION_TYPES,
  type AgentAction,
  type AgentActionType,
  type AgentRole,
} from '../core/types.js';
import type { ToolDefinition } from '../core/toolDef.js';
import type { ToolPermissionCategory } from './types.js';
import { skillToolDef } from './SkillTool/SkillTool.js';
import { securityAuditToolDef } from '../core/securityAuditSystem.js';
import { executeApplyPatch } from './applyPatch.js';
import { executeDeepResearch } from './deepResearch.js';
import { executeGenerateImage } from './generateImage.js';
import { executeGenerateVideo } from './generateVideo.js';
import { executeSynthesizeSpeech } from './synthesizeSpeech.js';
import { executeTranscribeAudio } from './transcribeAudio.js';
import { executeInsertInFile } from './insertInFile.js';
import { executeListFiles } from './listFiles.js';
import { executeLookupDocs } from './lookupDocs.js';
import { executeReadFile } from './readFile.js';
import { executeReplaceInFile } from './replaceInFile.js';
import { executeRunCommand } from './runCommand.js';
import { executeSearchFiles } from './searchFiles.js';
import { executeSearchWeb } from './searchWeb.js';
import { executeWriteFile } from './writeFile.js';

export type { ToolDefinition };

const AGENT_ROLE_VALUES: readonly AgentRole[] = [
  'planner',
  'researcher',
  'builder',
  'reviewer',
  'brainstormer',
  'arbiter',
  'architect',
  'designer',
  'qa',
];

const RUNTIME_MANAGED_TOOL_TYPES = new Set<AgentActionType>(
  RUNTIME_MANAGED_AGENT_ACTION_TYPES,
);
const PROVIDER_EXCLUDED_ACTION_TYPES = new Set<AgentActionType>(['agent']);
const PARALLEL_READ_ACTION_TYPES = new Set<AgentActionType>([
  'list_files',
  'read_file',
  'search_files',
  'lookup_docs',
  'mcp_read_resource',
  'mcp_get_prompt',
]);

function addError(
  errors: string[],
  condition: boolean,
  message: string,
): void {
  if (condition) {
    errors.push(message);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateRequiredNonEmptyString(
  value: unknown,
  label: string,
  errors: string[],
): void {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} is required.`);
  }
}

function validateOptionalNonEmptyString(
  value: unknown,
  label: string,
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }

  if (!isNonEmptyString(value)) {
    errors.push(`${label} must be a non-empty string.`);
  }
}

function validatePositiveInteger(
  value: unknown,
  label: string,
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || Number(value) <= 0) {
    errors.push(`${label} must be a positive integer.`);
  }
}

function validateIntegerRange(
  value: unknown,
  label: string,
  min: number,
  max: number,
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }

  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    errors.push(`${label} must be an integer between ${min} and ${max}.`);
  }
}

function validateBooleanValue(
  value: unknown,
  label: string,
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'boolean') {
    errors.push(`${label} must be a boolean.`);
  }
}

function validateEnumString<TValue extends string>(
  value: unknown,
  label: string,
  values: readonly TValue[],
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }

  if (typeof value !== 'string' || !values.includes(value as TValue)) {
    errors.push(`${label} must be one of: ${values.join(', ')}.`);
  }
}

function validateStringArray(
  value: unknown,
  label: string,
  errors: string[],
): void {
  if (value === undefined) {
    return;
  }

  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    errors.push(`${label} must be an array of non-empty strings.`);
  }
}

function validateAgentRoleValue(value: unknown, errors: string[]): void {
  validateEnumString(value, 'role', AGENT_ROLE_VALUES, errors);
}

function validateReadFileAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.path, 'path', errors);
  validatePositiveInteger(action?.startLine, 'startLine', errors);
  validatePositiveInteger(action?.endLine, 'endLine', errors);
  if (
    Number.isInteger(action?.startLine) &&
    Number.isInteger(action?.endLine) &&
    Number(action.endLine) < Number(action.startLine)
  ) {
    errors.push('endLine must be greater than or equal to startLine.');
  }
  return errors;
}

function validateListFilesAction(action: any): string[] {
  const errors: string[] = [];
  validateOptionalNonEmptyString(action?.pattern, 'pattern', errors);
  validatePositiveInteger(action?.maxResults, 'maxResults', errors);
  return errors;
}

function validateSearchFilesAction(action: any): string[] {
  const errors: string[] = [];
  validateOptionalNonEmptyString(action?.pattern, 'pattern', errors);
  validateOptionalNonEmptyString(action?.query, 'query', errors);
  validatePositiveInteger(action?.maxResults, 'maxResults', errors);
  addError(
    errors,
    !isNonEmptyString(action?.pattern) && !isNonEmptyString(action?.query),
    'search_files requires at least one of pattern or query.',
  );
  return errors;
}

function validateLookupDocsAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.query, 'query', errors);
  validateOptionalNonEmptyString(action?.library, 'library', errors);
  validateOptionalNonEmptyString(action?.version, 'version', errors);
  validatePositiveInteger(action?.maxResults, 'maxResults', errors);
  return errors;
}

function validateSearchWebAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.query, 'query', errors);
  validatePositiveInteger(action?.limit, 'limit', errors);
  validateEnumString(
    action?.backend,
    'backend',
    ['auto', 'bing', 'google', 'duckduckgo', 'wikipedia'] as const,
    errors,
  );
  return errors;
}

function validateDeepResearchAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.query, 'query', errors);
  validateOptionalNonEmptyString(
    action?.systemInstruction,
    'systemInstruction',
    errors,
  );
  validatePositiveInteger(action?.maxPolls, 'maxPolls', errors);
  validatePositiveInteger(action?.pollIntervalMs, 'pollIntervalMs', errors);
  return errors;
}

function validateMcpCallToolAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.serverId, 'serverId', errors);
  validateRequiredNonEmptyString(action?.toolName, 'toolName', errors);
  validatePositiveInteger(action?.timeoutMs, 'timeoutMs', errors);
  validateBooleanValue(action?.readOnly, 'readOnly', errors);
  if (
    action?.args !== undefined &&
    (!action.args || typeof action.args !== 'object' || Array.isArray(action.args))
  ) {
    errors.push('args must be a JSON object.');
  }
  return errors;
}

function validateMcpReadResourceAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.serverId, 'serverId', errors);
  validateRequiredNonEmptyString(action?.uri, 'uri', errors);
  validatePositiveInteger(action?.timeoutMs, 'timeoutMs', errors);
  return errors;
}

function validateMcpGetPromptAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.serverId, 'serverId', errors);
  validateRequiredNonEmptyString(action?.promptName, 'promptName', errors);
  validatePositiveInteger(action?.timeoutMs, 'timeoutMs', errors);
  if (
    action?.args !== undefined &&
    (!action.args || typeof action.args !== 'object' || Array.isArray(action.args))
  ) {
    errors.push('args must be a JSON object.');
  }
  return errors;
}

function validateWriteFileAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.path, 'path', errors);
  if (typeof action?.content !== 'string') {
    errors.push('content is required.');
  }
  return errors;
}

function validateInsertInFileAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.path, 'path', errors);
  if (typeof action?.content !== 'string') {
    errors.push('content is required.');
  }
  if (action?.after !== undefined && typeof action.after !== 'string') {
    errors.push('after must be a string.');
  }
  if (action?.before !== undefined && typeof action.before !== 'string') {
    errors.push('before must be a string.');
  }
  validatePositiveInteger(action?.atLine, 'atLine', errors);

  const anchorCount = [
    typeof action?.after === 'string' && action.after.trim().length > 0,
    typeof action?.before === 'string' && action.before.trim().length > 0,
    Number.isInteger(action?.atLine) && Number(action.atLine) > 0,
  ].filter(Boolean).length;
  if (anchorCount !== 1) {
    errors.push(
      'insert_in_file requires exactly one anchor: after, before, or atLine.',
    );
  }

  return errors;
}

function validateReplaceInFileAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.path, 'path', errors);
  validateRequiredNonEmptyString(action?.find, 'find', errors);
  if (typeof action?.replace !== 'string') {
    errors.push('replace is required.');
  }
  validateBooleanValue(action?.replaceAll, 'replaceAll', errors);
  return errors;
}

function validateApplyPatchAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.patch, 'patch', errors);
  return errors;
}

function validateRunCommandAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.command, 'command', errors);
  validatePositiveInteger(action?.timeoutMs, 'timeoutMs', errors);
  return errors;
}

function validateDelegateTaskAction(action: any): string[] {
  const errors: string[] = [];
  validateAgentRoleValue(action?.role, errors);
  validateRequiredNonEmptyString(action?.task, 'task', errors);
  validatePositiveInteger(action?.maxTurns, 'maxTurns', errors);
  validateBooleanValue(action?.runInBackground, 'runInBackground', errors);
  return errors;
}

function validateSpawnBackgroundWorkflowAction(action: any): string[] {
  const errors: string[] = [];
  validateEnumString(
    action?.command,
    'command',
    ['run', 'athena', 'design', 'niko', 'contest', 'nidhogg'] as const,
    errors,
  );
  validateRequiredNonEmptyString(action?.prompt, 'prompt', errors);
  validatePositiveInteger(action?.maxTurns, 'maxTurns', errors);
  return errors;
}

function validateApproveBuilderExecutionAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.sessionId, 'sessionId', errors);
  validateOptionalNonEmptyString(action?.summary, 'summary', errors);
  validatePositiveInteger(action?.maxTurns, 'maxTurns', errors);
  return errors;
}

function validateOdinSearchSkillsAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.query, 'query', errors);
  validateEnumString(action?.scope, 'scope', ['local', 'cloud', 'all'] as const, errors);
  validatePositiveInteger(action?.limit, 'limit', errors);
  validateBooleanValue(action?.autoImport, 'autoImport', errors);
  return errors;
}

function validateOdinExecuteTaskAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.task, 'task', errors);
  validateEnumString(
    action?.searchScope,
    'searchScope',
    ['local', 'cloud', 'all'] as const,
    errors,
  );
  validatePositiveInteger(action?.maxIterations, 'maxIterations', errors);
  return errors;
}

function validateOdinFixSkillAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.skillId, 'skillId', errors);
  validateOptionalNonEmptyString(action?.errorContext, 'errorContext', errors);
  validateOptionalNonEmptyString(action?.summary, 'summary', errors);
  return errors;
}

function validateOdinUploadSkillAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.skillId, 'skillId', errors);
  validateEnumString(
    action?.visibility,
    'visibility',
    ['local', 'private', 'public'] as const,
    errors,
  );
  validateOptionalNonEmptyString(action?.notes, 'notes', errors);
  return errors;
}

function validateOdinImportCloudSkillsAction(action: any): string[] {
  const errors: string[] = [];
  validateOptionalNonEmptyString(action?.query, 'query', errors);
  validatePositiveInteger(action?.limit, 'limit', errors);
  return errors;
}

function validateGenerateImageAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.prompt, 'prompt', errors);
  validateOptionalNonEmptyString(action?.model, 'model', errors);
  validateOptionalNonEmptyString(action?.size, 'size', errors);
  validateOptionalNonEmptyString(action?.quality, 'quality', errors);
  validateOptionalNonEmptyString(action?.outputFormat, 'outputFormat', errors);
  validateOptionalNonEmptyString(action?.background, 'background', errors);
  validateIntegerRange(action?.outputCompression, 'outputCompression', 0, 100, errors);
  validatePositiveInteger(action?.count, 'count', errors);
  validateOptionalNonEmptyString(action?.outputPath, 'outputPath', errors);
  validateBooleanValue(action?.watermark, 'watermark', errors);
  validateBooleanValue(action?.runInBackground, 'runInBackground', errors);
  return errors;
}

function validateGenerateVideoAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.prompt, 'prompt', errors);
  validateOptionalNonEmptyString(action?.model, 'model', errors);
  validateOptionalNonEmptyString(action?.ratio, 'ratio', errors);
  validatePositiveInteger(action?.duration, 'duration', errors);
  validateOptionalNonEmptyString(action?.outputPath, 'outputPath', errors);
  validateStringArray(
    action?.referenceImageUrls,
    'referenceImageUrls',
    errors,
  );
  validateBooleanValue(action?.generateAudio, 'generateAudio', errors);
  validateBooleanValue(action?.watermark, 'watermark', errors);
  validatePositiveInteger(action?.maxPolls, 'maxPolls', errors);
  validatePositiveInteger(action?.pollIntervalMs, 'pollIntervalMs', errors);
  validateBooleanValue(action?.runInBackground, 'runInBackground', errors);
  return errors;
}

function validateSynthesizeSpeechAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.text, 'text', errors);
  validateOptionalNonEmptyString(action?.voice, 'voice', errors);
  validateOptionalNonEmptyString(action?.language, 'language', errors);
  validateOptionalNonEmptyString(action?.outputPath, 'outputPath', errors);
  validateBooleanValue(action?.playAudio, 'playAudio', errors);
  if (action?.rate !== undefined && (!Number.isFinite(action.rate) || action.rate < 0.5 || action.rate > 2)) {
    errors.push('rate must be a number between 0.5 and 2.');
  }
  if (action?.pitch !== undefined && (!Number.isFinite(action.pitch) || action.pitch < 0.5 || action.pitch > 2)) {
    errors.push('pitch must be a number between 0.5 and 2.');
  }
  return errors;
}

function validateTranscribeAudioAction(action: any): string[] {
  const errors: string[] = [];
  validateRequiredNonEmptyString(action?.inputPath, 'inputPath', errors);
  validateOptionalNonEmptyString(action?.language, 'language', errors);
  validateEnumString(action?.model, 'model', ['tiny', 'base', 'small', 'medium', 'large-v3'] as const, errors);
  validateOptionalNonEmptyString(action?.modelPath, 'modelPath', errors);
  validateEnumString(action?.engine, 'engine', ['auto', 'whisper.cpp', 'openai-whisper'] as const, errors);
  validateOptionalNonEmptyString(action?.command, 'command', errors);
  return errors;
}

function validateFreyaVisualAssetAction(action: any): string[] {
  const errors: string[] = [];
  validateEnumString(
    action?.assetType,
    'assetType',
    ['image', 'video', 'icon'] as const,
    errors,
  );
  validateRequiredNonEmptyString(
    action?.contextDescription,
    'contextDescription',
    errors,
  );
  validateOptionalNonEmptyString(action?.preferredStyle, 'preferredStyle', errors);
  return errors;
}

function validateAgentAction(action: any): string[] {
  const errors: string[] = [];
  validateEnumString(
    action?.action,
    'action',
    ['create', 'list', 'run', 'stop', 'status', 'result'] as const,
    errors,
  );
  validateOptionalNonEmptyString(action?.id, 'id', errors);
  validateOptionalNonEmptyString(action?.name, 'name', errors);
  validateOptionalNonEmptyString(action?.description, 'description', errors);
  validateOptionalNonEmptyString(action?.task, 'task', errors);
  validateStringArray(action?.toolsets, 'toolsets', errors);
  validatePositiveInteger(action?.timeout, 'timeout', errors);
  validatePositiveInteger(action?.maxIterations, 'maxIterations', errors);
  validateEnumString(
    action?.priority,
    'priority',
    ['low', 'medium', 'high'] as const,
    errors,
  );
  return errors;
}

const fileToolDef: ToolDefinition = {
  type: 'file',
  description: '文件操作工具，支持读取、写入、修改和搜索文件',
  kind: 'read',
  permissionCategory: 'read',
  executionMode: 'blocking',
  parallelSafe: true,
  validate: () => [],
};

const systemToolDef: ToolDefinition = {
  type: 'system',
  description: '系统操作工具，支持执行命令、获取系统信息和管理进程',
  kind: 'shell',
  permissionCategory: 'execute',
  executionMode: 'blocking',
  parallelSafe: false,
  validate: () => [],
};

const actionToolDefs: ToolDefinition[] = [
  {
    type: 'list_files',
    description: '列出目录中的文件',
    kind: 'read',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: validateListFilesAction,
    execute: executeListFiles as any,
  },
  {
    type: 'read_file',
    description: '读取文件内容',
    kind: 'read',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: validateReadFileAction,
    execute: executeReadFile as any,
  },
  {
    type: 'search_files',
    description: '搜索文件内容',
    kind: 'search',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: validateSearchFilesAction,
    execute: executeSearchFiles as any,
  },
  {
    type: 'lookup_docs',
    description: '查找文档',
    kind: 'search',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: validateLookupDocsAction,
    execute: executeLookupDocs as any,
  },
  {
    type: 'search_web',
    description: '搜索网页内容',
    kind: 'search',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: validateSearchWebAction,
    execute: executeSearchWeb as any,
  },
  {
    type: 'deep_research',
    description: '运行 Gemini Deep Research 并返回结构化研究结果',
    kind: 'search',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: validateDeepResearchAction,
    execute: executeDeepResearch as any,
  },
  {
    type: 'mcp_call_tool',
    description: '调用已连接 MCP 服务器暴露的工具',
    kind: 'mcp',
    permissionCategory: 'execute',
    executionMode: 'non-blocking',
    parallelSafe: true,
    validate: validateMcpCallToolAction,
  },
  {
    type: 'mcp_read_resource',
    description: '读取 MCP 服务器暴露的资源',
    kind: 'mcp',
    permissionCategory: 'read',
    executionMode: 'non-blocking',
    parallelSafe: true,
    validate: validateMcpReadResourceAction,
  },
  {
    type: 'mcp_get_prompt',
    description: '获取 MCP 服务器暴露的 prompt 模板',
    kind: 'mcp',
    permissionCategory: 'read',
    executionMode: 'non-blocking',
    parallelSafe: true,
    validate: validateMcpGetPromptAction,
  },
  {
    type: 'write_file',
    description: '写入文件内容',
    kind: 'write',
    permissionCategory: 'write',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateWriteFileAction,
    execute: executeWriteFile as any,
  },
  {
    type: 'insert_in_file',
    description: '在文件中插入内容',
    kind: 'write',
    permissionCategory: 'write',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateInsertInFileAction,
    execute: executeInsertInFile as any,
  },
  {
    type: 'replace_in_file',
    description: '替换文件内容',
    kind: 'write',
    permissionCategory: 'write',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateReplaceInFileAction,
    execute: executeReplaceInFile as any,
  },
  {
    type: 'apply_patch',
    description: '应用补丁到文件',
    kind: 'write',
    permissionCategory: 'write',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateApplyPatchAction,
    execute: executeApplyPatch as any,
  },
  {
    type: 'run_command',
    description: '执行系统命令',
    kind: 'shell',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateRunCommandAction,
    execute: executeRunCommand as any,
  },
  {
    type: 'delegate_task',
    description: '委托子任务给专门 agent',
    kind: 'agent',
    permissionCategory: 'agent',
    executionMode: 'non-blocking',
    parallelSafe: true,
    validate: validateDelegateTaskAction,
  },
  {
    type: 'spawn_background_workflow',
    description: '启动后台工作流',
    kind: 'agent',
    permissionCategory: 'execute',
    executionMode: 'non-blocking',
    parallelSafe: false,
    validate: validateSpawnBackgroundWorkflowAction,
  },
  {
    type: 'approve_builder_execution',
    description: '批准 builder 提案进入执行阶段',
    kind: 'agent',
    permissionCategory: 'agent',
    executionMode: 'non-blocking',
    parallelSafe: false,
    validate: validateApproveBuilderExecutionAction,
  },
  {
    type: 'odin_search_skills',
    description: '搜索可用技能',
    kind: 'search',
    permissionCategory: 'read',
    executionMode: 'non-blocking',
    parallelSafe: true,
    validate: validateOdinSearchSkillsAction,
  },
  {
    type: 'odin_execute_task',
    description: '通过 Odin 查找并执行技能任务',
    kind: 'agent',
    permissionCategory: 'agent',
    executionMode: 'non-blocking',
    parallelSafe: false,
    validate: validateOdinExecuteTaskAction,
  },
  {
    type: 'odin_fix_skill',
    description: '修复指定技能',
    kind: 'agent',
    permissionCategory: 'agent',
    executionMode: 'non-blocking',
    parallelSafe: false,
    validate: validateOdinFixSkillAction,
  },
  {
    type: 'odin_upload_skill',
    description: '上传本地技能到 Odin 云端',
    kind: 'agent',
    permissionCategory: 'agent',
    executionMode: 'non-blocking',
    parallelSafe: false,
    validate: validateOdinUploadSkillAction,
  },
  {
    type: 'odin_import_cloud_skills',
    description: '导入 Odin 云端技能',
    kind: 'agent',
    permissionCategory: 'agent',
    executionMode: 'non-blocking',
    parallelSafe: false,
    validate: validateOdinImportCloudSkillsAction,
  },
  {
    type: 'generate_image',
    description: '生成图像',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateGenerateImageAction,
    execute: executeGenerateImage as any,
  },
  {
    type: 'generate_video',
    description: '生成视频',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateGenerateVideoAction,
    execute: executeGenerateVideo as any,
  },
  {
    type: 'synthesize_speech',
    description: '使用已配置的 TTS provider 将文本合成为音频文件。内置免费 Microsoft Edge TTS，无需 API key。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateSynthesizeSpeechAction,
    execute: executeSynthesizeSpeech as any,
  },
  {
    type: 'transcribe_audio',
    description: '使用免费的本地 Whisper 引擎转写音频文件。优先 whisper.cpp，其次 Python whisper；不需要 API key。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateTranscribeAudioAction,
    execute: executeTranscribeAudio as any,
  },
  {
    type: 'request_freya_visual_asset',
    description: '请求 Freya 视觉资源工作流',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'non-blocking',
    parallelSafe: false,
    validate: validateFreyaVisualAssetAction,
  },
  {
    type: 'agent',
    description: '代理执行工具，允许创建和管理独立的代理任务，支持并行执行和状态管理',
    kind: 'agent',
    permissionCategory: 'agent',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: validateAgentAction,
  },
];

const capabilityToolDefs: ToolDefinition[] = [
  {
    type: 'http_request',
    description: '发送HTTP请求',
    kind: 'shell',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.url, 'url', errors);
      return errors;
    },
  },
  {
    type: 'search',
    description: '执行网络搜索并返回结果摘要',
    kind: 'shell',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.query, 'query', errors);
      return errors;
    },
  },
  {
    type: 'web_scraper',
    description: '从指定 URL 提取网页内容',
    kind: 'shell',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.url, 'url', errors);
      return errors;
    },
  },
  {
    type: 'user_interaction',
    description: '允许 AI 主动向用户提问，获取反馈或确认',
    kind: 'function',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.question, 'question', errors);
      return errors;
    },
  },
  {
    type: 'confirm',
    description: '获取用户对某个问题的简单确认（是/否）',
    kind: 'function',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.question, 'question', errors);
      return errors;
    },
  },
  // NOTE: removed 3 stub tools (`todo`, `mcp`, `notebook_worktree`) that were
  // declared with executionMode='blocking' but had no `execute` function.
  // They were never callable from the brain (would throw at runtime). The
  // /mcp slash command lives in interactive.ts; TodoTool exists as a class
  // in src/tools/TodoTool/ but isn't currently wired through the agent loop.

  // ── Spotify integration ────────────────────────────────────────────────
  // brain-callable tools that drive Spotify Web API. Authentication via
  // /spotify login (OAuth PKCE flow). See src/tools/spotify/ for impl.
  {
    type: 'spotify_play_liked',
    description: '播放用户的 Liked Songs（点赞歌曲）。可选 shuffle 模式 + 指定设备。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeSpotifyPlayLiked } = await import('./spotify/spotifyTools.js');
      return executeSpotifyPlayLiked(action);
    }) as any,
  },
  {
    type: 'spotify_search_and_play',
    description: '搜索并播放（曲目或歌单）。query 必填。kind 默认 auto。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.query, 'query', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeSpotifySearchAndPlay } = await import('./spotify/spotifyTools.js');
      return executeSpotifySearchAndPlay(action);
    }) as any,
  },
  {
    type: 'spotify_play_playlist',
    description: '按名字播放用户/公开歌单。name 必填，优先匹配用户自己的歌单。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.name, 'name', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeSpotifyPlayPlaylist } = await import('./spotify/spotifyTools.js');
      return executeSpotifyPlayPlaylist(action);
    }) as any,
  },
  {
    type: 'spotify_resume',
    description: '恢复当前的 Spotify 播放（从暂停状态继续）。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeSpotifyResume } = await import('./spotify/spotifyTools.js');
      return executeSpotifyResume(action);
    }) as any,
  },
  {
    type: 'spotify_pause',
    description: '暂停 Spotify 播放。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeSpotifyPause } = await import('./spotify/spotifyTools.js');
      return executeSpotifyPause(action);
    }) as any,
  },
  {
    type: 'spotify_skip_next',
    description: '跳到下一首。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeSpotifySkipNext } = await import('./spotify/spotifyTools.js');
      return executeSpotifySkipNext(action);
    }) as any,
  },
  {
    type: 'spotify_skip_previous',
    description: '跳到上一首（或重播当前）。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeSpotifySkipPrevious } = await import('./spotify/spotifyTools.js');
      return executeSpotifySkipPrevious(action);
    }) as any,
  },
  {
    type: 'spotify_set_volume',
    description: '设置音量 0-100。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      if (typeof action?.volume !== 'number') {
        errors.push('volume must be a number 0-100');
      }
      return errors;
    },
    execute: (async (action: any) => {
      const { executeSpotifySetVolume } = await import('./spotify/spotifyTools.js');
      return executeSpotifySetVolume(action);
    }) as any,
  },
  {
    type: 'spotify_now_playing',
    description: '查询 Spotify 当前播放状态（歌名 / 歌手 / 设备 / 是否播放）。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeSpotifyNowPlaying } = await import('./spotify/spotifyTools.js');
      return executeSpotifyNowPlaying(action);
    }) as any,
  },
  {
    type: 'spotify_set_device',
    description: '将播放转移到指定设备（Spotify Connect 跨设备控制）。deviceHint 必填。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.deviceHint, 'deviceHint', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeSpotifySetDevice } = await import('./spotify/spotifyTools.js');
      return executeSpotifySetDevice(action);
    }) as any,
  },

  // ── Weather ────────────────────────────────────────────────────────────
  {
    type: 'weather_current',
    description: '查询指定城市的当前天气（温度、湿度、风速、天气描述）。城市名支持中英文。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.location, 'location', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeWeatherCurrent } = await import('./weather/weatherTools.js');
      return executeWeatherCurrent(action);
    }) as any,
  },
  {
    type: 'weather_forecast',
    description: '查询指定城市的多日天气预报（最多 3 天）。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.location, 'location', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeWeatherForecast } = await import('./weather/weatherTools.js');
      return executeWeatherForecast(action);
    }) as any,
  },

  // ── World clock / time diff ────────────────────────────────────────────
  {
    type: 'world_clock',
    description: '同时显示多个城市的当前时间。cities 数组接受城市名（中英文）或 IANA 时区。',
    kind: 'function',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: (action: any) => {
      const errors: string[] = [];
      if (!Array.isArray(action?.cities) || action.cities.length === 0) {
        errors.push('cities must be a non-empty array');
      }
      return errors;
    },
    execute: (async (action: any) => {
      const { executeWorldClock } = await import('./worldClock/worldClockTools.js');
      return executeWorldClock(action);
    }) as any,
  },
  {
    type: 'time_diff',
    description: '计算两个城市的时差（"我在曼谷给上海家人打电话现在合适吗"）。',
    kind: 'function',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.fromCity, 'fromCity', errors);
      validateRequiredNonEmptyString(action?.toCity, 'toCity', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeTimeDiff } = await import('./worldClock/worldClockTools.js');
      return executeTimeDiff(action);
    }) as any,
  },

  // ── Currency ───────────────────────────────────────────────────────────
  {
    type: 'currency_convert',
    description: '货币换算（如 5000 THB 换成 USD）。from / to 用 ISO 4217 代码（USD/CNY/THB/EUR 等），中文名也接受。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: (action: any) => {
      const errors: string[] = [];
      if (typeof action?.amount !== 'number') errors.push('amount must be a number');
      validateRequiredNonEmptyString(action?.from, 'from', errors);
      validateRequiredNonEmptyString(action?.to, 'to', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeCurrencyConvert } = await import('./currency/currencyTools.js');
      return executeCurrencyConvert(action);
    }) as any,
  },
  {
    type: 'currency_rates',
    description: '查询某基础货币对常见货币的当前汇率。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.base, 'base', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeCurrencyRates } = await import('./currency/currencyTools.js');
      return executeCurrencyRates(action);
    }) as any,
  },

  // ── Flight tracking ────────────────────────────────────────────────────
  {
    type: 'flight_lookup',
    description: '查询航班信息（航司、机型、起降城市）+ 实时位置（在飞行时）。callsign 为航班号如 "TG681"、"BA12"。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.callsign, 'callsign', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeFlightLookup } = await import('./flightTrack/flightTrackTools.js');
      return executeFlightLookup(action);
    }) as any,
  },

  // ── Apple Calendar (macOS native via osascript) ────────────────────────
  {
    type: 'calendar_list_today',
    description: '列出今日的 Apple Calendar 事件（macOS 限定，需授权日历访问）。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeCalendarList } = await import('./appleCalendar/appleCalendarTools.js');
      return executeCalendarList(action);
    }) as any,
  },
  {
    type: 'calendar_list_upcoming',
    description: '列出未来 N 天的 Apple Calendar 事件，N 默认 7。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeCalendarList } = await import('./appleCalendar/appleCalendarTools.js');
      return executeCalendarList(action);
    }) as any,
  },
  {
    type: 'calendar_add_event',
    description: '添加 Apple Calendar 事件。startISO 必填（ISO 8601 格式如 "2026-04-29T19:00:00"）。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.title, 'title', errors);
      validateRequiredNonEmptyString(action?.startISO, 'startISO', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeCalendarAddEvent } = await import('./appleCalendar/appleCalendarTools.js');
      return executeCalendarAddEvent(action);
    }) as any,
  },

  // ── Apple Reminders (macOS native) ─────────────────────────────────────
  {
    type: 'reminders_list',
    description: '列出 Apple Reminders 待办事项。可指定 list 名，默认列所有未完成。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: () => [],
    execute: (async (action: any) => {
      const { executeRemindersList } = await import('./appleReminders/appleRemindersTools.js');
      return executeRemindersList(action);
    }) as any,
  },
  {
    type: 'reminders_add',
    description: '添加 Apple Reminders 待办。可选 list / dueISO / notes。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.title, 'title', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeRemindersAdd } = await import('./appleReminders/appleRemindersTools.js');
      return executeRemindersAdd(action);
    }) as any,
  },
  {
    type: 'reminders_complete',
    description: '把指定标题的待办标记为完成（先尝试精确匹配，否则模糊匹配第一条）。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (action: any) => {
      const errors: string[] = [];
      validateRequiredNonEmptyString(action?.title, 'title', errors);
      return errors;
    },
    execute: (async (action: any) => {
      const { executeRemindersComplete } = await import('./appleReminders/appleRemindersTools.js');
      return executeRemindersComplete(action);
    }) as any,
  },

  // ── Browser automation (Playwright headed Chromium) ────────────────────
  {
    type: 'browser_navigate',
    description: '在本机 Chromium 浏览器中打开 URL。url 必填。当 http_request 被反爬阻挡时，切换到这条工具。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (a: any) => {
      const errs: string[] = [];
      validateRequiredNonEmptyString(a?.url, 'url', errs);
      return errs;
    },
    execute: (async (a: any) => {
      const { executeBrowserNavigate } = await import('./browser/browserTools.js');
      return executeBrowserNavigate(a);
    }) as any,
  },
  {
    type: 'browser_screenshot',
    description: '对当前浏览器页面截图。fullPage 控制是否截全页；width/height 可切换桌面或手机视口。返回截图路径和基础布局审计。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: () => [],
    execute: (async (a: any) => {
      const { executeBrowserScreenshot } = await import('./browser/browserTools.js');
      return executeBrowserScreenshot(a);
    }) as any,
  },
  {
    type: 'browser_extract_text',
    description: '提取当前页面（或指定 selector 的元素）可见文本。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: () => [],
    execute: (async (a: any) => {
      const { executeBrowserExtract } = await import('./browser/browserTools.js');
      return executeBrowserExtract(a);
    }) as any,
  },
  {
    type: 'browser_click',
    description: '点击当前页面元素。提供 selector（CSS）或 text（按可见文字匹配）至少一个。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (a: any) => {
      if (!a?.selector && !a?.text) return ['need selector or text'];
      return [];
    },
    execute: (async (a: any) => {
      const { executeBrowserClick } = await import('./browser/browserTools.js');
      return executeBrowserClick(a);
    }) as any,
  },
  {
    type: 'browser_type',
    description: '在表单输入框中输入文字。selector + text 必填，可选 pressEnter。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (a: any) => {
      const errs: string[] = [];
      validateRequiredNonEmptyString(a?.selector, 'selector', errs);
      if (typeof a?.text !== 'string') errs.push('text required');
      return errs;
    },
    execute: (async (a: any) => {
      const { executeBrowserType } = await import('./browser/browserTools.js');
      return executeBrowserType(a);
    }) as any,
  },
  {
    type: 'browser_wait_for',
    description: '等待元素出现（页面加载完成时使用）。selector 或 text 之一必填。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (a: any) => {
      if (!a?.selector && !a?.text) return ['need selector or text'];
      return [];
    },
    execute: (async (a: any) => {
      const { executeBrowserWait } = await import('./browser/browserTools.js');
      return executeBrowserWait(a);
    }) as any,
  },
  {
    type: 'browser_close',
    description: '关闭当前浏览器标签（保留 context 以便下次保留 cookie / 登录态）。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: () => [],
    execute: (async (a: any) => {
      const { executeBrowserClose } = await import('./browser/browserTools.js');
      return executeBrowserClose(a);
    }) as any,
  },

  // ── MCP self-management ────────────────────────────────────────────────
  {
    type: 'mcp_list',
    description: '列出当前 ~/.artemis/mcp-servers.json 中所有 MCP server 状态。可按 filter 子串过滤、status 过滤启用/禁用。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: () => [],
    execute: (async (a: any) => {
      const { executeMcpList } = await import('./mcpManage/mcpManageTools.js');
      return executeMcpList(a);
    }) as any,
  },
  {
    type: 'mcp_enable',
    description: '启用指定 MCP server。id 必填，需要精确匹配（先用 mcp_list 或 mcp_suggest 找正确 id）。注意启用后首次调用前可能要在 mcp-servers.json 补 API key/OAuth。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (a: any) => {
      const errs: string[] = [];
      validateRequiredNonEmptyString(a?.id, 'id', errs);
      return errs;
    },
    execute: (async (a: any) => {
      const { executeMcpEnable } = await import('./mcpManage/mcpManageTools.js');
      return executeMcpEnable(a);
    }) as any,
  },
  {
    type: 'mcp_disable',
    description: '禁用指定 MCP server。',
    kind: 'code',
    permissionCategory: 'execute',
    executionMode: 'blocking',
    parallelSafe: false,
    validate: (a: any) => {
      const errs: string[] = [];
      validateRequiredNonEmptyString(a?.id, 'id', errs);
      return errs;
    },
    execute: (async (a: any) => {
      const { executeMcpDisable } = await import('./mcpManage/mcpManageTools.js');
      return executeMcpDisable(a);
    }) as any,
  },
  {
    type: 'mcp_suggest',
    description: '基于 intent 描述推荐相关 MCP server。intent 必填（如 "机票查询"、"git 操作"）。',
    kind: 'code',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    validate: (a: any) => {
      const errs: string[] = [];
      validateRequiredNonEmptyString(a?.intent, 'intent', errs);
      return errs;
    },
    execute: (async (a: any) => {
      const { executeMcpSuggest } = await import('./mcpManage/mcpManageTools.js');
      return executeMcpSuggest(a);
    }) as any,
  },
];

export const toolDefs: ToolDefinition[] = [
  fileToolDef,
  systemToolDef,
  skillToolDef,
  securityAuditToolDef,
  ...actionToolDefs,
  ...capabilityToolDefs,
];

export function getToolDefinition(toolType: string): ToolDefinition | undefined {
  return toolDefs.find((def) => def.type === toolType);
}

export function getToolPermissionCategory(toolType: string): ToolPermissionCategory {
  return getToolDefinition(toolType)?.permissionCategory ?? 'none';
}

export function getToolExecutionMode(toolType: string): ToolDefinition['executionMode'] {
  return getToolDefinition(toolType)?.executionMode ?? 'blocking';
}

export function isRuntimeManagedTool(toolType: string): boolean {
  const definition = getToolDefinition(toolType);
  return Boolean(
    definition &&
      definition.executionMode === 'non-blocking' &&
      RUNTIME_MANAGED_TOOL_TYPES.has(toolType as AgentActionType),
  );
}

export function isDirectlyExecutableTool(toolType: string): boolean {
  const definition = getToolDefinition(toolType);
  return Boolean(
    definition &&
      definition.executionMode === 'blocking' &&
      typeof definition.execute === 'function',
  );
}

export function isToolAvailableForProvider(toolType: string): boolean {
  if (!ALL_AGENT_ACTION_TYPES.includes(toolType as AgentActionType)) {
    return false;
  }

  if (PROVIDER_EXCLUDED_ACTION_TYPES.has(toolType as AgentActionType)) {
    return false;
  }

  return isDirectlyExecutableTool(toolType) || isRuntimeManagedTool(toolType);
}

export function getExecutableToolDefinitions(): ToolDefinition[] {
  return toolDefs.filter((tool) => isDirectlyExecutableTool(tool.type));
}

export function getProviderCallableActionTypes(): AgentActionType[] {
  return ALL_AGENT_ACTION_TYPES.filter((type) => isToolAvailableForProvider(type));
}

export function isParallelReadOnlyAction(action: AgentAction): boolean {
  const definition = getToolDefinition(action.type);
  if (!definition?.parallelSafe) {
    return false;
  }

  if (PARALLEL_READ_ACTION_TYPES.has(action.type)) {
    return definition.permissionCategory === 'read';
  }

  return action.type === 'mcp_call_tool' && action.readOnly === true;
}

export function validateToolAction(action: any): string[] {
  const toolDef = getToolDefinition(action?.toolType || action?.type);
  if (!toolDef) {
    return ['Unknown tool type'];
  }

  return toolDef.validate ? toolDef.validate(action) : [];
}

export function renderDetailedToolManifest(): string {
  return toolDefs
    .map((def) => {
      const details = [
        `## ${def.type}`,
        def.description,
        `Kind: ${def.kind}`,
        `Permission: ${def.permissionCategory}`,
        `Execution: ${def.executionMode}`,
        `Direct executor: ${def.execute ? 'yes' : 'no'}`,
      ];
      if (ALL_AGENT_ACTION_TYPES.includes(def.type as AgentActionType)) {
        details.push(
          `Provider callable: ${isToolAvailableForProvider(def.type) ? 'yes' : 'no'}`,
        );
      }
      return details.join('\n');
    })
    .join('\n\n');
}

export function renderToolManifest(): string {
  return renderDetailedToolManifest();
}

export function validateToolRegistryIntegrity(): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();

  for (const tool of toolDefs) {
    seen.set(tool.type, (seen.get(tool.type) ?? 0) + 1);
    if (!tool.type || !tool.description || !tool.kind || !tool.permissionCategory) {
      errors.push(`Tool definition missing required fields: ${tool.type}`);
    }
  }

  for (const [toolType, count] of seen.entries()) {
    if (count > 1) {
      errors.push(`duplicate tool definition for ${toolType}`);
    }
  }

  for (const toolType of ALL_AGENT_ACTION_TYPES) {
    if (!getToolDefinition(toolType)) {
      errors.push(`tool registry is missing a definition for ${toolType}`);
    }
  }

  for (const toolType of RUNTIME_MANAGED_AGENT_ACTION_TYPES) {
    const tool = getToolDefinition(toolType);
    if (!tool) {
      continue;
    }
    if (tool.execute) {
      errors.push(`runtime-managed tool ${tool.type} must not define a direct executor`);
    }
    if (tool.executionMode !== 'non-blocking') {
      errors.push(`runtime-managed tool ${tool.type} should use executionMode=non-blocking`);
    }
  }

  for (const toolType of getProviderCallableActionTypes()) {
    if (!isDirectlyExecutableTool(toolType) && !isRuntimeManagedTool(toolType)) {
      errors.push(
        `provider-callable tool ${toolType} has no executor or runtime-managed handler`,
      );
    }
  }

  for (const toolType of ALL_AGENT_ACTION_TYPES) {
    if (
      !PROVIDER_EXCLUDED_ACTION_TYPES.has(toolType) &&
      !isDirectlyExecutableTool(toolType) &&
      !isRuntimeManagedTool(toolType)
    ) {
      errors.push(
        `tool ${toolType} is neither directly executable nor runtime-managed`,
      );
    }
  }

  return [...new Set(errors)];
}

export function getToolDefinitionByPermissionCategory(category: string): ToolDefinition[] {
  return toolDefs.filter((tool) => tool.permissionCategory === category);
}
