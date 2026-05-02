/* eslint-disable @typescript-eslint/no-unused-vars */
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { release as osRelease } from 'node:os';
import { ProviderStore } from './providers/store.js';
import { annotateProviderResponse, createTrackedProviderFromConfig, recordProviderProfileTelemetry, } from './providers/telemetry.js';
import { Session } from './core/session.js';
import type { SessionMessage, SessionRecord, AgentAction, AssistantEnvelope } from './core/types.js';
import { estimateContextLimit, fmtTok, normalizeContextLimit } from './cli/hud.js';
import { compressMessages } from './core/contextCompressor.js';
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
你是 Artemis，一个面向真实本地工作区的工程代理，工作方式严格对齐 Claude Code。
- 默认用中文回复，除非用户明确使用其他语言
- 直接、简洁、专业；不要寒暄，不要营销式措辞
- 你的目标不是"给建议"，而是亲自调工具完成检查、修改、验证，再汇报结果

[Claude Code 执行协议]
- 收到任务先用一句话说要做什么，然后直接调工具动手——不要先讨论再行动
- 复杂任务（≥3 步）开局先输出 markdown 任务清单：\`- [ ] xxx\` / \`- [-] 进行中\` / \`- ✅ 完成\`，每完成一步立即更新清单
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
- 任务结束最多两句话总结：做了什么 + 文件在哪
- 除非用户要求，否则不要长篇解释常识
`;

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
// Context compression state — persists across turns for "update, not rewrite"
let _lastSummaryText: any;
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

function buildSystemPromptText() {
    const env = buildHostEnvironmentBlock();
    const learned = learnedDreamSuffix
        ? `\n\n[Long-term style accumulated from dreams]\n${learnedDreamSuffix}`
        : '';
    const base = `${env}${BASE_SYSTEM_PROMPT}${learned}`;
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
        const { homedir } = await import('node:os');
        const globalStore = new ProviderStore(homedir());
        const globalData = await globalStore.load();
        config = globalStore.getDefaultMainProfile(globalData);
        if (config) {
            telemetryCwd = homedir();
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
        const { homedir } = await import('node:os');
        const globalStore = new ProviderStore(homedir());
        const globalData = await globalStore.load();
        workerCfg = globalStore.getProfile(globalData, globalData.specialistProfileId);
        telemetryCwd = homedir();
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
    _lastSummaryText = undefined;
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
    getSession().restore(messages);
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

async function buildProviderConversationMessages(
    conversationMessages: SessionMessage[],
    model?: string,
    contextLength?: number,
    reservedTokens = 0,
    onInfo?: (message: string) => void,
): Promise<SessionMessage[]> {
    if (!model) {
        return conversationMessages;
    }

    const fullLimit = getConfiguredContextLimit(model, contextLength);
    const availableLimit = Math.max(32_000, fullLimit - Math.max(0, Math.round(reservedTokens)));
    const compression = await compressMessages(conversationMessages, summarizeOnce, {
        tokenLimit: availableLimit,
        previousSummary: _lastSummaryText,
        threshold: _compressionThresholdOverride,
        onInfo,
    });
    if (compression.summaryText) {
        _lastSummaryText = compression.summaryText;
    }
    return compression.messages;
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

    const splitPaths = paths.map((entry) => path.resolve(entry).split(path.sep).filter(Boolean));
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
        return null;
    }

    return path.join(path.parse(path.resolve(paths[0]!)).root, ...shared);
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
        // formatter plugins) — they must NOT bypass shell gates in accept-edits mode.
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
            await executeExtraTool(name, input, workspace.cwd),
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

async function checkPermission(toolName: any, category: any, permissionMode: any, onPermissionRequest: any, args: any) {
    const normalizedCategory = String(category ?? 'none');
    if (isReadPermissionCategory(normalizedCategory)) {
        return null;
    }

    // read-only: only read/no-op categories allowed
    if (permissionMode === 'read-only') {
        return `Permission denied: "${toolName}" requires ${category} access but mode is read-only.`;
    }

    if (permissionMode === 'accept-all') {
        return null;
    }

    // accept-edits: file writes are allowed, shell/execute/agent/admin remain gated.
    if (permissionMode === 'accept-edits') {
        if (isEditPermissionCategory(normalizedCategory)) {
            return null;
        }
        return `Permission denied: "${toolName}" requires ${category} access but mode is accept-edits.`;
    }

    // prompt mode: ask callback
    if (permissionMode === 'prompt') {
        if (onPermissionRequest) {
            const allowed = await onPermissionRequest(toolName, category, args);
            if (!allowed)
                return `User denied permission for tool "${toolName}".`;
            return null;
        }
        return `Permission denied: "${toolName}" requires ${category} access but prompt mode has no permission callback.`;
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
    return (
        /(?:please|try|run|execute|paste|copy).{0,80}\b(?:cat|ls|grep|find|npm|node|python|bash|sh|curl)\b/i.test(normalized) ||
        /(?:请|先|运行|执行|把结果|粘贴).{0,80}(?:cat|ls|grep|find|npm|node|python|bash|sh|命令|终端)/i.test(text)
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

async function completeWithOptionalStream(
    provider: ChatProvider,
    messages: SessionMessage[],
    onDelta: ((delta: string) => void) | undefined,
    options: any,
): Promise<ProviderResponse> {
    const auditRole = options?.auditRole === 'worker' || options?.auditRole === 'compression'
        ? options.auditRole
        : 'main';
    let result: ProviderResponse;
    if (onDelta && typeof provider.completeStream === 'function') {
        result = estimateResponseUsage(await provider.completeStream(messages, onDelta, options), messages);
    } else {
        result = estimateResponseUsage(await provider.complete(messages, options), messages);
    }
    recordBifrostAudit(auditRole, result, messages);
    return result;
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
    permissionMode?: 'prompt' | 'read-only' | 'accept-edits' | 'accept-all';
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
}

const MAX_DIRECT_NATIVE_TOOL_ROUNDS = 24;

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
        permissionMode = 'prompt',
        onPermissionRequest,
        onToolCall,
        onToolResult,
        onToolLog,
        onReasoning,
        disableNativeTools = false,
        imageAttachments = [],
        onWorkspaceSwitchRequest,
        onUserConfirmationRequest,
        maxNativeToolRounds: rawMaxNativeToolRounds,
    } = options;
    const readFileHistory = new Map<string, { output: string }>();
    const tSession = getSession(cwd);
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
    let providerConversationMessages = await buildProviderConversationMessages(
        rawMessages,
        providerConfigVal?.model,
        providerConfigVal?.contextLength,
        reservedSystemTokens,
        // Surface compression activity to the user via the tool-log channel
        // (was previously silent — long sessions had no visibility into
        // when/why the compressor fired or whether it succeeded).
        onToolLog ? (msg: string) => onToolLog(msg, 'info') : undefined,
    );

    const latestUserText = getLatestUserText(rawMessages);
    const enabledTools = await loadSetupToolEnabled(cwd);
    const supportsNativeTools = p.supportsNativeToolCalls === true && !disableNativeTools;
    const plainChat = isPlainChatRequest(latestUserText);
    const projectedToolNames = supportsNativeTools && !plainChat
        ? filterDirectToolsBySetup(listDirectToolNames(), enabledTools)
        : [];
    const visionEnabled = isSetupToolEnabled(enabledTools, 'vision');
    let finalResult: ProviderResponse | null = null;
    let emittedFinalText = false;
    let unresolvedDirectToolFailure: DirectToolFailureState | null = null;
    let previousResponseId: string | undefined;
    let pendingToolOutputs: ProviderNativeToolOutput[] | undefined;

    const maxNativeToolRounds = Math.max(
        1,
        Math.floor(rawMaxNativeToolRounds ?? MAX_DIRECT_NATIVE_TOOL_ROUNDS),
    );

    for (let round = 1; round <= maxNativeToolRounds; round += 1) {
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
        const completion = await completeWithOptionalStream(
            p,
            providerMessages,
            onDelta,
            {
                ...responseContinuation,
                nativeFunctionTools,
                imageAttachments: round === 1 && visionEnabled ? imageAttachments : undefined,
                onReasoning,
                guardStreamingText: supportsNativeTools && !plainChat,
            },
        );
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
                const forcedCompletion = await completeWithOptionalStream(
                    p,
                    [...providerMessages, finalizerMessage],
                    onDelta,
                    {
                        onReasoning,
                        guardStreamingText: false,
                    },
                );
                const forcedReply = (forcedCompletion.text ?? '').trim() || [
                    '我已经停止继续调用工具。',
                    '目前还没有足够的最终文本可返回；请发送“继续”让我基于当前上下文接着处理，或把任务拆成更小的一步。',
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
                    output: toolOutput,
                });
                const toolMessage = makeSessionMessage('tool', toolOutput, {
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
        if (supportsNativeTools && !plainChat && reply.trim()) {
            if (isPseudoToolTranscript(reply)) {
                throw new Error(buildProviderIncompatibilityMessage());
            }

            if (isToolDeflection(reply)) {
                const guardMessage = buildRuntimeGuardMessage(reply);
                providerConversationMessages = [...providerConversationMessages, guardMessage];
                rawMessages = [...rawMessages, guardMessage];
                tSession.restore(rawMessages);
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
                    continue;
                }
            }
        }

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
