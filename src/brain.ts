/* eslint-disable @typescript-eslint/no-unused-vars */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { release as osRelease } from 'node:os';
import { ProviderStore, createGlobalProviderStore } from './providers/store.js';
import { resolveArtemisHomeDir, resolveDataRootDir } from './utils/fs.js';
import { annotateProviderResponse, createTrackedProviderFromConfig, recordProviderProfileTelemetry, } from './providers/telemetry.js';
import { Session } from './core/session.js';
import type { SessionMessage, SessionRecord, AgentAction, AssistantEnvelope } from './core/types.js';
import { estimateContextLimit, fmtTok, normalizeContextLimit } from './cli/hud.js';
import { hasPlatformCapabilities } from './providers/capabilities.js';
import {
    appendImageNote,
    loadVisionHelper,
    memoizeVisionHelper,
    prepareUserImagesForModel,
    type VisionHelper,
} from './core/visionHelper.js';
import { estimateTokens, estimateMessagesTokens, estimateToolSchemaTokens } from './core/tokenEstimation.js';
import {
    ContextOverflowError,
    buildContextOverflowMessage,
    createContextStorage,
    detectConversationLanguage,
    getCompactionSummary,
    isContextOverflowError,
    manageContext,
    measureContext,
    normalizeContextState,
    providerPromptTokens,
    recordProviderUsage,
    resolveContextBudget,
    resolveMaxContextTokens,
    spillToolResultIfLarge,
    type ContextBudget,
    type ContextState,
    type ContextStorage,
    type ManageReason,
    type SummarizeFn,
} from './core/compaction/index.js';
import {
    isRecoveryMessage,
    projectDirectToolNames,
    widenProjectedDirectToolNames,
} from './core/directToolProjection.js';
import { getToolDefinition } from './tools/registry.js';
import {
    getBackgroundTaskRegistry,
    type BackgroundTaskKind,
} from './core/backgroundTasks.js';
import { resolveExtensionRuntime } from './extensions/runtime.js';
import { EXTRA_TOOL_NAMES, executeExtraTool } from './tools/extras.js';
import { buildDirectNativeFunctionTools, listDirectToolNames } from './tools/directTools.js';
import type { ToolExecutionResult, WorkspaceSwitchRequest } from './tools/types.js';
import { withRuntimeLogSink, type RuntimeLogLevel } from './utils/log.js';
import {
    mapPermissionModeToToolAccess,
    normalizePermissionMode,
    type PermissionModeInput,
    type ToolAccessMode,
} from './security/permissionModes.js';
import {
    isPathInsideWorkspace,
    resolveWorkspaceCandidatePath,
    resolveWorkspaceForTargetPath,
} from './utils/workspaceRoots.js';
import type {
    ChatProvider,
    ImageAttachment,
    ProviderNativeToolCall,
    ProviderNativeToolOutput,
    ProviderResponse,
} from './providers/types.js';

const BASE_SYSTEM_PROMPT = `\
你是 Artemis，一个面向真实本地工作区的工程代理，工作方式遵循 Artemis 执行协议。
- 默认用中文回复，除非用户明确使用其他语言
- 直接、简洁、专业；不要寒暄，不要营销式措辞
- 你的目标不是"给建议"，而是亲自调工具完成检查、修改、验证，再汇报结果

[Artemis 执行协议]
- 收到任务先用一句话说要做什么，然后直接调工具动手——不要先讨论再行动
- 复杂任务（≥3 步）开局可以输出简短任务清单；每完成一个有意义阶段，用 1-2 句话更新“已经完成什么、下一步做什么”，不要等到最后才一次性总结
- 没有依赖的工具调用一律并行（同一回合发多个工具调用），有依赖才串行
- generate_image/generate_video 支持 runInBackground:true；只有当你能在没有生成文件路径的情况下继续做其它工作时才使用。当前答案或下一步工具依赖图片/视频结果时不要后台化，要等待真实工具结果。
- 工具返回是唯一依据；未看到工具结果不得声称完成、修好、运行成功
- 严禁伪造命令、工具结果、日志或文件内容

当任务涉及代码、文件、命令、配置、报错、重构、调试时：
- 先快速判断任务，再用工具自己检查，不要把本地命令执行转嫁给用户
- 优先用只读工具确认事实；修改时保持最小必要改动，遵循现有代码风格
- 局部修改优先用 replace_in_file；新建或整文件重写才用 write_file
- 修改后必须运行合适的验证；如果无法验证，要明确说明缺口
- 不要要求用户自己去跑 cat/ls/grep/find/npm/python/bash/sh——你有工具，直接调
- 不要因为少量上下文缺失就停止；先继续检查，再决定下一步

路径与工作区：
- 用户提到明确路径时按该路径操作，不要猜测或拼接错误根目录
- 当前工作区不包含目标路径时先确认路径，依赖运行时的工作区切换流程继续
- 同一回合 run_command 触发的 cwd 变化持续生效；后续操作基于新 cwd

输出规则：
- 结论要和工具证据一致；不确定就说不确定
- 代码与命令用代码块或行内代码表示
- 进度展示要分段：完成调查、修改、验证、生成资产等有意义阶段后，给一个短更新；不要复读原始工具日志
- 因为用户已经看到了分段进度，任务结束时只做短收束：是否完成 + 关键文件/产物 + 验证结果；不要再输出完整流水账或很长的最终清单，除非用户明确要求
- 除非用户要求，否则不要长篇解释常识
`;

function buildLocaleInstruction(locale: 'en' | 'zh' = 'zh'): string {
    if (locale === 'en') {
        return [
            '',
            '[UI language override]',
            '- The current UI language is English.',
            '- Reply in English by default unless the user explicitly asks for another language.',
            '- For complex tasks, write progress checklists in English.',
            '- Use English checklist items such as:',
            '  - [ ] Inspect files',
            '  - [-] In progress',
            '  - [✅] Done',
            '- Final summaries, tool result summaries, and status updates should also be in English.',
        ].join('\n');
    }
    return [
        '',
        '[界面语言覆盖]',
        '- 当前界面语言是中文。',
        '- 默认用中文回复，除非用户明确要求其他语言。',
        '- 复杂任务的任务清单、进度更新、最终总结默认用中文。',
    ].join('\n');
}

let provider: any = null;
let providerConfig: any = null;
let providerTelemetryContext: any = null;
let providerCwd: string | null = null;
// mtimes of the provider stores the cached lead provider was built from.
let providerStoreStamp: string | null = null;
let session: any = null;
let systemPromptSuffix: string = '';
// Model used when no provider profile exists and only ANTHROPIC_API_KEY is
// set (no profile to take a model from). Shared with the CLI model label.
// TODO: this id is outdated; move to a current model once the env-only
// fallback is re-validated (hosted deployments always configure a profile).
export const ENV_FALLBACK_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
// Runtime overrides from CLI flags (--model, --api-key, --base-url)
let _modelOverride: any;
let _apiKeyOverride: any;
let _baseUrlOverride: any;
// Effort override from /effort. undefined = no override; null = force API default.
let _effortOverride: any;
let _lastPromptTokens = 0;
let _compressionThresholdOverride: number | undefined;
// setup.agent.compression: enabled=false turns off proactive compaction
// (overflow recovery stays on); maxContextTokens caps the window for cost.
let _compressionEnabled = true;
let _compressionMaxContextTokens: number | undefined;
// ── Dual-model worker provider ──────────────────────────────────────────────
// When the user configures a "specialist" profile (smaller/cheaper model),
// it's loaded here. Used for: summarization, compression, bulk digestion,
// search-result compaction. The main brain loop continues to use the lead
// provider (above). If no specialist is configured, worker* falls back to
// the lead provider, so callers can use it unconditionally.
let workerProvider: any = null;
let workerProviderConfig: any = null;
let workerProviderCwd: string | null = null;
let setupToolCache:
    | {
        cwd: string;
        loadedAt: number;
        enabled: Record<string, boolean>;
    }
    | null = null;

/**
 * Input size of the most recent provider request (cache reads and writes
 * included): the current context size, for the HUD. Not a sum across rounds.
 */
export function getLastPromptTokens() { return _lastPromptTokens; }

function noteRequestPromptTokens(usage: ProviderResponse['usage'] | undefined): void {
    const tokens = providerPromptTokens(usage) ?? usage?.promptTokens;
    if (typeof tokens === 'number' && tokens > 0) _lastPromptTokens = tokens;
}

/** Apply CLI flag overrides. Call once before first think(). */
export function applyProviderOverrides(opts: any) {
    _modelOverride = opts.model || _modelOverride;
    _apiKeyOverride = opts.apiKey || _apiKeyOverride;
    _baseUrlOverride = opts.baseUrl || _baseUrlOverride;
    provider = null; // force re-create with new settings
    providerCwd = null;
    workerProvider = null; // worker may need to re-resolve too
    workerProviderConfig = null;
    workerProviderCwd = null;
}

/** Switch model mid-session (e.g. from /model slash command). */
export function switchModel(model: any) {
    _modelOverride = model;
    provider = null;
    providerCwd = null;
    // Worker provider stays — switching the lead doesn't invalidate the specialist.
}

/** Switch reasoning effort mid-session (e.g. from /effort). Pass undefined to reset to API default. */
export function switchEffort(effort: any) {
    _effortOverride = effort ?? null;
    provider = null;
    providerCwd = null;
}

/** Current effective effort level, or undefined when running on the API default. */
export function getCurrentEffort(): string | undefined {
    if (_effortOverride === null) return undefined;
    return _effortOverride ?? providerConfig?.effort;
}

/** Return the current system prompt suffix (ARTEMIS.md content etc.). */
export function getSystemPromptSuffix(): string {
    return systemPromptSuffix ?? '';
}

/** Append project-specific instructions (e.g. from ARTEMIS.md) to the system prompt. */
export function setSystemPromptSuffix(suffix: any) {
    systemPromptSuffix = suffix;
    // Update the active session's system prompt in-place rather than nullifying
    // the session — nullifying destroys conversation history, which causes the
    // agent to lose all context after a workspace switch or ARTEMIS.md reload.
    if (session) {
        session.updateSystemPrompt(buildSystemPromptText());
    }
}

function buildHostEnvironmentBlock(): string {
    // Prepend host platform context so the model picks the right path syntax
    // (Windows: D:\\foo\\bar; macOS/Linux: /Users/.../foo; WSL: /mnt/d/...).
    // Without this, requests like "进入D盘新建420COMPANY" on Windows native
    // get a WSL-style /mnt/d/ guess that fails workspace-trust + filesystem
    // checks because the artemis process is on Win32, not WSL.
    const platform = (() => {
        if (process.platform === 'win32') return 'Windows (win32)';
        if (process.platform === 'darwin') return 'macOS (darwin)';
        if (process.platform === 'linux') {
            // WSL detection: WSL surfaces as platform=linux but runs Windows commands too.
            try {
                const release = osRelease().toLowerCase();
                if (release.includes('microsoft') || release.includes('wsl')) return 'WSL on Windows (linux+wsl)';
            } catch { /* ignore */ }
            return 'Linux';
        }
        return process.platform;
    })();
    const lines = [`[Host environment]`, `- OS: ${platform}`];
    if (process.platform === 'win32') {
        lines.push(
            '- Use Windows-native paths when the user names a drive: "D盘" / "D drive" → D:\\\\, NOT /mnt/d/.',
            '- Shell defaults to cmd.exe; do NOT generate bash-only syntax (mkdir -p, &&-chained POSIX assumptions, /tmp, ~).',
            '- Path separators in shell args usually need backslashes; in JSON / YAML / source code, forward slashes are fine.',
        );
    } else if (platform.startsWith('WSL')) {
        lines.push(
            '- Inside WSL: "D盘" / "D drive" maps to /mnt/d/. Use POSIX shell syntax. Native Windows tools may also be available via /mnt/c/Windows/...',
        );
    }
    lines.push('');
    return lines.join('\n');
}

// Loaded once at module init from ~/.artemis/dreams/learned-prompt.md and
// refreshed whenever a new dream gets composed. Kept separate from
// systemPromptSuffix so per-session ARTEMIS.md content never mixes with
// long-term style accumulated by the dream system.
let learnedDreamSuffix = '';
export function refreshLearnedDreamSuffix(text: string): void {
    learnedDreamSuffix = text?.trim() ?? '';
    if (session) {
        session.updateSystemPrompt(buildSystemPromptText());
    }
}
// Best-effort load on module init — ignore failures so an io error here
// can't block the brain from starting.
void (async () => {
    try {
        const { loadLearnedPrompt } = await import('./services/dreamStore.js');
        const text = await loadLearnedPrompt();
        if (text) learnedDreamSuffix = text;
    } catch { /* ignore */ }
})();

function buildCheckpointInstruction(locale = 'zh'): string {
    if (locale === 'en') {
        return [
            '',
            '[Context compaction / anti-amnesia]',
            '- Long conversations are compacted automatically. When the history starts with a "[Context compacted]" message, it holds a structured summary of the earlier conversation (goals, decisions, files, open work) and names the archive file with the full earlier history.',
            '- Read that archive with read_file or search_files when exact earlier details matter. Old tool results may be replaced by one-line placeholders naming the file that holds the full output.',
            '- Never restart a task from scratch after a compaction — continue from the summary.',
        ].join('\n');
    }
    return [
        '',
        '[上下文压缩 / 防失忆]',
        '- 长对话会被自动压缩。如果历史以「[上下文已压缩]」消息开头，它包含之前对话的结构化摘要（目标、决策、文件、待办），并给出完整早期历史的归档文件路径。',
        '- 需要原文细节时，用 read_file 或 search_files 读取该归档。旧的工具输出可能被替换为一行占位符，其中写明完整输出所在的文件。',
        '- 压缩之后不要从头重做任务——从摘要继续。',
    ].join('\n');
}

function buildSystemPromptText(locale: 'en' | 'zh' = 'zh') {
    const env = buildHostEnvironmentBlock();
    const learned = learnedDreamSuffix
        ? `\n\n[Long-term style accumulated from dreams]\n${learnedDreamSuffix}`
        : '';
    const base = `${env}${BASE_SYSTEM_PROMPT}\n${buildLocaleInstruction(locale)}\n${buildCheckpointInstruction(locale)}${learned}`;
    return systemPromptSuffix
        ? `${base}\n${systemPromptSuffix}`
        : base;
}

const SETUP_TOOL_NAME_GROUPS: Record<string, readonly string[]> = {
    web: [
        'search_web',
        'deep_research',
        'http_request',
        'check_url',
        'download_file',
        'dns_lookup',
        'parse_url',
        'weather_current',
        'weather_forecast',
        'world_clock',
        'time_diff',
        'currency_convert',
        'currency_rates',
        'flight_lookup',
    ],
    browser: [
        'browser_navigate',
        'browser_screenshot',
        'browser_extract_text',
        'browser_click',
        'browser_type',
        'browser_wait_for',
        'browser_close',
    ],
    terminal: [
        'run_command',
        'git_status',
        'git_diff',
        'git_log',
        'git_add',
        'git_commit',
        'git_branch',
        'npm_run',
        'which_command',
        'get_system_info',
        'date_now',
    ],
    file: [
        'list_files',
        'read_file',
        'search_files',
        'write_file',
        'insert_in_file',
        'replace_in_file',
        'apply_patch',
        'delete_file',
        'move_file',
        'copy_file',
        'create_directory',
        'delete_directory',
        'file_info',
        'list_directory',
        'count_lines',
        'hash_file',
        'path_info',
        'get_imports',
        'notebook_create',
        'notebook_list',
        'notebook_update',
        'notebook_delete',
        'notebook_view',
        'notebook_search',
        'notebook_addTag',
        'notebook_removeTag',
        'notebook_tree',
    ],
    code_execution: [
        'calculate',
        'regex_match',
        'json_query',
        'format_json',
        'diff_text',
        'sort_lines',
        'dedupe_lines',
        'base64_encode',
        'base64_decode',
        'hash_text',
        'generate_uuid',
        'format_code',
        'url_encode',
    ],
    image_gen: [
        'generate_image',
        'generate_video',
    ],
};

const SETUP_TOOL_GROUP_BY_NAME = new Map<string, string>(
    Object.entries(SETUP_TOOL_NAME_GROUPS).flatMap(([group, names]) =>
        names.map((name) => [name, group] as const),
    ),
);

async function loadSetupToolEnabled(cwd: string): Promise<Record<string, boolean>> {
    const resolvedCwd = path.resolve(cwd);
    if (
        setupToolCache &&
        setupToolCache.cwd === resolvedCwd &&
        Date.now() - setupToolCache.loadedAt < 1000
    ) {
        return setupToolCache.enabled;
    }

    const store = new ProviderStore(resolvedCwd);
    const data = await store.load();
    setupToolCache = {
        cwd: resolvedCwd,
        loadedAt: Date.now(),
        enabled: data.setup?.tools.enabled ?? {},
    };
    return setupToolCache.enabled;
}

function isSetupToolEnabled(
    enabled: Record<string, boolean>,
    group: string,
): boolean {
    return enabled[group] !== false;
}

function filterDirectToolsBySetup(
    toolNames: readonly string[],
    enabled: Record<string, boolean>,
): string[] {
    return toolNames.filter((name) => {
        const group = SETUP_TOOL_GROUP_BY_NAME.get(name);
        return group ? isSetupToolEnabled(enabled, group) : true;
    });
}

function getDisabledToolGroup(
    toolName: string,
    enabled: Record<string, boolean>,
): string | undefined {
    const group = SETUP_TOOL_GROUP_BY_NAME.get(toolName);
    if (!group || isSetupToolEnabled(enabled, group)) {
        return undefined;
    }
    return group;
}

function resolveProjectedDirectToolNames(
    messages: SessionMessage[],
    enabled: Record<string, boolean>,
    widenAttempt: number,
    currentToolNames: string[],
): string[] {
    const allEnabledTools = filterDirectToolsBySetup(listDirectToolNames(), enabled);
    if (allEnabledTools.length === 0) {
        return [];
    }

    const rawProjection =
        widenAttempt > 0
            ? widenProjectedDirectToolNames(
                messages,
                currentToolNames.length > 0 ? currentToolNames : projectDirectToolNames(messages),
                widenAttempt - 1,
            )
            : projectDirectToolNames(messages);

    const projected = filterDirectToolsBySetup(rawProjection, enabled);

    // Fail open for ambiguous prompts. The projection always includes a small
    // core read surface; if no task-specific tool family was selected, keeping
    // only that core would be a quality regression for natural-language tasks
    // such as reminders, music, browser automation, or integrations we have not
    // learned to classify yet. In that case, preserve the old all-tools behavior.
    if (widenAttempt === 0 && projected.length <= 8) {
        return allEnabledTools;
    }

    return projected.length > 0 ? projected : allEnabledTools;
}

// ── provider ──────────────────────────────────────────────────────────────────
/**
 * Modification times of the cwd-local and global providers.json. A long-lived
 * bridge re-reads its provider when either changes (for example the platform
 * rewrote the profile after a plan change, flipping supportsImages).
 */
async function readProviderStoreStamp(cwd: string): Promise<string> {
    const files = [
        path.join(resolveDataRootDir(cwd), 'providers.json'),
        path.join(resolveArtemisHomeDir(), 'providers.json'),
    ];
    const times = await Promise.all(files.map(async (file) => {
        try {
            return String((await stat(file)).mtimeMs);
        } catch {
            return '-';
        }
    }));
    return times.join('|');
}

async function loadProvider(cwd: string = process.cwd()) {
    const requestedCwd = path.resolve(cwd);
    if (provider && providerCwd === requestedCwd) {
        if (providerStoreStamp === await readProviderStoreStamp(requestedCwd))
            return provider;
        // The stores changed: rebuild the lead and the worker from them.
        workerProvider = null;
        workerProviderConfig = null;
        workerProviderCwd = null;
    }
    // 1. Try cwd-local .artemis/providers.json
    const currentCwd = requestedCwd;
    const store = new ProviderStore(currentCwd);
    const data = await store.load();
    let config = store.getDefaultMainProfile(data);
    let telemetryCwd = currentCwd;
    _compressionThresholdOverride = data.setup?.agent.compression.threshold;
    _compressionEnabled = data.setup?.agent.compression.enabled !== false;
    _compressionMaxContextTokens = data.setup?.agent.compression.maxContextTokens;
    // 2. Fallback: try global ~/.artemis/providers.json
    if (!config) {
        const artemisHome = resolveArtemisHomeDir();
        const globalStore = createGlobalProviderStore();
        const globalData = await globalStore.load();
        config = globalStore.getDefaultMainProfile(globalData);
        if (config) {
            telemetryCwd = artemisHome;
            _compressionThresholdOverride = globalData.setup?.agent.compression.threshold;
            _compressionEnabled = globalData.setup?.agent.compression.enabled !== false;
            _compressionMaxContextTokens = globalData.setup?.agent.compression.maxContextTokens;
        }
    }
    // 3. Fallback: read ANTHROPIC_API_KEY from environment
    if (!config) {
        const key = process.env.ANTHROPIC_API_KEY;
        if (key) {
            config = {
                id: 'env-anthropic',
                protocol: 'messages',
                label: 'Anthropic (env)',
                apiKey: key,
                model: _modelOverride ?? ENV_FALLBACK_ANTHROPIC_MODEL,
                baseUrl: '',
            };
        }
    }
    if (!config) {
        throw new Error('No AI provider configured. Please set ANTHROPIC_API_KEY environment variable or run artemis config to configure.');
    }
    // Apply CLI overrides
    let finalConfig = { ...config };
    if (_modelOverride) {
        // Platform capabilities describe the profile's own model, not an
        // override: drop all four so the override model gets the name rules.
        const dropPlatformCapabilities = _modelOverride !== config.model && hasPlatformCapabilities(config);
        finalConfig = {
            ...finalConfig,
            model: _modelOverride,
            ...(dropPlatformCapabilities
                ? { supportsImages: undefined, contextLength: undefined, maxOutputTokens: undefined, capabilitiesSource: undefined }
                : {}),
        };
    }
    if (_apiKeyOverride) finalConfig = { ...finalConfig, apiKey: _apiKeyOverride };
    if (_baseUrlOverride) finalConfig = { ...finalConfig, baseUrl: _baseUrlOverride ?? undefined };
    if (_effortOverride !== undefined) finalConfig = { ...finalConfig, effort: _effortOverride ?? undefined };
    providerConfig = finalConfig;
    providerTelemetryContext =
        'id' in config
            ? {
                cwd: telemetryCwd,
                profileId: config.id,
                profileLabel: 'label' in config && typeof config.label === 'string'
                    ? config.label
                    : config.id,
            }
            : null;
    provider = createTrackedProviderFromConfig(finalConfig, {
        ...(providerTelemetryContext ?? {}),
    });
    providerCwd = currentCwd;
    // Taken after loading: load() itself may rewrite a store it repaired.
    providerStoreStamp = await readProviderStoreStamp(currentCwd);
    return provider;
}

function getProviderConfigSync() {
    return providerConfig;
}

// ── worker (specialist) provider ──────────────────────────────────────────────
/**
 * Load the worker (specialist) provider. Returns the same object as the lead
 * provider if no specialist profile is configured, so callers can blindly use
 * the result without checking for dual-model first.
 *
 * Resolution order matches loadProvider():
 *   1. cwd-local .artemis/providers.json
 *   2. global ~/.artemis/providers.json
 *   3. fallback to lead provider
 */
async function loadWorkerProvider(cwd: string = providerCwd ?? process.cwd()): Promise<{ provider: any; config: any }> {
    const requestedCwd = path.resolve(cwd);
    if (workerProvider && workerProviderConfig && workerProviderCwd === requestedCwd) {
        return { provider: workerProvider, config: workerProviderConfig };
    }

    // Make sure the lead is loaded so we can fall back to it
    await loadProvider(requestedCwd);

    // Try cwd-local
    const currentCwd = requestedCwd;
    const localStore = new ProviderStore(currentCwd);
    const localData = await localStore.load();
    let workerCfg = localStore.getProfile(localData, localData.specialistProfileId);
    let telemetryCwd = currentCwd;

    if (!workerCfg) {
        // Try global
        const artemisHome = resolveArtemisHomeDir();
        const globalStore = createGlobalProviderStore();
        const globalData = await globalStore.load();
        workerCfg = globalStore.getProfile(globalData, globalData.specialistProfileId);
        telemetryCwd = artemisHome;
    }

    if (!workerCfg) {
        // No specialist configured — fall back to lead. Cache so we don't keep
        // re-reading providers.json on every call.
        workerProviderConfig = providerConfig;
        workerProvider = provider;
        workerProviderCwd = requestedCwd;
        return { provider, config: providerConfig };
    }

    workerProviderConfig = workerCfg;
    workerProvider = createTrackedProviderFromConfig(workerCfg, {
        cwd: telemetryCwd,
        profileId: 'id' in workerCfg && typeof workerCfg.id === 'string' ? workerCfg.id : undefined,
        profileLabel:
            'label' in workerCfg && typeof (workerCfg as { label?: unknown }).label === 'string'
                ? (workerCfg as { label: string }).label
                : ('id' in workerCfg && typeof workerCfg.id === 'string' ? workerCfg.id : 'worker'),
    });
    workerProviderCwd = requestedCwd;

    return { provider: workerProvider, config: workerProviderConfig };
}

/** Reset the cached worker provider — used after providers.json changes. */
export function resetWorkerProvider() {
    workerProvider = null;
    workerProviderConfig = null;
    workerProviderCwd = null;
}

/** True if a distinct specialist profile is configured (different from main). */
export function hasDualModel(): boolean {
    if (!workerProviderConfig || !providerConfig) return false;
    if (workerProviderConfig === providerConfig) return false;
    // Same provider object reference is identity; deep model check guards
    // against the case where both profiles happen to point at the same model.
    const wModel = (workerProviderConfig as { model?: unknown }).model;
    const lModel = (providerConfig as { model?: unknown }).model;
    return Boolean(wModel) && wModel !== lModel;
}

/** Public accessor for the worker provider — used by external callers. */
export async function getWorkerProvider() {
    return loadWorkerProvider();
}

/**
 * Public accessor for the lead provider, for external callers that need
 * explicit access to the main/premium model.
 * This is the inverse of getWorkerProvider().
 */
export async function getLeadProvider(): Promise<{ provider: any; config: any }> {
    const p = await loadProvider(providerCwd ?? process.cwd());
    return { provider: p, config: providerConfig };
}

/**
 * Summarize a single prompt via the worker model when available.
 * Falls back to summarizeOnce's default behavior if no worker is configured
 * or the worker call fails. Use this for any "cheap, fast, high-throughput"
 * summarization: bulk file digests, search result compaction, tool output
 * compression before re-injecting into the main brain context.
 */
export async function summarizeViaWorker(prompt: string): Promise<string> {
    const { provider: p, config: cfg } = await loadWorkerProvider();
    if (cfg?.protocol === 'messages' && typeof cfg.apiKey === 'string' && cfg.apiKey.startsWith('sk-ant')) {
        const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
        try {
            const resp = await client.messages.create({
                model: cfg.model,
                max_tokens: 4096,
                messages: [{ role: 'user', content: prompt }],
            });
            const block = resp.content[0];
            return block?.type === 'text' ? block.text : '';
        } catch (workerErr) {
            // If worker is the same as lead, just rethrow. Otherwise fall back.
            if (cfg === providerConfig) throw workerErr;
            return summarizeOnce(prompt);
        }
    }
    // Generic provider path
    const sysMsg = {
        id: 'sum-sys',
        role: 'system' as const,
        content: 'You are a concise summarization assistant. Produce factual, compact summaries without speculation.',
        createdAt: new Date().toISOString(),
    };
    const userMsg = {
        id: 'sum-usr',
        role: 'user' as const,
        content: prompt,
        createdAt: new Date().toISOString(),
    };
    const result = await p.complete([sysMsg, userMsg]);
    recordBifrostAudit('worker', estimateResponseUsage(result, [sysMsg, userMsg]), [sysMsg, userMsg]);
    return result.text ?? '';
}

// ── session ───────────────────────────────────────────────────────────────────
function getSession(cwd: string = process.cwd()) {
    if (!session) session = new Session(buildSystemPromptText(), cwd);
    return session;
}

/** Reset conversation history (keeps provider alive). */
export function resetSession() {
    session = null;
    _lastPromptTokens = 0;
}

/**
 * Bridges and the CLI swap stored sessions in and out of the single active
 * session; per-session context state must not leak from one to the next.
 */
function resetContextState(activeSession: Session, contextState?: unknown, sessionId?: string): void {
    activeSession.deleteContext('compressionSummary');
    // A stored session brings its own state (anchor, breaker, compaction
    // index, calibration); anything else starts fresh.
    if (contextState && typeof contextState === 'object') {
        activeSession.setContext('contextState', normalizeContextState(contextState));
    } else {
        activeSession.deleteContext('contextState');
    }
    activeSession.setContext('contextSessionId', sessionId ?? newContextSessionId());
}

function newContextSessionId(): string {
    return `cli-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Context-management state of the active session, for callers that persist
 * it with their stored session (bridges keep it in metadata.context).
 */
export function getActiveContextState(): ContextState | undefined {
    const state = session?.getContext('contextState');
    return state ? normalizeContextState(state) : undefined;
}

async function completeSummaryPrompt(p: ChatProvider, system: string, prompt: string, auditRole: 'worker' | 'compression'): Promise<string> {
    const messages: SessionMessage[] = [
        { id: 'sum-sys', role: 'system', content: system, createdAt: new Date().toISOString() },
        { id: 'sum-usr', role: 'user', content: prompt, createdAt: new Date().toISOString() },
    ];
    const result = await p.complete(messages);
    recordBifrostAudit(auditRole, estimateResponseUsage(result, messages), messages);
    return result.text ?? '';
}

/**
 * Summarization call used by context compaction: the worker (specialist)
 * model when one is configured, else the main model; falls back to the main
 * model when the worker fails. No model id is hard-coded.
 */
const summarizeForCompaction: SummarizeFn = async ({ system, prompt, attempt }) => {
    const lead = await loadProvider(providerCwd ?? process.cwd());
    const { provider: workerP, config: workerCfg } = await loadWorkerProvider();
    // First try: the worker when one is configured. The single retry goes to
    // the main model; the context manager charges both to one input budget.
    const useWorker = (attempt ?? 0) === 0 && workerCfg && workerCfg !== providerConfig && workerP;
    return completeSummaryPrompt(useWorker ? workerP : lead, system, prompt, 'compression');
};

/** Context window of the model compaction summaries go to. */
async function resolveSummarizerWindow(): Promise<number | undefined> {
    try {
        const { provider: workerP, config: workerCfg } = await loadWorkerProvider();
        if (workerCfg && workerCfg !== providerConfig) {
            return workerP?.contextWindow ?? getConfiguredContextLimit(workerCfg.model, workerCfg.contextLength, hasPlatformCapabilities(workerCfg));
        }
    } catch { /* fall back to the lead window */ }
    return undefined;
}

/**
 * One-shot LLM call for summarization — does NOT touch the active session.
 * Uses the worker model when configured, else the main model.
 */
export const summarizeOnce = async (prompt: any): Promise<string> =>
    summarizeForCompaction({ system: 'You are a conversation summary assistant.', prompt: String(prompt ?? '') });

/** Restore a saved session's messages into the active session. */
export function restoreSession(messages: any) {
    const activeSession = getSession();
    activeSession.restore(messages);
    resetContextState(activeSession);
}

export function restoreSessionForCwd(messages: any, cwd: string) {
    const activeSession = getSession(cwd);
    activeSession.restore(messages);
    resetContextState(activeSession);
}

/**
 * Restore a stored session. `summary` is accepted for compatibility but not
 * re-injected: the rolling summary lives in the compaction boundary message
 * at the start of `messages`, and older sessions kept their full raw history.
 */
export function restoreSessionStateForCwd(
    state: { messages: any; summary?: string; contextState?: unknown; sessionId?: string },
    cwd: string,
) {
    const activeSession = getSession(cwd);
    activeSession.restore(state.messages);
    resetContextState(activeSession, state.contextState, state.sessionId);
}

/** The rolling compaction summary of the active session, if it was compacted. */
export function getCompressionSummary(cwd: string = process.cwd()): string | undefined {
    const summary = getCompactionSummary(getSession(cwd).getMessages());
    return summary && summary.trim() ? summary : undefined;
}

/** Return current messages (for session persistence). */
export function getMessages() {
    return getSession().getMessages();
}

/** Return provider info string (sync best-effort). */
export function providerInfo() {
    try {
        const cfg = getProviderConfigSync();
        if (!cfg) {
            const key = process.env.ANTHROPIC_API_KEY;
            if (key)
                return `Anthropic / ${_modelOverride ?? ENV_FALLBACK_ANTHROPIC_MODEL}`;
            return 'Not configured';
        }
        return `${cfg.protocol} / ${cfg.model ?? '?'}`;
    }
    catch {
        return 'Not configured';
    }
}

// ── Context budget awareness ──────────────────────────────────────────────────
const READ_FILE_HISTORY_INVALIDATING_TOOLS = new Set([
    'write_file',
    'insert_in_file',
    'replace_in_file',
    'apply_patch',
    'delete_file',
    'move_file',
    'copy_file',
    'create_directory',
    'delete_directory',
    'download_file',
    'run_command',
    'npm_run',
    'format_code',
    'git_add',
    'git_commit',
]);
type BifrostAuditSample = {
    at: string;
    role: 'main' | 'worker' | 'compression';
    model?: string;
    profileLabel?: string;
    messageCount: number;
    roleBreakdown: Record<string, number>;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    source: 'provider' | 'estimated';
};
const bifrostAuditSamples: BifrostAuditSample[] = [];

function messageRoleBreakdown(messages: SessionMessage[]): Record<string, number> {
    return messages.reduce<Record<string, number>>((acc, msg) => {
        acc[msg.role] = (acc[msg.role] ?? 0) + 1;
        return acc;
    }, {});
}

function recordBifrostAudit(role: BifrostAuditSample['role'], result: ProviderResponse, messages: SessionMessage[]) {
    const usage = result.usage ?? {};
    const promptTokens = Math.round(usage.promptTokens ?? estimateConversationTokens(messages));
    const completionTokens = Math.round(usage.completionTokens ?? estimateTokens(String(result.text ?? '')));
    bifrostAuditSamples.push({
        at: new Date().toISOString(),
        role,
        model: result.model ?? providerConfig?.model,
        profileLabel: usage.profileLabel,
        messageCount: messages.length,
        roleBreakdown: messageRoleBreakdown(messages),
        promptTokens,
        completionTokens,
        totalTokens: Math.round(usage.totalTokens ?? promptTokens + completionTokens),
        source: usage.source ?? 'estimated',
    });
    while (bifrostAuditSamples.length > 50) bifrostAuditSamples.shift();
}

export function getBifrostContextAuditReport(): string[] {
    if (bifrostAuditSamples.length === 0) {
        return ['No provider calls recorded yet in this process.'];
    }
    const latest = bifrostAuditSamples.slice(-12);
    const totals = bifrostAuditSamples.reduce<Record<string, { calls: number; prompt: number; total: number }>>((acc, sample) => {
        const bucket = acc[sample.role] ?? { calls: 0, prompt: 0, total: 0 };
        bucket.calls += 1;
        bucket.prompt += sample.promptTokens;
        bucket.total += sample.totalTokens;
        acc[sample.role] = bucket;
        return acc;
    }, {});
    const lines = ['Recent provider context audit:', ''];
    for (const sample of latest) {
        const roles = Object.entries(sample.roleBreakdown).map(([k, v]) => `${k}:${v}`).join(' ');
        lines.push(`${sample.at.slice(11, 19)}  ${sample.role.padEnd(11)} ${sample.source === 'estimated' ? '~' : ''}${sample.promptTokens}/${sample.totalTokens} tok  msgs=${sample.messageCount} (${roles})  ${sample.model ?? 'unknown'}`);
    }
    lines.push('', 'Totals:');
    for (const [role, bucket] of Object.entries(totals)) {
        lines.push(`  ${role}: calls=${bucket.calls} prompt=${bucket.prompt} total=${bucket.total}`);
    }
    return lines;
}

/**
 * `authoritative` marks a platform-written contextLength (capabilitiesSource
 * "platform"): it is used as-is, never capped or replaced by name rules.
 */
function getConfiguredContextLimit(model: string | undefined, contextLength?: number, authoritative = false): number {
    return estimateContextLimit(model ?? '', normalizeContextLimit(contextLength), authoritative);
}

function estimateConversationTokens(messages: SessionMessage[]): number {
    // 统一走 core/tokenEstimation（UTF-8 字节/4 + 图片常数），中文不再低估。
    return estimateMessagesTokens(messages);
}

async function buildRuntimeSystemMessages(
    systemPrompt: string,
    conversationMessages: SessionMessage[],
    model?: string,
): Promise<SessionMessage[]> {
    const runtimeMessages = [makeSessionMessage('system', systemPrompt)];
    if (!model) {
        return runtimeMessages;
    }

    // 自动解析与设计相关的任务并添加对应的技能
    const latestUserText = getLatestUserText(conversationMessages);
    const ctx = await resolveExtensionRuntime(process.cwd(), latestUserText);
    
    // 添加技能内容到系统提示
    if (ctx.activeSkills.length > 0) {
        const skillsSection = ctx.sections.find(section => section.includes('Local skills activated'));
        if (skillsSection) {
            runtimeMessages.push(makeSessionMessage('system', skillsSection));
        }
    }
    // No context-usage note: it changed the system prompt every turn (breaking
    // the prompt cache) and compaction now keeps the context within budget.
    return runtimeMessages;
}

// ── 防失忆存档日志（CHECKPOINT）─────────────────────────────────────────────
// 每次真正压缩时，把完整任务状态写进本地 md（带时间戳、可追加历史）。它只躺在
// 硬盘上、按需读取，所以正常运行几乎不耗 token；上下文被压缩/清理后，agent 可以
// 读它恢复「目标 / 进度 / 下一步」，避免失忆。两层结构：精简「当前状态」+ 追加历史。
function checkpointJournalPath(cwd: string): string {
    const key = createHash('sha1').update(cwd).digest('hex').slice(0, 12);
    return path.join(resolveArtemisHomeDir(), 'checkpoints', `${key}.md`);
}

async function writeCheckpointJournal(
    cwd: string,
    summaryText: string | undefined,
    pendingNext: string | undefined,
    currentFocus: string | undefined,
): Promise<void> {
    try {
        const file = checkpointJournalPath(cwd);
        await mkdir(path.dirname(file), { recursive: true });
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        // 保留追加式历史（最近 40 个压缩点）。
        let history = '';
        try {
            const prev = await readFile(file, 'utf8');
            const marker = '## 🗂 历史存档';
            const idx = prev.indexOf(marker);
            if (idx >= 0) history = prev.slice(prev.indexOf('\n', idx) + 1).trim();
        } catch { /* 无旧文件 */ }
        const clean = (v: string | undefined, n: number): string =>
            (v ?? '—').replace(/\s+/g, ' ').slice(0, n);
        const entry = `- [${ts}] 压缩存档 · 焦点: ${clean(currentFocus, 80)} · 下一步: ${clean(pendingNext, 120)}`;
        const histLines = [entry, ...history.split('\n').filter((l) => l.trim().startsWith('- ['))].slice(0, 40);
        const content = [
            '# Artemis 任务存档 · CHECKPOINT',
            '',
            '> 防「失忆」存档。如果你刚经历上下文压缩、对当前任务不确定，先读「📍 当前状态」恢复记忆；需要细节再翻「🗂 历史存档」。',
            '',
            `## 📍 当前状态 (更新于 ${ts})`,
            `- 工作区: ${cwd}`,
            `- 当前焦点: ${currentFocus ?? '—'}`,
            `- 下一步(待执行): ${pendingNext ?? '—'}`,
            '',
            '### 任务摘要',
            (summaryText && summaryText.trim()) ? summaryText.trim() : '(尚无摘要)',
            '',
            '## 🗂 历史存档 (最近 40 个压缩点)',
            histLines.join('\n'),
            '',
        ].join('\n');
        await writeFile(file, content, 'utf8');
    } catch { /* 存档绝不能拖垮主流程 */ }
}

// ── Tool definitions for Anthropic API ───────────────────────────────────────
// ── Convert SessionMessage[] → Anthropic MessageParam[] ──────────────────────
function toAnthropicMessages(messages: any) {
    const result: any[] = [];
    let i = 0;
    while (i < messages.length) {
        const msg = messages[i];
        if (msg.role === 'system') {
            i++;
            continue;
        }
        if (msg.role === 'assistant') {
            if (msg.contentBlocks && msg.contentBlocks.length > 0) {
                result.push({ role: 'assistant', content: msg.contentBlocks });
            }
            else {
                result.push({ role: 'assistant', content: msg.content });
            }
            i++;
            continue;
        }
        if (msg.role === 'tool') {
            // Group consecutive tool messages into one user message with tool_result blocks
            const toolResults: any[] = [];
            while (i < messages.length && messages[i].role === 'tool') {
                const t = messages[i];
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: t.toolUseId ?? '',
                    content: t.content,
                });
                i++;
            }
            result.push({ role: 'user', content: toolResults });
            continue;
        }
        // Regular user message
        result.push({ role: 'user', content: msg.content });
        i++;
    }
    return result;
}

type DirectToolError = {
    code: string;
    message: string;
    retryable?: boolean;
    availableTools?: string[];
    details?: Record<string, unknown>;
};

type DirectToolResult = {
    ok: boolean;
    output: string;
    error?: DirectToolError;
};

type DirectToolFailureState = {
    toolName: string;
    output: string;
    error?: DirectToolError;
};

type DirectToolContextOutput = {
    fullOutput: string;
    contextOutput: string;
    artifactPath?: string;
};

/**
 * Tool output as it enters the history. Output above the inline budget is
 * written to the session's tool-results directory and replaced by a preview
 * (head and tail, newlines intact) plus the path, so nothing is cut silently.
 */
function prepareDirectToolContextOutput(
    toolName: string,
    fullOutput: string,
    storage: ContextStorage,
    budget: ContextBudget,
): DirectToolContextOutput {
    const spilled = spillToolResultIfLarge(fullOutput, {
        storage,
        toolName,
        inlineTokens: budget.inlineToolResultTokens,
        inlineReadTokens: budget.inlineReadTokens,
        previewTokens: budget.toolPreviewTokens,
    });
    return { fullOutput, contextOutput: spilled.content, artifactPath: spilled.savedTo };
}

/** Context files of path B sessions that have no stored session id (per workspace). */
/**
 * Context files of path B conversations without a stored-session directory
 * (the interactive CLI): one directory per conversation under the workspace.
 */
function defaultContextDir(cwd: string, conversationId: string): string {
    const key = createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 12);
    return path.join(resolveArtemisHomeDir(), 'context', key, conversationId.replace(/[^\w.-]/g, '_'));
}

function buildDirectToolError(
    code: string,
    message: string,
    options: {
        retryable?: boolean;
        availableTools?: string[];
        details?: Record<string, unknown>;
    } = {},
): DirectToolError {
    return {
        code,
        message,
        retryable: options.retryable,
        ...(options.availableTools ? { availableTools: options.availableTools } : {}),
        ...(options.details ? { details: options.details } : {}),
    };
}

function buildDirectToolFailure(
    code: string,
    message: string,
    options: {
        retryable?: boolean;
        output?: string;
        availableTools?: string[];
        details?: Record<string, unknown>;
    } = {},
): DirectToolResult {
    return {
        ok: false,
        output: options.output ?? message,
        error: buildDirectToolError(code, message, options),
    };
}

function buildDirectToolValidationFailure(
    name: string,
    errors: string[],
): DirectToolResult {
    const message = [
        `Invalid arguments for tool ${name}:`,
        ...errors.map((error) => `- ${error}`),
    ].join('\n');

    return buildDirectToolFailure('tool_invalid_arguments', message, {
        retryable: true,
        details: { errors },
    });
}

function attachDirectToolFailureError(
    name: string,
    result: DirectToolResult,
): DirectToolResult {
    if (result.ok || result.error) {
        return result;
    }

    const message =
        result.output ||
        `Tool ${name} returned ok=false without a structured error.`;

    return {
        ...result,
        error: {
            code: 'tool_reported_failure',
            message,
            retryable: true,
        },
    };
}

function formatDirectToolOutput(result: DirectToolResult): string {
    if (result.ok || !result.error) {
        return result.output;
    }

    return JSON.stringify(
        {
            ok: false,
            output: result.output,
            error: result.error,
        },
        null,
        2,
    );
}

function replyMakesCompletionClaim(reply: string): boolean {
    return /(?:success(?:ful)?|succeeded|completed|done|installed|built|verified|works|成功|已成功|完成|已完成|安装成功|编译成功|验证通过|正常运行|能正常运行)/i.test(reply);
}

function replyAcknowledgesFailure(reply: string): boolean {
    return /(?:fail(?:ed|ure)?|error|denied|permission|not found|unavailable|blocked|unable|cannot|could not|missing.{0,40}(?:failed|not|could|unavailable|blocked)|(?:failed|not|could|unavailable|blocked).{0,40}missing|失败|报错|错误|拒绝|权限|缺失.{0,40}(?:失败|无法|不能|不存在|找不到|不可用|阻止)|不存在|找不到|不可用|被阻止|无法|不能|未成功)/i.test(reply);
}

function shouldGuardUnresolvedDirectToolFailure(
    reply: string,
    failure: DirectToolFailureState | null,
): failure is DirectToolFailureState {
    const text = reply.trim();
    return Boolean(
        failure &&
        text &&
        replyMakesCompletionClaim(text) &&
        !replyAcknowledgesFailure(text),
    );
}

function buildDirectToolFailureGuardMessage(
    failure: DirectToolFailureState,
    reply: string,
): SessionMessage {
    const details = [
        `[tool:${failure.toolName}]`,
        failure.error?.code ? `error_code: ${failure.error.code}` : undefined,
        failure.output ? `output:\n${failure.output.slice(0, 1600)}` : undefined,
    ].filter((line): line is string => Boolean(line));

    return makeSessionMessage(
        'user',
        [
            '[tool:runtime_guard]',
            'A direct tool call failed earlier in this turn, but the draft final reply claimed completion without acknowledging that failure.',
            'Do not claim success unless you have recovered with additional tool evidence. Either perform a recovery action with tools or explicitly report the blocker/failure to the user.',
            '',
            'Failed tool evidence:',
            ...details,
            '',
            'Blocked draft reply:',
            reply.slice(0, 1200),
        ].join('\n'),
    );
}

function buildDirectToolFailureFinalReply(
    failure: DirectToolFailureState,
    reply: string,
): string {
    const details = [
        `Failed tool: ${failure.toolName}`,
        failure.error?.code ? `Error code: ${failure.error.code}` : undefined,
        failure.output ? `Output:\n${failure.output.slice(0, 1600)}` : undefined,
    ].filter((line): line is string => Boolean(line));

    return [
        'I could not safely claim completion because a required tool call failed and the provider did not recover before the tool-round limit.',
        '',
        ...details,
        '',
        'Discarded draft reply:',
        reply.slice(0, 1200),
    ].join('\n');
}

const EXTRA_TOOL_PATH_KEYS: Record<string, string[]> = {
    delete_file: ['path'],
    move_file: ['from', 'to'],
    copy_file: ['from', 'to'],
    create_directory: ['path'],
    delete_directory: ['path'],
    file_info: ['path'],
    list_directory: ['path'],
    count_lines: ['path'],
};

function commonPathPrefix(paths: string[]): string | null {
    if (paths.length === 0) {
        return null;
    }

    const windowsLike = paths.every((entry) => /^[A-Za-z]:(?:[\\/]|$)|^\\\\/.test(entry));
    const pathApi = windowsLike ? path.win32 : path;
    const resolvedPaths = paths.map((entry) => pathApi.resolve(entry));
    const roots = resolvedPaths.map((entry) => pathApi.parse(entry).root);
    const firstRoot = roots[0];
    if (!firstRoot || roots.some((root) => root.toLowerCase() !== firstRoot.toLowerCase())) {
        return null;
    }

    const splitPaths = resolvedPaths.map((entry, index) => {
        const withoutRoot = entry.slice(roots[index]!.length);
        return withoutRoot.split(pathApi.sep).filter(Boolean);
    });
    const minLength = Math.min(...splitPaths.map((segments) => segments.length));
    const shared: string[] = [];

    for (let index = 0; index < minLength; index += 1) {
        const segment = splitPaths[0]?.[index];
        if (!segment || splitPaths.some((segments) => segments[index] !== segment)) {
            break;
        }
        shared.push(segment);
    }

    if (shared.length === 0) {
        return firstRoot;
    }

    return pathApi.join(firstRoot, ...shared);
}

async function maybeSwitchWorkspaceForExtraTool(
    name: string,
    input: Record<string, unknown>,
    opts: {
        cwd: string;
        updateCwd?: (newCwd: string) => void | Promise<void>;
        onWorkspaceSwitchRequest?: (request: WorkspaceSwitchRequest) => Promise<boolean>;
    },
): Promise<{ cwd: string; failure?: DirectToolResult }> {
    const pathKeys = EXTRA_TOOL_PATH_KEYS[name];
    if (!pathKeys || !opts.onWorkspaceSwitchRequest) {
        return { cwd: opts.cwd };
    }

    const requestedPaths: string[] = [];
    for (const key of pathKeys) {
        const rawValue = input[key];
        if (typeof rawValue !== 'string' || !rawValue.trim()) {
            continue;
        }
        const candidate = resolveWorkspaceCandidatePath(rawValue.trim(), opts.cwd);
        if (!isPathInsideWorkspace(opts.cwd, candidate)) {
            requestedPaths.push(candidate);
        }
    }

    if (requestedPaths.length === 0) {
        return { cwd: opts.cwd };
    }

    const commonTarget = commonPathPrefix(requestedPaths);
    if (!commonTarget) {
        return {
            cwd: opts.cwd,
            failure: buildDirectToolFailure(
                'tool_workspace_switch_failed',
                `Tool ${name} targets multiple unrelated workspaces. Switch to the intended root first.`,
                { retryable: false },
            ),
        };
    }
    const resolution = await resolveWorkspaceForTargetPath(commonTarget, opts.cwd);
    if (!resolution) {
        return {
            cwd: opts.cwd,
            failure: buildDirectToolFailure(
                'tool_workspace_switch_failed',
                `Workspace switch failed for tool ${name}.`,
                { retryable: true },
            ),
        };
    }

    const accepted = await opts.onWorkspaceSwitchRequest({
        requestedPath: resolution.requestedPath,
        workspacePath: resolution.workspacePath,
        usedNearestExistingParent: resolution.usedNearestExistingParent,
        source: 'tool-path',
        toolName: name,
        originalPath: requestedPaths.join(', '),
        switchNow: true,
    });
    if (!accepted) {
        return {
            cwd: opts.cwd,
            failure: buildDirectToolFailure(
                'tool_workspace_switch_declined',
                `Workspace switch declined for tool ${name}.`,
                { retryable: false },
            ),
        };
    }

    await Promise.resolve(opts.updateCwd?.(resolution.workspacePath));
    return { cwd: resolution.workspacePath };
}

// ── Tool execution with permission gate ──────────────────────────────────────
async function executeTool(name: any, input: any, opts: any) {
    return withRuntimeLogSink(
        opts.onToolLog
            ? (entry) => opts.onToolLog(entry.message, entry.level)
            : undefined,
        () => executeToolInner(name, input, opts),
    );
}

async function executeToolInner(name: any, input: any, opts: any) {
    const { cwd, permissionMode, onPermissionRequest, updateCwd, onWorkspaceSwitchRequest, onUserConfirmationRequest, readFileHistory } = opts;
    const argsRecord = (input && typeof input === 'object') ? input : {};
    const enabledTools = await loadSetupToolEnabled(cwd);
    const disabledGroup = getDisabledToolGroup(String(name), enabledTools);
    if (disabledGroup) {
        return buildDirectToolFailure(
            'tool_disabled_by_setup',
            `Tool "${name}" is disabled by Full Setup group "${disabledGroup}". Re-enable it with "artemis setup tools".`,
            { retryable: false },
        );
    }
    // ── Extra tools (file ops, git, text, crypto, network, dev) ──────────────
    if (EXTRA_TOOL_NAMES.has(name)) {
        // Determine permission category for gate.
        // Shell tools execute user-controlled subprocess (hooks, npm scripts,
        // formatter plugins) — they must NOT bypass shell gates in WRITER mode.
        const shellTools = new Set(['git_commit', 'npm_run', 'format_code']);
        const writeTools = new Set(['delete_file', 'move_file', 'copy_file', 'create_directory',
            'delete_directory', 'git_add', 'download_file']);
        const cat = shellTools.has(name) ? 'shell' : writeTools.has(name) ? 'write' : 'read';
        const denied = await checkPermission(name, cat, permissionMode, onPermissionRequest, argsRecord);
        if (denied)
            return buildDirectToolFailure('tool_permission_denied', denied, {
                retryable: false,
            });
        const workspace = await maybeSwitchWorkspaceForExtraTool(name, argsRecord, {
            cwd,
            updateCwd,
            onWorkspaceSwitchRequest,
        });
        if (workspace.failure) {
            return workspace.failure;
        }
        return attachDirectToolFailureError(
            name,
            await executeExtraTool(name, input, workspace.cwd, mapPermissionModeForToolContext(permissionMode)),
        );
    }
    // ── http_request is handled inline (not in TOOL_REGISTRY) ────────────────
    if (name === 'http_request') {
        const inp = input;
        const url = typeof inp.url === 'string' ? inp.url : '';
        const method = typeof inp.method === 'string' ? inp.method.toUpperCase() : 'GET';
        const body = typeof inp.body === 'string' ? inp.body : undefined;
        const hdrs = inp.headers ?? {};
        if (!url)
            return buildDirectToolValidationFailure(name, ['url is required.']);
        // Permission gate for non-GET
        if (method !== 'GET' && method !== 'HEAD') {
            const cat = 'write';
            const denied = await checkPermission(name, cat, permissionMode, onPermissionRequest, argsRecord);
            if (denied)
                return buildDirectToolFailure('tool_permission_denied', denied, {
                    retryable: false,
                });
        }
        try {
            const resp = await fetch(url, { method, body, headers: hdrs });
            const text = await resp.text();
            const preview = text.slice(0, 50_000);
            return {
                ok: resp.ok,
                output: `HTTP ${resp.status} ${resp.statusText}\n${preview}${text.length > 50_000 ? '\n[truncated]' : ''}`,
            };
        }
        catch (e) {
            const message = `http_request error: ${String(e)}`;
            return buildDirectToolFailure('tool_execution_failed', message, {
                retryable: false,
            });
        }
    }
    const tool = getToolDefinition(name);
    if (!tool)
        return buildDirectToolFailure('tool_unknown', `Unknown tool: ${name}`, {
            retryable: true,
            availableTools: listDirectToolNames(),
        });
    const cat = tool.permissionCategory;
    // ── permission gate ───────────────────────────────────────────────────────
    const denied = await checkPermission(name, cat, permissionMode, onPermissionRequest, argsRecord);
    if (denied)
        return buildDirectToolFailure('tool_permission_denied', denied, {
            retryable: false,
        });
    if (tool.executionMode === 'non-blocking' || !tool.execute) {
        return buildDirectToolFailure(
            'tool_runtime_managed',
            `"${name}" is a non-blocking tool and cannot run in direct mode.`,
            {
                retryable: false,
                availableTools: listDirectToolNames(),
            },
        );
    }
    const action = { type: name, ...input };
    const errors = tool.validate?.(action) ?? [];
    if (errors.length > 0)
        return buildDirectToolValidationFailure(name, errors);
    if (isDirectBackgroundAction(action as AgentAction)) {
        return startDirectBackgroundTool(action as Extract<AgentAction, { type: 'generate_image' | 'generate_video' }>, tool, opts);
    }
    try {
        const result = await tool.execute(action, {
            cwd,
            updateCwd,
            requestWorkspaceSwitch: onWorkspaceSwitchRequest,
            requestUserConfirmation: onUserConfirmationRequest,
            readFileHistory,
            permissionMode: mapPermissionModeForToolContext(permissionMode),
        });
        return attachDirectToolFailureError(name, {
            ok: result.ok,
            output: result.output,
            error: result.error,
        });
    }
    catch (e) {
        const message = `Execution error: ${String(e)}`;
        return buildDirectToolFailure('tool_execution_failed', message, {
            retryable: false,
        });
    }
}

function isReadPermissionCategory(category: string): boolean {
    return category === 'read' || category === 'none';
}

function isEditPermissionCategory(category: string): boolean {
    return isReadPermissionCategory(category) || category === 'write';
}

function mapPermissionModeForToolContext(permissionMode: PermissionModeInput): ToolAccessMode {
    return mapPermissionModeToToolAccess(permissionMode);
}

async function checkPermission(toolName: any, category: any, permissionMode: any, onPermissionRequest: any, args: any) {
    const normalizedCategory = String(category ?? 'none');
    permissionMode = normalizePermissionMode(permissionMode as PermissionModeInput);
    if (isReadPermissionCategory(normalizedCategory)) {
        return null;
    }

    if (permissionMode === 'PRODUCER') {
        return null;
    }

    if (permissionMode === 'WRITER') {
        if (isEditPermissionCategory(normalizedCategory)) {
            return null;
        }
        if (onPermissionRequest) {
            const allowed = await onPermissionRequest(toolName, category, args);
            if (!allowed)
                return `User denied permission for tool "${toolName}".`;
            return null;
        }
        return `Permission denied: "${toolName}" requires ${category} access but WRITER mode has no permission callback.`;
    }

    if (permissionMode === 'GHOSTWRITER') {
        if (onPermissionRequest) {
            const allowed = await onPermissionRequest(toolName, category, args);
            if (!allowed)
                return `User denied permission for tool "${toolName}".`;
            return null;
        }
        return `Permission denied: "${toolName}" requires ${category} access but GHOSTWRITER mode has no permission callback.`;
    }

    // read-only: only read/no-op categories allowed
    if (permissionMode === 'read-only') {
        return `Permission denied: "${toolName}" requires ${category} access but mode is read-only.`;
    }

    return `Permission denied: unknown permission mode "${permissionMode}".`;
}

function parseNativeToolArguments(call: any) {
    if (!call.arguments.trim())
        return {};
    const parsed = JSON.parse(call.arguments);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Tool ${call.name} arguments must decode to a JSON object.`);
    }
    return parsed;
}

function makeSessionMessage(
    role: SessionMessage['role'],
    content: string,
    extra: Partial<SessionMessage> = {},
): SessionMessage {
    return {
        id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        role,
        content,
        createdAt: new Date().toISOString(),
        ...extra,
    };
}

function truncateForBackground(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function isDirectBackgroundAction(action: AgentAction): action is Extract<AgentAction, { type: 'generate_image' | 'generate_video' }> {
    return (
        (action as { runInBackground?: unknown }).runInBackground === true &&
        (action.type === 'generate_image' || action.type === 'generate_video')
    );
}

function describeDirectBackgroundTask(action: Extract<AgentAction, { type: 'generate_image' | 'generate_video' }>): string {
    const noun = action.type === 'generate_image' ? 'image' : 'video';
    return `${noun}: ${truncateForBackground(action.prompt, 60)}`;
}

function appendBackgroundSystemMessage(cwd: string, message: string): void {
    try {
        const active = getSession(cwd);
        active.restore([
            ...active.getMessages(),
            makeSessionMessage('system', message),
        ]);
    } catch {
        /* best-effort */
    }
}

function startDirectBackgroundTool(
    action: Extract<AgentAction, { type: 'generate_image' | 'generate_video' }>,
    tool: NonNullable<ReturnType<typeof getToolDefinition>>,
    opts: any,
): ToolExecutionResult {
    const registry = getBackgroundTaskRegistry();
    const kind = action.type as BackgroundTaskKind;
    const label = describeDirectBackgroundTask(action);
    const taskId = registry.start<ToolExecutionResult>({
        kind,
        label,
        runner: async () => {
            const result = await tool.execute!(action, {
                cwd: opts.cwd,
                updateCwd: opts.updateCwd,
                requestWorkspaceSwitch: opts.onWorkspaceSwitchRequest,
            });
            return {
                action,
                ok: result.ok,
                output: result.output,
                error: result.error,
            };
        },
        isFailureResult: (result) => result.ok !== true,
        onComplete: async (result, record) => {
            const elapsedSec = Math.max(
                1,
                Math.floor(((record.completedAtMs ?? Date.now()) - record.startedAtMs) / 1000),
            );
            const tag = result.ok ? '完成' : '失败';
            const output = truncateForBackground(result.output ?? '', 800);
            appendBackgroundSystemMessage(
                opts.cwd,
                `[background_task ${record.id}] ${kind} ${tag}（耗时 ${elapsedSec}s）\n${output}`,
            );
            opts.onToolLog?.(
                `[background] ${kind} ${record.id} ${result.ok ? 'ok' : 'failed'} in ${elapsedSec}s`,
                result.ok ? 'info' : 'warn',
            );
        },
        onError: async (error, record) => {
            const elapsedSec = Math.max(
                1,
                Math.floor(((record.completedAtMs ?? Date.now()) - record.startedAtMs) / 1000),
            );
            appendBackgroundSystemMessage(
                opts.cwd,
                `[background_task ${record.id}] ${kind} 异常（耗时 ${elapsedSec}s）\n${truncateForBackground(error.message, 800)}`,
            );
            opts.onToolLog?.(
                `[background] ${kind} ${record.id} threw: ${error.message}`,
                'error',
            );
        },
    });

    opts.onToolLog?.(`[background] ${kind} ${taskId} started: ${label}`, 'info');

    return {
        action,
        ok: true,
        output: [
            'Background task started.',
            `task_id: ${taskId}`,
            `kind: ${kind}`,
            `label: ${label}`,
            '',
            'The tool is running asynchronously. Continue only with work that does not need this result.',
            `A later turn will receive [background_task ${taskId}] with the generated file path or failure details.`,
        ].join('\n'),
    };
}

function getLatestUserText(messages: SessionMessage[]): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role === 'user' && !isRecoveryMessage(message)) {
            return message.content.trim();
        }
    }
    return '';
}

function isPlainChatRequest(input: string): boolean {
    const text = input.trim().toLowerCase();
    if (!text) return false;
    if (/^(hi|hello|hey|thanks|thank you|ping|test|testing)$/i.test(text)) return true;
    if (/^(你好|您好|在吗|谢谢|测试一下|我来测试一下|随便聊聊)[。！!？?]*$/u.test(text)) return true;
    return false;
}

function isPseudoToolTranscript(text: string): boolean {
    return /(?:^|\n)\s*(?:run_command|read_file|write_file|apply_patch|replace_in_file|list_files|search_files)\s*:/i.test(text);
}

function isToolDeflection(text: string): boolean {
    const normalized = text.replace(/\s+/g, ' ').toLowerCase();
    const commandWords = String.raw`(?:cat|ls|grep|find|npm|node|python|bash|sh|curl)`;
    const userDirectedEnglish = new RegExp(
        String.raw`\b(?:please|try|execute|paste|copy|ask\s+(?:you|the\s+user)\s+to|have\s+(?:you|the\s+user)|you\s+(?:can|should|need\s+to|must)|the\s+user\s+(?:can|should|needs\s+to|must))\b.{0,120}\b` + commandWords + String.raw`\b`,
        'i',
    );
    const pasteBackEnglish = new RegExp(
        String.raw`\b(?:run|execute)\b.{0,120}\b` + commandWords + String.raw`\b.{0,120}\b(?:paste|send|tell\s+me|share)\b`,
        'i',
    );
    const userDirectedChinese = /(?:请|麻烦|需要你|让你|让用户|你来|用户来|自己|手动).{0,120}(?:cat|ls|grep|find|npm|node|python|bash|sh|命令|终端|运行|执行)/i;
    const pasteBackChinese = /(?:运行|执行).{0,120}(?:cat|ls|grep|find|npm|node|python|bash|sh|命令).{0,120}(?:把结果|粘贴|发给我|告诉我)/i;
    return (
        userDirectedEnglish.test(normalized) ||
        pasteBackEnglish.test(normalized) ||
        userDirectedChinese.test(text) ||
        pasteBackChinese.test(text)
    );
}

function buildRuntimeGuardMessage(reply: string): SessionMessage {
    return makeSessionMessage(
        'user',
        [
            '[tool:runtime_guard]',
            'The provider tried to delegate local workspace inspection or command execution back to the user.',
            'Do not ask the user to run cat, ls, grep, find, npm, shell, or terminal commands.',
            'Use the provided native function tools directly and then answer from tool results.',
            '',
            'Blocked provider text:',
            reply.slice(0, 1200),
        ].join('\n'),
    );
}

function buildNativeToolLimitFinalizerMessage(maxRounds: number, latestUserText: string): SessionMessage {
    return makeSessionMessage(
        'user',
        [
            '[tool:runtime_guard]',
            `The runtime has reached the native tool round budget (${maxRounds} rounds).`,
            'Do not call any more tools. Produce the best possible final reply now.',
            'Summarize what was completed, mention any known verification failures or blockers, and give the next concrete step if work is incomplete.',
            'Do not expose internal tool-loop terminology to the user.',
            '',
            'Original user request:',
            latestUserText.slice(0, 1200),
        ].join('\n'),
    );
}

function buildEmptyFinalReplyGuardMessage(latestUserText: string): SessionMessage {
    return makeSessionMessage(
        'user',
        [
            '[tool:runtime_guard]',
            'The previous provider response contained no final user-visible text and no tool calls.',
            'Do not call any more tools unless absolutely required. Produce a user-visible final reply now.',
            'If the task is complete, summarize the concrete result. If it is incomplete, state the exact blocker or next action.',
            'Never return an empty reply.',
            '',
            'Original user request:',
            latestUserText.slice(0, 1200),
        ].join('\n'),
    );
}

function normalizeThinkArgs(
    onDeltaOrOptions?: ((delta: string) => void) | ThinkOptions,
    maybeOptions?: ThinkOptions,
): { onDelta?: (delta: string) => void; options: ThinkOptions } {
    if (typeof onDeltaOrOptions === 'function') {
        return {
            onDelta: onDeltaOrOptions,
            options: maybeOptions ?? {},
        };
    }

    return {
        onDelta: onDeltaOrOptions?.onStream,
        options: onDeltaOrOptions ?? maybeOptions ?? {},
    };
}

function responseUsageAsTokenStats(result: ProviderResponse): Record<string, any> {
    const usage = result.usage ?? {};
    const hasProviderPrompt = typeof usage.promptTokens === 'number' && usage.promptTokens > 0;
    // promptTokens here is the turn's cumulative billing total across tool
    // rounds; the context size is the last request's count (_lastPromptTokens).
    return {
        contextLimit: estimateContextLimit(
            result.model ?? providerConfig?.model ?? '',
            normalizeContextLimit(providerConfig?.contextLength),
            hasPlatformCapabilities(providerConfig),
        ),
        contextLimitAuthoritative: hasPlatformCapabilities(providerConfig),
        promptTokens: usage.promptTokens ?? 0,
        contextTokens: _lastPromptTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        completionTokens: usage.completionTokens ?? 0,
        totalTokens: usage.totalTokens ?? ((usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)),
        tokenUsageSource: usage.source ?? (hasProviderPrompt ? 'provider' : 'estimated'),
        durationMs: usage.durationMs,
        firstResponseMs: usage.firstResponseMs,
        profileId: usage.profileId,
        profileLabel: usage.profileLabel,
        protocol: usage.protocol,
        model: result.model,
    };
}

function addOptionalNumbers(left: number | undefined, right: number | undefined): number | undefined {
    if (typeof left !== 'number') return right;
    if (typeof right !== 'number') return left;
    return left + right;
}

function accumulateProviderUsage(
    current: ProviderResponse['usage'] | undefined,
    next: ProviderResponse['usage'] | undefined,
): ProviderResponse['usage'] | undefined {
    if (!next) {
        return current;
    }

    const promptTokens = addOptionalNumbers(current?.promptTokens, next.promptTokens);
    const completionTokens = addOptionalNumbers(current?.completionTokens, next.completionTokens);
    const totalTokens =
        addOptionalNumbers(current?.totalTokens, next.totalTokens) ??
        (typeof promptTokens === 'number' && typeof completionTokens === 'number'
            ? promptTokens + completionTokens
            : undefined);

    return {
        ...next,
        promptTokens,
        completionTokens,
        totalTokens,
        durationMs: addOptionalNumbers(current?.durationMs, next.durationMs),
        firstResponseMs: current?.firstResponseMs ?? next.firstResponseMs,
        source:
            current?.source === 'estimated' || next.source === 'estimated'
                ? 'estimated'
                : next.source ?? current?.source,
    };
}

function mergeFinalProviderUsage(
    finalUsage: ProviderResponse['usage'] | undefined,
    cumulative: ProviderResponse['usage'] | undefined,
): ProviderResponse['usage'] | undefined {
    if (!cumulative) return finalUsage;
    if (!finalUsage) return cumulative;

    // The final provider response has already been included in cumulativeUsage
    // inside the tool loop. Do not add it again here; only preserve final-call
    // metadata fields that are more specific than the accumulated counters.
    return {
        ...finalUsage,
        ...cumulative,
        profileId: finalUsage.profileId ?? cumulative.profileId,
        profileLabel: finalUsage.profileLabel ?? cumulative.profileLabel,
        protocol: finalUsage.protocol ?? cumulative.protocol,
    };
}

function estimateResponseUsage(
    result: ProviderResponse,
    messages: SessionMessage[],
): ProviderResponse {
    const usage = result.usage ?? {};
    const hasProviderPrompt = typeof usage.promptTokens === 'number' && usage.promptTokens > 0;
    const hasProviderCompletion = typeof usage.completionTokens === 'number' && usage.completionTokens >= 0;
    if (hasProviderPrompt) {
        return {
            ...result,
            usage: {
                ...usage,
                source: usage.source ?? 'provider',
            },
        };
    }
    const promptTokens = Math.max(1, Math.round(estimateConversationTokens(messages)));
    const completionTokens = hasProviderCompletion
        ? usage.completionTokens
        : Math.max(0, estimateTokens(String(result.text ?? '')));
    return {
        ...result,
        usage: {
            ...usage,
            promptTokens,
            completionTokens,
            totalTokens: usage.totalTokens ?? promptTokens + (completionTokens ?? 0),
            source: 'estimated',
        },
    };
}

const PROVIDER_MAX_RETRIES = 5;
function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        const onAbort = (): void => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
// Retry transient provider faults (429 / 5xx / network) with exponential backoff
// so an unattended long run rides out rate-limits and blips instead of dying.
// Permanent faults (400/401/403) and user aborts are NOT retried.
function providerRetryDelayMs(err: unknown, attempt: number): number | null {
    if (isAbortLikeError(err)) return null;
    const e = err as { status?: number; statusCode?: number; response?: { status?: number }; code?: unknown; message?: unknown };
    const status = e?.status ?? e?.statusCode ?? e?.response?.status;
    let retryable = false;
    if (typeof status === 'number') {
        retryable = status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
    } else {
        const blob = `${String(e?.message ?? '')} ${String(e?.code ?? '')}`;
        retryable = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|timed out|timeout|network|overloaded|rate.?limit|\u9650\u901f|\u9650\u6d41|\u989d\u5ea6|\u8d85\u65f6|\u7e41\u5fd9|502|503|504/i.test(blob);
    }
    if (!retryable || attempt >= PROVIDER_MAX_RETRIES) return null;
    const base = Math.min(30_000, 2_000 * Math.pow(2, attempt - 1));
    return base + Math.floor(Math.random() * 500);
}

async function completeWithOptionalStream(
    provider: ChatProvider,
    messages: SessionMessage[],
    onDelta: ((delta: string) => void) | undefined,
    options: any,
): Promise<ProviderResponse> {
    const auditRole = options?.auditRole === 'worker' || options?.auditRole === 'compression'
        ? options.auditRole
        : 'main';
    const onRetryLog: ((m: string) => void) | undefined = typeof options?.onRetryLog === 'function' ? options.onRetryLog : undefined;
    const abortSignal: AbortSignal | undefined = options?.abortSignal;
    let attempt = 0;
    for (;;) {
        attempt += 1;
        let emitted = false;
        const guardedDelta = onDelta ? (d: string): void => { emitted = true; onDelta(d); } : undefined;
        try {
            let result: ProviderResponse;
            if (guardedDelta && typeof provider.completeStream === 'function') {
                result = estimateResponseUsage(await provider.completeStream(messages, guardedDelta, options), messages);
            } else {
                result = estimateResponseUsage(await provider.complete(messages, options), messages);
            }
            recordBifrostAudit(auditRole, result, messages);
            return result;
        } catch (err) {
            if (emitted || isAbortLikeError(err)) throw err;
            const delay = providerRetryDelayMs(err, attempt);
            if (delay === null) throw err;
            const short = String((err as { message?: unknown })?.message ?? err).split('\n')[0].slice(0, 80);
            onRetryLog?.(`[\u91cd\u8bd5] \u6a21\u578b\u8c03\u7528\u5931\u8d25\uff08${short}\uff09\u2014 \u7b2c ${attempt}/${PROVIDER_MAX_RETRIES} \u6b21\uff0c${Math.round(delay / 1000)}s \u540e\u91cd\u8bd5\u2026`);
            try {
                await sleepMs(delay, abortSignal);
            } catch {
                throw err;
            }
        }
    }
}

function buildProviderIncompatibilityMessage(): string {
    const cfg = getProviderConfigSync();
    const protocol = cfg?.protocol ?? 'unknown';
    const model = cfg?.model ?? 'unknown';
    return [
        `Provider incompatibility detected: ${protocol} / ${model}`,
        'The provider returned a textual pseudo tool transcript instead of native tool_calls.',
        'This is unsafe because Artemis cannot verify that the tool actually executed.',
    ].join('\n');
}

export interface ThinkOptions {
    permissionMode?: PermissionModeInput;
    onPermissionRequest?: (toolName: string, category: string, args: any) => Promise<boolean>;
    locale?: 'en' | 'zh';
    cwd?: string;
    disableNativeTools?: boolean;
    onToolCall?: (name: any, args: any) => void;
    onToolResult?: (name: any, ok: any, output: any) => void;
    onToolLog?: (message: string, level?: RuntimeLogLevel) => void;
    onStream?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    imageAttachments?: ImageAttachment[];
    /**
     * Describes images when the model cannot see them. Undefined: resolved from
     * the provider store's visionProfileId when needed; null: none.
     */
    visionHelper?: VisionHelper | null;
    onWorkspaceSwitchRequest?: (request: WorkspaceSwitchRequest) => Promise<boolean>;
    onUserConfirmationRequest?: (request: { question: string; screenshotPath?: string; timeoutMs?: number }) => Promise<boolean>;
    maxNativeToolRounds?: number;
    pollRunningUserMessages?: () => string[];
    onRunningUserMessageAccepted?: (text: string) => void;
    /** @deprecated The rolling summary now lives in the history (compaction boundary message); ignored. */
    initialCompressionSummary?: string;
    /** Called with the new rolling summary whenever the history is compacted. */
    onCompressionSummary?: (summary: string) => void;
    /**
     * Directory for this conversation's context files (transcript archive,
     * spilled tool outputs). Bridges and the CLI pass the stored session's
     * directory; otherwise a per-workspace directory under ~/.artemis/context.
     */
    contextDir?: string;
    /**
     * 'hosted' (chat bridges) applies the hosted context cap (200K tokens by
     * default, see resolveMaxContextTokens); 'interactive' (default, the CLI)
     * uses the full model window unless a cap is configured.
     */
    contextMode?: 'hosted' | 'interactive';
}

const MAX_DIRECT_NATIVE_TOOL_ROUNDS = 96;
const RUNNING_INTERJECTION_POLL_MS = 750;

function isAbortLikeError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const record = error as { name?: unknown; code?: unknown; message?: unknown };
    return record.name === 'AbortError' ||
        record.code === 'ABORT_ERR' ||
        /aborted|abort/i.test(String(record.message ?? ''));
}

export async function think(
    input: string,
    onDeltaOrOptions?: ((delta: string) => void) | ThinkOptions,
    maybeOptions?: ThinkOptions,
) {
    // Reset the dream-system idle clock — any think() invocation means the
    // user (or a bridge user) is doing something, so don't dream now.
    void (async () => {
        try {
            const { markActivity } = await import('./services/idleWatcher.js');
            markActivity();
        } catch { /* ignore */ }
    })();
    const { onDelta, options } = normalizeThinkArgs(onDeltaOrOptions, maybeOptions);
    const {
        cwd = process.cwd(),
        permissionMode = 'GHOSTWRITER',
        onPermissionRequest,
        onToolCall,
        onToolResult,
        onToolLog,
        onReasoning,
        locale = 'zh',
        disableNativeTools = false,
        imageAttachments = [],
        visionHelper,
        onWorkspaceSwitchRequest,
        onUserConfirmationRequest,
        maxNativeToolRounds: rawMaxNativeToolRounds,
        pollRunningUserMessages,
        onRunningUserMessageAccepted,
        onCompressionSummary,
        contextDir,
        contextMode = 'interactive',
    } = options;
    const readFileHistory = new Map<string, { output: string }>();
    const tSession = getSession(cwd);
    tSession.updateSystemPrompt(buildSystemPromptText(locale));
    // A model that cannot see images gets bridge/pasted images as text: the
    // vision helper's descriptions, or a note when there is no helper.
    let requestImageAttachments = imageAttachments;
    if (imageAttachments.length > 0) {
        const imageProvider = await loadProvider(cwd);
        const preparedImages = await prepareUserImagesForModel({
            userText: input,
            images: imageAttachments,
            modelSeesImages: imageProvider.supportsImages === true,
            getHelper: memoizeVisionHelper(async () =>
                visionHelper !== undefined
                    ? visionHelper ?? undefined
                    : loadVisionHelper(cwd, { onInfo: onToolLog ? (m: string) => onToolLog(m, 'info') : undefined })),
            locale,
            onInfo: onToolLog ? (m: string) => onToolLog(m, 'info') : undefined,
        });
        input = appendImageNote(input, preparedImages.note);
        requestImageAttachments = preparedImages.images;
    }
    tSession.addUser(input);
    const requestMessageId = tSession.getMessages().at(-1)?.id;

    const p = await loadProvider(cwd);
    let currentCwd = cwd;
    const providerConfigVal = getProviderConfigSync();
    // The conversation as stored AND as sent: compaction rewrites it in
    // place and writes it back to the session, so every round and every
    // later turn starts from the compacted history.
    let history: SessionMessage[] = tSession.getMessages();
    const writeBack = (next: SessionMessage[]): void => {
        history = next;
        tSession.restore(history);
    };
    const appendHistory = (...messages: SessionMessage[]): void => {
        writeBack([...history, ...messages]);
    };
    const systemMessages = await buildRuntimeSystemMessages(
        tSession.getSystemPrompt(),
        history,
        providerConfigVal?.model,
    );
    const systemTokens = Math.round(estimateConversationTokens(systemMessages));

    // ── Context management (see core/compaction) ──────────────────────────
    if (typeof tSession.getContext('contextSessionId') !== 'string') {
        tSession.setContext('contextSessionId', newContextSessionId());
    }
    const contextStorage = createContextStorage(
        contextDir ?? defaultContextDir(cwd, tSession.getContext('contextSessionId') as string),
    );
    const contextState: ContextState = normalizeContextState(tSession.getContext('contextState'));
    tSession.setContext('contextState', contextState);
    const contextBudget = resolveContextBudget({
        contextWindow: p.contextWindow ?? getConfiguredContextLimit(providerConfigVal?.model, providerConfigVal?.contextLength, hasPlatformCapabilities(providerConfigVal)),
        maxOutputTokens: p.maxOutputTokens,
        thresholdRatio: _compressionThresholdOverride,
        maxContextTokens: resolveMaxContextTokens({ configured: _compressionMaxContextTokens, mode: contextMode }),
    });
    const contextLanguage = detectConversationLanguage(history, locale);
    const summarizerWindow = await resolveSummarizerWindow();
    const logInfo = onToolLog ? (message: string): void => onToolLog(message, 'info') : undefined;
    let previousResponseId: string | undefined;
    let pendingToolOutputs: ProviderNativeToolOutput[] | undefined;
    const manageHistory = async (
        reason: ManageReason,
        nativeFunctionTools: unknown[] | undefined,
    ): Promise<number> => {
        const fixedTokens = systemTokens + estimateToolSchemaTokens(nativeFunctionTools);
        const managed = await manageContext({
            messages: history,
            fixedTokens,
            budget: contextBudget,
            state: contextState,
            storage: contextStorage,
            summarize: summarizeForCompaction,
            summarizerWindow,
            restore: { cwd: currentCwd },
            // This turn's request stays in the live history, however large.
            pinnedIds: requestMessageId ? [requestMessageId] : undefined,
            reason,
            proactive: _compressionEnabled,
            language: contextLanguage,
        });
        if (managed.changed) {
            writeBack(managed.messages);
            // A server-side continuation still holds the old, larger history.
            previousResponseId = undefined;
            pendingToolOutputs = undefined;
            if (managed.summary) {
                onCompressionSummary?.(managed.summary);
                void writeCheckpointJournal(cwd, managed.summary, undefined, getLatestUserText(history));
            }
        }
        if (managed.notice) logInfo?.(managed.notice);
        return fixedTokens;
    };

    const latestUserText = getLatestUserText(history);
    const enabledTools = await loadSetupToolEnabled(cwd);
    const supportsNativeTools = p.supportsNativeToolCalls === true && !disableNativeTools;
    const plainChat = isPlainChatRequest(latestUserText);
    let toolProjectionWidenAttempt = 0;
    let projectedToolNames = supportsNativeTools && !plainChat
        ? resolveProjectedDirectToolNames(
            history,
            enabledTools,
            toolProjectionWidenAttempt,
            [],
        )
        : [];
    // Persist the active tool surface so post-compaction state reflects the
    // tools that were actually available.
    if (projectedToolNames.length > 0) {
        tSession.setContext('activeToolNames', projectedToolNames);
    }
    const widenProjectedTools = (): void => {
        if (!supportsNativeTools || plainChat) {
            return;
        }
        toolProjectionWidenAttempt += 1;
        projectedToolNames = resolveProjectedDirectToolNames(
            history,
            enabledTools,
            toolProjectionWidenAttempt,
            projectedToolNames,
        );
        if (projectedToolNames.length > 0) {
            tSession.setContext('activeToolNames', projectedToolNames);
        }
    };
    const hasImageAttachments = requestImageAttachments.length > 0;
    let finalResult: ProviderResponse | null = null;
    let cumulativeUsage: ProviderResponse['usage'] | undefined;
    let emittedFinalText = false;
    let unresolvedDirectToolFailure: DirectToolFailureState | null = null;
    let emptyFinalReplyRetryCount = 0;
    let forceCompaction = false;
    // Interjections that arrive while a round's tool calls run wait here: an
    // assistant tool-call turn must be followed directly by its results.
    let toolRoundActive = false;
    let deferredInterjections: SessionMessage[] = [];
    const absorbRunningUserMessages = (): number => {
        const updates = pollRunningUserMessages?.() ?? [];
        let accepted = 0;
        for (const raw of updates) {
            const text = raw.trim();
            if (!text) continue;
            const injected = makeSessionMessage(
                'user',
                [
                    '[New user message received while the previous task was still running]',
                    text,
                    '',
                    'Treat this as the latest instruction/correction for the current in-progress task. If it changes the goal, pause or adjust before continuing.',
                ].join('\n'),
            );
            if (toolRoundActive) {
                deferredInterjections.push(injected);
            } else {
                appendHistory(injected);
            }
            onRunningUserMessageAccepted?.(text);
            accepted += 1;
        }
        return accepted;
    };
    const completeWithRunningInterjectionCheck = async (
        messages: SessionMessage[],
        completionOptions: Record<string, unknown>,
    ): Promise<{ interrupted: true } | { interrupted: false; completion: ProviderResponse }> => {
        const controller = new AbortController();
        let interrupted = false;
        let polling = false;
        const poll = (): void => {
            if (polling || controller.signal.aborted) return;
            polling = true;
            try {
                if (absorbRunningUserMessages() > 0) {
                    interrupted = true;
                    controller.abort();
                }
            } finally {
                polling = false;
            }
        };
        const timer = setInterval(poll, RUNNING_INTERJECTION_POLL_MS);
        try {
            const completion = await completeWithOptionalStream(
                p,
                messages,
                onDelta,
                {
                    ...completionOptions,
                    abortSignal: controller.signal,
                    onRetryLog: onToolLog ? (m: string): void => onToolLog(m, 'warn') : undefined,
                },
            );
            return { interrupted: false, completion };
        } catch (error) {
            if (interrupted && isAbortLikeError(error)) {
                return { interrupted: true };
            }
            throw error;
        } finally {
            clearInterval(timer);
        }
    };
    /**
     * One provider request with overflow recovery: a context-length rejection
     * forces a compaction (written back to the session, so a bridge does not
     * repeat the overflow on its next message) and one retry.
     */
    const requestWithOverflowRecovery = async (
        build: () => { messages: SessionMessage[]; completionOptions: Record<string, unknown> },
        nativeFunctionTools: unknown[] | undefined,
    ): Promise<{ interrupted: true } | { interrupted: false; completion: ProviderResponse; sent: SessionMessage[] }> => {
        let request = build();
        let sent = history;
        try {
            const attempt = await completeWithRunningInterjectionCheck(request.messages, request.completionOptions);
            return attempt.interrupted ? attempt : { ...attempt, sent };
        } catch (error) {
            if (!isContextOverflowError(error)) throw error;
            logInfo?.(contextLanguage === 'zh'
                ? '[上下文] 请求超出模型上下文窗口，正在压缩历史并重试一次'
                : '[context] the provider rejected the request as too large; compacting and retrying once');
            await manageHistory('overflow', nativeFunctionTools);
            request = build();
            sent = history;
            try {
                const attempt = await completeWithRunningInterjectionCheck(request.messages, request.completionOptions);
                return attempt.interrupted ? attempt : { ...attempt, sent };
            } catch (retryError) {
                if (!isContextOverflowError(retryError)) throw retryError;
                const detail = retryError instanceof Error ? retryError.message.split('\n')[0]!.slice(0, 200) : String(retryError);
                throw new ContextOverflowError(buildContextOverflowMessage(contextLanguage, detail), retryError);
            }
        }
    };

    const maxNativeToolRounds = Math.max(
        1,
        Math.floor(rawMaxNativeToolRounds ?? MAX_DIRECT_NATIVE_TOOL_ROUNDS),
    );
    const maxEmptyFinalReplyRetries = 2;
    const maxProviderRounds = maxNativeToolRounds + maxEmptyFinalReplyRetries;

    nativeRoundLoop:
    for (let round = 1; round <= maxProviderRounds; round += 1) {
        absorbRunningUserMessages();
        const nativeFunctionTools = supportsNativeTools && projectedToolNames.length > 0
            ? buildDirectNativeFunctionTools({ allowedToolNames: projectedToolNames })
            : undefined;
        // An empty reply often means the model choked on a bloated context:
        // compact for real when the context is large, else just retry.
        let reason: ManageReason = 'proactive';
        if (forceCompaction) {
            forceCompaction = false;
            const fixed = systemTokens + estimateToolSchemaTokens(nativeFunctionTools);
            if (measureContext(contextState, history, fixed).tokens > contextBudget.effective * 0.5) reason = 'manual';
        }
        const fixedTokens = await manageHistory(reason, nativeFunctionTools);
        const buildRequest = (): { messages: SessionMessage[]; completionOptions: Record<string, unknown> } => {
            const responseContinuation = previousResponseId && pendingToolOutputs
                ? {
                    previousResponseId,
                    toolOutputs: pendingToolOutputs,
                }
                : {};
            return {
                messages: [...systemMessages, ...history],
                completionOptions: {
                    ...responseContinuation,
                    nativeFunctionTools,
                    // User-supplied images are input context, not a generated/optional
                    // tool capability. Do not drop them just because the setup "vision"
                    // tool group was disabled; providers that cannot handle images will
                    // ignore/fail explicitly in their own adapter path.
                    imageAttachments: round === 1 && hasImageAttachments ? requestImageAttachments : undefined,
                    onReasoning,
                    guardStreamingText: supportsNativeTools && !plainChat,
                },
            };
        };
        const completionAttempt = await requestWithOverflowRecovery(buildRequest, nativeFunctionTools);
        previousResponseId = undefined;
        pendingToolOutputs = undefined;
        if (completionAttempt.interrupted) {
            widenProjectedTools();
            continue;
        }
        const completion = completionAttempt.completion;
        noteRequestPromptTokens(completion.usage);
        recordProviderUsage(contextState, completion.usage, completionAttempt.sent, fixedTokens);
        cumulativeUsage = accumulateProviderUsage(cumulativeUsage, completion.usage);
        finalResult = completion;

        const nativeCalls = completion.nativeToolCalls ?? [];
        if (nativeCalls.length > 0) {
            if (round >= maxNativeToolRounds) {
                onToolLog?.(
                    `Native tool round budget reached (${maxNativeToolRounds}); requesting a no-tool final reply.`,
                    'warn',
                );
                const finalizerMessage = buildNativeToolLimitFinalizerMessage(
                    maxNativeToolRounds,
                    latestUserText,
                );
                // Same overflow recovery as any other request: compact, retry once.
                const forcedAttempt = await requestWithOverflowRecovery(
                    () => ({
                        messages: [...systemMessages, ...history, finalizerMessage],
                        completionOptions: {
                            onReasoning,
                            guardStreamingText: false,
                        },
                    }),
                    undefined,
                );
                if (forcedAttempt.interrupted) {
                    widenProjectedTools();
                    continue nativeRoundLoop;
                }
                const forcedCompletion = forcedAttempt.completion;
                noteRequestPromptTokens(forcedCompletion.usage);
                cumulativeUsage = accumulateProviderUsage(cumulativeUsage, forcedCompletion.usage);
                const forcedReply = (forcedCompletion.text ?? '').trim() || [
                    '我已经停止继续调用工具。',
                    '目前还没有足够的最终文本可返回；运行时未把本轮标记为任务完成。请直接重试上一条请求或发送更具体的下一步指令。',
                ].join('\n');
                finalResult = {
                    ...forcedCompletion,
                    text: forcedReply,
                    nativeToolCalls: [],
                };
                if (forcedReply && forcedCompletion.streamed !== true && onDelta) {
                    onDelta(forcedReply);
                    emittedFinalText = true;
                }
                const assistantReplyMessage = makeSessionMessage('assistant', forcedReply, {
                    reasoningContent: finalResult.reasoningContent,
                    rawContentBlocks: finalResult.rawContentBlocks,
                });
                appendHistory(finalizerMessage, assistantReplyMessage);
                break;
            }
            if (providerConfigVal?.protocol === 'responses' && !completion.responseId) {
                throw new Error(
                    'Responses provider returned native tool calls without a response id.',
                );
            }

            const assistantMessage = makeSessionMessage(
                'assistant',
                completion.text ?? '',
                {
                    toolCalls: nativeCalls.map((call: ProviderNativeToolCall) => ({
                        id: call.callId,
                        name: call.name,
                        arguments: call.arguments,
                    })),
                    // Preserve reasoning chain so it can be echoed back on the
                    // next turn — DeepSeek-R1 requires this or returns HTTP 400.
                    reasoningContent: completion.reasoningContent,
                    // Preserve Anthropic raw content blocks (thinking + signatures)
                    // for extended-thinking + tool_use round-trip.
                    rawContentBlocks: completion.rawContentBlocks,
                },
            );
            const roundMessages: SessionMessage[] = [assistantMessage];
            const toolOutputs: ProviderNativeToolOutput[] = [];
            toolRoundActive = true;
            try {
                for (const call of nativeCalls) {
                    absorbRunningUserMessages();
                    let args: Record<string, unknown>;
                    try {
                        args = parseNativeToolArguments(call);
                    } catch (error) {
                        args = {};
                        const message = error instanceof Error ? error.message : String(error);
                        unresolvedDirectToolFailure = {
                            toolName: call.name,
                            output: message,
                            error: buildDirectToolError(
                                'tool_invalid_json',
                                message,
                                { retryable: true },
                            ),
                        };
                        const output = JSON.stringify(
                            {
                                ok: false,
                                toolName: call.name,
                                output: message,
                                error: {
                                    code: 'tool_invalid_json',
                                    message,
                                    retryable: true,
                                },
                            },
                            null,
                            2,
                        );
                        toolOutputs.push({
                            callId: call.callId,
                            output,
                        });
                        roundMessages.push(makeSessionMessage('tool', output, {
                            name: call.name,
                            toolUseId: call.callId,
                        }));
                        continue;
                    }

                    onToolCall?.(call.name, args);
                    if (READ_FILE_HISTORY_INVALIDATING_TOOLS.has(String(call.name))) {
                        readFileHistory.clear();
                    }
                    const toolResult = attachDirectToolFailureError(
                        call.name,
                        await executeTool(call.name, args, {
                            cwd: currentCwd,
                            permissionMode,
                            onPermissionRequest,
                            onToolLog,
                            updateCwd: (newCwd: string) => { currentCwd = newCwd; },
                            onWorkspaceSwitchRequest,
                            onUserConfirmationRequest,
                            readFileHistory,
                        }),
                    );
                    const toolOutput = formatDirectToolOutput(toolResult);
                    const contextPreparedOutput = prepareDirectToolContextOutput(call.name, toolOutput, contextStorage, contextBudget);
                    onToolResult?.(call.name, toolResult.ok, toolResult.output);
                    if (!toolResult.ok) {
                        unresolvedDirectToolFailure = {
                            toolName: call.name,
                            output: toolResult.output,
                            error: toolResult.error,
                        };
                    } else if (unresolvedDirectToolFailure) {
                        unresolvedDirectToolFailure = null;
                    }
                    toolOutputs.push({
                        callId: call.callId,
                        output: contextPreparedOutput.contextOutput,
                    });
                    roundMessages.push(makeSessionMessage('tool', contextPreparedOutput.contextOutput, {
                        name: call.name,
                        toolUseId: call.callId,
                    }));
                }
            } finally {
                toolRoundActive = false;
                // Results first, then any interjection that arrived meanwhile;
                // the history never loses either.
                const interjections = deferredInterjections;
                deferredInterjections = [];
                appendHistory(...roundMessages, ...interjections);
            }
            previousResponseId = completion.responseId;
            pendingToolOutputs = toolOutputs;
            continue;
        }

        let reply = completion.text ?? '';
        if (supportsNativeTools && !plainChat && !reply.trim()) {
            if (emptyFinalReplyRetryCount < maxEmptyFinalReplyRetries && round < maxProviderRounds) {
                emptyFinalReplyRetryCount += 1;
                forceCompaction = true;
                onToolLog?.(
                    `Provider returned an empty final reply; requesting a no-tool final reply (retry ${emptyFinalReplyRetryCount}/${maxEmptyFinalReplyRetries}).`,
                    'warn',
                );
                appendHistory(buildEmptyFinalReplyGuardMessage(latestUserText));
                widenProjectedTools();
                continue;
            }
            reply = [
                '本轮模型没有返回可见的最终文本。',
                '运行时已自动重试但提供商仍返回空文本；本轮未标记为任务完成。请直接重试上一条请求或发送更具体的下一步指令。',
            ].join('\n');
        }
        if (supportsNativeTools && !plainChat && reply.trim()) {
            if (isPseudoToolTranscript(reply)) {
                throw new Error(buildProviderIncompatibilityMessage());
            }

            if (isToolDeflection(reply)) {
                appendHistory(buildRuntimeGuardMessage(reply));
                widenProjectedTools();
                continue;
            }

            if (shouldGuardUnresolvedDirectToolFailure(reply, unresolvedDirectToolFailure)) {
                if (round >= maxNativeToolRounds) {
                    reply = buildDirectToolFailureFinalReply(
                        unresolvedDirectToolFailure,
                        reply,
                    );
                    unresolvedDirectToolFailure = null;
                } else {
                    appendHistory(buildDirectToolFailureGuardMessage(
                        unresolvedDirectToolFailure,
                        reply,
                    ));
                    widenProjectedTools();
                    continue;
                }
            }
        }

        finalResult = {
            ...completion,
            text: reply,
            nativeToolCalls: [],
        };
        if (reply && completion.streamed !== true && onDelta) {
            onDelta(reply);
            emittedFinalText = true;
        }
        appendHistory(makeSessionMessage('assistant', reply, {
            reasoningContent: finalResult?.reasoningContent,
            rawContentBlocks: finalResult?.rawContentBlocks,
        }));
        break;
    }

    if (!finalResult) {
        throw new Error('Provider did not return a response.');
    }

    if (cumulativeUsage) {
        finalResult = {
            ...finalResult,
            usage: mergeFinalProviderUsage(finalResult.usage, cumulativeUsage),
        };
    }

    const tokenStats = responseUsageAsTokenStats(finalResult);
    const reply = finalResult.text ?? '';
    return {
        reply,
        text: reply,
        cwd: currentCwd,
        usage: finalResult.usage,
        tokenStats,
        toolCalls: finalResult.nativeToolCalls ?? [],
        streamed: finalResult.streamed === true || emittedFinalText,
    };
}

export function setSystemPrompt() {
    // This function is kept for backward compatibility
    // System prompt is managed through setSystemPromptSuffix
}

export function getProviderTelemetryContext() {
    return providerTelemetryContext;
}
