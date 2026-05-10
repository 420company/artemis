import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, pathExists, resolveDataRootDir } from '../utils/fs.js'
import { DEFAULT_UI_LOCALE, normalizeUiLocale } from './locale.js'
import type { UiLocale } from './locale.js'
import {
  isPathInsideWorkspace,
  mergeTrustedWorkspaceRoots,
  normalizeTrustedWorkspaceRoots,
} from '../utils/workspaceRoots.js'

export const DEFAULT_WORDUP_INTERVAL_MINUTES = 30
export const DEFAULT_DOCS_SEARCH_ENGINE = 'bing'
export const DEFAULT_RESEARCH_ENGINE = 'builtin'
export const DEFAULT_GEMINI_DEEP_RESEARCH_AGENT = 'deep-research-preview-04-2026'
export const DEFAULT_GEMINI_DEEP_RESEARCH_MAX_POLLS = 360
export const DEFAULT_GEMINI_DEEP_RESEARCH_POLL_INTERVAL_MS = 5_000

export type DocsSearchEngine = 'bing' | 'google'
export type ResearchEngine = 'builtin' | 'gemini-deep-research'

export type BundleModelChoice = 'main' | 'brain'
export type BundleMode = 'auto' | 'manual'
export const DEFAULT_BUNDLE_MIN_LENGTH = 60
export type VisualAssetPreference = 'local' | 'search' | 'skip'

export interface CliSettings {
  uiLocale: UiLocale
  uiLocaleConfigured: boolean
  workspaceTrustConfirmed: boolean
  wordUpEnabled: boolean
  wordUpIntervalMinutes: number
  docsSearchEngine: DocsSearchEngine
  docsSearchEngineConfigured: boolean
  researchEngine: ResearchEngine
  researchEngineConfigured: boolean
  geminiApiKey?: string
  geminiDeepResearchAgent?: string
  geminiDeepResearchMaxPolls?: number
  geminiDeepResearchPollIntervalMs?: number
  onboardingCompleted: boolean
  bundleConfigured: boolean
  bundleEnabled: boolean
  bundleMode: BundleMode
  bundleModelChoice: BundleModelChoice
  bundleMinLength: number
  dailyAuditEnabled: boolean
  trustedWorkspaceRoots: string[]
  lastTrustedWorkspaceRoot?: string
  visualAssetPreference?: VisualAssetPreference
}

function getDefaultCliSettings(): CliSettings {
  return {
    uiLocale: DEFAULT_UI_LOCALE,
    uiLocaleConfigured: false,
    workspaceTrustConfirmed: false,
    wordUpEnabled: false,
    wordUpIntervalMinutes: DEFAULT_WORDUP_INTERVAL_MINUTES,
    docsSearchEngine: DEFAULT_DOCS_SEARCH_ENGINE,
    docsSearchEngineConfigured: false,
    researchEngine: DEFAULT_RESEARCH_ENGINE,
    researchEngineConfigured: false,
    geminiApiKey: undefined,
    geminiDeepResearchAgent: undefined,
    geminiDeepResearchMaxPolls: DEFAULT_GEMINI_DEEP_RESEARCH_MAX_POLLS,
    geminiDeepResearchPollIntervalMs: DEFAULT_GEMINI_DEEP_RESEARCH_POLL_INTERVAL_MS,
    onboardingCompleted: false,
    bundleConfigured: false,
    bundleEnabled: false,
    bundleMode: 'auto',
    bundleModelChoice: 'brain',
    bundleMinLength: DEFAULT_BUNDLE_MIN_LENGTH,
    dailyAuditEnabled: false,
    trustedWorkspaceRoots: [],
    lastTrustedWorkspaceRoot: undefined,
    visualAssetPreference: undefined,
  }
}

function normalizeVisualAssetPreference(value: unknown): VisualAssetPreference | undefined {
  return value === 'local' || value === 'search' || value === 'skip'
    ? value
    : undefined
}

function normalizeBundleMode(value: unknown): BundleMode {
  return value === 'manual' ? 'manual' : 'auto'
}

function normalizeBundleModel(value: unknown): BundleModelChoice {
  return value === 'main' ? 'main' : 'brain'
}

function normalizeBundleMinLength(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : DEFAULT_BUNDLE_MIN_LENGTH
}

function normalizeIntervalMinutes(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : DEFAULT_WORDUP_INTERVAL_MINUTES
}

function normalizeDocsSearchEngine(value: unknown): DocsSearchEngine {
  return value === 'google' || value === 'bing' ? value : DEFAULT_DOCS_SEARCH_ENGINE
}

function normalizeResearchEngine(value: unknown): ResearchEngine {
  return value === 'gemini-deep-research' ? 'gemini-deep-research' : DEFAULT_RESEARCH_ENGINE
}

function normalizeGeminiDeepResearchAgent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed.startsWith('models/gemini-') ||
    trimmed.startsWith('gemini-')
  ) {
    return undefined
  }
  return trimmed
}

function normalizePositiveIntegerSetting(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : fallback
}

export class CliSettingsStore {
  private rootDir: string
  private filePath: string

  constructor(cwd: string) {
    this.rootDir = resolveDataRootDir(cwd)
    this.filePath = path.join(this.rootDir, 'cli-settings.json')
  }

  private async ensure(): Promise<void> {
    await ensureDir(this.rootDir)
  }

  async load(): Promise<CliSettings> {
    await this.ensure()
    if (!(await pathExists(this.filePath))) return getDefaultCliSettings()
    const raw = await readFile(this.filePath, 'utf8')
    const p = JSON.parse(raw) as Record<string, unknown>
    return {
      uiLocale: normalizeUiLocale(p.uiLocale as string | undefined),
      uiLocaleConfigured: p.uiLocaleConfigured === true &&
        (p.uiLocale === 'zh-CN' || p.uiLocale === 'en'),
      workspaceTrustConfirmed: p.workspaceTrustConfirmed === true,
      wordUpEnabled: p.wordUpEnabled === true,
      wordUpIntervalMinutes: normalizeIntervalMinutes(p.wordUpIntervalMinutes),
      docsSearchEngine: normalizeDocsSearchEngine(p.docsSearchEngine),
      docsSearchEngineConfigured: p.docsSearchEngineConfigured === true &&
        (p.docsSearchEngine === 'google' || p.docsSearchEngine === 'bing'),
      researchEngine: normalizeResearchEngine(p.researchEngine),
      researchEngineConfigured: p.researchEngineConfigured === true &&
        (p.researchEngine === 'builtin' || p.researchEngine === 'gemini-deep-research'),
      geminiApiKey: typeof p.geminiApiKey === 'string' && p.geminiApiKey.trim()
        ? p.geminiApiKey.trim()
        : undefined,
      geminiDeepResearchAgent: normalizeGeminiDeepResearchAgent(p.geminiDeepResearchAgent),
      geminiDeepResearchMaxPolls: normalizePositiveIntegerSetting(
        p.geminiDeepResearchMaxPolls,
        DEFAULT_GEMINI_DEEP_RESEARCH_MAX_POLLS,
      ),
      geminiDeepResearchPollIntervalMs: normalizePositiveIntegerSetting(
        p.geminiDeepResearchPollIntervalMs,
        DEFAULT_GEMINI_DEEP_RESEARCH_POLL_INTERVAL_MS,
      ),
      onboardingCompleted: p.onboardingCompleted === true,
      bundleConfigured: p.bundleConfigured === true,
      bundleEnabled: p.bundleEnabled === true,
      bundleMode: normalizeBundleMode(p.bundleMode),
      bundleModelChoice: normalizeBundleModel(p.bundleModelChoice),
      bundleMinLength: normalizeBundleMinLength(p.bundleMinLength),
      dailyAuditEnabled: p.dailyAuditEnabled === true,
      trustedWorkspaceRoots: normalizeTrustedWorkspaceRoots(p.trustedWorkspaceRoots),
      lastTrustedWorkspaceRoot: typeof p.lastTrustedWorkspaceRoot === 'string' && p.lastTrustedWorkspaceRoot.trim()
        ? path.resolve(p.lastTrustedWorkspaceRoot.trim())
        : undefined,
      visualAssetPreference: normalizeVisualAssetPreference(p.visualAssetPreference),
    }
  }

  async save(settings: CliSettings): Promise<void> {
    await this.ensure()
    await writeFile(this.filePath, JSON.stringify(settings, null, 2), 'utf8')
  }

  async update(partial: Partial<CliSettings>): Promise<CliSettings> {
    const current = await this.load()
    const next: CliSettings = {
      uiLocale: partial.uiLocale !== undefined
        ? normalizeUiLocale(partial.uiLocale) : current.uiLocale,
      uiLocaleConfigured: typeof partial.uiLocaleConfigured === 'boolean'
        ? partial.uiLocaleConfigured : current.uiLocaleConfigured,
      workspaceTrustConfirmed: typeof partial.workspaceTrustConfirmed === 'boolean'
        ? partial.workspaceTrustConfirmed : current.workspaceTrustConfirmed,
      wordUpEnabled: typeof partial.wordUpEnabled === 'boolean'
        ? partial.wordUpEnabled : current.wordUpEnabled,
      wordUpIntervalMinutes: partial.wordUpIntervalMinutes !== undefined
        ? normalizeIntervalMinutes(partial.wordUpIntervalMinutes) : current.wordUpIntervalMinutes,
      docsSearchEngine: partial.docsSearchEngine !== undefined
        ? normalizeDocsSearchEngine(partial.docsSearchEngine) : current.docsSearchEngine,
      docsSearchEngineConfigured: typeof partial.docsSearchEngineConfigured === 'boolean'
        ? partial.docsSearchEngineConfigured : current.docsSearchEngineConfigured,
      researchEngine: partial.researchEngine !== undefined
        ? normalizeResearchEngine(partial.researchEngine) : current.researchEngine,
      researchEngineConfigured: typeof partial.researchEngineConfigured === 'boolean'
        ? partial.researchEngineConfigured : current.researchEngineConfigured,
      geminiApiKey: typeof partial.geminiApiKey === 'string'
        ? partial.geminiApiKey.trim() || undefined : current.geminiApiKey,
      geminiDeepResearchAgent: partial.geminiDeepResearchAgent !== undefined
        ? normalizeGeminiDeepResearchAgent(partial.geminiDeepResearchAgent)
        : current.geminiDeepResearchAgent,
      geminiDeepResearchMaxPolls: partial.geminiDeepResearchMaxPolls !== undefined
        ? normalizePositiveIntegerSetting(partial.geminiDeepResearchMaxPolls, DEFAULT_GEMINI_DEEP_RESEARCH_MAX_POLLS)
        : current.geminiDeepResearchMaxPolls,
      geminiDeepResearchPollIntervalMs: partial.geminiDeepResearchPollIntervalMs !== undefined
        ? normalizePositiveIntegerSetting(partial.geminiDeepResearchPollIntervalMs, DEFAULT_GEMINI_DEEP_RESEARCH_POLL_INTERVAL_MS)
        : current.geminiDeepResearchPollIntervalMs,
      onboardingCompleted: typeof partial.onboardingCompleted === 'boolean'
        ? partial.onboardingCompleted : current.onboardingCompleted,
      bundleConfigured: typeof partial.bundleConfigured === 'boolean'
        ? partial.bundleConfigured : current.bundleConfigured,
      bundleEnabled: typeof partial.bundleEnabled === 'boolean'
        ? partial.bundleEnabled : current.bundleEnabled,
      bundleMode: partial.bundleMode !== undefined
        ? normalizeBundleMode(partial.bundleMode) : current.bundleMode,
      bundleModelChoice: partial.bundleModelChoice !== undefined
        ? normalizeBundleModel(partial.bundleModelChoice) : current.bundleModelChoice,
      bundleMinLength: partial.bundleMinLength !== undefined
        ? normalizeBundleMinLength(partial.bundleMinLength) : current.bundleMinLength,
      dailyAuditEnabled: typeof partial.dailyAuditEnabled === 'boolean'
        ? partial.dailyAuditEnabled : current.dailyAuditEnabled,
      trustedWorkspaceRoots: partial.trustedWorkspaceRoots !== undefined
        ? normalizeTrustedWorkspaceRoots(partial.trustedWorkspaceRoots)
        : current.trustedWorkspaceRoots,
      lastTrustedWorkspaceRoot: typeof partial.lastTrustedWorkspaceRoot === 'string' && partial.lastTrustedWorkspaceRoot.trim()
        ? path.resolve(partial.lastTrustedWorkspaceRoot.trim())
        : partial.lastTrustedWorkspaceRoot === undefined
          ? current.lastTrustedWorkspaceRoot
          : undefined,
      visualAssetPreference: partial.visualAssetPreference !== undefined
        ? normalizeVisualAssetPreference(partial.visualAssetPreference)
        : current.visualAssetPreference,
    }
    await this.save(next)
    return next
  }

  async setUiLocale(locale: UiLocale): Promise<CliSettings> {
    return this.update({ uiLocale: locale, uiLocaleConfigured: true })
  }

  async setWordUpEnabled(enabled: boolean): Promise<CliSettings> {
    return this.update({ wordUpEnabled: enabled })
  }

  async setWorkspaceTrustConfirmed(confirmed: boolean): Promise<CliSettings> {
    return this.update({ workspaceTrustConfirmed: confirmed })
  }

  async isWorkspaceTrusted(workspacePath: string): Promise<boolean> {
    const current = await this.load()
    const target = path.resolve(workspacePath)
    return current.trustedWorkspaceRoots.some((root) => isPathInsideWorkspace(root, target))
  }

  async rememberTrustedWorkspace(workspacePath: string): Promise<CliSettings> {
    const current = await this.load()
    const trustedWorkspaceRoots = mergeTrustedWorkspaceRoots(
      current.trustedWorkspaceRoots,
      workspacePath,
    )
    return this.update({
      workspaceTrustConfirmed: true,
      trustedWorkspaceRoots,
      lastTrustedWorkspaceRoot: path.resolve(workspacePath),
    })
  }

  async setDocsSearchEngine(engine: DocsSearchEngine): Promise<CliSettings> {
    return this.update({ docsSearchEngine: engine, docsSearchEngineConfigured: true })
  }

  async clearVisualAssetPreference(): Promise<CliSettings> {
    const current = await this.load()
    const next: CliSettings = {
      ...current,
      visualAssetPreference: undefined,
    }
    await this.save(next)
    return next
  }

  async setResearchEngine(engine: ResearchEngine): Promise<CliSettings> {
    return this.update({ researchEngine: engine, researchEngineConfigured: true })
  }

  async setBundleConfig(config: {
    enabled: boolean
    mode: BundleMode
    modelChoice: BundleModelChoice
  }): Promise<CliSettings> {
    return this.update({
      bundleConfigured: true,
      bundleEnabled: config.enabled,
      bundleMode: config.mode,
      bundleModelChoice: config.modelChoice,
    })
  }

  async setBundleEnabled(enabled: boolean): Promise<CliSettings> {
    return this.update({ bundleEnabled: enabled, bundleConfigured: true })
  }
}
