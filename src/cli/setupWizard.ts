import * as os from 'node:os'
import * as path from 'node:path'
import { pickLocale, type UiLocale } from './locale.js'
import { buildPanel } from './ui.js'
import {
  chooseInteractiveOption,
  createInteractivePromptIO,
} from './prompt.js'
import { CliSettingsStore } from './settings.js'
import { ProviderStore } from '../providers/store.js'
import { promptForVerifiedProviderProfile } from '../providers/onboarding.js'
import type {
  AgentSetupConfig,
  TerminalSetupConfig,
  VoiceSetupConfig,
  ToolSetupConfig,
  ProviderProfile,
} from '../providers/types.js'
import { runVisualModelSetup } from './onboarding.js'
import { runMemoryEnhancementSetup } from './memorySetup.js'
import { setupTelegramBridge } from '../telegram/bridge.js'
import { setupDiscordBridge } from '../discord/bridge.js'
import { setupWeChatBridge } from '../wechat/bridge.js'
import { resolveDataRootDir } from '../utils/fs.js'

// 扩展配置 sections
type SetupSection =
  | 'model'          // 模型提供商
  | 'visual'         // 视觉生成
  | 'gateway'        // 通讯平台
  | 'agent'          // 代理设置
  | 'memory'         // 记忆增强
  | 'terminal'       // 终端后端
  | 'tts'            // 语音输出
  | 'tools'          // 工具配置
  | 'session'        // 会话管理

type SetupWizardOptions = {
  cwd: string
  locale: UiLocale
  section?: string
  forceFirstTime?: boolean
}

const HOME_DIR = os.homedir()

function tr(locale: UiLocale, zh: string, en: string): string {
  return pickLocale(locale, { zh, en })
}

function sectionTitle(title: string, lines: string[] = []): void {
  console.log()
  console.log(buildPanel(title, lines))
  console.log()
}

function slugify(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

function normalizeSection(value: string | undefined): SetupSection | undefined {
  const v = value?.trim().toLowerCase()
  if (!v) return undefined
  if (v === 'provider' || v === 'providers') return 'model'
  if (v === 'vision') return 'visual'
  if (v === 'messaging' || v === 'bragi' || v === 'gateway') return 'gateway'
  if (['model', 'visual', 'gateway', 'agent', 'memory', 'terminal', 'tts', 'tools', 'session'].includes(v)) {
    return v as SetupSection
  }
  return undefined
}

async function askText(prompt: string, defaultValue = '', mask = false): Promise<string> {
  const io = createInteractivePromptIO()
  const suffix = defaultValue ? ` [${defaultValue}]` : ''
  const raw = await io.ask(`${prompt}${suffix}: `, mask)
  return raw.trim() || defaultValue
}

async function askNumber(prompt: string, defaultValue: number, options: {
  min?: number
  max?: number
  integer?: boolean
} = {}): Promise<number> {
  while (true) {
    const raw = await askText(prompt, String(defaultValue))
    const parsed = Number(raw)
    if (
      Number.isFinite(parsed) &&
      (options.integer ? Number.isInteger(parsed) : true) &&
      (options.min === undefined || parsed >= options.min) &&
      (options.max === undefined || parsed <= options.max)
    ) {
      return options.integer ? Math.round(parsed) : parsed
    }
    console.log(`  ${prompt} must be a valid number.`)
  }
}

async function askYesNo(locale: UiLocale, title: string, defaultValue: boolean): Promise<boolean> {
  return chooseInteractiveOption<boolean>({
    title,
    initialIndex: defaultValue ? 0 : 1,
    hint: tr(locale, '↑↓ 移动  Enter 确认', '↑↓ move  Enter confirm'),
    choices: [
      { label: tr(locale, '是', 'Yes'), value: true },
      { label: tr(locale, '否', 'No'), value: false },
    ],
  })
}

// 新增：终端后端配置
async function configureTerminalSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  try {
    const { cwd, locale } = options
    sectionTitle('Terminal Backend', [
      tr(locale, '选择命令执行的环境，影响工具隔离性。', 'Choose where commands run, affects tool isolation.'),
    ])
    
    const backend = await chooseInteractiveOption<'local' | 'docker' | 'ssh' | 'modal'>({
      title: tr(locale, '选择终端后端', 'Select terminal backend'),
      initialIndex: 0,
      choices: [
        { label: tr(locale, 'Local - 直接在本机运行（默认）', 'Local - run directly on this machine (default)'), value: 'local' },
        { label: tr(locale, 'Docker - 隔离容器', 'Docker - isolated container'), value: 'docker' },
        { label: tr(locale, 'SSH - 远程机器', 'SSH - remote machine'), value: 'ssh' },
        { label: tr(locale, 'Modal - 无服务器云沙箱', 'Modal - serverless cloud sandbox'), value: 'modal' },
      ],
    })
    
    await new ProviderStore(cwd).updateSetupConfig((setup) => ({
      ...setup,
      terminal: { backend },
    }))
    
    console.log(`  ✓ Terminal backend set to: ${backend}`)
  } catch (error) {
    console.error(`  ❌ Failed to configure terminal settings: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

async function configureTTSSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  try {
    const { cwd, locale } = options
    sectionTitle('Text-to-Speech', [
      tr(locale, '配置语音输出，支持多个提供商。', 'Configure speech output with multiple providers.'),
    ])
    
    const provider = await chooseInteractiveOption<'edge' | 'elevenlabs' | 'openai' | 'xai' | 'minimax' | 'mistral' | 'gemini' | 'kittentts'>({
      title: tr(locale, '选择 TTS 提供商', 'Select TTS provider'),
      initialIndex: 0,
      choices: [
        { label: 'Microsoft Edge TTS (free)', value: 'edge' },
        { label: 'ElevenLabs (premium)', value: 'elevenlabs' },
        { label: 'OpenAI TTS', value: 'openai' },
        { label: 'xAI TTS', value: 'xai' },
        { label: 'MiniMax TTS', value: 'minimax' },
        { label: 'Mistral Voxtral', value: 'mistral' },
        { label: 'Google Gemini TTS', value: 'gemini' },
        { label: 'KittenTTS (local)', value: 'kittentts' },
      ],
    })
    
    let config: any = { provider }
    if (provider !== 'edge' && provider !== 'kittentts') {
      const apiKey = await askText(tr(locale, 'API key', 'API key'), '', true)
      config.apiKey = apiKey
    }
    
    await new ProviderStore(cwd).updateSetupConfig((setup) => ({
      ...setup,
      voice: {
        ...setup.voice,
        tts: {
          ...setup.voice.tts,
          ...config,
        },
      },
      tools: {
        ...setup.tools,
        providers: {
          ...setup.tools.providers,
          tts: provider,
        },
      },
    }))
    
    console.log(`  ✓ TTS provider set to: ${provider}`)
  } catch (error) {
    console.error(`  ❌ Failed to configure TTS settings: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

async function configureToolSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  try {
    const { cwd, locale } = options
    sectionTitle('Tool Configuration', [
      tr(locale, '启用或禁用工具，需要 API key 的工具将在启用时配置。', 'Enable or disable tools, tools needing API keys will be configured when enabled.'),
    ])
    
    const availableTools = [
      { id: 'web', label: '🔍 Web Search & Scraping', enabled: true },
      { id: 'browser', label: '🌐 Browser Automation', enabled: true },
      { id: 'terminal', label: '💻 Terminal & Processes', enabled: true },
      { id: 'file', label: '📁 File Operations', enabled: true },
      { id: 'code_execution', label: '⚡ Code Execution', enabled: true },
      { id: 'vision', label: '👁️  Vision / Image Analysis', enabled: true },
      { id: 'image_gen', label: '🎨 Image Generation', enabled: false },
      { id: 'moa', label: '🧠 Mixture of Agents', enabled: false },
      { id: 'tts', label: '🔊 Text-to-Speech', enabled: true },
      { id: 'stt', label: '🎙️ Speech-to-Text', enabled: true },
      { id: 'skills', label: '📚 Skills', enabled: true },
      { id: 'todo', label: '📋 Task Planning', enabled: true },
      { id: 'memory', label: '💾 Memory', enabled: true },
      { id: 'session_search', label: '🔎 Session Search', enabled: true },
      { id: 'clarify', label: '❓ Clarifying Questions', enabled: true },
      { id: 'delegation', label: '👥 Task Delegation', enabled: true },
      { id: 'cronjob', label: '⏰ Cron Jobs', enabled: true },
      { id: 'messaging', label: '📨 Cross-Platform Messaging', enabled: true },
      { id: 'rl', label: '🧪 RL Training', enabled: false },
      { id: 'homeassistant', label: '🏠 Home Assistant', enabled: false },
    ]
    
    const enabledConfig: Record<string, boolean> = {}
    for (const tool of availableTools) {
      const shouldEnable = await askYesNo(locale, `${tool.label}`, tool.enabled)
      enabledConfig[tool.id] = shouldEnable
    }
    
    await new ProviderStore(cwd).updateSetupConfig((setup) => ({
      ...setup,
      tools: {
        ...setup.tools,
        enabled: {
          ...setup.tools.enabled,
          ...enabledConfig,
        },
      },
    }))
    
    const enabledCount = Object.values(enabledConfig).filter(enabled => enabled).length
    console.log(`  ✓ Enabled ${enabledCount} tools`)
  } catch (error) {
    console.error(`  ❌ Failed to configure tool settings: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

async function configureSessionSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  try {
    const { cwd, locale } = options
    sectionTitle('Session Management', [
      tr(locale, '配置会话自动重置策略，管理 API 成本。', 'Configure session auto-reset policies to manage API costs.'),
    ])
    
    const resetMode = await chooseInteractiveOption<'both' | 'idle' | 'daily' | 'never'>({
      title: tr(locale, '会话重置模式', 'Session reset mode'),
      initialIndex: 0,
      choices: [
        { label: tr(locale, 'Inactivity + daily reset (推荐)', 'Inactivity + daily reset (recommended)'), value: 'both' },
        { label: tr(locale, 'Inactivity only', 'Inactivity only'), value: 'idle' },
        { label: tr(locale, 'Daily only', 'Daily only'), value: 'daily' },
        { label: tr(locale, 'Never auto-reset', 'Never auto-reset'), value: 'never' },
      ],
    })
    
    const config: any = { mode: resetMode }
    
    if (resetMode === 'both' || resetMode === 'idle') {
      const timeout = await askNumber(tr(locale, 'Inactivity timeout (minutes)', 'Inactivity timeout (minutes)'), 1440, {
        min: 1,
        integer: true,
      })
      config.idleMinutes = timeout
    }
    
    if (resetMode === 'both' || resetMode === 'daily') {
      const hour = await askNumber(tr(locale, 'Daily reset hour (0-23)', 'Daily reset hour (0-23)'), 4, {
        min: 0,
        max: 23,
        integer: true,
      })
      config.dailyHour = hour
    }
    
    await new ProviderStore(cwd).updateSetupConfig((setup) => ({
      ...setup,
      agent: {
        ...setup.agent,
        sessionReset: config,
      },
    }))
    
    console.log(`  ✓ Session management configured`)
  } catch (error) {
    console.error(`  ❌ Failed to configure session settings: ${error instanceof Error ? error.message : String(error)}`)
    throw error
  }
}

async function persistProfileToTargets(cwd: string, profile: ProviderProfile, asSpecialist: boolean): Promise<void> {
  const targets = cwd === HOME_DIR ? [cwd] : [cwd, HOME_DIR]
  for (const target of targets) {
    const store = new ProviderStore(target)
    const data = await store.load()
    data.profiles = data.profiles.filter((entry) => entry.id !== profile.id)
    data.profiles.push(profile)
    if (asSpecialist) {
      data.specialistProfileId = profile.id
    } else {
      data.defaultMainProfileId = profile.id
    }
    const isCustomProfile = /custom|自定义/i.test(profile.label ?? '')
    if (isCustomProfile && profile.label && profile.baseUrl && profile.model) {
      data.customProviders = data.customProviders ?? []
      const existing = data.customProviders.find((entry) =>
        entry.baseUrl === profile.baseUrl && entry.model === profile.model
      )
      if (!existing) {
        data.customProviders.push({
          id: slugify(`${profile.label}-${profile.model}`, `custom-${Date.now()}`),
          label: profile.label,
          protocol: profile.protocol,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
          model: profile.model,
          contextLength: profile.contextLength,
        })
      }
    }
    await store.save(data)
  }
}

async function configureProviderProfile(options: {
  cwd: string
  locale: UiLocale
  role: 'primary' | 'secondary'
}): Promise<ProviderProfile | undefined> {
  const { cwd, locale, role } = options
  const io = createInteractivePromptIO()
  const store = new ProviderStore(cwd)
  const data = await store.load()

  if ((data.customProviders?.length ?? 0) > 0) {
    const savedAction = await chooseInteractiveOption<'new' | 'use' | 'remove'>({
      title: tr(locale, '已保存自定义 Provider', 'Saved custom providers'),
      initialIndex: 0,
      choices: [
        { label: tr(locale, '配置新的 Provider', 'Configure a new provider'), value: 'new' },
        { label: tr(locale, '使用已保存的自定义 Provider', 'Use a saved custom provider'), value: 'use' },
        { label: tr(locale, '删除已保存的自定义 Provider', 'Remove a saved custom provider'), value: 'remove' },
      ],
    })

    if (savedAction === 'use') {
      const selected = await chooseInteractiveOption<string>({
        title: tr(locale, '选择已保存自定义 Provider', 'Choose saved custom provider'),
        choices: (data.customProviders ?? []).map((provider) => ({
          label: provider.label,
          value: provider.id,
          description: `${provider.model} @ ${provider.baseUrl}`,
        })),
      })
      const saved = data.customProviders?.find((provider) => provider.id === selected)
      if (saved) {
        const profile: ProviderProfile = {
          id: role === 'primary' ? 'main' : 'secondary',
          label: saved.label,
          protocol: saved.protocol,
          baseUrl: saved.baseUrl,
          apiKey: saved.apiKey ?? '',
          model: saved.model,
          contextLength: saved.contextLength,
        }
        await persistProfileToTargets(cwd, profile, role === 'secondary')
        return profile
      }
    } else if (savedAction === 'remove') {
      const selected = await chooseInteractiveOption<string>({
        title: tr(locale, '选择要删除的自定义 Provider', 'Choose custom provider to remove'),
        choices: (data.customProviders ?? []).map((provider) => ({
          label: provider.label,
          value: provider.id,
          description: `${provider.model} @ ${provider.baseUrl}`,
        })),
      })
      data.customProviders = (data.customProviders ?? []).filter((provider) => provider.id !== selected)
      await store.save(data)
      console.log('  ✓ Removed saved custom provider.')
    }
  }

  const profile = await promptForVerifiedProviderProfile(
    io,
    data,
    {
      heading: role === 'primary'
        ? tr(locale, '主模型 Provider', 'Primary model provider')
        : tr(locale, '副模型 Provider', 'Secondary model provider'),
      defaultAlias: role === 'primary'
        ? tr(locale, '主模型', 'Primary model')
        : tr(locale, '副模型', 'Secondary model'),
      defaultIdPrefix: role === 'primary' ? 'main' : 'secondary',
      cancellationLabel: tr(locale, '取消', 'Cancel'),
      fixedId: role === 'primary' ? 'main' : 'secondary',
    },
    locale,
  )
  if (!profile) return undefined
  await persistProfileToTargets(cwd, profile, role === 'secondary')
  return profile
}

async function configureModelProvider(options: { cwd: string; locale: UiLocale; quick?: boolean }): Promise<void> {
  const { cwd, locale, quick = false } = options
  sectionTitle('Inference Provider', [
    tr(locale, '只显示当前运行时真正支持的 Provider 配置路径。', 'Only shows provider paths that the current runtime can actually execute.'),
  ])

  const primary = await configureProviderProfile({ cwd, locale, role: 'primary' })
  if (!primary) {
    console.log(tr(locale, 'Provider 配置已跳过。', 'Provider setup skipped.'))
    return
  }

  console.log(`  ✓ ${tr(locale, '主模型', 'Primary')}: ${primary.model} (${primary.label ?? primary.id})`)
  console.log()

  if (!quick) {
    const wantSecondary = await askYesNo(
      locale,
      tr(locale, '是否配置副模型 Provider（保留 Artemis 双模型能力）？', 'Configure a secondary provider (keep Artemis dual-model support)?'),
      false,
    )
    if (wantSecondary) {
      const secondary = await configureProviderProfile({ cwd, locale, role: 'secondary' })
      if (secondary) {
        console.log(`  ✓ ${tr(locale, '副模型', 'Secondary')}: ${secondary.model} (${secondary.label ?? secondary.id})`)
      }
    }
  }
}

async function configureAgentSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const store = new ProviderStore(cwd)
  const data = await store.load()
  const current = data.setup?.agent
  sectionTitle('Agent Settings', [
    tr(locale, '这里只保留当前运行时已经接入的 Agent 配置。', 'This section only exposes agent settings that are already wired into runtime.'),
  ])

  const agent: AgentSetupConfig = {
    ...(current ?? data.setup!.agent),
    maxIterations: await askNumber('Max iterations', current?.maxIterations ?? 90, { integer: true, min: 1 }),
    compression: {
      ...(current?.compression ?? data.setup!.agent.compression),
      enabled: true,
      threshold: await askNumber('Compression threshold (0.5-0.95)', current?.compression.threshold ?? 0.5, { min: 0.5, max: 0.95 }),
    },
  }

  await store.updateSetupConfig((setup) => ({ ...setup, agent }))
  console.log(`  ✓ Max iterations: ${agent.maxIterations}`)
  console.log(`  ✓ Compression threshold: ${agent.compression.threshold}`)
}

async function configureGateway(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  sectionTitle('Messaging Platforms', [
    tr(locale, '保留 Artemis 原有 3 个通讯配置：Telegram、Discord、WeChat。', 'Keeps the original Artemis messaging setup: Telegram, Discord, WeChat.'),
    tr(locale, '这里没有超时自动选择；必须手动确认。', 'No timeout-based auto-selection here; user confirmation is required.'),
  ])

  while (true) {
    const platform = await chooseInteractiveOption<'telegram' | 'discord' | 'wechat' | 'done'>({
      title: tr(locale, '选择要配置的通讯平台', 'Choose a messaging platform to configure'),
      choices: [
        { label: 'Telegram', value: 'telegram' },
        { label: 'Discord', value: 'discord' },
        { label: 'WeChat 微信（个人号）', value: 'wechat' },
        { label: tr(locale, '完成', 'Done'), value: 'done' },
      ],
    })
    if (platform === 'done') break
    const result = platform === 'telegram'
      ? await setupTelegramBridge({ cwd, onInfo: (msg) => console.log(msg) })
      : platform === 'discord'
        ? await setupDiscordBridge({ cwd, onInfo: (msg) => console.log(msg) })
        : await setupWeChatBridge({ cwd, onInfo: (msg) => console.log(msg) })
    console.log()
    console.log(result)
    console.log()
  }
}

function buildAvailabilitySummary(data: Awaited<ReturnType<ProviderStore['load']>>): string[] {
  const main = data.profiles.find((profile) => profile.id === data.defaultMainProfileId) ?? data.profiles[0]
  const secondary = data.profiles.find((profile) => profile.id === data.specialistProfileId)
  const visual = data.visualProfile
  const setup = data.setup
  const lines: string[] = []
  lines.push(`${main ? '✓' : '✗'} Main provider${main ? `: ${main.model}` : ': missing'}`)
  lines.push(`${secondary ? '✓' : '✗'} Secondary provider${secondary ? `: ${secondary.model}` : ': not configured'}`)
  lines.push(`${visual?.enabled ? '✓' : '✗'} Image generation${visual?.enabled ? `: ${visual.image.provider}/${visual.image.model}` : ': disabled'}`)
  lines.push(`${visual?.video.enabled ? '✓' : '✗'} Video generation${visual?.video.enabled ? `: ${visual.video.provider}/${visual.video.model}` : ': disabled'}`)
  lines.push(`✓ Agent max iterations: ${setup?.agent.maxIterations ?? 90}`)
  lines.push(`✓ Compression threshold: ${setup?.agent.compression.threshold ?? 0.5}`)
  lines.push(`✓ Memory enhancement: ${data.memoryProfile?.enabled ? `${data.memoryProfile.provider}` : 'disabled'}`)
  return lines
}

async function printConfigurationLocation(cwd: string): Promise<void> {
  const root = resolveDataRootDir(cwd)
  sectionTitle('Configuration Location', [
    `Config file:  ${path.join(root, 'providers.json')}`,
    `Settings:     ${path.join(root, 'cli-settings.json')}`,
    `Messaging:    ${path.join(root, 'bragi.json')}`,
    `Data folder:  ${root}`,
    `Workspace:    ${cwd}`,
    `Backup:       ${path.join(root, 'setup-onboarding-backup-20260423')}`,
  ])
}

async function printSetupSummary(cwd: string, locale: UiLocale): Promise<void> {
  const data = await new ProviderStore(cwd).load()
  console.log()
  console.log(buildPanel('Setup Summary', buildAvailabilitySummary(data)))
  console.log()
  console.log(buildPanel(
    tr(locale, '下一步', 'Next steps'),
    [
      'artemis setup          Re-run the full wizard',
      'artemis setup model    Change model/provider',
      'artemis setup visual   Configure image/video generation',
      'artemis setup gateway  Configure Telegram/Discord/WeChat',
      'artemis setup agent    Configure max iterations/compression',
      'artemis setup memory   Configure memory enhancement',
      'artemis setup terminal Configure terminal backend',
      'artemis setup tts      Configure text-to-speech',
      'artemis setup tools    Configure tool settings',
      'artemis setup session  Configure session management',
      'artemis config         View current settings',
      'artemis doctor         Check for issues',
    ],
  ))
  console.log()
}

async function runFullSetup(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  await printConfigurationLocation(cwd)
  await configureModelProvider({ cwd, locale })
  await runVisualModelSetup(locale, cwd)
  await configureAgentSettings({ cwd, locale })
  await configureGateway({ cwd, locale })
  await runMemoryEnhancementSetup(locale, cwd)
  await configureTerminalSettings({ cwd, locale })
  await configureTTSSettings({ cwd, locale })
  await configureToolSettings({ cwd, locale })
  await configureSessionSettings({ cwd, locale })
  await new CliSettingsStore(cwd).update({ onboardingCompleted: true }).catch(() => {})
  await printSetupSummary(cwd, locale)
}

async function runFirstTimeQuickSetup(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  sectionTitle('Quick Setup', [
    tr(locale, '只配置主 provider / model、Agent 默认值，并可选配置通讯平台。', 'Configure only the main provider/model, runtime agent defaults, and optionally messaging.'),
  ])

  await configureModelProvider({ cwd, locale, quick: true })
  await new ProviderStore(cwd).updateSetupConfig((setup) => ({
    ...setup,
    agent: {
      ...setup.agent,
      maxIterations: 90,
      compression: {
        ...setup.agent.compression,
        enabled: true,
        threshold: 0.5,
      },
    },
  }))

  const setupMessaging = await askYesNo(
    locale,
    tr(locale, '现在配置通讯平台？（Telegram / Discord / WeChat）', 'Configure messaging now? (Telegram / Discord / WeChat)'),
    false,
  )
  if (setupMessaging) {
    await configureGateway({ cwd, locale })
  }

  await new CliSettingsStore(cwd).update({ onboardingCompleted: true }).catch(() => {})
  await printSetupSummary(cwd, locale)
}

async function runMissingOnlySetup(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const store = new ProviderStore(cwd)
  const data = await store.load()
  sectionTitle('Quick Setup — Missing Items Only')

  const missing: string[] = []
  const main = store.getDefaultMainProfile(data)
  if (!main?.apiKey || !main.baseUrl || !main.model) missing.push('main provider')

  if (missing.length === 0) {
    console.log('  ✓ Everything essential is configured.')
    console.log('  Run Full Setup if you want to reconfigure everything.')
    return
  }

  console.log(`  Missing: ${missing.join(', ')}`)
  if (missing.includes('main provider')) await configureModelProvider({ cwd, locale, quick: true })
  await printSetupSummary(cwd, locale)
}

async function runSection(section: SetupSection, options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  if (section === 'model') await configureModelProvider({ cwd, locale })
  else if (section === 'visual') await runVisualModelSetup(locale, cwd)
  else if (section === 'gateway') await configureGateway({ cwd, locale })
  else if (section === 'agent') await configureAgentSettings({ cwd, locale })
  else if (section === 'memory') await runMemoryEnhancementSetup(locale, cwd)
  else if (section === 'terminal') await configureTerminalSettings({ cwd, locale })
  else if (section === 'tts') await configureTTSSettings({ cwd, locale })
  else if (section === 'tools') await configureToolSettings({ cwd, locale })
  else if (section === 'session') await configureSessionSettings({ cwd, locale })
  await printSetupSummary(cwd, locale)
}

export async function runSetupWizard(options: SetupWizardOptions): Promise<void> {
  const { cwd, locale } = options
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('  Not an interactive terminal — setup requires a TTY.')
    console.log('  非交互终端，配置向导需要交互式终端。')
    return
  }

  const section = normalizeSection(options.section)
  if (options.section && !section) {
    console.log(`Unknown setup section: ${options.section}`)
    console.log('Available: model, visual, gateway, agent, memory, terminal, tts, tools, session')
    return
  }
  if (section) {
    await runSection(section, { cwd, locale })
    return
  }

  const store = new ProviderStore(cwd)
  const data = await store.load()
  const settings = await new CliSettingsStore(cwd).load()
  const existing = Boolean(store.getDefaultMainProfile(data)) || settings.onboardingCompleted

  sectionTitle('Artemis Setup Wizard', [
    tr(locale, '现在只显示已经真实打通到运行时的配置路径。', 'Only runtime-backed setup paths are shown now.'),
    tr(locale, 'Press Ctrl+C at any time to exit.', 'Press Ctrl+C at any time to exit.'),
  ])

  if (!existing || options.forceFirstTime) {
    const mode = await chooseInteractiveOption<'quick' | 'full'>({
      title: tr(locale, '你想如何配置 Artemis？', 'How would you like to set up Artemis?'),
      initialIndex: 0,
      choices: [
        { label: tr(locale, 'Quick setup — provider, model & messaging（推荐）', 'Quick setup — provider, model & messaging (recommended)'), value: 'quick' },
        { label: tr(locale, 'Full setup — configure everything', 'Full setup — configure everything'), value: 'full' },
      ],
    })
    if (mode === 'quick') await runFirstTimeQuickSetup({ cwd, locale })
    else await runFullSetup({ cwd, locale })
    return
  }

  const action = await chooseInteractiveOption<'quick' | 'full' | SetupSection | 'exit'>({
    title: tr(locale, '选择配置操作', 'What would you like to do?'),
    initialIndex: 0,
    choices: [
      { label: 'Quick Setup - configure missing items only', value: 'quick' },
      { label: 'Full Setup - reconfigure everything', value: 'full' },
      { label: 'Model & Provider', value: 'model' },
      { label: 'Visual / Image & Video', value: 'visual' },
      { label: 'Messaging Platforms', value: 'gateway' },
      { label: 'Agent Settings', value: 'agent' },
      { label: 'Memory Enhancement', value: 'memory' },
      { label: 'Terminal Backend', value: 'terminal' },
      { label: 'Text-to-Speech', value: 'tts' },
      { label: 'Tool Configuration', value: 'tools' },
      { label: 'Session Management', value: 'session' },
      { label: 'Exit', value: 'exit' },
    ],
  })

  if (action === 'exit') return
  if (action === 'quick') await runMissingOnlySetup({ cwd, locale })
  else if (action === 'full') await runFullSetup({ cwd, locale })
  else await runSection(action, { cwd, locale })
}
