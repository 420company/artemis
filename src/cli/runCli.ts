/**
 * cli/runCli.ts — top-level CLI dispatcher
 *
 * Handles: help, version, config, doctor, chat (interactive).
 * Each subcommand either handles itself or delegates to runInteractive().
 */

import path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { notifyTerminal } from './bridgeNotify.js'
import { parseArgs, getHelpText } from './parseArgs.js'
import { getVersionText } from './branding.js'
import { buildPanel } from './ui.js'
import { CliSettingsStore } from './settings.js'
import { ProviderStore } from '../providers/store.js'
import { createProviderFromConfig } from '../providers/factory.js'
import { probeProviderConfig, probeProviderNativeToolCalls } from '../providers/health.js'
import { formatProviderProfileTelemetry } from '../providers/telemetry.js'
import { runInteractive } from './interactive.js'
import { runOnboarding, runVisualModelSetup } from './onboarding.js'
import { runSetupWizard } from './setupWizard.js'
import { runMemoryEnhancementSetup } from './memorySetup.js'
import { runFirstRunWelcome } from './firstRunWelcome.js'
import { runWorkspaceTrustDialog } from './workspaceTrust.js'
import { runWordup, loadResumeSession } from './wordup.js'
import { runTelegramBridge, setupTelegramBridge, shouldAutoStartTelegram } from '../telegram/bridge.js'
import { runDiscordBridge, setupDiscordBridge, shouldAutoStartDiscordBridge } from '../discord/bridge.js'
import { runWeChatBridge, setupWeChatBridge, shouldAutoStartWeChatBridge } from '../wechat/bridge.js'
import { McpServerStore } from '../mcp/store.js'
import { probeMcpServer } from '../mcp/probe.js'
import { OdinStore } from '../odin/store.js'
import { SessionStore } from '../storage/sessions.js'
import { parseHeimdallCommandBody, buildHeimdallReport, buildHeimdallThreadsReport } from '../services/heimdallControl.js'
import type { UiLocale } from './locale.js'
import { normalizeUiLocale } from './locale.js'
import type { PermissionMode } from './parseArgs.js'
import { findInstructionFiles } from './artemisMd.js'
import { QueryEngine } from '../core/queryEngine.js'
import { SecurityAuditSystem } from '../core/securityAuditSystem.js'
import { executeAction } from '../tools/index.js'
import { getToolDefinition, toolDefs, validateToolRegistryIntegrity } from '../tools/registry.js'
import { getVisualProviderSupportNote } from '../tools/visual/providers/interface.js'
import { resolveDataRootDir } from '../utils/fs.js'

export async function runCli(argv: string[]): Promise<void> {
  let options
  try {
    options = parseArgs(argv)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`  Error: ${msg}`)
    console.error(`  Run 'artemis help' for usage.`)
    process.exit(1)
  }

  // ─── ANSI ────────────────────────────────────────────────────────────────────

  const A = {
    reset:    '\x1b[0m',  bold:    '\x1b[1m',  dim:    '\x1b[2m',
    cyan:     '\x1b[36m', green:   '\x1b[32m', yellow: '\x1b[33m',
    magenta:  '\x1b[35m', blue:    '\x1b[34m', red:    '\x1b[31m',
    white:    '\x1b[97m', gray:    '\x1b[90m',
    bgCyan:   '\x1b[46m', bgGreen: '\x1b[42m', black:  '\x1b[30m',
  }
  const c = (text: string, ...codes: string[]): string =>
    process.stdout.isTTY ? codes.join('') + text + A.reset : text

  const settingsStore = new CliSettingsStore(options.cwd)
  const trustSettingsStore = new CliSettingsStore(os.homedir())
  const settings = await settingsStore.load()
  let locale: UiLocale = normalizeUiLocale(
    process.env.ARTEMIS_LOCALE ?? (settings.uiLocaleConfigured ? settings.uiLocale : undefined)
  )
  let suppressInitialNewbornOnce = false

  // ── help ────────────────────────────────────────────────────────────────────
  if (options.command === 'help') {
    console.log(getHelpText(locale))
    return
  }

  // ── version ─────────────────────────────────────────────────────────────────
  if (options.command === 'version') {
    console.log(getVersionText())
    return
  }

  if (!settings.uiLocaleConfigured) {
    locale = await runFirstRunWelcome({ settingsStore })
    suppressInitialNewbornOnce = true
  }

  // ── workspace trust check ───────────────────────────────────────────────────
  // Skip for pure info commands that don't touch the filesystem via tools.
  // Trusted roots are remembered globally in ~/.artemis so switching to a new
  // workspace prompts once, while returning to a known workspace stays quiet.
  const trustExemptCommands = new Set(['help', 'version', 'doctor'])
  if (!trustExemptCommands.has(options.command ?? '')) {
    const alreadyTrusted = await trustSettingsStore.isWorkspaceTrusted(options.cwd)
    if (!alreadyTrusted) {
      const result = await runWorkspaceTrustDialog({
        cwd: options.cwd,
        locale,
        settingsStore: trustSettingsStore,
      })
      if (result === 'declined') {
        const msg = locale === 'zh-CN'
          ? '已取消。请在你信任的项目目录下重新启动 artemis。'
          : 'Declined. Relaunch artemis from a workspace you trust.'
        console.log()
        console.log(`  ${msg}`)
        console.log()
        process.exit(0)
      }
    } else {
      await trustSettingsStore.rememberTrustedWorkspace(options.cwd)
    }
    suppressInitialNewbornOnce = true
  }

  if (!options.maxTurnsExplicit) {
    try {
      const runtimeProviderStore = new ProviderStore(options.cwd)
      const runtimeProviderData = await runtimeProviderStore.load()
      const configuredMaxTurns = runtimeProviderData.setup?.agent.maxIterations
      if (typeof configuredMaxTurns === 'number' && Number.isFinite(configuredMaxTurns) && configuredMaxTurns > 0) {
        options.maxTurns = Math.max(1, Math.round(configuredMaxTurns))
      }
    } catch {
      // keep CLI default when setup config is unavailable
    }
  }

  // ── config ──────────────────────────────────────────────────────────────────
  if (options.command === 'config') {
    const configSubcommand = options.prompt?.trim().toLowerCase()
    const setupSections = new Set(['model', 'provider', 'providers', 'visual', 'vision', 'gateway', 'messaging', 'bragi', 'agent', 'memory'])
    if (options.setup || (configSubcommand && setupSections.has(configSubcommand))) {
      await runSetupWizard({ locale, cwd: options.cwd, section: options.setup ? undefined : configSubcommand })
    } else if (configSubcommand === 'visual' || configSubcommand === 'vision') {
      await runVisualModelSetup(locale, options.cwd)
    } else if (configSubcommand === 'memory') {
      await runMemoryEnhancementSetup(locale, options.cwd)
    } else {
      await runConfig({ cwd: options.cwd, locale })
    }
    return
  }

  // ── setup ───────────────────────────────────────────────────────────────────
  if (options.command === 'setup') {
    await runSetupWizard({ locale, cwd: options.cwd, section: options.prompt })
    return
  }

  // ── doctor ──────────────────────────────────────────────────────────────────
  if (options.command === 'doctor') {
    await runDoctor({ cwd: options.cwd, locale, testProviders: options.testProviders })
    return
  }

  // ── resume ──────────────────────────────────────────────────────────────────
  if (options.command === 'resume') {
    await runResumeCommand({ cwd: options.cwd, locale, sessionId: options.sessionId, settingsStore, permissionMode: options.permissionMode, autoDrive: options.autoDrive, model: options.model, maxTurns: options.maxTurns })
    return
  }

  // ── wordup ──────────────────────────────────────────────────────────────────
  if (options.command === 'wordup') {
    await runWordup({ cwd: options.cwd, locale })
    return
  }

  // ── bragi ───────────────────────────────────────────────────────────────────
  if (options.command === 'bragi') {
    await runBragiCommand({ cwd: options.cwd, locale, args: options.prompt?.split(' ') ?? [] })
    return
  }

  // ── mcp ──────────────────────────────────────────────────────────────────────
  if (options.command === 'mcp') {
    await runMcpCommand({ cwd: options.cwd, locale, args: options.prompt?.split(' ') ?? [] })
    return
  }

  // ── odin ─────────────────────────────────────────────────────────────────────
  if (options.command === 'odin') {
    await runOdinCommand({ cwd: options.cwd, locale, args: options.prompt?.split(' ') ?? [] })
    return
  }

  // ── heimdall ──────────────────────────────────────────────────────────────────
  if (options.command === 'heimdall') {
    await runHeimdallCommand({ cwd: options.cwd, locale, args: options.prompt?.split(' ') ?? [] })
    return
  }

  // ── memory ──────────────────────────────────────────────────────────────────
  if (options.command === 'memory') {
    const { runMemoryCommand } = await import('./memoryDashboard.js')
    await runMemoryCommand({ cwd: options.cwd, locale, args: options.prompt?.split(' ') ?? [] })
    return
  }

  const commandArgs = splitCommandArgs(options.prompt)

  // ── tool ───────────────────────────────────────────────────────────────────
  if (options.command === 'tool') {
    await runToolCommand({ cwd: options.cwd, locale, args: commandArgs })
    return
  }

  // ── analyze / execute ──────────────────────────────────────────────────────
  if (options.command === 'analyze' || options.command === 'execute') {
    await runQueryCommand({
      locale,
      prompt: options.prompt,
      mode: options.command,
      model: options.model,
    })
    return
  }

  // ── skill ──────────────────────────────────────────────────────────────────
  if (options.command === 'skill') {
    await runSkillCommand({ cwd: options.cwd, locale, args: commandArgs })
    return
  }

  // ── audit ──────────────────────────────────────────────────────────────────
  if (options.command === 'audit') {
    await runAuditCommand({ cwd: options.cwd, locale, args: commandArgs })
    return
  }

  // ── session ────────────────────────────────────────────────────────────────
  if (options.command === 'session') {
    await runSessionCommand({ cwd: options.cwd, locale, args: commandArgs })
    return
  }

  // ── stubs for advanced subcommands ──────────────────────────────────────────
  const stubCommands: Record<string, string> = {
    tasks:    'Task manager (coming soon)',
    runtimes: 'Runtime profiles (coming soon)',
  }
  if (options.command in stubCommands) {
    console.log()
    console.log(buildPanel(options.command, [stubCommands[options.command as keyof typeof stubCommands]]))
    console.log()
    return
  }

  // ── provider onboarding (first-run) ─────────────────────────────────────────
  const isUsableProviderConfig = (config: {
    apiKey?: string
    baseUrl?: string
    model?: string
  } | undefined): boolean =>
    Boolean(
      config?.apiKey?.trim() &&
      config?.baseUrl?.trim() &&
      config?.model?.trim()
    )

  // Check cwd-local AND global (~/.artemis) for existing config
  const providerStore = new ProviderStore(options.cwd)
  const providerData = await providerStore.load()
  let activeConfig = providerStore.getDefaultMainProfile(providerData)
  if (!isUsableProviderConfig(activeConfig)) {
    const { homedir } = await import('node:os')
    const globalStore = new ProviderStore(homedir())
    const globalData = await globalStore.load()
    activeConfig = globalStore.getDefaultMainProfile(globalData)
  }
  const hasEnvKey = Boolean(process.env.ANTHROPIC_API_KEY)
  if (!isUsableProviderConfig(activeConfig) && !hasEnvKey) {
    await runSetupWizard({ locale, cwd: options.cwd, forceFirstTime: true })
    suppressInitialNewbornOnce = true
  }

  // ── prepare for interactive session ─────────────────────────────────────────
  const bridgeSessionStore = new SessionStore(options.cwd)
  const bridgeAborts: AbortController[] = []
  // Bridge logs go to a file so they don't pollute the interactive terminal.
  const bridgeLogPath = path.join(os.homedir(), '.artemis', 'bridge.log')
  const logToBridgeFile = (name: string, msg: string) => {
    const line = `[${new Date().toISOString()}] [${name}] ${msg}\n`
    appendFile(bridgeLogPath, line).catch(() => {})
  }

  // Auto-restart bridge on failure with exponential back-off (max 60 s).
  const startedBridges = new Set<string>()
  const startBridge = (name: string, fn: (signal: AbortSignal) => Promise<void>) => {
    if (startedBridges.has(name)) return
    startedBridges.add(name)
    const ac = new AbortController()
    bridgeAborts.push(ac)
    const run = (delayMs: number) => {
      fn(ac.signal).catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('aborted') || ac.signal.aborted) return
        logToBridgeFile(name, `crash: ${msg}`)
        const next = Math.min(delayMs * 2, 60_000)
        logToBridgeFile(name, `restarting in ${next / 1000}s...`)
        setTimeout(() => run(next), next)
      })
    }
    run(2_000)
  }

  const launchBridgeByName = (platform: string) => {
    // Bridges inherit the CLI's permission mode so /accept-all on launch also
    // empowers Telegram/Discord/WeChat sessions to write code remotely.
    const defaultPermissionMode = options.permissionMode
    if (platform === 'telegram') {
      startBridge('telegram', signal => runTelegramBridge({ cwd: options.cwd, sessionStore: bridgeSessionStore, maxTurns: 8, defaultPermissionMode, signal, onInfo: msg => logToBridgeFile('telegram', msg), onNotify: notifyTerminal }))
      return
    }
    if (platform === 'discord') {
      startBridge('discord', signal => runDiscordBridge({ cwd: options.cwd, sessionStore: bridgeSessionStore, maxTurns: 8, defaultPermissionMode, signal, onInfo: msg => logToBridgeFile('discord', msg), onNotify: notifyTerminal }))
      return
    }
    if (platform === 'wechat') {
      startBridge('wechat', signal => runWeChatBridge({ cwd: options.cwd, sessionStore: bridgeSessionStore, maxTurns: 8, defaultPermissionMode, signal, onInfo: msg => logToBridgeFile('wechat', msg), onNotify: notifyTerminal }))
    }
  }

  // ── chat / default ──────────────────────────────────────────────────────────
  const workflowCommands = new Set(['run', 'athena', 'design', 'niko', 'contest', 'nidhogg'])
  const initialPrompt = workflowCommands.has(options.command)
    ? `/${options.command} ${options.prompt ?? ''}`.trim()
    : options.prompt

  await runInteractive({
    cwd: options.cwd,
    locale,
    permissionMode: options.permissionMode,
    autoDrive: options.autoDrive,
    model: options.model,
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    maxTurns: options.maxTurns,
    initialPrompt,
    sessionId: options.sessionId,
    resumeLast: options.resumeLast,
    suppressInitialNewbornOnce,
    onBridgeStart: launchBridgeByName,
    settingsStore,
    // Pass the bridges that should be auto-started
    autoStartBridges: ([] as string[])
      .concat(await shouldAutoStartTelegram(options.cwd) ? ['telegram'] : [])
      .concat(await shouldAutoStartDiscordBridge(options.cwd) ? ['discord'] : [])
      .concat(await shouldAutoStartWeChatBridge(options.cwd) ? ['wechat'] : []),
  })
}

function splitCommandArgs(prompt: string | undefined): string[] {
  return (prompt ?? '')
    .split(/\s+/)
    .map(part => part.trim())
    .filter(Boolean)
}

function parsePrimitiveValue(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function parseKeyValueArgs(args: string[]): Record<string, unknown> {
  const parsed: Record<string, unknown> = {}
  for (const arg of args) {
    const idx = arg.indexOf('=')
    if (idx <= 0) continue
    const key = arg.slice(0, idx).trim()
    const value = arg.slice(idx + 1).trim()
    if (key) parsed[key] = parsePrimitiveValue(value)
  }
  return parsed
}

async function runToolCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale, args } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const sub = args[0]?.toLowerCase()

  if (!sub || sub === 'list' || sub === 'ls' || sub === '--list') {
    const rows = toolDefs
      .map(tool => {
        const executor = tool.execute ? 'direct' : tool.executionMode === 'non-blocking' ? 'runtime' : 'registered'
        return `${tool.type.padEnd(24)} ${tool.kind.padEnd(8)} ${tool.permissionCategory.padEnd(9)} ${executor}`
      })
    console.log()
    console.log(buildPanel(t(`工具 (${toolDefs.length})`, `Tools (${toolDefs.length})`), [
      'type                     kind     permission executor',
      ...rows,
    ]))
    console.log()
    return
  }

  if (sub === 'detail' || sub === 'show' || sub === '--detail') {
    const toolName = args[1]
    const tool = toolName ? getToolDefinition(toolName) : undefined
    if (!tool) {
      console.log()
      console.log(buildPanel(t('工具未找到', 'Tool not found'), [toolName ?? t('缺少工具名。', 'Missing tool name.')]))
      console.log()
      return
    }
    console.log()
    console.log(buildPanel(tool.type, [
      tool.description,
      `Kind: ${tool.kind}`,
      `Permission: ${tool.permissionCategory}`,
      `Execution: ${tool.executionMode}`,
      `Parallel safe: ${tool.parallelSafe ? 'yes' : 'no'}`,
      `Direct executor: ${tool.execute ? 'yes' : 'no'}`,
    ]))
    console.log()
    return
  }

  const toolName = sub === 'run' || sub === 'exec' || sub === '--run' ? args[1] : args[0]
  const payloadArgs = sub === 'run' || sub === 'exec' || sub === '--run' ? args.slice(2) : args.slice(1)
  const tool = getToolDefinition(toolName ?? '')
  if (!tool) {
    console.log()
    console.log(buildPanel(t('未知工具', 'Unknown tool'), [
      toolName ?? t('缺少工具名。', 'Missing tool name.'),
      t('运行 artemis tool --list 查看可用工具。', 'Run artemis tool --list to inspect available tools.'),
    ]))
    console.log()
    return
  }
  if (!tool.execute) {
    console.log()
    console.log(buildPanel(t('工具不可直接执行', 'Tool is not directly executable'), [
      `${tool.type}: ${tool.description}`,
      t('该工具由 agent runtime 管理，或仅注册为能力声明。', 'This tool is runtime-managed or registered as a capability declaration.'),
    ]))
    console.log()
    return
  }

  const action = {
    type: tool.type,
    ...parseKeyValueArgs(payloadArgs),
  } as any
  const result = await executeAction(action, {
    cwd,
    permissionMode: 'accept-all',
    updateCwd: () => {},
  })
  console.log(result.output)
}

async function runQueryCommand(options: {
  locale: UiLocale
  prompt?: string
  mode: 'analyze' | 'execute'
  model?: string
}): Promise<void> {
  const { locale, prompt, mode, model } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  if (!prompt?.trim()) {
    console.log()
    console.log(buildPanel(t(`${mode} 用法`, `${mode} usage`), [
      `artemis ${mode} <query>`,
    ]))
    console.log()
    return
  }
  const engine = new QueryEngine({
    enableDebug: mode === 'analyze',
    enableStreaming: false,
  })
  const result = await engine.executeQuery(prompt, {
    model,
    thinkingMode: mode === 'analyze',
  })
  const responseText = typeof result.response?.text === 'string'
    ? result.response.text
    : JSON.stringify(result.response, null, 2)
  console.log()
  console.log(buildPanel(mode === 'analyze' ? t('分析结果', 'Analysis result') : t('执行结果', 'Execution result'), [
    responseText,
    `Session: ${result.sessionId}`,
    `Duration: ${result.durationMs}ms`,
    `Tokens: ${result.usage?.total_tokens ?? 0}`,
  ]))
  console.log()
}

type SkillSummary = {
  id: string
  title: string
  path: string
  description: string
  virtual?: boolean
}

const SKILL_NAME_ALIASES: Record<string, string> = {
  'logo-generator': 'logo-designer',
  'logo-generator-skill': 'logo-designer',
  'html-ppt': 'kaleidoscope',
  'html-ppt-skill': 'kaleidoscope',
  'qiaomu-mondo-poster-design': 'shit-poster',
  'claude-design-sys-prompt': 'dirty-prompt',
  'Claude-Design-Sys-Prompt': 'dirty-prompt',
  hue: 'color-master',
  'extract-design': 'web-spider',
  'design-extract': 'web-spider',
}

const DESIGN_CAPABILITY_SKILLS: SkillSummary[] = [
  {
    id: 'logo-designer',
    title: 'logo-designer',
    path: '(design capability)',
    description: 'Renamed from logo-generator-skill. SVG logo systems, geometric variants, export-ready marks, and showcase presentation.',
    virtual: true,
  },
  {
    id: 'kaleidoscope',
    title: 'kaleidoscope',
    path: '(design capability)',
    description: 'Renamed from html-ppt-skill. HTML pages, decks, themes, layouts, animations, and static presentation systems.',
    virtual: true,
  },
  {
    id: 'shit-poster',
    title: 'shit-poster',
    path: '(design capability)',
    description: 'Renamed from qiaomu-mondo-poster-design. Posters, covers, social ratios, strong hierarchy, and style-directed composition.',
    virtual: true,
  },
  {
    id: 'dirty-prompt',
    title: 'dirty-prompt',
    path: '(design capability)',
    description: 'Renamed from Claude-Design-Sys-Prompt. Structured design prompt protocol, constraints, negative prompts, and execution brief.',
    virtual: true,
  },
  {
    id: 'color-master',
    title: 'color-master',
    path: '(design capability)',
    description: 'Renamed from hue. Brand learning, token extraction, typography, spacing, components, light/dark modes, and visual consistency.',
    virtual: true,
  },
  {
    id: 'web-spider',
    title: 'web-spider',
    path: '(design capability)',
    description: 'Renamed from design-extract. Website design-system extraction, DTCG tokens, CSS health, WCAG remediation, and MCP context.',
    virtual: true,
  },
]

async function discoverLocalSkills(cwd: string): Promise<SkillSummary[]> {
  const roots = [
    path.join(cwd, 'skills'),
    path.join(cwd, 'plugins'),
  ].filter(root => fs.existsSync(root))
  const results: SkillSummary[] = []
  const skipDirs = new Set(['node_modules', '.git', 'dist', '.next', 'coverage'])
  const seenIds = new Set<string>()

  // 首先遍历目录，收集所有技能文件夹
  const skillDirectories = new Set<string>()
  const collectSkillDirs = async (dir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue
        const fullPath = path.join(dir, entry.name)
        // 检查这个目录是否包含技能文件
        const hasSkillFile = await Promise.all([
          fs.promises.access(path.join(fullPath, 'SKILL.md')).then(() => true).catch(() => false),
          fs.promises.access(path.join(fullPath, 'SKILL.json')).then(() => true).catch(() => false)
        ]).then(([hasMd, hasJson]) => hasMd || hasJson)
        
        if (hasSkillFile) {
          skillDirectories.add(fullPath)
        } else {
          // 继续递归查找子目录
          await collectSkillDirs(fullPath)
        }
      }
    }
  }

  for (const root of roots) {
    await collectSkillDirs(root)
  }

  // 为每个技能文件夹加载技能信息，优先 SKILL.md
  for (const skillDir of skillDirectories) {
    const rawId = path.basename(skillDir)
    const id = SKILL_NAME_ALIASES[rawId] ?? rawId
    
    if (seenIds.has(id)) continue
    seenIds.add(id)
    
    // 优先尝试加载 SKILL.md
    const mdPath = path.join(skillDir, 'SKILL.md')
    if (fs.existsSync(mdPath)) {
      try {
        const raw = await fs.promises.readFile(mdPath, 'utf8')
        const lines = raw.split(/\r?\n/)
        const title = lines.find(line => line.startsWith('# '))?.replace(/^#\s+/, '').trim() || rawId
        const description = lines
          .filter(line => line.trim() && !line.startsWith('#'))
          .slice(0, 2)
          .join(' ')
          .slice(0, 180)
        
        results.push({
          id,
          title: id === rawId ? title : id,
          path: mdPath,
          description,
        })
        continue
      } catch (error) {
        console.warn(`Failed to parse SKILL.md: ${mdPath}`, error)
      }
    }
    
    // 如果 SKILL.md 加载失败或不存在，尝试加载 SKILL.json
    const jsonPath = path.join(skillDir, 'SKILL.json')
    if (fs.existsSync(jsonPath)) {
      try {
        const raw = await fs.promises.readFile(jsonPath, 'utf8')
        const skillData = JSON.parse(raw)
        
        results.push({
          id,
          title: skillData.name || id,
          path: jsonPath,
          description: skillData.description?.slice(0, 180) || '',
        })
      } catch (error) {
        console.warn(`Failed to parse SKILL.json: ${jsonPath}`, error)
      }
    }
  }

  for (const capability of DESIGN_CAPABILITY_SKILLS) {
    if (!seenIds.has(capability.id)) {
      seenIds.add(capability.id)
      results.push(capability)
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id))
}

async function runSkillCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale, args } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const sub = args[0]?.toLowerCase()
  const skills = await discoverLocalSkills(cwd)

  if (!sub || sub === 'list' || sub === 'ls' || sub === '--list') {
    const rows = skills.length > 0
      ? skills.map(skill => `${skill.id.padEnd(28)} ${skill.title}`)
      : [t('未发现本地 SKILL.md。', 'No local SKILL.md files found.')]
    console.log()
    console.log(buildPanel(t(`技能 (${skills.length})`, `Skills (${skills.length})`), rows))
    console.log()
    return
  }

  // 执行技能功能
  if (sub === 'execute' || sub === 'run' || sub === '--execute' || sub === '--run') {
    const name = args[1]
    if (!name) {
      console.log()
      console.log(buildPanel(t('用法', 'Usage'), [
        `artemis skill ${sub} <skill-name> [inputs]`,
        t('运行 artemis skill --list 查看可用技能。', 'Run artemis skill --list to inspect available skills.'),
      ]))
      console.log()
      return
    }

    const skill = skills.find(candidate =>
      candidate.id === name ||
      candidate.title.toLowerCase() === name?.toLowerCase()
    )
    if (!skill) {
      console.log()
      console.log(buildPanel(t('技能未找到', 'Skill not found'), [
        name,
        t('运行 artemis skill --list 查看可用技能。', 'Run artemis skill --list to inspect available skills.'),
      ]))
      console.log()
      return
    }

    // 解析输入参数
    let inputs = {}
    if (args[2]) {
      try {
        inputs = JSON.parse(args[2])
      } catch (error) {
        console.log()
        console.log(buildPanel(t('输入解析错误', 'Input parse error'), [
          t('输入参数必须是有效的 JSON 格式。', 'Input must be valid JSON.'),
          String(error),
        ]))
        console.log()
        return
      }
    }

    // 创建技能管理器
    const { SkillManager } = await import('../core/skillManager.js')
    const skillManager = new SkillManager()
    
    try {
      // 执行技能
      const result = await skillManager.executeSkill(skill.id, inputs, {
        cwd,
        workingDirectory: cwd,
        environmentVariables: Object.entries(process.env).reduce((acc, [key, value]) => {
          if (value !== undefined) {
            acc[key] = value;
          }
          return acc;
        }, {} as Record<string, string>),
        tools: toolDefs,
        logger: {
          info: (msg: string) => console.log(`INFO: ${msg}`),
          warn: (msg: string) => console.warn(`WARN: ${msg}`),
          error: (msg: string) => console.error(`ERROR: ${msg}`),
          debug: (msg: string) => {},
        },
      })

      console.log()
      if (result.success) {
        console.log(buildPanel(t('技能执行成功', 'Skill execution successful'), [
          JSON.stringify(result.output, null, 2),
        ]))
      } else {
        console.log(buildPanel(t('技能执行失败', 'Skill execution failed'), [
          result.error || t('未知错误', 'Unknown error'),
        ]))
      }
      console.log()
    } catch (error) {
      console.log()
      console.log(buildPanel(t('技能执行错误', 'Skill execution error'), [
        String(error),
      ]))
      console.log()
    }
    return
  }

  const name = sub === 'show' || sub === 'detail' || sub === '--detail' || sub === 'info' || sub === '--info' ? args[1] : args[0]
  const skill = skills.find(candidate =>
    candidate.id === name ||
    candidate.title.toLowerCase() === name?.toLowerCase()
  )
  if (!skill) {
    console.log()
    console.log(buildPanel(t('技能未找到', 'Skill not found'), [
      name ?? t('缺少技能名。', 'Missing skill name.'),
      t('运行 artemis skill --list 查看可用技能。', 'Run artemis skill --list to inspect available skills.'),
    ]))
    console.log()
    return
  }

  const raw = skill.virtual
    ? skill.description
    : await fs.promises.readFile(skill.path, 'utf8')
  console.log()
  console.log(buildPanel(skill.title, [
    `ID: ${skill.id}`,
    `Path: ${skill.path}`,
    '',
    raw.split(/\r?\n/).slice(0, 60).join('\n'),
  ]))
  console.log()
}

async function runAuditCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale, args } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const sub = args[0]?.toLowerCase() ?? 'scan'
  const audit = new SecurityAuditSystem()

  if (sub === 'report' || sub === '--report') {
    console.log(audit.generateAuditReport())
    return
  }
  if (sub === 'stats' || sub === '--stats') {
    console.log(JSON.stringify(audit.getAuditStatistics(), null, 2))
    return
  }

  const registryErrors = validateToolRegistryIntegrity()
  const directTools = toolDefs.filter(tool => Boolean(tool.execute)).length
  const dataRoot = resolveDataRootDir(cwd)
  const lines = [
    `Data root: ${dataRoot}`,
    `Registered tools: ${toolDefs.length}`,
    `Direct executors: ${directTools}`,
    `Runtime-managed/capability-only tools: ${toolDefs.length - directTools}`,
    registryErrors.length === 0
      ? t('Tool registry: PASS', 'Tool registry: PASS')
      : t('Tool registry: FAIL', 'Tool registry: FAIL'),
    ...registryErrors.map(error => `- ${error}`),
  ]
  console.log()
  console.log(buildPanel(t('审计扫描', 'Audit scan'), lines))
  console.log()
}

async function runSessionCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale, args } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const sub = args[0]?.toLowerCase()
  const store = new SessionStore(cwd)

  if (!sub || sub === 'list' || sub === 'ls' || sub === '--list') {
    const sessions = await store.list()
    const rows = sessions.length > 0
      ? sessions.slice(0, 30).map(session => {
          const updated = session.updatedAt?.replace('T', ' ').replace(/\.\d+Z$/, 'Z') ?? ''
          return `${session.id}  ${updated}  ${session.title}`
        })
      : [t('没有会话记录。', 'No sessions found.')]
    console.log()
    console.log(buildPanel(t(`会话 (${sessions.length})`, `Sessions (${sessions.length})`), rows))
    console.log()
    return
  }

  if (sub === 'create' || sub === 'new' || sub === '--create') {
    const session = store.createSession({ title: args.slice(1).join(' ') || undefined })
    await store.save(session)
    console.log()
    console.log(buildPanel(t('会话已创建', 'Session created'), [
      `ID: ${session.id}`,
      `Title: ${session.title}`,
    ]))
    console.log()
    return
  }

  if (sub === 'show') {
    const id = args[1]
    if (!id) {
      console.log(t('\n  用法: artemis session show <id>', '\n  Usage: artemis session show <id>'))
      console.log()
      return
    }
    const session = await store.load(id)
    console.log(JSON.stringify(session, null, 2))
    return
  }

  if (sub === 'delete' || sub === 'rm' || sub === '--delete') {
    const idPrefix = args[1]
    if (!idPrefix) {
      console.log(t('\n  用法: artemis session delete <id>', '\n  Usage: artemis session delete <id>'))
      console.log()
      return
    }
    const sessions = await store.list()
    const session = sessions.find(candidate => candidate.id === idPrefix || candidate.id.startsWith(idPrefix))
    if (!session) {
      console.log()
      console.log(buildPanel(t('会话未找到', 'Session not found'), [idPrefix]))
      console.log()
      return
    }
    await fs.promises.unlink(path.join(resolveDataRootDir(cwd), 'sessions', `${session.id}.json`))
    console.log()
    console.log(buildPanel(t('会话已删除', 'Session deleted'), [`ID: ${session.id}`]))
    console.log()
    return
  }

  console.log()
  console.log(buildPanel(t('session 用法', 'session usage'), [
    'artemis session --list',
    'artemis session create [title]',
    'artemis session show <id>',
    'artemis session delete <id>',
  ]))
  console.log()
}

// ─── resume subcommand ───────────────────────────────────────────────────────

async function runResumeCommand(options: {
  cwd: string
  locale: UiLocale
  sessionId?: string
  settingsStore: CliSettingsStore
  permissionMode: PermissionMode
  autoDrive: boolean
  model?: string
  maxTurns: number
}): Promise<void> {
  const { locale, cwd, sessionId, settingsStore } = options

  const session = await loadResumeSession({
    cwd,
    sessionId,
    resumeLast: !sessionId,
    locale,
  })

  if (!session) {
    process.exit(1)
    return
  }

  await runInteractive({
    cwd,
    locale,
    permissionMode: options.permissionMode,
    autoDrive: options.autoDrive,
    model: options.model,
    maxTurns: options.maxTurns,
    resumeLast: !sessionId,
    sessionId: session.id,
    settingsStore,
  })
}

// ─── config subcommand ────────────────────────────────────────────────────────

async function runConfig(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { locale } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const store = new ProviderStore(options.cwd)
  const pData = await store.load()
  const config = store.getDefaultMainProfile(pData)
  const visualProfile = store.getVisualProfile(pData)
  const setupConfig = pData.setup
  const lines: string[] = []
  const configPath = path.join(resolveDataRootDir(options.cwd), 'providers.json')
  const noteLocale = locale === 'zh-CN' ? 'zh' : 'en'

  // ANSI colors for this function
  const A = {
    reset:    '\x1b[0m',  bold:    '\x1b[1m',  dim:    '\x1b[2m',
    cyan:     '\x1b[36m', green:   '\x1b[32m', yellow: '\x1b[33m',
    magenta:  '\x1b[35m', blue:    '\x1b[34m', red:    '\x1b[31m',
    white:    '\x1b[97m', gray:    '\x1b[90m',
    bgCyan:   '\x1b[46m', bgGreen: '\x1b[42m', black:  '\x1b[30m',
  }
  const c = (text: string, ...codes: string[]): string =>
    process.stdout.isTTY ? codes.join('') + text + A.reset : text

  if (config) {
    lines.push(`${t('当前 Provider', 'Active provider')}: ${config.protocol}`)
    {
      const key = config.apiKey ?? ''
      const masked = key.length > 8
        ? `${key.slice(0, 4)}****${key.slice(-4)}`
        : key.length > 2 ? `${key.slice(0, 2)}****` : '(not set)'
      lines.push(`API key: ${masked}`)
    }
    lines.push(`Model: ${config.model ?? '(none)'}`)
    if (config.baseUrl) {
      lines.push(`Base URL: ${config.baseUrl}`)
    }
    lines.push(
      `${t('延迟遥测', 'Latency telemetry')}: ${formatProviderProfileTelemetry(config.telemetry)}`,
    )
  } else {
    lines.push(t('未配置 Provider。', 'No provider configured.'))
    lines.push('')
    lines.push(t('设置 ANTHROPIC_API_KEY 后重启，或运行 artemis config --setup 向导。',
                 'Set ANTHROPIC_API_KEY and restart, or run artemis config --setup for wizard.'))
  }

  // 
  lines.push('')
  lines.push(c('视觉模型配置', A.bold))
  lines.push(`  启用: ${visualProfile.enabled ? c('✓', A.green) : c('✗', A.red)}`)
  
  lines.push(c('  图片生成:', A.cyan))
  lines.push(`    提供商: ${visualProfile.image.provider}`)
  lines.push(`    模型: ${visualProfile.image.model}`)
  const imgKey = visualProfile.image.apiKey ?? ''
  const maskedImgKey = imgKey.length > 8
    ? `${imgKey.slice(0, 4)}****${imgKey.slice(-4)}`
    : imgKey.length > 2 ? `${imgKey.slice(0, 2)}****` : '(not set)'
  lines.push(`    API Key: ${maskedImgKey}`)
  lines.push(`    尺寸: ${visualProfile.image.defaultParams.size}`)
  lines.push(`    质量: ${visualProfile.image.defaultParams.quality}`)
  lines.push(`    风格: ${visualProfile.image.defaultParams.style}`)
  if (visualProfile.image.defaultParams.outputFormat) {
    lines.push(`    输出格式: ${visualProfile.image.defaultParams.outputFormat}`)
  }
  if (typeof visualProfile.image.defaultParams.outputCompression === 'number') {
    lines.push(`    输出压缩: ${visualProfile.image.defaultParams.outputCompression}`)
  }
  if (visualProfile.image.defaultParams.background) {
    lines.push(`    背景: ${visualProfile.image.defaultParams.background}`)
  }
  lines.push(`    水印: ${visualProfile.image.defaultParams.watermark ? '是' : '否'}`)
  
  lines.push(c('  视频生成:', A.cyan))
  lines.push(`    启用: ${visualProfile.video.enabled ? c('✓', A.green) : c('✗', A.red)}`)
  lines.push(`    提供商: ${visualProfile.video.provider}`)
  lines.push(`    模型: ${visualProfile.video.model}`)
  const videoKey = visualProfile.video.apiKey ?? ''
  const maskedVideoKey = videoKey.length > 8
    ? `${videoKey.slice(0, 4)}****${videoKey.slice(-4)}`
    : videoKey.length > 2 ? `${videoKey.slice(0, 2)}****` : '(not set)'
  lines.push(`    API Key: ${maskedVideoKey}`)
  lines.push(`    时长: ${visualProfile.video.defaultParams.duration}`)
  lines.push(`    分辨率: ${visualProfile.video.defaultParams.resolution}`)
  lines.push(`    质量: ${visualProfile.video.defaultParams.quality}`)
  lines.push(`    风格: ${visualProfile.video.defaultParams.style}`)
  lines.push(`    格式: ${visualProfile.video.defaultParams.format}`)
  lines.push(`    帧率: ${visualProfile.video.defaultParams.framerate}`)

  const visualNotes = new Set<string>()
  if (visualProfile.enabled) {
    const imageNote = getVisualProviderSupportNote(visualProfile.image.provider, noteLocale)
    if (imageNote) visualNotes.add(imageNote)
    if (visualProfile.video.enabled) {
      const videoNote = getVisualProviderSupportNote(visualProfile.video.provider, noteLocale)
      if (videoNote) visualNotes.add(videoNote)
    }
  }
  if (visualNotes.size > 0) {
    lines.push('')
    lines.push(c(t('视觉说明', 'Visual notes'), A.bold + A.yellow))
    for (const note of visualNotes) {
      lines.push(`  - ${note}`)
    }
  }

  if (setupConfig) {
    lines.push('')
    lines.push(c(t('Agent 设置', 'Agent settings'), A.bold))
    lines.push(`  Max iterations: ${setupConfig.agent.maxIterations}`)
    lines.push(`  Compression threshold: ${setupConfig.agent.compression.threshold}`)
  }

  if ((pData.customProviders?.length ?? 0) > 0) {
    lines.push('')
    lines.push(c(t('自定义 Provider', 'Custom providers'), A.bold))
    for (const provider of pData.customProviders ?? []) {
      lines.push(`  ${provider.label}: ${provider.model} @ ${provider.baseUrl}`)
    }
  }

  lines.push('')
  if (fs.existsSync(configPath)) {
    lines.push(`${t('配置文件', 'Config file')}: ${configPath}`)
  } else {
    lines.push(t('配置文件未找到，使用环境变量。', 'Config file not found — using environment variables.'))
  }

  console.log()
  console.log(buildPanel(
    t('Provider 配置', 'Provider configuration'),
    lines
  ))
  console.log()
  console.log(t(
    '  运行 artemis setup 打开完整向导；artemis setup model/visual/gateway/agent/memory/terminal/tts/tools/session 可单独配置模块。',
    '  Run artemis setup for the full wizard; artemis setup model/visual/gateway/agent/memory/terminal/tts/tools/session configures a section.'
  ))
  console.log()
}

// ─── bragi subcommand ─────────────────────────────────────────────────────────

async function runBragiCommand(options: {
  cwd: string
  locale: UiLocale
  args: string[]
}): Promise<void> {
  const { cwd, locale, args } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const sub = args[0]?.toLowerCase()

  if (!sub || sub === 'help') {
    console.log()
    console.log(buildPanel(
      t('Bragi 远程桥', 'Bragi remote bridge'),
      [
        t('子命令:', 'Subcommands:'),
        '  artemis bragi telegram            ' + t('启动 Telegram bridge', 'Start Telegram bridge'),
        '  artemis bragi telegram setup      ' + t('配置 Telegram token', 'Configure Telegram token'),
        '  artemis bragi discord             ' + t('启动 Discord bridge', 'Start Discord bridge'),
        '  artemis bragi discord setup       ' + t('配置 Discord bot token', 'Configure Discord bot token'),
        '  artemis bragi wechat              ' + t('启动 WeChat 个人版 bridge', 'Start WeChat personal bridge'),
        '  artemis bragi wechat setup        ' + t('配置 WeChat 网关', 'Configure WeChat gateway'),
      ]
    ))
    console.log()
    return
  }

  if (sub === 'telegram') {
    const setupMode = args[1]?.toLowerCase() === 'setup'
    const sessionStore = new SessionStore(cwd)

    if (setupMode) {
      const result = await setupTelegramBridge({ cwd, onInfo: msg => console.log(msg) })
      console.log()
      console.log(result)
      console.log(buildPanel(t('下一步', 'Next step'), [t('运行 artemis 启动，Telegram bridge 将自动连接。', 'Run artemis — the Telegram bridge will connect automatically.')]))
      console.log()
      return
    }

    console.log()
    console.log(buildPanel(
      t('Telegram Bridge 启动中', 'Starting Telegram bridge'),
      [t('按 Ctrl+C 停止。', 'Press Ctrl+C to stop.')]
    ))
    console.log()

    await runTelegramBridge({
      cwd,
      sessionStore,
      maxTurns: 8,
      defaultPermissionMode: 'accept-all',
      onInfo: msg => console.log(msg),
    })
    return
  }

  if (sub === 'discord') {
    const setupMode = args[1]?.toLowerCase() === 'setup'
    if (setupMode) {
      const result = await setupDiscordBridge({ cwd, onInfo: msg => console.log(msg) })
      console.log()
      console.log(result)
      console.log(buildPanel(t('下一步', 'Next step'), [t('运行 artemis 启动，Discord bridge 将自动连接。', 'Run artemis — the Discord bridge will connect automatically.')]))
      console.log()
      return
    }
    const sessionStore = new SessionStore(cwd)
    console.log()
    console.log(buildPanel(
      t('Discord Bridge 启动中', 'Starting Discord bridge'),
      [t('按 Ctrl+C 停止。', 'Press Ctrl+C to stop.')]
    ))
    console.log()
    await runDiscordBridge({
      cwd,
      sessionStore,
      maxTurns: 8,
      defaultPermissionMode: 'accept-all',
      onInfo: msg => console.log(msg),
    })
    return
  }

  if (sub === 'wechat') {
    const setupMode = args[1]?.toLowerCase() === 'setup'
    const sessionStore = new SessionStore(cwd)
    if (setupMode) {
      const result = await setupWeChatBridge({ cwd, onInfo: msg => console.log(msg) })
      console.log()
      console.log(result)
      console.log(buildPanel(t('下一步', 'Next step'), [t('若已选择自动启动，重新运行 artemis 即可；否则运行 artemis bragi wechat 手动启动。', 'If auto-start was enabled, run artemis to connect automatically; otherwise run artemis bragi wechat to start manually.')]))
      console.log()
      return
    }
    console.log()
    console.log(buildPanel(
      t('WeChat Bridge 启动中', 'Starting WeChat bridge'),
      [t('按 Ctrl+C 停止。', 'Press Ctrl+C to stop.')]
    ))
    console.log()
    await runWeChatBridge({ cwd, sessionStore, maxTurns: 8, defaultPermissionMode: 'accept-all', onInfo: msg => console.log(msg) })
    return
  }

  console.log()
  console.log(buildPanel(
    t('未知 Bragi 子命令', 'Unknown Bragi subcommand'),
    [`"${sub}" — ` + t('运行 artemis bragi help 查看可用命令。', 'Run artemis bragi help for available commands.')]
  ))
  console.log()
}

// ─── mcp subcommand ──────────────────────────────────────────────────────────

async function runMcpCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale, args } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const sub = args[0]?.toLowerCase()
  const mcpStore = new McpServerStore(cwd)

  if (!sub || sub === 'list' || sub === 'ls') {
    const data = await mcpStore.load()
    if (data.servers.length === 0) {
      console.log()
      console.log(buildPanel(t('MCP 服务器', 'MCP servers'), [
        t('未配置 MCP 服务器。', 'No MCP servers configured.'),
        t('运行 artemis mcp add --stdio <命令> 添加。', 'Run artemis mcp add --stdio <command> to add one.'),
      ]))
      console.log()
      return
    }
    const rows = data.servers.map(s => {
      const status = s.enabled ? '✓' : '✗'
      const tools = s.surface?.tools?.length ?? '?'
      return `${status} ${s.id.padEnd(20)} ${s.transport.padEnd(16)} tools:${tools}`
    })
    console.log()
    console.log(buildPanel(t(`MCP 服务器 (${data.servers.length})`, `MCP servers (${data.servers.length})`), rows))
    console.log()
    return
  }

  if (sub === 'add') {
    const restArgs = args.slice(1)
    const transportFlag = restArgs.find(a => a === '--stdio' || a === '--http' || a === '--sse')
    const transport = transportFlag === '--http' ? 'streamable-http' : transportFlag === '--sse' ? 'sse' : 'stdio'
    const cmdIdx = transportFlag ? restArgs.indexOf(transportFlag) + 1 : 0
    const cmdOrUrl = restArgs[cmdIdx]
    if (!cmdOrUrl) {
      console.log()
      console.log(buildPanel(t('MCP add 用法', 'MCP add usage'), [
        'artemis mcp add [--stdio] <command> [args...]',
        'artemis mcp add --http <url>',
        'artemis mcp add --sse <url>',
      ]))
      console.log()
      return
    }
    const idFlag = restArgs.indexOf('--id')
    const id = idFlag >= 0 ? restArgs[idFlag + 1] : undefined
    const cmdArgs = transport === 'stdio' ? restArgs.slice(cmdIdx + 1).filter(a => !a.startsWith('--')) : undefined
    try {
      const server = await mcpStore.add({
        id: id ?? `mcp-${Date.now()}`,
        transport,
        command: transport === 'stdio' ? cmdOrUrl : undefined,
        commandArgs: cmdArgs,
        url: transport !== 'stdio' ? cmdOrUrl : undefined,
        enabled: true,
      })
      console.log()
      console.log(buildPanel(t('MCP 服务器已添加', 'MCP server added'), [
        `ID: ${server.id}`,
        `Transport: ${server.transport}`,
        transport === 'stdio' ? `Command: ${server.command} ${(server.commandArgs ?? []).join(' ')}` : `URL: ${server.url}`,
      ]))
      console.log()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log()
      console.log(buildPanel(t('添加失败', 'Add failed'), [msg]))
      console.log()
    }
    return
  }

  if (sub === 'remove' || sub === 'rm') {
    const id = args[1]
    if (!id) { console.log(t('\n  用法: artemis mcp remove <id>', '\n  Usage: artemis mcp remove <id>')); console.log(); return }
    const removed = await mcpStore.remove(id)
    console.log()
    console.log(buildPanel(removed ? t('已移除', 'Removed') : t('未找到', 'Not found'), [`ID: ${id}`]))
    console.log()
    return
  }

  if (sub === 'probe' || sub === 'test') {
    const id = args[1]
    if (!id) { console.log(t('\n  用法: artemis mcp probe <id>', '\n  Usage: artemis mcp probe <id>')); console.log(); return }
    const data = await mcpStore.load()
    const server = mcpStore.getById(data, id)
    if (!server) { console.log(buildPanel(t('未找到', 'Not found'), [`ID: ${id}`])); return }
    console.log()
    console.log(t(`  探测 MCP 服务器 ${id}...`, `  Probing MCP server ${id}...`))
    try {
      const result = await probeMcpServer(server)
      if (result.surface) {
        await mcpStore.updateSurface(id, result.surface)
      }
      const toolNames = result.surface?.tools?.map((t: { name: string }) => t.name) ?? []
      console.log(buildPanel(result.ok ? t('探测成功', 'Probe successful') : t('探测失败', 'Probe failed'), [
        `Status: ${result.message}`,
        `Tools: ${toolNames.length} — ${toolNames.slice(0, 5).join(', ')}${toolNames.length > 5 ? '...' : ''}`,
      ]))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      await mcpStore.setError(id, msg)
      console.log(buildPanel(t('探测失败', 'Probe failed'), [msg]))
    }
    console.log()
    return
  }

  // default: show help
  console.log()
  console.log(buildPanel(t('MCP 命令', 'MCP commands'), [
    '  artemis mcp list              ' + t('列出所有服务器', 'List all servers'),
    '  artemis mcp add [--stdio] <cmd>  ' + t('添加 stdio 服务器', 'Add stdio server'),
    '  artemis mcp add --http <url>  ' + t('添加 HTTP 服务器', 'Add HTTP server'),
    '  artemis mcp remove <id>       ' + t('移除服务器', 'Remove server'),
    '  artemis mcp probe <id>        ' + t('探测工具列表', 'Probe tool list'),
  ]))
  console.log()
}

// ─── odin subcommand ──────────────────────────────────────────────────────────

async function runOdinCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale, args } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const sub = args[0]?.toLowerCase()
  const odinStore = new OdinStore(cwd)

  if (!sub || sub === 'list' || sub === 'ls') {
    const skills = await odinStore.list({ status: 'active' })
    if (skills.length === 0) {
      console.log()
      console.log(buildPanel(t('Odin 技能', 'Odin skills'), [
        t('暂无活跃技能。', 'No active skills.'),
      ]))
      console.log()
      return
    }
    const rows = skills.slice(0, 20).map(s => {
      const conf = `[${String(s.confidence).padStart(2)}/10]`
      return `${conf} ${s.id.padEnd(24)} ${s.name.slice(0, 40)}`
    })
    console.log()
    console.log(buildPanel(t(`Odin 技能 (${skills.length})`, `Odin skills (${skills.length})`), rows))
    console.log()
    return
  }

  if (sub === 'search' || sub === 'find') {
    const query = args.slice(1).join(' ')
    if (!query) { console.log(t('\n  用法: artemis odin search <关键词>', '\n  Usage: artemis odin search <keywords>')); console.log(); return }
    const result = await odinStore.search({ query, limit: 8 })
    if (result.hits.length === 0) {
      console.log()
      console.log(buildPanel(t('搜索结果', 'Search results'), [t(`"${query}" — 无匹配。`, `"${query}" — no matches.`)]))
      console.log()
      return
    }
    const all = await odinStore.list()
    const rows = result.hits.map(h => {
      const skill = all.find(s => s.id === h.skillId)
      return `[${String(h.score).padStart(3)}] ${h.skillId.padEnd(24)} ${skill?.name?.slice(0, 40) ?? ''}`
    })
    console.log()
    console.log(buildPanel(t(`搜索: "${query}"`, `Search: "${query}"`), rows))
    console.log()
    return
  }

  if (sub === 'capture') {
    const name = args.slice(1).join(' ')
    if (!name) { console.log(t('\n  用法: artemis odin capture <技能名>', '\n  Usage: artemis odin capture <skill name>')); console.log(); return }
    const skill = await odinStore.capture({ name, source: 'captured' } as Parameters<typeof odinStore.capture>[0])
    console.log()
    console.log(buildPanel(t('技能已捕获', 'Skill captured'), [`ID: ${skill.id}`, `Name: ${skill.name}`]))
    console.log()
    return
  }

  if (sub === 'decay') {
    const result = await odinStore.applyDecay()
    console.log()
    console.log(buildPanel(t('技能衰减', 'Skill decay'), [
      t(`影响: ${result.affected}`, `Affected: ${result.affected}`),
    ]))
    console.log()
    return
  }

  if (sub === 'remove' || sub === 'rm') {
    const id = args[1]
    if (!id) { console.log(t('\n  用法: artemis odin remove <id>', '\n  Usage: artemis odin remove <id>')); console.log(); return }
    const removed = await odinStore.delete(id)
    console.log()
    console.log(buildPanel(removed ? t('已删除', 'Removed') : t('未找到', 'Not found'), [`ID: ${id}`]))
    console.log()
    return
  }

  // help
  console.log()
  console.log(buildPanel(t('Odin 技能引擎', 'Odin skill engine'), [
    '  artemis odin list             ' + t('列出活跃技能', 'List active skills'),
    '  artemis odin search <关键词>  ' + t('搜索技能', 'Search skills'),
    '  artemis odin capture <名称>   ' + t('捕获新技能', 'Capture new skill'),
    '  artemis odin decay            ' + t('运行技能衰减', 'Run skill decay'),
    '  artemis odin remove <id>      ' + t('删除技能', 'Remove skill'),
  ]))
  console.log()
}

// ─── doctor subcommand ────────────────────────────────────────────────────────

async function runDoctor(options: {
  cwd: string
  locale: UiLocale
  testProviders: boolean
}): Promise<void> {
  const lines: string[] = []

  // Node version
  lines.push(`Node: ${process.version}`)

  // cwd
  lines.push(`cwd: ${options.cwd}`)

  // Provider
  const pStore = new ProviderStore(options.cwd)
  const pData2 = await pStore.load()
  let config = pStore.getDefaultMainProfile(pData2)
  let providerSource = 'local'
  if (!config) {
    const globalStore = new ProviderStore(os.homedir())
    const globalData = await globalStore.load()
    const globalConfig = globalStore.getDefaultMainProfile(globalData)
    if (globalConfig) {
      config = globalConfig
      providerSource = 'global'
    }
  }
  if (config) {
    lines.push(`Provider: ${config.protocol} / ${config.model ?? 'n/a'}`)
    lines.push(`Provider source: ${providerSource}`)

    if (options.testProviders) {
      lines.push('')
      lines.push('Testing provider connection...')
      try {
        const p = createProviderFromConfig(config)
        const connectionProbe = await probeProviderConfig(config, { provider: p })
        if (!connectionProbe.ok) {
          lines.push(`❌ Provider error: ${connectionProbe.message}`)
        } else {
          lines.push(`✅ Provider OK — ${connectionProbe.message}`)
          const nativeToolProbe = await probeProviderNativeToolCalls(config, { provider: p })
          lines.push(
            nativeToolProbe.ok
              ? `✅ Native tools OK — ${nativeToolProbe.message}`
              : `❌ Native tools error: ${nativeToolProbe.message}`,
          )
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        lines.push(`❌ Provider error: ${msg}`)
      }
    }
  } else {
    lines.push('Provider: ❌ not configured')
  }

  // Settings file
  const settingsStore = new CliSettingsStore(options.cwd)
  const settings = await settingsStore.load()
  lines.push(`Locale: ${settings.uiLocale}${settings.uiLocaleConfigured ? '' : ' (default)'}`)
  lines.push(`WordUP: ${settings.wordUpEnabled ? 'enabled' : 'disabled'}`)
  lines.push(`Onboarding: ${settings.onboardingCompleted ? 'done' : 'pending'}`)

  // ARTEMIS.md
  const instructionFiles = await findInstructionFiles(options.cwd)
  lines.push(`ARTEMIS.md: ${instructionFiles.length > 0 ? instructionFiles.map(f => path.relative(options.cwd, f)).join(', ') : '(none)'}`)

  // MCP servers
  const mcpStore = new McpServerStore(options.cwd)
  const mcpData = await mcpStore.load()
  lines.push(`MCP servers: ${mcpData.servers.length}`)

  // Odin skills
  const odinStore = new OdinStore(options.cwd)
  const skills = await odinStore.list({ status: 'active' })
  lines.push(`Odin skills: ${skills.length} active`)

  console.log()
  console.log(buildPanel(
    options.locale === 'zh-CN' ? '系统诊断' : 'Doctor report',
    lines
  ))
  console.log()
}

// ─── heimdall subcommand ──────────────────────────────────────────────────────

async function runHeimdallCommand(options: { cwd: string; locale: UiLocale; args: string[] }): Promise<void> {
  const { cwd, locale, args } = options
  const t = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const input = args.join(' ')
  const body = parseHeimdallCommandBody(input)

  // Show help
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    console.log()
    console.log(buildPanel(t('Heimdall 命令', 'Heimdall commands'), [
      t('  Heimdall 负责线程视图、阻塞审批与运行态观察。', '  Heimdall is for thread state, approvals, and runtime visibility.'),
      t('  先发起工作流；需要观察、回复或放行时，再回到这里。', '  Start the workflow first; return here when you need to observe, reply, or unblock.'),
      '',
      '  artemis heimdall                   ' + t('显示当前线程状态', 'Show current thread status'),
      '  artemis heimdall threads           ' + t('列出所有线程', 'List all threads'),
      '  artemis heimdall events [n]        ' + t('查看事件日志（最近 n 条）', 'View event log (last n events)'),
      '  artemis heimdall follow            ' + t('实时跟随事件流', 'Follow event stream live'),
      '  artemis heimdall upload <path...>  ' + t('导入文件到线程上传区', 'Import files into thread uploads'),
      '  artemis heimdall approve           ' + t('批准当前阻塞请求', 'Approve current blocking request'),
      '  artemis heimdall unblock           ' + t('解除线程阻塞状态', 'Unblock thread'),
      '  artemis heimdall reply <text>      ' + t('回复待澄清问题', 'Reply to pending clarification'),
      '  artemis heimdall cleanup           ' + t('清理线程数据', 'Delete thread data'),
      '  artemis heimdall --json            ' + t('输出 JSON 格式', 'Output in JSON format'),
    ]))
    console.log()
    return
  }

  // `threads` action does not need a current session
  if (body.action === 'threads') {
    console.log()
    console.log(await buildHeimdallThreadsReport({ cwd, locale }))
    console.log()
    return
  }

  // All other actions require resolving a session
  const sessionStore = new SessionStore(cwd)
  let session = body.sessionId
    ? await sessionStore.load(body.sessionId).catch(() => null)
    : null

  if (!session) {
    // fall back to most-recently updated session
    const sessions = await sessionStore.list().catch(() => [] as Awaited<ReturnType<SessionStore['list']>>)
    session = sessions[0] ?? null
  }

  if (!session) {
    console.log()
    console.log(buildPanel(
      t('Heimdall — 无会话', 'Heimdall — no session'),
      [
        t(
          '当前还没有可查看的线程。先发起任务，再回到 Heimdall。',
          'No active thread yet. Start a task first, then return to Heimdall.',
        ),
        t('用法: artemis heimdall threads  查看已有线程目录', 'Tip: artemis heimdall threads  to list existing threads'),
      ]
    ))
    console.log()
    return
  }

  if (body.outputFormat === 'json') {
    const { getHeimdallThreadSnapshot } = await import('../services/heimdallGateway.js')
    const snapshot = await getHeimdallThreadSnapshot({ cwd, session }).catch((err: unknown) => ({
      error: err instanceof Error ? err.message : String(err),
    }))
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }

  const inputPaths = body.rest.filter(r => r.startsWith('/') || r.startsWith('./') || r.startsWith('../') || r.includes('.'))

  try {
    const report = await buildHeimdallReport({
      cwd,
      session,
      sessionStore,
      locale,
      action: body.action,
      limit: body.limit,
      afterOffset: body.afterOffset,
      timeoutSeconds: body.timeoutSeconds,
      replyText: body.replyText,
      inputPaths,
    })
    console.log()
    console.log(report)
    console.log()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log()
    console.log(buildPanel(t('Heimdall 错误', 'Heimdall error'), [msg]))
    console.log()
  }
}
