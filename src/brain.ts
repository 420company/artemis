/* eslint-disable @typescript-eslint/no-unused-vars */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { release as osRelease } from 'node:os';
import { ProviderStore } from './providers/store.js';
import { resolveArtemisHomeDir } from './utils/fs.js';
import { annotateProviderResponse, createTrackedProviderFromConfig, recordProviderProfileTelemetry, } from './providers/telemetry.js';
import { Session } from './core/session.js';
import type { SessionMessage, SessionRecord, AgentAction, AssistantEnvelope } from './core/types.js';
import { estimateContextLimit, fmtTok, normalizeContextLimit } from './cli/hud.js';
import { compressMessages, type CompressResult } from './core/contextCompressor.js';
import {
  recordCollapse,
  getOrCreateLedger,
  buildPostCompactRecoveryMessages,
  createFileStateSnapshot,
  saveFileArtifact,
  recordCompressionFailure,
  recordCompressionSuccess,
  recordCompressionTriggered,
  getThresholdMultiplier,
  isCircuitBreakerTripped,
  createCircuitBreakerState,
  recordTurnCompleted,
} from './core/collapse/index.js';
import type { CircuitBreakerState, CollapseEntry } from './core/collapse/index.js';
import {
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
let session: any = null;
let systemPromptSuffix: string = '';
// Runtime overrides from CLI flags (--model, --api-key, --base-url)
let _modelOverride: any;
let _apiKeyOverride: any;
let _baseUrlOverride: any;
// Effort override from /effort. undefined = no override; null = force API default.
let _effortOverride: any;
let _lastPromptTokens = 0;
let _compressionThresholdOverride: number | undefined;
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

/** Read last recorded prompt token count (for HUD / compression decisions). */
export function getLastPromptTokens() { return _lastPromptTokens; }

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
            '[Task checkpoint / anti-amnesia]',
            '- Artemis writes your FULL task state to a local checkpoint file under ~/.artemis/checkpoints/ every time the context is compressed.',
            "- If you have just been compressed and are unsure of the task state, list that directory and read the most recent .md (its 当前状态 / current-state block) to recover the goal, progress, and next step BEFORE continuing.",
            '- Never restart a task from scratch when a checkpoint exists — recover from it.',
        ].join('\n');
    }
    return [
        '',
        '[任务存档 / 防失忆]',
        '- 每次上下文被压缩时，Artemis 都会把你完整的任务状态写进本地存档文件（~/.artemis/checkpoints/ 目录下，按工作区命名）。',
        '- 如果你刚被压缩、对当前任务状态不确定，先列出该目录、读取最新的 .md（看它的「📍 当前状态」段），恢复目标、进度、下一步，再继续。',
        '- 有存档就别从头重做任务——从存档里恢复。',
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
async function loadProvider(cwd: string = process.cwd()) {
    const requestedCwd = path.resolve(cwd);
    if (provider && providerCwd === requestedCwd)
        return provider;
    // 1. Try cwd-local .artemis/providers.json
    const currentCwd = requestedCwd;
    const store = new ProviderStore(currentCwd);
    const data = await store.load();
    let config = store.getDefaultMainProfile(data);
    let telemetryCwd = currentCwd;
    _compressionThresholdOverride = data.setup?.agent.compression.threshold;
    // 2. Fallback: try global ~/.artemis/providers.json
    if (!config) {
        const artemisHome = resolveArtemisHomeDir();
        const globalStore = new ProviderStore(artemisHome);
        const globalData = await globalStore.load();
        config = globalStore.getDefaultMainProfile(globalData);
        if (config) {
            telemetryCwd = artemisHome;
            _compressionThresholdOverride = globalData.setup?.agent.compression.threshold;
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
                model: _modelOverride ?? 'claude-sonnet-4-20250514',
                baseUrl: '',
            };
        }
    }
    if (!config) {
        throw new Error('No AI provider configured. Please set ANTHROPIC_API_KEY environment variable or run artemis config to configure.');
    }
    // Apply CLI overrides
    let finalConfig = { ...config };
    if (_modelOverride) finalConfig = { ...finalConfig, model: _modelOverride };
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
        const globalStore = new ProviderStore(artemisHome);
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
 * Public accessor for the lead provider — used by external callers (e.g.
 * modelRouter) that need explicit access to the main/premium model.
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
 * One-shot LLM call for compression/summarization — does NOT touch the active session.
 *
 * Strategy (in order):
 *  1. Anthropic → try claude-haiku (cheap), fall back to configured main model if haiku unavailable
 *  2. Any other provider → use provider's complete() with the configured model
 *
 * If everything fails, throws — caller (compressMessages) catches and downgrades to Phase 1.
 */
export const summarizeOnce = async (prompt: any) => {
    // ── Dual-model path: prefer specialist (worker) profile if configured ────
    // The user explicitly set up two models for a reason — use the cheap one
    // here. Falls back to the legacy single-model logic below on failure.
    await loadProvider(); // make sure the lead is loaded
    const { provider: workerP, config: workerCfg } = await loadWorkerProvider();
    const dualModelActive = workerCfg && workerCfg !== providerConfig;
    if (dualModelActive) {
        try {
            if (workerCfg.protocol === 'messages' && typeof workerCfg.apiKey === 'string' && workerCfg.apiKey.startsWith('sk-ant')) {
                const client = new Anthropic({ apiKey: workerCfg.apiKey, baseURL: workerCfg.baseUrl });
                const resp = await client.messages.create({
                    model: workerCfg.model,
                    max_tokens: 4096,
                    messages: [{ role: 'user', content: prompt }],
                });
                const block = resp.content[0];
                return block?.type === 'text' ? block.text : '';
            }
            // Generic worker path
            const sysMsg = {
                id: 'sum-sys', role: 'system' as const,
                content: 'You are a conversation summary assistant.', createdAt: new Date().toISOString(),
            };
            const userMsg = {
                id: 'sum-usr', role: 'user' as const,
                content: prompt, createdAt: new Date().toISOString(),
            };
            const result = await workerP.complete([sysMsg, userMsg]);
            recordBifrostAudit('compression', estimateResponseUsage(result, [sysMsg, userMsg]), [sysMsg, userMsg]);
            return result.text;
        } catch (workerErr) {
            // Worker failed — fall through to legacy haiku-first path on lead
            void workerErr;
        }
    }

    // ── Single-model legacy path: try haiku first, fall back to configured ──
    const p = await loadProvider();
    const cfg = providerConfig;
    if (cfg?.protocol === 'messages' && cfg.apiKey?.startsWith('sk-ant')) {
        const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl });
        const tryModel = async (model: any) => {
            const resp = await client.messages.create({
                model,
                max_tokens: 4096,
                messages: [{ role: 'user', content: prompt }],
            });
            const block = resp.content[0];
            return block?.type === 'text' ? block.text : '';
        };
        try {
            return await tryModel('claude-haiku-4-5-20251001');
        }
        catch (haikusErr) {
            const mainModel = cfg.model ?? 'claude-sonnet-4-20250514';
            if (mainModel === 'claude-haiku-4-5-20251001') throw haikusErr;
            return await tryModel(mainModel);
        }
    }
    // ── Generic provider path ─────────────────────────────────────────────────
    const sysMsg = {
        id: 'sum-sys', role: 'system',
        content: 'You are a conversation summary assistant.', createdAt: new Date().toISOString(),
    };
    const userMsg = {
        id: 'sum-usr', role: 'user',
        content: prompt, createdAt: new Date().toISOString(),
    };
    const result = await p.complete([sysMsg, userMsg]);
    recordBifrostAudit('compression', estimateResponseUsage(result as ProviderResponse, [sysMsg as SessionMessage, userMsg as SessionMessage]), [sysMsg as SessionMessage, userMsg as SessionMessage]);
    return result.text;
};

/** Restore a saved session's messages into the active session. */
export function restoreSession(messages: any) {
    const activeSession = getSession();
    activeSession.restore(messages);
    activeSession.deleteContext('compressionSummary');
}

export function restoreSessionForCwd(messages: any, cwd: string) {
    const activeSession = getSession(cwd);
    activeSession.restore(messages);
    activeSession.deleteContext('compressionSummary');
}

export function restoreSessionStateForCwd(state: { messages: any; summary?: string }, cwd: string) {
    const activeSession = getSession(cwd);
    activeSession.restore(state.messages);
    const summary = typeof state.summary === 'string' ? state.summary.trim() : '';
    if (summary) {
        activeSession.setContext('compressionSummary', summary);
    } else {
        activeSession.deleteContext('compressionSummary');
    }
}

export function getCompressionSummary(cwd: string = process.cwd()): string | undefined {
    const summary = getSession(cwd).getContext('compressionSummary');
    return typeof summary === 'string' && summary.trim() ? summary : undefined;
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
                return `Anthropic / ${_modelOverride ?? 'claude-sonnet-4-20250514'}`;
            return 'Not configured';
        }
        return `${cfg.protocol} / ${cfg.model ?? '?'}`;
    }
    catch {
        return 'Not configured';
    }
}

// ── Context budget awareness ──────────────────────────────────────────────────
const BUDGET_WARN_PCT = 0.70; // inject warning at 70%
const BUDGET_ALERT_PCT = 0.88; // inject stronger warning at 88%
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
    const completionTokens = Math.round(usage.completionTokens ?? String(result.text ?? '').length / 4);
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

function getConfiguredContextLimit(model: string | undefined, contextLength?: number): number {
    return estimateContextLimit(model ?? '', normalizeContextLimit(contextLength));
}

function buildBudgetNote(promptTokens: any, model: any, contextLength?: number) {
    if (promptTokens <= 0)
        return '';
    const limit = getConfiguredContextLimit(model, contextLength);
    const pct = promptTokens / limit;
    if (pct < BUDGET_WARN_PCT)
        return '';
    const pctStr = Math.round(pct * 100);
    const usedStr = fmtTok(promptTokens);
    const limStr = fmtTok(limit);
    if (pct >= BUDGET_ALERT_PCT) {
        return `\n\n[⚠ CONTEXT CRITICAL: ${pctStr}% used (${usedStr}/${limStr}). Give the shortest possible answer. Strongly suggest the user starts a new session.]`;
    }
    return `\n\n[Context usage: ${pctStr}% (${usedStr}/${limStr}). Prefer concise answers.]`;
}

function estimateConversationTokens(messages: SessionMessage[]): number {
    return messages.reduce((sum, msg) => sum + String(msg.content ?? '').length, 0) / 4;
}

async function buildRuntimeSystemMessages(
    systemPrompt: string,
    conversationMessages: SessionMessage[],
    model?: string,
    contextLength?: number,
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

    const estimatedTokens = Math.round(estimateConversationTokens(conversationMessages));
    const budgetNote = buildBudgetNote(estimatedTokens, model, contextLength).trim();
    if (budgetNote) {
        runtimeMessages.push(makeSessionMessage('system', budgetNote));
    }
    return runtimeMessages;
}

// ── Circuit breaker state (per session) ─────────────────────────────────────
const sessionCircuitBreakers = new Map<string, CircuitBreakerState>()

function getCircuitBreaker(sessionId: string): CircuitBreakerState {
  let state = sessionCircuitBreakers.get(sessionId)
  if (!state) {
    state = createCircuitBreakerState()
    sessionCircuitBreakers.set(sessionId, state)
  }
  return state
}

// Tool names that count as "real progress" between compressions. If the
// compressor keeps firing but none of these appear in the messages since
// the last compression, it's a rumination loop and the circuit breaker
// will escalate the compression threshold.
const COMPRESSION_PROGRESS_TOOLS = new Set([
  'write_file',
  'insert_in_file',
  'replace_in_file',
  'apply_patch',
  'create_file',
  'delete_file',
])

interface ExtractedPendingIntent {
  text: string
  lastTool?: {
    name: string
    target?: string
    toolUseId?: string
    outcome: 'success' | 'failure' | 'pending'
  }
}

function extractTextFromAssistant(m: SessionMessage): string {
  let text = typeof m.content === 'string' ? m.content : ''
  if (!text && Array.isArray(m.contentBlocks)) {
    const textBlocks: string[] = []
    for (const block of m.contentBlocks as unknown[]) {
      if (block && typeof block === 'object') {
        const b = block as { type?: string; text?: string }
        if (b.type === 'text' && typeof b.text === 'string') textBlocks.push(b.text)
      }
    }
    text = textBlocks.join('\n')
  }
  return text.trim()
}

/**
 * Extract a "target hint" from a tool call's input. Different tools store
 * the operand under different keys (file_path, path, command, …) — we try
 * a small ordered list and fall back to the first 120 chars of stringified
 * input. Never throws.
 */
function extractToolTarget(toolName: string, input: unknown): string | undefined {
  if (input == null) return undefined
  let parsed: Record<string, unknown> | null = null
  if (typeof input === 'string') {
    try { parsed = JSON.parse(input) as Record<string, unknown> } catch { return input.slice(0, 120) }
  } else if (typeof input === 'object') {
    parsed = input as Record<string, unknown>
  }
  if (!parsed) return undefined
  for (const key of ['file_path', 'filePath', 'path', 'target', 'targetFile', 'src', 'source']) {
    const v = parsed[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  if (typeof parsed.command === 'string') return parsed.command.slice(0, 120)
  if (typeof parsed.cmd === 'string') return parsed.cmd.slice(0, 120)
  // Last resort: stringify the smallest sensible field
  try {
    const s = JSON.stringify(parsed)
    return s.length > 160 ? s.slice(0, 160) + '…' : s
  } catch { return undefined }
}

/**
 * Inspect an assistant message for its most recent tool call (Anthropic
 * tool_use block OR OpenAI-style toolCalls). Returns the tool name + a
 * "target" hint + the tool_use id so we can later match a tool_result.
 */
function extractLastToolCall(m: SessionMessage): { name: string; target?: string; toolUseId?: string } | null {
  // Anthropic contentBlocks path
  if (Array.isArray(m.contentBlocks)) {
    for (let i = m.contentBlocks.length - 1; i >= 0; i--) {
      const block = m.contentBlocks[i]
      if (block && typeof block === 'object') {
        const b = block as { type?: string; name?: string; input?: unknown; id?: string }
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          return {
            name: b.name,
            target: extractToolTarget(b.name, b.input),
            toolUseId: typeof b.id === 'string' ? b.id : undefined,
          }
        }
      }
    }
  }
  // OpenAI toolCalls path
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
    const tc = m.toolCalls[m.toolCalls.length - 1]!
    return {
      name: tc.name,
      target: extractToolTarget(tc.name, tc.arguments),
      toolUseId: tc.id,
    }
  }
  return null
}

/**
 * Determine outcome of a tool_use by scanning subsequent messages for a
 * matching tool_result. Heuristics for failure detection mirror
 * looksLikeToolFailure in contextCompressor.ts.
 */
function classifyToolOutcome(
  messages: SessionMessage[],
  fromIdx: number,
  toolUseId: string | undefined,
): 'success' | 'failure' | 'pending' {
  for (let j = fromIdx + 1; j < messages.length; j++) {
    const r = messages[j]!
    if (r.role !== 'tool') continue
    if (toolUseId && r.toolUseId && r.toolUseId !== toolUseId) continue
    const content = (r.content ?? '').toLowerCase()
    if (
      content.includes('"ok": false') ||
      content.includes('tool_invalid_arguments') ||
      content.includes('execution error') ||
      content.includes('error:') ||
      content.includes('failed')
    ) return 'failure'
    return 'success'
  }
  return 'pending'
}

/**
 * Extract the last substantive assistant text from the conversation tail
 * AND, if present, structured information about the tool the model was
 * invoking. Both halves are useful: text gives intent in natural language,
 * lastTool gives the concrete operation (file path / command / outcome).
 */
function extractLastAssistantIntent(messages: SessionMessage[]): ExtractedPendingIntent | null {
  let text: string | null = null
  let lastTool: ExtractedPendingIntent['lastTool'] | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'assistant') continue

    if (!text) {
      const t = extractTextFromAssistant(m)
      if (t.length >= 20) text = t
    }
    if (!lastTool) {
      const tool = extractLastToolCall(m)
      if (tool) {
        lastTool = {
          name: tool.name,
          target: tool.target,
          toolUseId: tool.toolUseId,
          outcome: classifyToolOutcome(messages, i, tool.toolUseId),
        }
      }
    }
    if (text && lastTool) break
  }
  if (!text && !lastTool) return null
  return { text: text ?? '', lastTool }
}

/**
 * Extract the latest user message content as "current focus" — passed to the
 * worker summarizer so it can drop stale topics (e.g. "artemix read-only mode")
 * that no longer apply to the current task. Without this, previousSummary
 * propagates dead task lines indefinitely.
 */
function extractCurrentUserFocus(messages: SessionMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role !== 'user') continue
    const text = typeof m.content === 'string' ? m.content.trim() : ''
    if (text.length < 5) continue
    // Skip system-style markers used for compression summary or recovery
    if (text.startsWith('[系统：') || text.startsWith('═══')) continue
    return text.length > 800 ? text.slice(0, 800) : text
  }
  return null
}

function countProgressOpsSince(
  messages: SessionMessage[],
  sinceMs: number,
): number {
  // If no prior compression timestamp, fall back to scanning the recent tail
  // so we don't escalate spuriously on the first compression of a session.
  const useTimestamp = sinceMs > 0
  let count = 0
  const start = useTimestamp ? 0 : Math.max(0, messages.length - 30)
  for (let i = start; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== 'tool' || !m.name) continue
    if (!COMPRESSION_PROGRESS_TOOLS.has(m.name)) continue
    if (useTimestamp) {
      const t = m.createdAt ? new Date(m.createdAt).getTime() : 0
      if (t && t < sinceMs) continue
    }
    count += 1
  }
  return count
}

// ── 机械兜底截断（不依赖模型）─────────────────────────────────────────────
// 智能摘要失败 / 断路器跳闸时，保证发给模型的永远 ≤ 窗口（留 15% 余量）。
// 保留[上次成功摘要] + [最近能塞下的若干轮]，并避开 tool_use/tool_result 配对断裂。
function mechanicalTruncateToFit(
    messages: SessionMessage[],
    summaryText: string | undefined,
    availableLimit: number,
): SessionMessage[] {
    const est = (m: SessionMessage) => Math.ceil((m?.content?.length ?? 0) / 4);
    const budget = Math.floor(Math.max(8_000, availableLimit) * 0.85);
    const summaryMsg: SessionMessage[] = summaryText
        ? [{ id: 'mech-summary', role: 'user', content: '[早期对话已压缩为摘要]\n' + summaryText, createdAt: new Date().toISOString() } as SessionMessage]
        : [];
    let used = summaryMsg.reduce((s, m) => s + est(m), 0);
    const kept: SessionMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const t = est(messages[i]!);
        if (kept.length > 0 && used + t > budget) break;
        kept.unshift(messages[i]!);
        used += t;
    }
    // 避免开头是孤儿 tool_result（其 assistant 工具调用已被截掉），否则 provider 会 400
    while (kept.length > 1 && ((kept[0]!.role as string) === 'tool' || (kept[0]!.role as string) === 'tool_result')) {
        kept.shift();
    }
    return [...summaryMsg, ...kept];
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

async function compressSessionMessagesForProvider(
    activeSession: Session,
    conversationMessages: SessionMessage[],
    model?: string,
    contextLength?: number,
    reservedTokens = 0,
    onInfo?: (message: string) => void,
    forceShrink?: number,
    locale: 'en' | 'zh' = 'zh',
): Promise<{ messages: SessionMessage[]; summaryText?: string }> {
    const t = (zh: string, en: string): string => (locale === 'en' ? en : zh);
    if (!model) {
        return { messages: conversationMessages };
    }

    // ── 空返回急救：调用方强制把上下文压到很小，让噎住的模型拿到干净小 payload 重试。
    //    恢复记忆由硬盘上的 checkpoint 存档兜底，所以这里丢掉大量历史是安全的。
    if (forceShrink && forceShrink > 0) {
        const fullLimit = getConfiguredContextLimit(model, contextLength);
        const small = Math.max(16_000, Math.floor(fullLimit * forceShrink) - Math.max(0, Math.round(reservedTokens)));
        onInfo?.(t(
            `[压缩] 空返回急救：压到约 ${Math.round(forceShrink * 100)}% 窗口后重试`,
            `[Compact] Empty-reply rescue: shrunk to ~${Math.round(forceShrink * 100)}% of window, retrying`));
        return { messages: mechanicalTruncateToFit(conversationMessages, activeSession.getContext('compressionSummary') as string | undefined, small) };
    }

    // ── Circuit breaker: skip compression if tripped ────────────────────────
    const breaker = getCircuitBreaker(activeSession.getWorkingDirectory())
    if (isCircuitBreakerTripped(breaker)) {
      onInfo?.(t('[压缩] 断路器触发，改用机械截断', '[Compact] Circuit breaker tripped; using mechanical truncation'))
      const mtLimit = Math.max(32_000, getConfiguredContextLimit(model, contextLength) - Math.max(0, Math.round(reservedTokens)));
      return { messages: mechanicalTruncateToFit(conversationMessages, activeSession.getContext('compressionSummary') as string | undefined, mtLimit) };
    }

    const previousSummary = activeSession.getContext('compressionSummary') as string | undefined;
    const fullLimit = getConfiguredContextLimit(model, contextLength);
    const availableLimit = Math.max(32_000, fullLimit - Math.max(0, Math.round(reservedTokens)));
    const tokensBefore = Math.ceil(conversationMessages.reduce((s, m) => s + m.content.length / 4, 0))

    // ── Churn detection: pre-flight threshold escalation ───────────────────
    // If this session has been rumination-looping (compressions firing
    // without any Edit/Write progress in between), the breaker raised the
    // threshold multiplier on the previous compression. Apply it here so
    // microcompact triggers later this turn too.
    const churnMultiplier = getThresholdMultiplier(breaker)

    // ── Capture pending action + current focus BEFORE compression ──────────
    // The last assistant text+toolcall becomes pendingAction so
    // postCompactRecovery can replay it. The latest user message becomes
    // currentFocus so the worker summarizer can drop stale topics.
    const pendingIntent = extractLastAssistantIntent(conversationMessages)
    if (pendingIntent) {
      const pendingPayload: Record<string, unknown> = {
        text: pendingIntent.text,
        capturedAt: new Date().toISOString(),
      }
      if (pendingIntent.lastTool) {
        // Drop toolUseId before storing — it's only useful at extraction time
        pendingPayload.lastTool = {
          name: pendingIntent.lastTool.name,
          target: pendingIntent.lastTool.target,
          outcome: pendingIntent.lastTool.outcome,
        }
      }
      activeSession.setContext('pendingActionIntent', pendingPayload)
    }
    const currentFocus = extractCurrentUserFocus(conversationMessages)

    // ── Summarizer window: the summary prompt goes to the worker model, so
    // size its INPUT by the worker's context window — not the lead's. A
    // small-window worker handed a prompt sized for a 1M lead would overflow.
    // Falls back to the lead window when no distinct worker is configured.
    let summarizerTokenLimit = availableLimit;
    try {
      const { config: workerCfg } = await loadWorkerProvider(activeSession.getWorkingDirectory());
      if (workerCfg && workerCfg !== providerConfig) {
        summarizerTokenLimit = getConfiguredContextLimit(workerCfg.model, workerCfg.contextLength);
      }
    } catch { /* worker unavailable — fall back to lead window */ }

    let compression: CompressResult
    try {
      compression = await compressMessages(conversationMessages, summarizeOnce, {
        tokenLimit: availableLimit,
        summarizerTokenLimit,
        previousSummary,
        threshold: _compressionThresholdOverride,
        churnMultiplier,
        currentFocus: currentFocus ?? undefined,
        locale,
        onInfo,
      });
    } catch (e: any) {
      // Record failure in circuit breaker
      const updatedBreaker = recordCompressionFailure(breaker, e.message)
      sessionCircuitBreakers.set(activeSession.getWorkingDirectory(), updatedBreaker)
      onInfo?.(t(
        `[压缩] 摘要连续失败 ${updatedBreaker.consecutiveFailures}/3，改用机械截断`,
        `[Compact] Summary failed ${updatedBreaker.consecutiveFailures}/3; using mechanical truncation`))
      return { messages: mechanicalTruncateToFit(conversationMessages, previousSummary, availableLimit) };
    }

    if (compression.summaryText) {
        activeSession.setContext('compressionSummary', compression.summaryText);
        if (compression.compressed) {
            void writeCheckpointJournal(
                activeSession.getWorkingDirectory(),
                compression.summaryText,
                pendingIntent?.text,
                currentFocus ?? undefined,
            );
        }
    }

    // ── Persistent Collapse Ledger: record the event ────────────────────────
    if (compression.compressed) {
      try {
        const sessionId = activeSession.getWorkingDirectory()
        const compressedIds = conversationMessages
          .filter((m, i) => !compression.messages.some(cm => cm.id === m.id))
          .map(m => m.id)

        const entry: CollapseEntry = {
          id: `collapse-${Date.now()}`,
          collapsedAt: new Date().toISOString(),
          tokensBefore: compression.tokensBefore ?? tokensBefore,
          tokensAfter: compression.tokensAfter ?? Math.ceil(compression.messages.reduce((s: number, m: SessionMessage) => s + m.content.length / 4, 0)),
          compressedMessageIds: compressedIds,
          summaryText: compression.summaryText,
          mode: compression.mode === 'full_compact' || compression.summaryText ? 'full_compact' : 'microcompact',
        }

        // Capture current file states and tool context for recovery
        const sessionTools = (activeSession.getContext('activeToolNames') as string[]) ?? []
        const sessionMcp = (activeSession.getContext('activeMcpServers') as string[]) ?? []
        const sessionSkills = (activeSession.getContext('activeSkills') as string[]) ?? []

        // Extract file paths from tool messages in the conversation history.
        // Two fixes vs the original loop:
        //   (1) Track the LATEST reference timestamp per path, not the first.
        //       Old loop did seenPaths.add() + continue, so first occurrence
        //       won — meaning a file read 200 messages ago dominated over a
        //       fresh re-read.
        //   (2) Drop entries whose last reference is older than a sliding
        //       cutoff so stale files don't keep getting reinjected.
        const STALE_MSG_DISTANCE = 100   // skip files whose last ref is >100 messages back
        const MAX_FILE_STATES = 8        // hard cap on snapshots stored
        const latestRefByPath = new Map<string, { ts: number; msgIndex: number }>()
        const latestMsgIndex = conversationMessages.length - 1

        for (let mi = 0; mi < conversationMessages.length; mi++) {
          const msg = conversationMessages[mi]!
          if (msg.role !== 'tool' || !msg.name) continue
          if (msg.name !== 'read_file' && msg.name !== 'write_file' && msg.name !== 'apply_patch') continue
          try {
            const parsed = JSON.parse(msg.content) as Record<string, unknown>
            const fp = typeof parsed.path === 'string' ? parsed.path
                     : typeof parsed.filePath === 'string' ? parsed.filePath
                     : null
            if (!fp) continue
            const ts = msg.createdAt ? new Date(msg.createdAt).getTime() : Date.now()
            const existing = latestRefByPath.get(fp)
            if (!existing || ts >= existing.ts) {
              latestRefByPath.set(fp, { ts, msgIndex: mi })
            }
          } catch { /* not JSON — skip */ }
        }

        // Apply TTL: drop files not referenced in the recent window
        const survivors = [...latestRefByPath.entries()]
          .filter(([, ref]) => (latestMsgIndex - ref.msgIndex) <= STALE_MSG_DISTANCE)
          .sort((a, b) => b[1].ts - a[1].ts)
          .slice(0, MAX_FILE_STATES)

        const fileStates: import('./core/collapse/ledger.js').FileStateSnapshot[] = []
        for (const [fp, ref] of survivors) {
          try {
            const { readFile: rf, stat: st } = await import('node:fs/promises')
            const content = await rf(fp, 'utf-8')
            const stats = await st(fp)
            const snapshot = createFileStateSnapshot(fp, content, stats.mtimeMs, ref.ts)
            // Persist full readable file content as an artifact so post-compact
            // recovery can restore actionable snippets for long coding tasks
            // instead of only the 800-char ledger head.
            snapshot.artifactPath = await saveFileArtifact(sessionId, fp, content)
            fileStates.push(snapshot)
          } catch {
            // File may have been deleted or is binary — create a minimal snapshot
            fileStates.push({
              filePath: fp,
              contentHash: 'unavailable',
              headContent: `[文件不可读: ${fp}]`,
              mtimeMs: 0,
              lastReferencedAt: ref.ts,
            })
          }
        }

        await recordCollapse(sessionId, entry, {
          // Already TTL-filtered and sorted by recency above
          fileStates,
          // Do not persist compression summaries as plans. Old behavior stored
          // generic conversation summaries here, then post-compact recovery
          // re-injected stale cross-project tasks as "current plan".
          planSnapshot: undefined,
          activeTools: sessionTools,
          activeMcpServers: sessionMcp,
          activeSkills: sessionSkills,
        })

        // ── Post-compact recovery: re-inject critical context ───────────────
        // Full compaction always gets recovery. Microcompact normally does not,
        // unless it degraded old read_file outputs into skeletons while an
        // in-flight action exists; that combination is where losing concrete
        // file state most often causes "what was I doing?" loops.
        const pendingActionStored = activeSession.getContext('pendingActionIntent') as
          | {
              text: string
              capturedAt: string
              lastTool?: { name: string; target?: string; outcome: 'success' | 'failure' | 'pending' }
            }
          | undefined
        const shouldInjectRecovery = entry.mode === 'full_compact' || (
          entry.mode === 'microcompact' &&
          (compression.readFileSkeletonsExtracted ?? 0) > 0 &&
          Boolean(pendingActionStored)
        )
        if (shouldInjectRecovery) {
          const ledger = await getOrCreateLedger(sessionId)
          const recoveryMessages = await buildPostCompactRecoveryMessages(ledger, {
            pendingAction: pendingActionStored,
          })

          if (recoveryMessages.length > 0) {
            compression.messages = [...compression.messages, ...recoveryMessages]
            const modeLabel = entry.mode === 'full_compact' ? '压缩' : '微压缩'
            onInfo?.(`[恢复] 已为${modeLabel}注入 ${recoveryMessages.length} 条恢复消息（进行中状态/文件状态/工具）`)
          }
        }

        // Record success in circuit breaker
        let updatedBreaker = recordCompressionSuccess(breaker)
        // ── Churn detection: did we see Edit/Write ops since last compression? ──
        // If not, escalate the threshold multiplier so the next compression
        // fires later and the model has more headroom to actually act.
        const editsSinceLast = countProgressOpsSince(
          conversationMessages,
          updatedBreaker.lastCompressionAt,
        )
        const churnUpdate = recordCompressionTriggered(updatedBreaker, {
          editsSinceLast,
          now: Date.now(),
        })
        updatedBreaker = churnUpdate.state
        if (churnUpdate.churnDetected) {
          onInfo?.(t(
            `[压缩] 检测到压缩振荡（5min 内 ${updatedBreaker.recentCompressionTimestamps.length} 次且无实质修改），阈值上调至 ${updatedBreaker.thresholdMultiplier.toFixed(2)}× 抑制空转`,
            `[Compact] Compaction thrash detected (${updatedBreaker.recentCompressionTimestamps.length}× in 5min with no real edits); threshold raised to ${updatedBreaker.thresholdMultiplier.toFixed(2)}× to suppress churn`))
        }
        sessionCircuitBreakers.set(activeSession.getWorkingDirectory(), updatedBreaker)
      } catch (ledgerError: any) {
        // Ledger failure should never block the main compression flow
        onInfo?.(t(
          `[压缩] 历史记录写入失败（不影响本次压缩）：${ledgerError.message}`,
          `[Compact] Ledger write failed (does not affect this compaction): ${ledgerError.message}`))
      }
    }

    return { messages: compression.messages, summaryText: compression.summaryText };
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

const TOOL_CONTEXT_INLINE_CHAR_LIMIT = 12_000;
const TOOL_CONTEXT_HEAD_CHAR_BUDGET = 4_000;
const TOOL_CONTEXT_TAIL_CHAR_BUDGET = 3_000;
const TOOL_ARTIFACT_DIR = path.join(resolveArtemisHomeDir(), 'tmp', 'tool-results');

function extractJsonEnvelopeOutput(text: string): { parsed: any; output: string } | null {
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') {
            return { parsed, output: parsed.output };
        }
    } catch {
        /* not a JSON tool envelope */
    }
    return null;
}

function collectHighSignalLines(text: string, maxLines = 80): string[] {
    const patterns = [
        /\b(error|failed|failure|exception|traceback|fatal|denied|not found|missing|warning|warn|timeout|timed out)\b/i,
        /\b(exit_code|exit code|status|ok|sha|commit|author|date|message|filename|status_code|http|HTTP)\b/i,
        /\b(success|succeeded|completed|passed|verified|built|done|changed|modified|created|deleted)\b/i,
        /(?:^|[\s/])(?:src|dist|lib|bin|scripts|plugins|skills|defaults|docs|test|tests)\/[\w./@-]+/i,
        /^[-+@]{2,}|^diff --git\b|^@@\s/,
    ];
    const lines = text.split('\n');
    const picked: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (!patterns.some((pattern) => pattern.test(line))) continue;
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 2);
        for (let j = start; j < end; j += 1) {
            const candidate = (lines[j] ?? '').slice(0, 1000);
            const key = `${j}:${candidate}`;
            if (!seen.has(key)) {
                seen.add(key);
                picked.push(candidate);
                if (picked.length >= maxLines) return picked;
            }
        }
    }
    return picked;
}

function buildLosslessToolSummary(fullOutput: string, artifactPath: string): string {
    const envelope = extractJsonEnvelopeOutput(fullOutput);
    const outputText = envelope?.output ?? fullOutput;
    const head = outputText.slice(0, TOOL_CONTEXT_HEAD_CHAR_BUDGET).trimEnd();
    const tail = outputText.slice(-TOOL_CONTEXT_TAIL_CHAR_BUDGET).trimStart();
    const signal = collectHighSignalLines(outputText)
        .join('\n')
        .slice(0, 4_000)
        .trim();
    const omitted = Math.max(0, outputText.length - head.length - tail.length);
    const summaryBody = [
        '[Artemis tool result compacted for context]',
        `Full original output saved at: ${artifactPath}`,
        `Original chars: ${fullOutput.length}; visible output chars: ${outputText.length}; omitted chars from visible output: ${omitted}`,
        'This compaction is evidence-preserving: if exact middle content is required, read the artifact path before making claims.',
        signal ? '\nHigh-signal excerpts:' : undefined,
        signal || undefined,
        '\nHead excerpt:',
        head,
        '\nTail excerpt:',
        tail,
    ].filter((part): part is string => Boolean(part)).join('\n');

    if (envelope) {
        const compactEnvelope = {
            ...envelope.parsed,
            output: summaryBody,
            artifactPath,
            originalOutputChars: fullOutput.length,
            contextCompacted: true,
        };
        return JSON.stringify(compactEnvelope, null, 2);
    }

    return summaryBody;
}

async function prepareDirectToolContextOutput(toolName: string, fullOutput: string): Promise<DirectToolContextOutput> {
    if (fullOutput.length <= TOOL_CONTEXT_INLINE_CHAR_LIMIT) {
        return { fullOutput, contextOutput: fullOutput };
    }

    const digest = createHash('sha256').update(fullOutput).digest('hex').slice(0, 16);
    const safeToolName = toolName.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80) || 'tool';
    const artifactPath = path.join(TOOL_ARTIFACT_DIR, `${Date.now()}-${safeToolName}-${digest}.txt`);
    await mkdir(TOOL_ARTIFACT_DIR, { recursive: true });
    await writeFile(artifactPath, fullOutput, 'utf8');

    return {
        fullOutput,
        contextOutput: buildLosslessToolSummary(fullOutput, artifactPath),
        artifactPath,
    };
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
        if (message?.role === 'user') {
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
    _lastPromptTokens = usage.promptTokens ?? _lastPromptTokens;
    return {
        contextLimit: normalizeContextLimit(providerConfig?.contextLength) ?? estimateContextLimit(result.model ?? providerConfig?.model ?? ''),
        promptTokens: usage.promptTokens ?? 0,
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
        : Math.max(0, Math.round(String(result.text ?? '').length / 4));
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
    while (true) {
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
    onWorkspaceSwitchRequest?: (request: WorkspaceSwitchRequest) => Promise<boolean>;
    onUserConfirmationRequest?: (request: { question: string; screenshotPath?: string; timeoutMs?: number }) => Promise<boolean>;
    maxNativeToolRounds?: number;
    pollRunningUserMessages?: () => string[];
    onRunningUserMessageAccepted?: (text: string) => void;
    initialCompressionSummary?: string;
    onCompressionSummary?: (summary: string) => void;
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
        onWorkspaceSwitchRequest,
        onUserConfirmationRequest,
        maxNativeToolRounds: rawMaxNativeToolRounds,
        pollRunningUserMessages,
        onRunningUserMessageAccepted,
        initialCompressionSummary,
        onCompressionSummary,
    } = options;
    const readFileHistory = new Map<string, { output: string }>();
    const tSession = getSession(cwd);
    tSession.updateSystemPrompt(buildSystemPromptText(locale));
    if (initialCompressionSummary?.trim() && !tSession.getContext('compressionSummary')) {
        tSession.setContext('compressionSummary', initialCompressionSummary);
    }
    tSession.addUser(input);

    const p = await loadProvider(cwd);
    let currentCwd = cwd;
    const providerConfigVal = getProviderConfigSync();
    let rawMessages = tSession.getMessages();
    const systemMessages = await buildRuntimeSystemMessages(
        tSession.getSystemPrompt(),
        rawMessages,
        providerConfigVal?.model,
        providerConfigVal?.contextLength,
    );
    const reservedSystemTokens = Math.round(estimateConversationTokens(systemMessages));
    let providerCompression = await compressSessionMessagesForProvider(
        tSession,
        rawMessages,
        providerConfigVal?.model,
        providerConfigVal?.contextLength,
        reservedSystemTokens,
        // Surface compression activity to the user via the tool-log channel
        // (was previously silent — long sessions had no visibility into
        // when/why the compressor fired or whether it succeeded).
        onToolLog ? (msg: string) => onToolLog(msg, 'info') : undefined,
        undefined,
        locale,
    );
    if (providerCompression.summaryText) {
        onCompressionSummary?.(providerCompression.summaryText);
    }
    let providerConversationMessages = providerCompression.messages;

    const latestUserText = getLatestUserText(rawMessages);
    const enabledTools = await loadSetupToolEnabled(cwd);
    const supportsNativeTools = p.supportsNativeToolCalls === true && !disableNativeTools;
    const plainChat = isPlainChatRequest(latestUserText);
    let toolProjectionWidenAttempt = 0;
    let projectedToolNames = supportsNativeTools && !plainChat
        ? resolveProjectedDirectToolNames(
            providerConversationMessages,
            enabledTools,
            toolProjectionWidenAttempt,
            [],
        )
        : [];
    const widenProjectedTools = (): void => {
        if (!supportsNativeTools || plainChat) {
            return;
        }
        toolProjectionWidenAttempt += 1;
        projectedToolNames = resolveProjectedDirectToolNames(
            providerConversationMessages,
            enabledTools,
            toolProjectionWidenAttempt,
            projectedToolNames,
        );
    };
    const hasImageAttachments = imageAttachments.length > 0;
    let finalResult: ProviderResponse | null = null;
    let cumulativeUsage: ProviderResponse['usage'] | undefined;
    let emittedFinalText = false;
    let unresolvedDirectToolFailure: DirectToolFailureState | null = null;
    let previousResponseId: string | undefined;
    let pendingToolOutputs: ProviderNativeToolOutput[] | undefined;
    let emptyFinalReplyRetryCount = 0;
    let forceCompactFraction: number | undefined;
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
            providerConversationMessages = [...providerConversationMessages, injected];
            rawMessages = [...rawMessages, injected];
            tSession.restore(rawMessages);
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

    const maxNativeToolRounds = Math.max(
        1,
        Math.floor(rawMaxNativeToolRounds ?? MAX_DIRECT_NATIVE_TOOL_ROUNDS),
    );
    const maxEmptyFinalReplyRetries = 2;
    const maxProviderRounds = maxNativeToolRounds + maxEmptyFinalReplyRetries;

    nativeRoundLoop:
    for (let round = 1; round <= maxProviderRounds; round += 1) {
        absorbRunningUserMessages();
        if (round > 1) {
            providerCompression = await compressSessionMessagesForProvider(
                tSession,
                rawMessages,
                providerConfigVal?.model,
                providerConfigVal?.contextLength,
                reservedSystemTokens,
                onToolLog ? (msg: string) => onToolLog(msg, 'info') : undefined,
                forceCompactFraction,
                locale,
            );
            forceCompactFraction = undefined;
            if (providerCompression.summaryText) {
                onCompressionSummary?.(providerCompression.summaryText);
            }
            providerConversationMessages = providerCompression.messages;
        }
        const nativeFunctionTools = supportsNativeTools && projectedToolNames.length > 0
            ? buildDirectNativeFunctionTools({ allowedToolNames: projectedToolNames })
            : undefined;
        const responseContinuation = previousResponseId && pendingToolOutputs
            ? {
                previousResponseId,
                toolOutputs: pendingToolOutputs,
            }
            : {};
        previousResponseId = undefined;
        pendingToolOutputs = undefined;
        const providerMessages = [...systemMessages, ...providerConversationMessages];
        const completionAttempt = await completeWithRunningInterjectionCheck(
            providerMessages,
            {
                ...responseContinuation,
                nativeFunctionTools,
                // User-supplied images are input context, not a generated/optional
                // tool capability. Do not drop them just because the setup "vision"
                // tool group was disabled; providers that cannot handle images will
                // ignore/fail explicitly in their own adapter path.
                imageAttachments: round === 1 && hasImageAttachments ? imageAttachments : undefined,
                onReasoning,
                guardStreamingText: supportsNativeTools && !plainChat,
            },
        );
        if (completionAttempt.interrupted) {
            previousResponseId = undefined;
            pendingToolOutputs = undefined;
            widenProjectedTools();
            continue;
        }
        const completion = completionAttempt.completion;
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
                const forcedAttempt = await completeWithRunningInterjectionCheck(
                    [...providerMessages, finalizerMessage],
                    {
                        onReasoning,
                        guardStreamingText: false,
                    },
                );
                if (forcedAttempt.interrupted) {
                    previousResponseId = undefined;
                    pendingToolOutputs = undefined;
                    widenProjectedTools();
                    continue nativeRoundLoop;
                }
                const forcedCompletion = forcedAttempt.completion;
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
                providerConversationMessages = [
                    ...providerConversationMessages,
                    finalizerMessage,
                    assistantReplyMessage,
                ];
                rawMessages = [...rawMessages, finalizerMessage, assistantReplyMessage];
                tSession.restore(rawMessages);
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
            const nextProviderMessages: SessionMessage[] = [...providerConversationMessages, assistantMessage];
            const nextRawMessages: SessionMessage[] = [...rawMessages, assistantMessage];
            const toolOutputs: ProviderNativeToolOutput[] = [];

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
                    const toolMessage = makeSessionMessage('tool', output, {
                        name: call.name,
                        toolUseId: call.callId,
                    });
                    nextProviderMessages.push(toolMessage);
                    nextRawMessages.push(toolMessage);
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
                const contextPreparedOutput = await prepareDirectToolContextOutput(call.name, toolOutput);
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
                const toolMessage = makeSessionMessage('tool', contextPreparedOutput.contextOutput, {
                    name: call.name,
                    toolUseId: call.callId,
                });
                nextProviderMessages.push(toolMessage);
                nextRawMessages.push(toolMessage);
            }

            providerConversationMessages = nextProviderMessages;
            rawMessages = nextRawMessages;
            tSession.restore(rawMessages);
            previousResponseId = completion.responseId;
            pendingToolOutputs = toolOutputs;
            continue;
        }

        let reply = completion.text ?? '';
        if (supportsNativeTools && !plainChat && !reply.trim()) {
            if (emptyFinalReplyRetryCount < maxEmptyFinalReplyRetries && round < maxProviderRounds) {
                emptyFinalReplyRetryCount += 1;
                // 空返回 = 模型多半被臃肿上下文噎住了。重试前强制狠压一刀，
                // 让它拿到又小又干净的 payload（记忆由 checkpoint 存档保住）。
                forceCompactFraction = emptyFinalReplyRetryCount >= 2 ? 0.2 : 0.35;
                onToolLog?.(
                    `Provider returned an empty final reply; requesting a no-tool final reply (retry ${emptyFinalReplyRetryCount}/${maxEmptyFinalReplyRetries}).`,
                    'warn',
                );
                const guardMessage = buildEmptyFinalReplyGuardMessage(latestUserText);
                providerConversationMessages = [...providerConversationMessages, guardMessage];
                rawMessages = [...rawMessages, guardMessage];
                tSession.restore(rawMessages);
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
                const guardMessage = buildRuntimeGuardMessage(reply);
                providerConversationMessages = [...providerConversationMessages, guardMessage];
                rawMessages = [...rawMessages, guardMessage];
                tSession.restore(rawMessages);
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
                    const guardMessage = buildDirectToolFailureGuardMessage(
                        unresolvedDirectToolFailure,
                        reply,
                    );
                    providerConversationMessages = [...providerConversationMessages, guardMessage];
                    rawMessages = [...rawMessages, guardMessage];
                    tSession.restore(rawMessages);
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
        const assistantReplyMessage = makeSessionMessage('assistant', reply, {
            reasoningContent: finalResult?.reasoningContent,
            rawContentBlocks: finalResult?.rawContentBlocks,
        });
        providerConversationMessages = [...providerConversationMessages, assistantReplyMessage];
        rawMessages = [...rawMessages, assistantReplyMessage];
        tSession.restore(rawMessages);
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
