/* eslint-disable @typescript-eslint/no-unused-vars, prefer-const */
import * as os from 'node:os'
import * as path from 'node:path'
import { pickLocale, type UiLocale } from './locale.js'
import { buildPanel } from './ui.js'
import {
  chooseInteractiveOption,
  createInteractivePromptIO,
} from './prompt.js'
import {
  CliSettingsStore,
  DEFAULT_GEMINI_DEEP_RESEARCH_AGENT,
  DEFAULT_GEMINI_DEEP_RESEARCH_MAX_POLLS,
  DEFAULT_GEMINI_DEEP_RESEARCH_POLL_INTERVAL_MS,
  type DocsSearchEngine,
  type ResearchEngine,
} from './settings.js'
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
  | 'dream'          // 做梦系统
  | 'docs'           // 文档搜索 / 深度研究

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
  if (v === 'dream' || v === 'dreams') return 'dream'
  if (v === 'doc' || v === 'docs' || v === 'search' || v === 'research' || v === 'deep-research' || v === 'deep_research') return 'docs'
  if (['model', 'visual', 'gateway', 'bundle', 'skills', 'agent', 'memory', 'automation', 'terminal', 'tts', 'tools', 'session', 'dream', 'docs'].includes(v)) {
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

async function askNumber(locale: UiLocale, prompt: string, defaultValue: number, options: {
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
    console.log(tr(locale, `  ${prompt} 必须是有效数字。`, `  ${prompt} must be a valid number.`))
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
    sectionTitle(tr(locale, '终端后端', 'Terminal Backend'), [
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
    
    console.log(tr(locale, `  ✓ 终端后端已设置为：${backend}`, `  ✓ Terminal backend set to: ${backend}`))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(tr(options.locale, `  ❌ 终端设置配置失败：${message}`, `  ❌ Failed to configure terminal settings: ${message}`))
    throw error
  }
}

async function configureTTSSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  sectionTitle(tr(locale, '语音输入 / 输出', 'Voice Input / Output'), [
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
    sectionTitle(tr(locale, '工具配置', 'Tool Configuration'), [
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
        id: 'image_gen', label: '🎨 Image Generation', enabled: true,
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
    console.log(tr(locale, `  ✓ 已启用 ${enabledCount} 组工具`, `  ✓ Enabled ${enabledCount} tool groups`))
  } catch (error) {
    console.error(tr(options.locale, `  ❌ 工具配置失败：${error instanceof Error ? error.message : String(error)}`, `  ❌ Failed to configure tool settings: ${error instanceof Error ? error.message : String(error)}`))
    throw error
  }
}

async function configureSessionSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  try {
    const { cwd, locale } = options
    sectionTitle(tr(locale, '会话管理', 'Session Management'), [
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
      const timeout = await askNumber(locale, tr(locale, '空闲超时（分钟）', 'Inactivity timeout (minutes)'), 1440, {
        min: 1,
        integer: true,
      })
      config.idleMinutes = timeout
    }
    
    if (resetMode === 'both' || resetMode === 'daily') {
      const hour = await askNumber(locale, tr(locale, '每日重置小时（0-23）', 'Daily reset hour (0-23)'), 4, {
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
    
    console.log(tr(locale, '  ✓ 会话管理已配置', '  ✓ Session management configured'))
  } catch (error) {
    console.error(tr(options.locale, `  ❌ 会话设置配置失败：${error instanceof Error ? error.message : String(error)}`, `  ❌ Failed to configure session settings: ${error instanceof Error ? error.message : String(error)}`))
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
          contextLengthSource: profile.contextLengthSource,
          contextLengthCheckedAt: profile.contextLengthCheckedAt,
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
          contextLengthSource: saved.contextLengthSource,
          contextLengthCheckedAt: saved.contextLengthCheckedAt,
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
      console.log(tr(locale, '  ✓ 已删除保存的自定义 Provider。', '  ✓ Removed saved custom provider.'))
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
  sectionTitle(tr(locale, '推理模型 Provider', 'Inference Provider'), [
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

async function configureQuickMemoryEnhancement(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const setupMemory = await askYesNo(
    locale,
    tr(locale, '现在配置记忆增强系统？', 'Configure memory enhancement now?'),
    true,
    tr(
      locale,
      '推荐启用。它会把长期偏好、项目事实和稳定背景写入可检索记忆，长任务不必完全依赖当前上下文窗口。',
      'Recommended. It stores long-term preferences, project facts, and stable background in retrievable memory so long tasks do not rely only on the current context window.',
    ),
  )
  if (setupMemory) {
    await runMemoryEnhancementSetup(locale, cwd)
  } else {
    console.log(tr(locale, '  ✓ 已跳过记忆增强，可之后用 artemis setup memory 配置。', '  ✓ Memory enhancement skipped; configure it later with artemis setup memory.'))
  }
}

async function configureQuickVoiceIO(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const setupVoice = await askYesNo(
    locale,
    tr(locale, '现在配置语音输入/输出？', 'Configure voice input/output now?'),
    true,
    tr(
      locale,
      '推荐启用 STT。配置通讯桥接后，你可以发送语音，由本地 Whisper 转文字再交给 Artemis 处理；TTS 可把回复合成为语音文件。',
      'Recommended for STT. After messaging bridges are configured, you can send voice, let local Whisper transcribe it, and pass the text to Artemis; TTS can synthesize replies as audio files.',
    ),
  )
  if (setupVoice) {
    await configureTTSSettings({ cwd, locale })
  } else {
    console.log(tr(locale, '  ✓ 已跳过语音输入/输出，可之后用 artemis setup tts 配置。', '  ✓ Voice input/output skipped; configure it later with artemis setup tts.'))
  }
}

async function configureAgentSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const store = new ProviderStore(cwd)
  const data = await store.load()
  const current = data.setup?.agent
  sectionTitle(tr(locale, 'Agent 设置', 'Agent Settings'), [
    tr(locale, '这里只保留当前运行时已经接入的 Agent 配置。', 'This section only exposes agent settings that are already wired into runtime.'),
  ])

  const agent: AgentSetupConfig = {
    ...(current ?? data.setup!.agent),
    maxIterations: await askNumber(locale, tr(locale, '最大执行轮数', 'Max iterations'), current?.maxIterations ?? 90, { integer: true, min: 1 }),
    compression: {
      ...(current?.compression ?? data.setup!.agent.compression),
      enabled: true,
      threshold: await askNumber(
        locale,
        tr(locale, '上下文压缩阈值（0.5-0.95，留空保持自适应默认值）', 'Compression threshold (0.5-0.95, blank keeps adaptive default)'),
        current?.compression.threshold ?? 0.7,
        { min: 0.5, max: 0.95 },
      ),
    },
  }

  await store.updateSetupConfig((setup) => ({ ...setup, agent }))
  console.log(tr(locale, `  ✓ 最大执行轮数：${agent.maxIterations}`, `  ✓ Max iterations: ${agent.maxIterations}`))
  console.log(tr(
    locale,
    `  ✓ 上下文压缩阈值：${agent.compression.threshold ?? '自适应'}`,
    `  ✓ Compression threshold: ${agent.compression.threshold ?? 'adaptive'}`,
  ))
}

async function configureGateway(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  sectionTitle(tr(locale, '通讯平台', 'Messaging Platforms'), [
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

async function configureBundleSettings(options: { cwd: string; locale: UiLocale; assumeEnabled?: boolean }): Promise<void> {
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
    assumeEnabled: options.assumeEnabled,
    printPanel: (title, lines) => {
      console.log()
      console.log(buildPanel(title, lines))
      console.log()
    },
  })
}

async function configureDocsAndResearchSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const settingsStore = new CliSettingsStore(cwd)
  const settings = await settingsStore.load()

  sectionTitle(tr(locale, '文档搜索 / 深度研究', 'Docs Search / Deep Research'), [
    tr(
      locale,
      'search_web / lookup_docs 不需要 Gemini API；Gemini Deep Research 是独立的 research backend。',
      'search_web / lookup_docs do not need a Gemini API key; Gemini Deep Research is a separate research backend.',
    ),
    tr(
      locale,
      'Google docs search 需要 GOOGLE_CSE_ID + GOOGLE_API_KEY；缺失时会自动 fallback 到 Bing。',
      'Google docs search needs GOOGLE_CSE_ID + GOOGLE_API_KEY; Artemis falls back to Bing when they are missing.',
    ),
  ])

  const docsEngine = await chooseInteractiveOption<DocsSearchEngine>({
    title: tr(locale, 'lookup_docs 使用哪个文档搜索引擎？', 'Which docs search engine should lookup_docs use?'),
    initialIndex: settings.docsSearchEngine === 'google' ? 1 : 0,
    choices: [
      { label: 'Bing', value: 'bing', description: tr(locale, 'default · 免 API key', 'default · no API key') },
      { label: 'Google', value: 'google', description: tr(locale, 'higher precision · 需要 GOOGLE_CSE_ID + GOOGLE_API_KEY', 'higher precision · needs GOOGLE_CSE_ID + GOOGLE_API_KEY') },
    ],
  })
  await settingsStore.setDocsSearchEngine(docsEngine)
  if (docsEngine === 'google' && (!process.env.GOOGLE_CSE_ID || !process.env.GOOGLE_API_KEY)) {
    console.log(tr(
      locale,
        '  ⚠ 未检测到 GOOGLE_CSE_ID + GOOGLE_API_KEY；lookup_docs fallback: Bing。',
        '  ⚠ GOOGLE_CSE_ID + GOOGLE_API_KEY were not detected; lookup_docs fallback: Bing.',
    ))
  }

  const researchEngine = await chooseInteractiveOption<ResearchEngine>({
    title: tr(locale, 'deep_research 使用哪个研究后端？', 'Which research backend should deep_research use?'),
    initialIndex: settings.researchEngine === 'gemini-deep-research' ? 1 : 0,
    choices: [
      { label: tr(locale, 'Built-in prompt (default)', 'Built-in prompt (default)'), value: 'builtin', description: tr(locale, '不需要 Gemini API key', 'no Gemini API key') },
      { label: 'Gemini Deep Research', value: 'gemini-deep-research', description: tr(locale, '需要 Gemini API key · 用于 multi-step research', 'needs Gemini API key · multi-step research') },
    ],
  })
  await settingsStore.setResearchEngine(researchEngine)

  if (researchEngine === 'gemini-deep-research') {
    console.log(tr(
      locale,
      '  ℹ 当前使用 Google GenAI SDK 的 background interaction + 轮询模式，不是 webhook。复杂研究可以延长轮询时间；完成前会保留 interaction id。',
      '  ℹ This uses the Google GenAI SDK background interaction + polling mode, not webhooks. For complex research, extend the polling window; the interaction id is preserved.',
    ))
    const existingKey = process.env.ARTEMIS_GEMINI_API_KEY || process.env.GEMINI_API_KEY || settings.geminiApiKey || ''
    const apiKey = await askText(
      tr(locale, 'Gemini API key（可留空使用环境变量 ARTEMIS_GEMINI_API_KEY / GEMINI_API_KEY）', 'Gemini API key (leave blank to use ARTEMIS_GEMINI_API_KEY / GEMINI_API_KEY)'),
      existingKey,
      true,
    )
    const agent = await askText(
      tr(locale, 'Gemini Deep Research agent', 'Gemini Deep Research agent'),
      settings.geminiDeepResearchAgent || DEFAULT_GEMINI_DEEP_RESEARCH_AGENT,
    )
    const maxPolls = await askNumber(
      locale,
      tr(locale, 'Gemini Deep Research 最大轮询次数', 'Gemini Deep Research max poll attempts'),
      settings.geminiDeepResearchMaxPolls ?? DEFAULT_GEMINI_DEEP_RESEARCH_MAX_POLLS,
      { integer: true, min: 1 },
    )
    const pollIntervalMs = await askNumber(
      locale,
      tr(locale, 'Gemini Deep Research 轮询间隔（毫秒）', 'Gemini Deep Research poll interval (ms)'),
      settings.geminiDeepResearchPollIntervalMs ?? DEFAULT_GEMINI_DEEP_RESEARCH_POLL_INTERVAL_MS,
      { integer: true, min: 1 },
    )
    await settingsStore.update({
      geminiApiKey: apiKey || undefined,
      geminiDeepResearchAgent: agent || DEFAULT_GEMINI_DEEP_RESEARCH_AGENT,
      geminiDeepResearchMaxPolls: maxPolls,
      geminiDeepResearchPollIntervalMs: pollIntervalMs,
      researchEngine: 'gemini-deep-research',
      researchEngineConfigured: true,
    })
    if (!apiKey) {
      console.log(tr(
        locale,
        '  ⚠ Gemini API key 未保存；使用 deep_research 前设置 ARTEMIS_GEMINI_API_KEY 或 GEMINI_API_KEY。',
        '  ⚠ No Gemini API key saved; set ARTEMIS_GEMINI_API_KEY or GEMINI_API_KEY before using deep_research.',
      ))
    } else {
      console.log(tr(
        locale,
        `  ✓ Gemini Deep Research 已配置。轮询窗口约 ${Math.round((maxPolls * pollIntervalMs) / 60000)} 分钟。`,
        `  ✓ Gemini Deep Research configured. Polling window is about ${Math.round((maxPolls * pollIntervalMs) / 60000)} minutes.`,
      ))
    }
  } else {
    console.log(tr(locale, '  ✓ deep_research backend: builtin · 保持内置模式。', '  ✓ deep_research backend: builtin.'))
  }
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
  sectionTitle(tr(locale, 'Skills 目录', 'Skills Catalog'), [
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

  sectionTitle(tr(locale, '自动化 / Cron', 'Automation / Cron'), [
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
  if (visual?.image?.nsfw || visual?.video?.nsfw) lines.push(`🔞 NSFW mode: image=${visual?.image?.nsfw ? 'on' : 'off'} video=${visual?.video?.nsfw ? 'on' : 'off'}`)
  lines.push(`${data.memoryProfile?.enabled ? '✓' : '✗'} Memory enhancement${data.memoryProfile?.enabled ? `: ${data.memoryProfile.provider}` : ': disabled'}`)
  lines.push(`${setup?.tools.enabled.tts ? '✓' : '✗'} Text-to-speech${setup?.tools.enabled.tts ? `: ${setup.voice.tts.provider}/${setup.voice.tts.voice ?? 'default'}` : ': disabled'}`)
  lines.push(`${setup?.tools.enabled.stt ? '✓' : '✗'} Speech-to-text${setup?.tools.enabled.stt ? `: ${setup.voice.stt.provider}/${setup.voice.stt.engine ?? 'auto'}/${setup.voice.stt.localModel ?? 'base'}` : ': disabled'}`)
  return lines
}

function isEnabledFlag(value: unknown): boolean {
  if (value === true) return true
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return false
}

function hasVisualImageConfig(data: Awaited<ReturnType<ProviderStore['load']>>): boolean {
  const visual = data.visualProfile
  return Boolean(
    visual &&
    (isEnabledFlag(visual.enabled) || visual.image?.apiKey?.trim()) &&
    visual.image?.provider?.trim() &&
    visual.image?.apiKey?.trim() &&
    visual.image?.model?.trim(),
  )
}

async function printConfigurationLocation(cwd: string, locale: UiLocale): Promise<void> {
  const root = resolveDataRootDir(cwd)
  sectionTitle(tr(locale, '配置位置', 'Configuration Location'), [
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
  await printConfigurationLocation(cwd, locale)
  await configureModelProvider({ cwd, locale })
  await runMemoryEnhancementSetup(locale, cwd)
  await configureBundleSettings({ cwd, locale })
  await configureSkillsCatalog({ cwd, locale })
  await runVisualModelSetup(locale, cwd)
  await configureGateway({ cwd, locale })
  await configureTTSSettings({ cwd, locale })
  await configureAutomationCron({ cwd, locale })
  await configureTerminalSettings({ cwd, locale })
  await configureSessionSettings({ cwd, locale })
  await configureDocsAndResearchSettings({ cwd, locale })
  await new CliSettingsStore(cwd).update({ onboardingCompleted: true }).catch(() => {})
  await printSetupSummary(cwd, locale)
}

async function runFirstTimeQuickSetup(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  sectionTitle(tr(locale, '快速配置', 'Quick Setup'), [
    tr(locale, '配置主/副 Provider、记忆增强、视觉模型、通讯平台和语音输入/输出。', 'Configure primary/secondary providers, memory enhancement, visual model, messaging, and voice input/output.'),
  ])

  await configureModelProvider({ cwd, locale, quick: true })
  await configureQuickMemoryEnhancement({ cwd, locale })

  const setupBundle = await askYesNo(
    locale,
    tr(locale, '现在启用文字润色 / Bundle？', 'Enable prompt polishing / Bundle now?'),
    true,
    tr(locale, '它会把较长需求整理成结构化提示词，发送前展示“原版 vs 增强版”供你确认。', 'It rewrites longer requests into structured prompts and shows original vs enhanced before sending.'),
  )
  if (setupBundle) {
    await configureBundleSettings({ cwd, locale, assumeEnabled: true })
  }

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

  await configureQuickVoiceIO({ cwd, locale })

  const setupDocs = await askYesNo(
    locale,
    tr(locale, '现在配置文档搜索 / Gemini Deep Research？', 'Configure docs search / Gemini Deep Research now?'),
    false,
    tr(locale, '普通搜索不用 Gemini API；只有启用 Gemini Deep Research 才需要 Gemini API key。', 'Regular search does not need Gemini API; only Gemini Deep Research needs a Gemini API key.'),
  )
  if (setupDocs) {
    await configureDocsAndResearchSettings({ cwd, locale })
  }

  await new CliSettingsStore(cwd).update({ onboardingCompleted: true }).catch(() => {})
  await printSetupSummary(cwd, locale)
}

async function runMissingOnlySetup(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { cwd, locale } = options
  const store = new ProviderStore(cwd)
  const data = await store.load()
  sectionTitle(tr(locale, '快速配置 — 只补缺失项', 'Quick Setup — Missing Items Only'))

  const missing: string[] = []
  const main = store.getDefaultMainProfile(data)
  if (!main?.apiKey || !main.baseUrl || !main.model) missing.push('main provider')
  if (!data.memoryProfile?.enabled) missing.push('memory enhancement')
  if (!hasVisualImageConfig(data)) missing.push('visual model')
  if (!data.setup?.tools?.enabled?.stt && !data.setup?.tools?.enabled?.tts) missing.push('voice input/output')

  if (missing.length === 0) {
    console.log(tr(locale, '  ✓ 必要配置都已完成。', '  ✓ Everything essential is configured.'))
    console.log(tr(locale, '  如果想重新配置全部项目，可以运行 Full Setup。', '  Run Full Setup if you want to reconfigure everything.'))
    return
  }

  console.log(tr(locale, `  缺失：${missing.join(', ')}`, `  Missing: ${missing.join(', ')}`))
  if (missing.includes('main provider')) await configureModelProvider({ cwd, locale, quick: true })
  if (missing.includes('memory enhancement')) await configureQuickMemoryEnhancement({ cwd, locale })
  if (missing.includes('visual model')) {
    const setupVisual = await askYesNo(
      locale,
      tr(locale, '检测到视觉模型未配置。现在配置图片/视频生成 API 吗？', 'Visual model is not configured. Configure image/video generation API now?'),
      true,
    )
    if (setupVisual) await runVisualModelSetup(locale, cwd)
  }
  if (missing.includes('voice input/output')) await configureQuickVoiceIO({ cwd, locale })
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
  else if (section === 'dream') await configureDreamSettings({ cwd, locale })
  else if (section === 'docs') await configureDocsAndResearchSettings({ cwd, locale })
  await printSetupSummary(cwd, locale)
}

async function configureDreamSettings(options: { cwd: string; locale: UiLocale }): Promise<void> {
  const { locale } = options
  const { loadDreamConfig, saveDreamConfig } = await import('../services/dreamStore.js')
  const current = await loadDreamConfig()

  sectionTitle(tr(locale, 'Artemis 梦境', 'Artemis Dreams'), [
    tr(locale, '空闲超过 1 小时后，Artemis 会读取今天的工作记录，写一段梦境笔记。', 'After ≥1h of inactivity, Artemis reads today\'s session activity and composes a dream note.'),
    tr(locale, '梦境提炼出的风格/偏好可以累加到长期系统提示词，让 AI 进化出自己的风格。', 'Distilled lines from each dream can accumulate into a long-term system-prompt suffix.'),
    tr(locale, '完成的梦境会主动推送到所有已授权的 Telegram/Discord/WeChat 聊天。', 'Each finished dream is broadcast to every authorized Telegram/Discord/WeChat chat.'),
  ])

  const mode = await chooseInteractiveOption<'text' | 'vision' | 'off'>({
    title: tr(locale, '梦境模式', 'Dream mode'),
    initialIndex: current.mode === 'off' ? 2 : current.mode === 'vision' ? 1 : 0,
    choices: [
      { label: tr(locale, '仅文字（每天 ~1 次主模型调用）', 'Text-only (~1 main-model call/day)'), value: 'text' },
      { label: tr(locale, '文字 + 配图（额外调一次现有视觉系统）', 'Text + image (also calls your visual provider)'), value: 'vision' },
      { label: tr(locale, '关闭', 'Off'), value: 'off' },
    ],
  })

  let evolveSystemPrompt = current.evolveSystemPrompt
  let pushToBridges = current.pushToBridges
  if (mode !== 'off') {
    const evolve = await chooseInteractiveOption<'on' | 'off'>({
      title: tr(locale, '梦后扩展系统提示词（让 AI 进化风格）', 'Append distilled style to long-term system prompt'),
      initialIndex: current.evolveSystemPrompt ? 0 : 1,
      choices: [
        { label: tr(locale, '启用（推荐）', 'Enable (recommended)'), value: 'on' },
        { label: tr(locale, '关闭', 'Off'), value: 'off' },
      ],
    })
    evolveSystemPrompt = evolve === 'on'

    const push = await chooseInteractiveOption<'on' | 'off'>({
      title: tr(locale, '主动推送到聊天桥接', 'Push dreams to active bridges'),
      initialIndex: current.pushToBridges ? 0 : 1,
      choices: [
        { label: tr(locale, '启用（每个梦境发到 Telegram/Discord/WeChat）', 'Enable (send each dream to all bridges)'), value: 'on' },
        { label: tr(locale, '关闭（只在本地保存，不打扰聊天）', 'Off (local only, do not notify chats)'), value: 'off' },
      ],
    })
    pushToBridges = push === 'on'
  }

  await saveDreamConfig({
    ...current,
    enabled: mode !== 'off',
    mode,
    evolveSystemPrompt,
    pushToBridges,
  })

  console.log(`  ✓ ${tr(locale, '梦境配置已保存', 'Dream config saved')}: mode=${mode}, evolve=${evolveSystemPrompt}, push=${pushToBridges}`)
}

export async function runSetupWizard(options: SetupWizardOptions): Promise<void> {
  const { cwd, locale } = options
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(tr(locale, '  非交互终端，配置向导需要交互式终端。', '  Not an interactive terminal — setup requires a TTY.'))
    return
  }

  const section = normalizeSection(options.section)
  if (options.section && !section) {
    console.log(tr(locale, `未知配置分区：${options.section}`, `Unknown setup section: ${options.section}`))
    console.log(tr(locale, '可用分区：model, bundle, skills, visual, gateway, memory, cron, terminal, tts, session, dream, docs', 'Available: model, bundle, skills, visual, gateway, memory, cron, terminal, tts, session, dream, docs'))
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

  sectionTitle(tr(locale, 'Artemis 配置向导', 'Artemis Setup Wizard'), [
    tr(locale, '选择要配置的项目；不确定就先选 Quick setup 跑通最小可用环境。', 'Pick what to configure, or run Quick setup for a minimal working baseline.'),
    tr(locale, '随时按 Ctrl+C 退出。', 'Press Ctrl+C at any time to exit.'),
  ])

  if (!existing || options.forceFirstTime) {
    const mode = await chooseInteractiveOption<'quick' | 'full'>({
      title: tr(locale, '你想如何配置 Artemis？', 'How would you like to set up Artemis?'),
      initialIndex: 0,
      choices: [
        { label: tr(locale, 'Quick setup — provider, model, Bundle & messaging（推荐）', 'Quick setup — provider, model, Bundle & messaging (recommended)'), value: 'quick' },
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
      { label: tr(locale, 'Quick Setup - 只补缺失项', 'Quick Setup - configure missing items only'), value: 'quick' },
      { label: tr(locale, 'Full Setup - 重新配置全部项目', 'Full Setup - reconfigure everything'), value: 'full' },
      { label: tr(locale, '模型与 Provider', 'Model & Provider'), value: 'model' },
      { label: tr(locale, '提示词润色 / Bundle', 'Prompt Polishing / Bundle'), value: 'bundle' },
      { label: tr(locale, 'Skills 目录', 'Skills Catalog'), value: 'skills' },
      { label: tr(locale, '视觉 / 图片与视频', 'Visual / Image & Video'), value: 'visual' },
      { label: tr(locale, '通讯平台', 'Messaging Platforms'), value: 'gateway' },
      { label: tr(locale, '记忆增强', 'Memory Enhancement'), value: 'memory' },
      { label: tr(locale, '自动化 / Cron', 'Automation / Cron'), value: 'automation' },
      { label: tr(locale, '终端后端', 'Terminal Backend'), value: 'terminal' },
      { label: tr(locale, '语音输入 / 输出', 'Voice Input / Output'), value: 'tts' },
      { label: tr(locale, '会话管理', 'Session Management'), value: 'session' },
      { label: tr(locale, '文档搜索 / 深度研究', 'Docs Search / Deep Research'), value: 'docs' },
      { label: tr(locale, '梦境系统', 'Dream System'), value: 'dream' },
      { label: tr(locale, '退出', 'Exit'), value: 'exit' },
    ],
  })

  if (action === 'exit') return
  if (action === 'quick') await runMissingOnlySetup({ cwd, locale })
  else if (action === 'full') await runFullSetup({ cwd, locale })
  else await runSection(action, { cwd, locale })
}
