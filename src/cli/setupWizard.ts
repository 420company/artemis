/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const */
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
import { runBundleOnboarding } from './bundleOnboarding.js'
import { SkillManager } from '../core/skillManager.js'
import { CronScheduler } from '../services/cron.js'

// 扩展配置 sections
type SetupSection =
  | 'model'          // 模型提供商
  | 'visual'         // 视觉生成
  | 'gateway'        // 通讯平台
  | 'bundle'         // 文字润色
  | 'skills'         // Skills Catalog
  | 'agent'          // Legacy direct-only agent settings
  | 'memory'         // 记忆增强
  | 'automation'     // 自动化 / Cron
  | 'terminal'       // 终端后端
  | 'tts'            // 语音输出
  | 'tools'          // Legacy direct-only tool gates
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
  if (v === 'polish' || v === 'polisher' || v === 'rewrite' || v === 'bundle') return 'bundle'
  if (v === 'skill' || v === 'skills' || v === 'catalog') return 'skills'
  if (v === 'cron' || v === 'automation' || v === 'automations') return 'automation'
  if (['model', 'visual', 'gateway', 'bundle', 'skills', 'agent', 'memory', 'automation', 'terminal', 'tts', 'tools', 'session'].includes(v)) {
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
  for (;;) {
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

async function askYesNo(
  locale: UiLocale,
  title: string,
  defaultValue: boolean,
  description?: string,
): Promise<boolean> {
  const yesDescription = description
    ? `${description} ${tr(locale, defaultValue ? '默认启用。' : '仅在你明确需要时启用，默认关闭。', defaultValue ? 'Enabled by default.' : 'Enable only when you explicitly need it; off by default.')}`
    : undefined
  const noDescription = defaultValue
    ? tr(locale, '关闭后这个能力不会提供给 AI；只有你不希望它使用时才选这里。', 'Disables this capability for the AI; choose this only if you do not want it used.')
    : tr(locale, '保持关闭；以后可以在 Full Setup 或对应配置页重新启用。', 'Keep it off; you can enable it later from Full Setup or the related settings page.')

  return chooseInteractiveOption<boolean>({
    title,
    initialIndex: defaultValue ? 0 : 1,
    hint: tr(locale, '↑↓ 移动  Enter 确认', '↑↓ move  Enter confirm'),
    choices: [
      {
        label: tr(locale, '是（启用）', 'Yes (enable)'),
        value: true,
        description: yesDescription,
      },
      {
        label: tr(locale, '否（关闭）', 'No (disable)'),
        value: false,
        description: noDescription,
      },
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
  const { cwd, locale } = options
  sectionTitle('Voice Input / Output', [
    tr(
      locale,
      '配置真实语音输出。当前内置 Microsoft Edge TTS 免费线路，不需要 API key。',
      'Configure real speech output. The built-in Microsoft Edge TTS path is free and requires no API key.',
    ),
    tr(
      locale,
      '语音输入/STT 使用本地 Whisper（whisper.cpp 或 Python whisper），免费且不需要 API key。',
      'Speech input/STT uses local Whisper (whisper.cpp or Python whisper), free and API-keyless.',
    ),
  ])

  const ttsEnabled = await askYesNo(
    locale,
    tr(locale, '启用 Microsoft Edge TTS（免费）？', 'Enable Microsoft Edge TTS (free)?'),
    true,
    tr(locale, '用于通讯桥接、通知播报、把文本合成为 MP3。', 'Useful for messaging bridges, notification readout, and text-to-MP3 synthesis.'),
  )

  let voice = 'en-US-AriaNeural'
  if (ttsEnabled) {
    voice = await chooseInteractiveOption<string>({
      title: tr(locale, '选择默认声音', 'Choose default voice'),
      initialIndex: 0,
      choices: [
        { label: 'en-US-AriaNeural', value: 'en-US-AriaNeural', description: tr(locale, '英文女声，通用默认', 'English female, general default') },
        { label: 'en-US-GuyNeural', value: 'en-US-GuyNeural', description: tr(locale, '英文男声', 'English male') },
        { label: 'zh-CN-XiaoxiaoNeural', value: 'zh-CN-XiaoxiaoNeural', description: tr(locale, '中文女声', 'Chinese female') },
        { label: 'zh-CN-YunxiNeural', value: 'zh-CN-YunxiNeural', description: tr(locale, '中文男声，偏自然', 'Chinese male, natural') },
        { label: 'zh-CN-YunjianNeural', value: 'zh-CN-YunjianNeural', description: tr(locale, '中文男声，偏播报', 'Chinese male, narration') },
      ],
    })
  }

  const sttEnabled = await askYesNo(
    locale,
    tr(locale, '启用本地 Whisper STT（免费 / 无 API key）？', 'Enable local Whisper STT (free / no API key)?'),
    true,
    tr(locale, '用于把本地音频文件转成文字；WeChat 这类桥接若已提供 voice_item.text 会直接使用桥接文本。', 'Transcribes local audio files; bridges such as WeChat use voice_item.text directly when the bridge already supplies text.'),
  )

  let sttModel: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' = 'base'
  let sttEngine: 'auto' | 'whisper.cpp' | 'openai-whisper' = 'auto'
  if (sttEnabled) {
    sttEngine = await chooseInteractiveOption<'auto' | 'whisper.cpp' | 'openai-whisper'>({
      title: tr(locale, '选择本地 STT 引擎', 'Choose local STT engine'),
      initialIndex: 0,
      choices: [
        { label: 'Auto - whisper.cpp first, then Python whisper', value: 'auto' },
        { label: 'whisper.cpp / whisper-cli', value: 'whisper.cpp' },
        { label: 'Python openai-whisper CLI', value: 'openai-whisper' },
      ],
    })
    sttModel = await chooseInteractiveOption<'tiny' | 'base' | 'small' | 'medium' | 'large-v3'>({
      title: tr(locale, '选择默认 Whisper 模型', 'Choose default Whisper model'),
      initialIndex: 1,
      choices: [
        { label: 'tiny - fastest, lowest accuracy', value: 'tiny' },
        { label: 'base - balanced default', value: 'base' },
        { label: 'small - better accuracy', value: 'small' },
        { label: 'medium - slower, stronger', value: 'medium' },
        { label: 'large-v3 - strongest, slowest', value: 'large-v3' },
      ],
    })
  }

  await new ProviderStore(cwd).updateSetupConfig((setup) => ({
    ...setup,
    voice: {
      ...setup.voice,
      tts: {
        ...setup.voice.tts,
        provider: 'edge',
        voice,
      },
      stt: {
        ...setup.voice.stt,
        enabled: sttEnabled,
        provider: 'local',
        engine: sttEngine,
        localModel: sttModel,
      },
      voice: {
        ...setup.voice.voice,
        autoTts: false,
      },
    },
    tools: {
      ...setup.tools,
      enabled: {
        ...setup.tools.enabled,
        tts: ttsEnabled,
        stt: sttEnabled,
      },
      providers: {
        ...setup.tools.providers,
        tts: 'edge',
        stt: 'local',
      },
    },
  }))

  console.log(tr(
    locale,
    ttsEnabled
      ? `  ✓ 已启用 Microsoft Edge TTS，默认声音：${voice}`
      : '  ✓ 已关闭 TTS。',
    ttsEnabled
      ? `  ✓ Microsoft Edge TTS enabled with default voice: ${voice}`
      : '  ✓ TTS disabled.',
  ))
  console.log(tr(
    locale,
    sttEnabled
      ? `  ✓ 已启用本地 Whisper STT：${sttEngine} / ${sttModel}。若未安装引擎，transcribe_audio 会给出安装提示。`
      : '  ✓ 已关闭 STT。',
    sttEnabled
      ? `  ✓ Local Whisper STT enabled: ${sttEngine} / ${sttModel}. If no engine is installed, transcribe_audio will return install guidance.`
      : '  ✓ STT disabled.',
  ))
}

async function configureToolSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  try {
    const { cwd, locale } = options
    sectionTitle('Tool Configuration', [
      tr(locale, '按组开关 AI 可以使用的工具能力。', 'Toggle the tool groups available to the AI by category.'),
      tr(
        locale,
        '关闭后，AI 既看不到这组工具，也无法绕过去调用。',
        'When disabled, the AI cannot see or call any tool in that group.',
      ),
      tr(
        locale,
        '不确定就保留默认值（光标已停在推荐选项上），按 Enter 即可。',
        'If unsure, keep the default — the cursor is already on the recommended option, just press Enter.',
      ),
    ])

    const availableTools: Array<{ id: string; label: string; enabled: boolean; description: { zh: string; en: string } }> = [
      {
        id: 'web', label: '🔍 Web / Network Tools', enabled: true,
        description: {
          zh: '控制 search_web、deep_research、HTTP 请求、URL/DNS 检查、天气/汇率/航班等联网工具。',
          en: 'Controls search_web, deep_research, HTTP requests, URL/DNS checks, weather, currency, and flight tools.',
        },
      },
      {
        id: 'browser', label: '🌐 Browser Automation', enabled: true,
        description: {
          zh: '驱动 Chrome 完成自动化操作（登录、点击、表单）。需要本机有 Chromium，慢一点。',
          en: 'Drives Chrome to automate logins/clicks/forms. Requires Chromium locally, somewhat slow.',
        },
      },
      {
        id: 'terminal', label: '💻 Terminal & Processes', enabled: true,
        description: {
          zh: '控制 run_command、git、npm_run、系统信息等会触碰本机进程的工具。',
          en: 'Controls run_command, git, npm_run, and system/process inspection tools.',
        },
      },
      {
        id: 'file', label: '📁 File Operations', enabled: true,
        description: {
          zh: '读写本地文件。任何要改代码、写文档的任务都需要。',
          en: 'Read & write local files. Required for any code or doc editing task.',
        },
      },
      {
        id: 'code_execution', label: '⚡ Code Execution', enabled: true,
        description: {
          zh: '控制计算、JSON/文本处理、编码、hash、格式化等本地数据处理工具。',
          en: 'Controls calculation, JSON/text processing, encoding, hashing, and formatting utilities.',
        },
      },
      {
        id: 'vision', label: '👁️  Vision / Image Analysis', enabled: true,
        description: {
          zh: '让 AI 看图（截图、设计稿）。前端 UI 验收、OCR 等常用。',
          en: 'Let AI read images (screenshots, mockups). Used for frontend QA, OCR, etc.',
        },
      },
      {
        id: 'image_gen', label: '🎨 Image Generation', enabled: false,
        description: {
          zh: '控制 generate_image / generate_video。需要先通过 /visual 配置真实视觉 provider。',
          en: 'Controls generate_image / generate_video. Requires a real visual provider configured via /visual.',
        },
      },
      {
        id: 'tts', label: '🔊 Text-to-Speech', enabled: true,
        description: {
          zh: '控制 synthesize_speech，把文本通过 Microsoft Edge TTS 免费合成为 MP3。',
          en: 'Controls synthesize_speech, converting text to MP3 through free Microsoft Edge TTS.',
        },
      },
      {
        id: 'stt', label: '🎙️ Speech-to-Text', enabled: true,
        description: {
          zh: '控制 transcribe_audio，使用本地 Whisper 免费转写音频文件，不需要 API key。',
          en: 'Controls transcribe_audio, using local Whisper to transcribe audio files for free without an API key.',
        },
      },
    ]

    const existing = (await new ProviderStore(cwd).load()).setup?.tools.enabled ?? {}
    const enabledConfig: Record<string, boolean> = {}
    for (const tool of availableTools) {
      const desc = tr(locale, tool.description.zh, tool.description.en)
      const current = existing[tool.id] ?? tool.enabled
      const shouldEnable = await askYesNo(locale, tool.label, current, desc)
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
  const { cwd, locale } = options
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

  const wantSecondary = await askYesNo(
    locale,
    tr(locale, '是否配置副模型 Provider？', 'Configure a secondary model provider?'),
    false,
  )
  if (wantSecondary) {
    const secondary = await configureProviderProfile({ cwd, locale, role: 'secondary' })
    if (secondary) {
      console.log(`  ✓ ${tr(locale, '副模型', 'Secondary')}: ${secondary.model} (${secondary.label ?? secondary.id})`)
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

  for (;;) {
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

async function configureBundleSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const providerStore = new ProviderStore(cwd)
  const data = await providerStore.load()
  const main = providerStore.getDefaultMainProfile(data)
  const secondary = providerStore.getProfile(data, data.specialistProfileId)

  sectionTitle(tr(locale, '文字润色 / Bundle', 'Prompt Polishing / Bundle'), [
    tr(
      locale,
      '把较长的自然语言需求润色成结构化技术提示词，发送前会展示“原版 vs 增强版”供你确认。',
      'Rewrites longer natural-language requests into structured technical prompts and shows original vs enhanced before sending.',
    ),
    tr(
      locale,
      '也可以随时用 /bundle <文字> 手动润色，或用 /bundle config 重新配置。',
      'You can also run /bundle <text> manually, or /bundle config to reconfigure.',
    ),
  ])

  if (!main) {
    console.log(tr(
      locale,
      '  ⚠ 还没有主模型 Provider，文字润色需要至少一个可用模型。请先完成 Model & Provider 配置。',
      '  ⚠ No primary model provider is configured yet. Prompt polishing needs at least one usable model. Configure Model & Provider first.',
    ))
    return
  }

  await runBundleOnboarding({
    locale,
    settingsStore: new CliSettingsStore(cwd),
    hasSecondaryModel: Boolean(secondary),
    printPanel: (title, lines) => {
      console.log()
      console.log(buildPanel(title, lines))
      console.log()
    },
  })
}

function summarizeSkillCategories(skills: Array<{ category?: string }>, limit = 8): string {
  const counts = new Map<string, number>()
  for (const skill of skills) {
    const category = (skill.category ?? 'general').trim().toLowerCase() || 'general'
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([category, count]) => `${category}(${count})`)
    .join(', ')
}

async function configureSkillsCatalog(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { locale } = options
  sectionTitle('Skills Catalog', [
    tr(
      locale,
      'Skills 已作为内置能力加载，不在安装时逐个选择，避免 999+ 个技能变成低效清单。',
      'Skills are loaded as built-in capabilities; setup does not ask you to select hundreds of skills one by one.',
    ),
    tr(
      locale,
      '使用 /skills 查看分类，或 /skills <关键词> 搜索需要的技能。',
      'Use /skills to view categories, or /skills <keyword> to search.',
    ),
  ])

  const skillManager = new SkillManager()
  await skillManager.ready()
  const skills = skillManager.getAllSkillDefinitions()
  console.log(tr(
    locale,
    `  ✓ 已加载 ${skills.length} 个 skills。`,
    `  ✓ Loaded ${skills.length} skills.`,
  ))
  const categories = summarizeSkillCategories(skills)
  if (categories) {
    console.log(tr(locale, `  ✓ 分类概览：${categories}`, `  ✓ Categories: ${categories}`))
  }
  console.log(tr(
    locale,
    '  用法：/skills、/skills code、/skills design、/skills 文案',
    '  Usage: /skills, /skills code, /skills design, /skills copywriting',
  ))
}

async function configureAutomationCron(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const cron = new CronScheduler(cwd)
  const settings = await cron.getSettings()
  const jobs = cron.getJobs()
  const repoAudit = jobs.find((job) => job.id === 'repo-audit')

  sectionTitle('Automation / Cron', [
    tr(
      locale,
      '这里只配置当前真实接通的自动化任务，不展示尚未接入运行时的空壳选项。',
      'Only runtime-backed automation is configurable here; placeholder jobs are not shown.',
    ),
    tr(
      locale,
      '当前可用：Daily Repository Audit，每 24 小时总结仓库变更并通过已配置的消息桥广播。',
      'Available now: Daily Repository Audit, which summarizes repository changes every 24 hours and broadcasts through configured messaging bridges.',
    ),
  ])

  const enabled = await askYesNo(
    locale,
    tr(locale, '启用 Daily Repository Audit？', 'Enable Daily Repository Audit?'),
    settings.enabled,
    repoAudit
      ? tr(locale, `${repoAudit.name} 是当前唯一真实接通的 Cron 任务。`, `${repoAudit.name} is the only currently wired cron job.`)
      : undefined,
  )

  await cron.setEnabled(enabled)
  console.log(tr(
    locale,
    enabled
      ? '  ✓ 已启用 Daily Repository Audit。'
      : '  ✓ 已关闭 Daily Repository Audit。',
    enabled
      ? '  ✓ Daily Repository Audit enabled.'
      : '  ✓ Daily Repository Audit disabled.',
  ))
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
  lines.push(`${data.memoryProfile?.enabled ? '✓' : '✗'} Memory enhancement${data.memoryProfile?.enabled ? `: ${data.memoryProfile.provider}` : ': disabled'}`)
  lines.push(`${setup?.tools.enabled.tts ? '✓' : '✗'} Text-to-speech${setup?.tools.enabled.tts ? `: ${setup.voice.tts.provider}/${setup.voice.tts.voice ?? 'default'}` : ': disabled'}`)
  lines.push(`${setup?.tools.enabled.stt ? '✓' : '✗'} Speech-to-text${setup?.tools.enabled.stt ? `: ${setup.voice.stt.provider}/${setup.voice.stt.engine ?? 'auto'}/${setup.voice.stt.localModel ?? 'base'}` : ': disabled'}`)
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
  const settings = await new CliSettingsStore(cwd).load()
  const cronSettings = await new CronScheduler(cwd).getSettings()
  const lines = buildAvailabilitySummary(data)
  lines.push(`${settings.bundleEnabled ? '✓' : '✗'} Prompt polishing${settings.bundleConfigured ? `: ${settings.bundleMode}/${settings.bundleModelChoice}` : ': not configured'}`)
  lines.push(`✓ Skills catalog: use /skills or /skills <keyword>`)
  lines.push(`${cronSettings.enabled ? '✓' : '✗'} Daily Repository Audit${cronSettings.lastRun['repo-audit'] ? `: last run ${cronSettings.lastRun['repo-audit']}` : ': not run yet'}`)
  console.log()
  console.log(buildPanel('Setup Summary', lines))
  console.log()
  console.log(buildPanel(
    tr(locale, '下一步', 'Next steps'),
    [
      'artemis setup          Re-run the full wizard',
      'artemis setup model    Change model/provider',
      'artemis setup visual   Configure image/video generation',
      'artemis setup gateway  Configure Telegram/Discord/WeChat',
      'artemis setup bundle   Configure prompt polishing',
      'artemis setup skills   View skills catalog summary',
      'artemis setup memory   Configure memory enhancement',
      'artemis setup cron     Configure automation/cron',
      'artemis setup terminal Configure terminal backend',
      'artemis setup tts      Configure text-to-speech',
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
  await configureBundleSettings({ cwd, locale })
  await configureSkillsCatalog({ cwd, locale })
  await runVisualModelSetup(locale, cwd)
  await configureGateway({ cwd, locale })
  await runMemoryEnhancementSetup(locale, cwd)
  await configureAutomationCron({ cwd, locale })
  await configureTerminalSettings({ cwd, locale })
  await configureTTSSettings({ cwd, locale })
  await configureSessionSettings({ cwd, locale })
  await new CliSettingsStore(cwd).update({ onboardingCompleted: true }).catch(() => {})
  await printSetupSummary(cwd, locale)
}

async function runFirstTimeQuickSetup(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  sectionTitle('Quick Setup', [
    tr(locale, '配置主/副 Provider、视觉模型，并可选配置通讯平台。', 'Configure primary/secondary providers, visual model, and optionally messaging.'),
  ])

  await configureModelProvider({ cwd, locale, quick: true })

  const setupVisual = await askYesNo(
    locale,
    tr(locale, '现在配置视觉模型（图片/视频生成）？', 'Configure visual model (image/video generation) now?'),
    false,
  )
  if (setupVisual) {
    await runVisualModelSetup(locale, cwd)
  }

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
  else if (section === 'bundle') await configureBundleSettings({ cwd, locale })
  else if (section === 'skills') await configureSkillsCatalog({ cwd, locale })
  else if (section === 'agent') await configureAgentSettings({ cwd, locale })
  else if (section === 'memory') await runMemoryEnhancementSetup(locale, cwd)
  else if (section === 'automation') await configureAutomationCron({ cwd, locale })
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
    console.log('Available: model, bundle, skills, visual, gateway, memory, cron, terminal, tts, session')
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
    tr(locale, '选择要配置的项目；不确定就先选 Quick setup 跑通最小可用环境。', 'Pick what to configure, or run Quick setup for a minimal working baseline.'),
    tr(locale, '随时按 Ctrl+C 退出。', 'Press Ctrl+C at any time to exit.'),
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
      { label: 'Prompt Polishing / Bundle', value: 'bundle' },
      { label: 'Skills Catalog', value: 'skills' },
      { label: 'Visual / Image & Video', value: 'visual' },
      { label: 'Messaging Platforms', value: 'gateway' },
      { label: 'Memory Enhancement', value: 'memory' },
      { label: 'Automation / Cron', value: 'automation' },
      { label: 'Terminal Backend', value: 'terminal' },
      { label: 'Voice Input / Output', value: 'tts' },
      { label: 'Session Management', value: 'session' },
      { label: 'Exit', value: 'exit' },
    ],
  })

  if (action === 'exit') return
  if (action === 'quick') await runMissingOnlySetup({ cwd, locale })
  else if (action === 'full') await runFullSetup({ cwd, locale })
  else await runSection(action, { cwd, locale })
}
