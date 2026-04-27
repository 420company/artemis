/**
 * cli/onboarding.ts — first-run onboarding wizard
 *
 * Phases:
 *   1. Primary AI provider
 *   2. Secondary AI provider (dual-model mode, optional)
 *   3. Communication bridges (Telegram / Discord / WeChat, optional)
 *   4. Summary HUD — show real configured status
 */

import * as os from 'node:os'
import { createInterface } from 'node:readline'
import { chooseInteractiveOption, createInteractivePromptIO } from './prompt.js'
import type { UiLocale } from './locale.js'
import { pickLocale, isChineseLocale } from './locale.js'
import { stringWidth } from '../input/stringWidth.js'
import { CliSettingsStore } from './settings.js'
import { ProviderStore } from '../providers/store.js'
import { BragiStore } from '../bragi/store.js'
import { TelegramStore } from '../telegram/store.js'
import { WeChatStore } from '../wechat/store.js'
import { runWeixinQRLogin } from '../wechat/setup.js'
import { DiscordBotClient } from '../discord/client.js'
import { promptForVerifiedProviderProfile } from '../providers/onboarding.js'
import type { ProviderProfile, VisualModelConfig } from '../providers/types.js'
import type { BragiPlatformId } from '../bragi/types.js'
import {
  getVisualProviderSupportNote,
  isPlaceholderVisualProvider,
} from '../tools/visual/providers/interface.js'
import {
  defaultVisualBaseUrlForProvider,
  defaultVisualModelForProvider,
} from '../utils/visualGenerationConfig.js'

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

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function padLineAnsi(text: string, width: number): string {
  const visible = stringWidth(stripAnsi(text))
  if (visible >= width) return text
  return text + ' '.repeat(width - visible)
}

const HOME_DIR = os.homedir()

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Ask a single line of text. mask=true shows first 4 and last 4 chars, rest as * for API keys. */
function askLine(question: string, mask = false): Promise<string | null> {
  return new Promise(resolve => {
    process.stdin.resume()
    const rl = createInterface({
      input:  process.stdin,
      output: process.stdout,
      terminal: mask ? false : undefined,
    })

    if (mask && process.stdin.isTTY) {
      process.stdout.write(question)
      let buf = ''
      process.stdin.setRawMode(true)
      process.stdin.resume()
      process.stdin.setEncoding('utf8')
      const onData = (ch: string) => {
        if (ch === '\r' || ch === '\n') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(buf || null)
          rl.close()
        } else if (ch === '\u0003') {
          process.stdin.setRawMode(false)
          process.stdin.pause()
          process.stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(null)
          rl.close()
        } else if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1)
            // Clear the last character from display
            process.stdout.write('\b \b')
          }
        } else if (ch >= ' ') {
          // ch may be a single char (typed) or a multi-char string (pasted).
          const graphemes = [...ch]
          buf += ch
          
          // Display masked version: first 4 and last 4 chars, rest as *
          const masked = maskApiKey(buf)
          // Clear previous masked display and show new one
          if (buf.length > graphemes.length) {
            process.stdout.write('\b'.repeat(maskApiKey(buf.slice(0, -graphemes.length)).length))
          }
          process.stdout.write(masked.slice(-graphemes.length))
        }
      }
      process.stdin.on('data', onData)
      return
    }

    // IMPORTANT: resolve() BEFORE rl.close() — rl.close() synchronously emits
    // 'close', which would call resolve(null) and win the race if resolve() is called after.
    rl.question(question, answer => { resolve(answer.trim() || null); rl.close() })
    rl.once('close', () => resolve(null))
  })
}

/** Mask API key: show first 4 and last 4 characters, middle as * */
function maskApiKey(key: string): string {
  if (!key || key.length <= 8) {
    return '*'.repeat(key.length)
  }
  return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4)
}

/** Ask optional line (enters empty string on blank). */
async function askOptional(question: string): Promise<string> {
  const v = await askLine(question)
  return v ?? ''
}

async function askRequiredOptional(
  question: string,
  t: (zh: string, en: string) => string,
): Promise<string | null> {
  while (true) {
    const value = await askOptional(question)
    if (value.trim()) {
      return value.trim()
    }
    console.log(c('  ' + t('该项不能为空。', 'This field cannot be empty.'), A.yellow))
  }
}

/** Ask a yes/no question with arrow-key menu. */
async function askYesNo(
  t: (zh: string, en: string) => string,
  question: string,
  defaultYes = false,
): Promise<boolean> {
  try {
    return await chooseInteractiveOption<boolean>({
      title: question,
      hint: t('↑↓ 移动  Enter 确认', '↑↓ move  Enter confirm'),
      initialIndex: defaultYes ? 0 : 1,
      choices: [
        { label: t('是', 'Yes'), value: true },
        { label: t('否，跳过', 'No, skip'), value: false },
      ],
    })
  } catch {
    return false
  }
}

function sectionHeader(step: string, title: string, subtitle: string): void {
  console.log()
  console.log(c(`  ${step}  ${title}`, A.bold + A.cyan))
  console.log(c(`       ${subtitle}`, A.dim))
  console.log()
}

// ─── provider wizard ──────────────────────────────────────────────────────────

async function configureProvider(
  locale: UiLocale,
  role: 'primary' | 'secondary',
  cwd?: string,
): Promise<ProviderProfile | null> {
  const zh = isChineseLocale(locale)
  const t  = (z: string, e: string) => zh ? z : e

  // Track the last panel text so we can reprint it after clearing.
  let lastPanel = ''

  const base = createInteractivePromptIO()

  // Custom PromptIO: save the panel text on write(); clear + reprint panel
  // before every interactive choose() so the terminal stays clean.
  const promptIO = {
    ...base,
    write(message: string) {
      lastPanel = message
      process.stdout.write('\x1b[2J\x1b[H')   // clear screen
      base.write(message)
    },
    async choose<V>(options: Parameters<NonNullable<typeof base.choose>>[0]): Promise<V> {
      process.stdout.write('\x1b[2J\x1b[H')   // clear screen
      if (lastPanel) base.write(lastPanel)     // reprint context panel
      return (base.choose as NonNullable<typeof base.choose>)(options) as Promise<V>
    },
  } as typeof base

  const store = new ProviderStore(cwd ?? HOME_DIR)
  const data = await store.load()

  const profile = await promptForVerifiedProviderProfile(
    promptIO,
    data,
    {
      heading: role === 'primary'
        ? t('配置主 AI Provider', 'Configure primary AI provider')
        : t('配置副 AI Provider（双模型）', 'Configure secondary AI provider (dual-model)'),
      defaultAlias: role === 'primary'
        ? t('主模型', 'Primary model')
        : t('副模型', 'Secondary model'),
      defaultIdPrefix: role === 'primary' ? 'main' : 'secondary',
      cancellationLabel: t('取消', 'cancel'),
      fixedId: role === 'primary' ? 'main' : 'secondary',
    },
    locale,
  )

  return profile ?? null
}

// ─── visual model wizard ──────────────────────────────────────────────────────

type VisualConfigWizardOptions = {
  skipEnablePrompt?: boolean
}

function buildVisualProviderChoiceLabel(
  provider: string,
  label: string,
  zh: boolean,
): string {
  if (provider === 'custom') {
    return zh ? '自定义接口（OpenAI-compatible）' : 'Custom API (OpenAI-compatible)'
  }
  if (isPlaceholderVisualProvider(provider)) {
    return zh ? `${label}（占位，需适配）` : `${label} (placeholder)`
  }
  return label
}

function printVisualProviderSupportNote(
  provider: string,
  zh: boolean,
): void {
  const note = getVisualProviderSupportNote(provider, zh ? 'zh' : 'en')
  if (!note) return
  console.log(c(`  ${note}`, A.yellow + A.dim))
  console.log()
}

function buildVisualProfileSummaryLines(
  visualProfile: VisualModelConfig,
  t: (zh: string, en: string) => string,
): string[] {
  const lines = [
    `${t('图片', 'Image')}: ${visualProfile.image.provider}/${visualProfile.image.model}`,
  ]
  if (visualProfile.video.enabled) {
    lines.push(`${t('视频', 'Video')}: ${visualProfile.video.provider}/${visualProfile.video.model}`)
  } else {
    lines.push(`${t('视频', 'Video')}: ${t('未启用', 'disabled')}`)
  }
  return lines
}

async function persistVisualProfile(
  cwd: string | undefined,
  visualProfile: VisualModelConfig,
): Promise<void> {
  const targets = cwd && cwd !== HOME_DIR
    ? [cwd, HOME_DIR]
    : [cwd ?? HOME_DIR]

  for (const target of targets) {
    const store = new ProviderStore(target)
    await store.setVisualProfile(visualProfile)
  }
}

async function configureVisualModel(
  t: (zh: string, en: string) => string,
  zh: boolean,
  options: VisualConfigWizardOptions = {},
): Promise<VisualModelConfig | null> {
  if (!options.skipEnablePrompt) {
    const wantVisual = await askYesNo(
      t,
      t('是否配置视觉模型（图片/视频生成）？', 'Configure visual model (image/video generation)?'),
      false,
    )
    console.log()

    if (!wantVisual) {
      return null
    }
  }

  console.log(c('  ' + t('视觉模型配置', 'Visual model configuration'), A.bold))
  console.log(c('  ' + t('支持图片和视频生成功能', 'Supports image and video generation'), A.dim))
  console.log()

  const askVisualBaseUrl = async (
    provider: string,
    assetLabel: string,
  ): Promise<string | null> => {
    const defaultBaseUrl = defaultVisualBaseUrlForProvider(provider)
    if (provider === 'custom') {
      return askRequiredOptional(
        c(
          '  ' +
            t(
              `${assetLabel} 自定义 API Base URL（必填，建议 OpenAI-compatible 根地址）: `,
              `${assetLabel} custom API base URL (required, preferably an OpenAI-compatible root URL): `,
            ),
          A.bold + A.yellow,
        ),
        t,
      )
    }
    return askOptional(
      c(
        '  ' +
          t(
            `API 地址（留空使用默认 ${defaultBaseUrl || 'provider default'}）: `,
            `API URL (blank = ${defaultBaseUrl || 'provider default'}): `,
          ),
        A.bold + A.yellow,
      ),
    )
  }

  // 
  console.log(c('  ' + t('图片生成配置', 'Image generation configuration'), A.cyan))
  const imageProvider = await chooseInteractiveOption<string>({
    title: t('选择图片生成提供商', 'Choose image generation provider'),
    hint: t('↑↓ 移动  Enter 确认', '↑↓ move  Enter confirm'),
    choices: [
      { label: 'BytePlus', value: 'byteplus' },
      { label: 'OpenAI GPT Image 1.5', value: 'openai' },
      { label: buildVisualProviderChoiceLabel('custom', 'Custom API', zh), value: 'custom' },
      { label: t('取消', 'Cancel'), value: '__cancel__' },
    ],
  })

  if (imageProvider === '__cancel__') {
    return null
  }

  printVisualProviderSupportNote(imageProvider, zh)

  const imageApiKey = await askLine(c('  ' + t('API Key: ', 'API Key: '), A.bold + A.yellow), true)
  if (!imageApiKey) {
    return null
  }

  const imageDefaultBaseUrl = defaultVisualBaseUrlForProvider(imageProvider)
  const imageDefaultModel = defaultVisualModelForProvider(imageProvider, 'image')
  const imageBaseUrl = await askVisualBaseUrl(imageProvider, t('图片', 'Image'))
  if (imageBaseUrl === null) {
    return null
  }
  const imageModel = await askOptional(c('  ' + t(`模型名称（留空使用默认 ${imageDefaultModel}）: `, `Model name (blank = ${imageDefaultModel}): `), A.bold + A.yellow))

  // 
  console.log()
  const wantVideo = await askYesNo(
    t,
    t('是否配置视频生成功能？', 'Configure video generation?'),
    false,
  )
  console.log()

  let videoConfig: VisualModelConfig['video'] | null = null
  if (wantVideo) {
    console.log(c('  ' + t('视频生成配置', 'Video generation configuration'), A.cyan))
    const videoProvider = await chooseInteractiveOption<string>({
      title: t('选择视频生成提供商', 'Choose video generation provider'),
      hint: t('↑↓ 移动  Enter 确认', '↑↓ move  Enter confirm'),
      choices: [
        { label: 'BytePlus', value: 'byteplus' },
        { label: 'OpenAI Sora 2', value: 'openai' },
        { label: buildVisualProviderChoiceLabel('custom', 'Custom API', zh), value: 'custom' },
        { label: t('取消', 'Cancel'), value: '__cancel__' },
      ],
    })

    if (videoProvider === '__cancel__') {
      return null
    }

    printVisualProviderSupportNote(videoProvider, zh)

    const videoApiKey = await askLine(c('  ' + t('API Key: ', 'API Key: '), A.bold + A.yellow), true)
    if (!videoApiKey) {
      return null
    }

    const videoDefaultBaseUrl = defaultVisualBaseUrlForProvider(videoProvider)
    const videoDefaultModel = defaultVisualModelForProvider(videoProvider, 'video')
    const videoBaseUrl = await askVisualBaseUrl(videoProvider, t('视频', 'Video'))
    if (videoBaseUrl === null) {
      return null
    }
    const videoModel = await askOptional(c('  ' + t(`模型名称（留空使用默认 ${videoDefaultModel}）: `, `Model name (blank = ${videoDefaultModel}): `), A.bold + A.yellow))

    videoConfig = {
      enabled: true,
      provider: videoProvider,
      apiKey: videoApiKey,
      baseUrl: videoBaseUrl || videoDefaultBaseUrl,
      model: videoModel || videoDefaultModel,
      defaultParams: {
        duration: '10s',
        resolution: '1080p',
        quality: 'standard',
        style: 'realistic',
        format: 'mp4',
        framerate: '30fps',
        watermark: false,
      },
    }
  } else {
    videoConfig = {
      enabled: false,
      provider: 'byteplus',
      apiKey: '',
      baseUrl: defaultVisualBaseUrlForProvider('byteplus'),
      model: defaultVisualModelForProvider('byteplus', 'video'),
      defaultParams: {
        duration: '10s',
        resolution: '1080p',
        quality: 'standard',
        style: 'realistic',
        format: 'mp4',
        framerate: '30fps',
        watermark: false,
      },
    }
  }

  // 
  const visualConfig: VisualModelConfig = {
    enabled: true,
    image: {
      provider: imageProvider,
      apiKey: imageApiKey,
      baseUrl: imageBaseUrl || imageDefaultBaseUrl,
      model: imageModel || imageDefaultModel,
      defaultParams: imageProvider === 'openai'
        ? {
            size: '1024x1024',
            quality: 'medium',
            style: 'realistic',
            watermark: false,
            outputFormat: 'png',
            background: 'auto',
          }
        : {
            size: '2K',
            quality: 'standard',
            style: 'realistic',
            watermark: false,
          },
    },
    video: videoConfig!,
  }

  console.log()
  console.log(c('  ✓ ' + t('视觉模型配置完成', 'Visual model configured'), A.green))
  console.log()

  return visualConfig
}

// ─── bridge wizard ────────────────────────────────────────────────────────────

type BridgeResult = { platform: BragiPlatformId; credentials: Record<string, string>; extra: Record<string, string> }

async function configureBridge(
  t: (zh: string, en: string) => string,
  platform: BragiPlatformId,
): Promise<BridgeResult | null> {
  const credentials: Record<string, string> = {}
  const extra: Record<string, string> = {}

  switch (platform) {
    case 'telegram': {
      console.log(c('  ' + t('Telegram Bot 配置', 'Telegram Bot setup'), A.bold))
      console.log(c('  ' + t('从 @BotFather 获取 Bot Token', 'Get Bot Token from @BotFather'), A.dim))
      console.log()
      const token = await askLine(c('  Bot Token: ', A.bold + A.yellow), true)
      if (!token) return null
      credentials.botToken = token
      break
    }
    case 'discord': {
      console.log(c('  ' + t('Discord Bot 配置', 'Discord Bot setup'), A.bold))
      console.log(c('  ' + t('discord.com/developers/applications → Bot → 重置 Token，并开启 Message Content Intent', 'discord.com/developers/applications → Bot → Reset Token, enable Message Content Intent'), A.dim))
      console.log()
      let discordToken = ''
      while (!discordToken) {
        const raw = await askLine(c('  Bot Token: ', A.bold + A.yellow), true)
        if (!raw) return null
        try {
          const client = new DiscordBotClient(raw)
          const me = await client.getCurrentUser()
          const name = me.global_name ?? me.username
          console.log(c(`  ✓ ${t('验证成功', 'Verified')}: ${name}`, A.green))
          discordToken = raw
          extra.botName = name
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(c('  ✗ ' + msg, A.red))
          console.log(c('  ' + t('请重新输入完整 Token。', 'Please re-enter the full token.'), A.dim))
        }
      }
      credentials.botToken = discordToken
      break
    }
    case 'wechat': {
      console.log(c('  ' + t('微信个人号配置', 'WeChat Personal setup'), A.bold))
      console.log(c('  ' + t('通过 iLink 云服务扫码登录，无需本地安装任何软件', 'Log in via iLink cloud service — no local software needed'), A.dim))
      console.log()

      // Ask login method
      let loginMethod: 'qr' | 'manual'
      try {
        loginMethod = await chooseInteractiveOption<'qr' | 'manual'>({
          title: t('选择登录方式', 'Choose login method'),
          hint: t('↑↓ 移动  Enter 确认', '↑↓ move  Enter confirm'),
          choices: [
            { label: t('扫码登录（推荐）— 打开链接扫码即可', 'QR scan (recommended) — open link and scan'), value: 'qr' },
            { label: t('手动输入 Token', 'Enter token manually'), value: 'manual' },
          ],
        })
      } catch { return null }

      console.log()

      if (loginMethod === 'qr') {
        console.log(c('  ' + t('正在获取二维码...', 'Fetching QR code...'), A.dim))
        console.log()
        try {
          const result = await runWeixinQRLogin({
            onStatus: (msg) => {
              // Print QR URL prominently so user can click/copy it
              if (msg.startsWith('QR URL:')) {
                const url = msg.slice('QR URL:'.length).trim()
                console.log()
                console.log(c('  ' + t('请用微信扫描以下二维码链接：', 'Scan this QR code link with WeChat:'), A.bold))
                console.log()
                console.log(c('  ' + url, A.cyan + A.bold))
                console.log()
              } else {
                console.log(c('  ' + msg, A.dim))
              }
            },
          })
          extra.gatewayUrl   = result.botBaseUrl
          credentials.gatewayToken = result.token
          console.log()
          console.log(c('  ✓ ' + t('微信登录成功！', 'WeChat login successful!'), A.green + A.bold))
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          console.log(c('  ✗ ' + t('登录失败: ', 'Login failed: ') + msg, A.red))
          return null
        }
      } else {
        // Manual token entry
        console.log(c('  ' + t('手动输入 iLink Gateway 信息', 'Enter iLink gateway details manually'), A.dim))
        console.log()
        const gatewayUrl = await askOptional(c(`  Gateway URL ${t('(留空使用 ilinkai.weixin.qq.com)', '(leave blank for ilinkai.weixin.qq.com)')}: `, A.bold + A.yellow))
        extra.gatewayUrl = gatewayUrl || 'https://ilinkai.weixin.qq.com'

        const gatewayToken = await askLine(c('  Gateway Token: ', A.bold + A.yellow), true)
        if (!gatewayToken) return null
        credentials.gatewayToken = gatewayToken
      }

      console.log()
      console.log(c('  ' + '─'.repeat(60), A.yellow))
      console.log(c('  ⚠ ' + t('请重启 Artemis', 'Please restart Artemis'), A.yellow + A.bold))
      console.log(c('  ' + t('微信桥接配置完成后，需要重启 Artemis 才能让 wechat 桥实际启动并接收消息。',
                              'After WeChat bridge setup, restart Artemis so the wechat bridge actually starts and receives messages.'), A.dim))
      console.log(c('  ' + t('退出后再次运行  artemis  即可。',
                              'Exit and run  artemis  again.'), A.dim))
      console.log(c('  ' + '─'.repeat(60), A.yellow))
      console.log()
      break
    }
  }

  return { platform, credentials, extra }
}

// ─── summary HUD ──────────────────────────────────────────────────────────────

function renderOnboardingSummary(
  t: (zh: string, en: string) => string,
  primary:   ProviderProfile | null,
  secondary: ProviderProfile | null,
  visual:    any | null,
  bridges:   BridgeResult[],
): void {
  const ok  = (s: string) => c('✓', A.green + A.bold) + ' ' + s
  const no  = (s: string) => c('✗', A.red) + ' ' + c(s, A.dim)

  const primaryLine   = primary   ? ok(`${primary.model}  ${c(`(${primary.label})`, A.dim)}`) : no(t('未配置', 'not configured'))
  const secondaryLine = secondary ? ok(`${secondary.model}  ${c(`(${secondary.label})`, A.dim)}`) : no(t('未配置（单模型模式）', 'not configured (single-model mode)'))
  
  const visualLine = visual && visual.enabled 
    ? ok(`${c(t('已启用', 'Enabled'), A.green)}`) 
    : no(t('未配置（可之后用 artemis config 添加）', 'not configured (add later with artemis config)'))

  const platformLabels: Record<BragiPlatformId, string> = {
    telegram: 'Telegram', discord: 'Discord', wechat: 'WeChat',
  }
  const bridgeLine = bridges.length > 0
    ? ok(bridges.map(b => c(platformLabels[b.platform], A.cyan)).join('  '))
    : no(t('未配置（可之后用 artemis config 添加）', 'not configured (add later with artemis config)'))

  const width = 62
  const hr = '─'.repeat(width)
  const row = (label: string, value: string) => {
    const labelWidth = stringWidth(stripAnsi(label))
    const valueWidth = stringWidth(stripAnsi(value))
    const targetContentWidth = width - 4  // -4 for '  ' padding on each side
    // 计算标签所需宽度：中文标签设为12，英文标签根据最长的来
    const requiredLabelWidth = Math.max(
      t('主模型', 'Primary AI').length, 
      t('副模型', 'Secondary').length, 
      t('视觉模型', 'Visual').length, 
      t('通讯桥', 'Bridges').length
    )
    const labelPadded = label + ' '.repeat(Math.max(0, requiredLabelWidth - labelWidth))
    const spaceBetween = Math.max(0, targetContentWidth - stringWidth(stripAnsi(labelPadded)) - valueWidth)
    const raw = `  ${labelPadded}${' '.repeat(Math.max(1, spaceBetween))}${value}  `
    return c('│', A.cyan) + padLineAnsi(raw, width) + c('│', A.cyan)
  }

  console.log()
  console.log(c('┌' + hr + '┐', A.cyan))
  const titleText = c('  Artemis  — ' + t('配置完成', 'Setup Complete'), A.bold + A.white)
  console.log(c('│', A.cyan) + padLineAnsi(titleText, width) + c('│', A.cyan))
  console.log(c('├' + hr + '┤', A.cyan))
  console.log(row(c(t('主模型', 'Primary AI'), A.bold),   primaryLine))
  console.log(row(c(t('副模型', 'Secondary'), A.bold),    secondaryLine))
  console.log(row(c(t('视觉模型', 'Visual'), A.bold),      visualLine))
  console.log(row(c(t('通讯桥', 'Bridges'), A.bold),      bridgeLine))
  console.log(c('├' + hr + '┤', A.cyan))
  const line1 = c('  ' + t('输入消息开始对话  /help 查看命令', 'Type a message to start  /help for commands'), A.dim)
  console.log(c('│', A.cyan) + padLineAnsi(line1, width) + c('│', A.cyan))
  if (bridges.length > 0) {
    const line2 = c('  ' + t('通讯桥已配置，启动 Artemis 时会自动连接', 'Bridges configured — they start automatically when Artemis launches'), A.dim)
    console.log(c('│', A.cyan) + padLineAnsi(line2, width) + c('│', A.cyan))
  }
  console.log(c('└' + hr + '┘', A.cyan))
  console.log()
}

// ─── export ───────────────────────────────────────────────────────────────────

export interface OnboardingResult {
  configured: boolean
  apiKey?: string
  model?: string
}

export interface VisualModelSetupResult {
  configured: boolean
  changed: boolean
  visualProfile?: VisualModelConfig | null
}

export async function runVisualModelSetup(
  localeHint: UiLocale,
  cwd?: string,
): Promise<VisualModelSetupResult> {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY

  if (!isTTY) {
    console.log('  Not an interactive terminal — visual model setup requires a TTY.')
    console.log('  非交互终端，视觉模型配置需要交互式终端。')
    return { configured: false, changed: false }
  }

  const locale = localeHint
  const zh = isChineseLocale(locale)
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  const store = new ProviderStore(cwd ?? HOME_DIR)
  const data = await store.load()
  const currentVisual = store.getVisualProfile(data)

  sectionHeader(
    t('▸ 视觉模型配置', '▸ Visual model setup'),
    t('单独编辑视觉配置', 'Edit visual configuration only'),
    t('仅修改图片/视频生成配置，不触碰主模型、副模型或通讯桥', 'Update image/video generation only without touching main, secondary, or bridge settings'),
  )

  if (currentVisual?.enabled) {
    console.log(c('  ' + t('当前视觉配置', 'Current visual configuration'), A.bold))
    for (const line of buildVisualProfileSummaryLines(currentVisual, t)) {
      console.log(c(`    ${line}`, A.dim))
    }
    console.log()

    const action = await chooseInteractiveOption<'reconfigure' | 'disable' | 'cancel'>({
      title: t('选择操作', 'Choose action'),
      hint: t('↑↓ 移动  Enter 确认', '↑↓ move  Enter confirm'),
      choices: [
        { label: t('重新配置', 'Reconfigure'), value: 'reconfigure' },
        { label: t('禁用视觉生成', 'Disable visual generation'), value: 'disable' },
        { label: t('取消并保留现状', 'Cancel and keep current config'), value: 'cancel' },
      ],
    })

    console.log()

    if (action === 'cancel') {
      console.log(c('  ' + t('未修改视觉配置。', 'Visual configuration unchanged.'), A.dim))
      console.log()
      return { configured: true, changed: false, visualProfile: currentVisual }
    }

    if (action === 'disable') {
      const disabledProfile: VisualModelConfig = {
        ...currentVisual,
        enabled: false,
        video: {
          ...currentVisual.video,
          enabled: false,
        },
      }
      await persistVisualProfile(cwd, disabledProfile)
      console.log(c('  ✓ ' + t('视觉生成已禁用，并已同步到工作区与全局配置。', 'Visual generation disabled and synced to workspace and global config.'), A.green))
      console.log()
      return { configured: false, changed: true, visualProfile: disabledProfile }
    }
  }

  const visualProfile = await configureVisualModel(t, zh, { skipEnablePrompt: true })
  if (!visualProfile) {
    console.log(c('  ' + t('已取消视觉模型配置。', 'Visual model setup cancelled.'), A.dim))
    console.log()
    return {
      configured: Boolean(currentVisual?.enabled),
      changed: false,
      visualProfile: currentVisual ?? null,
    }
  }

  await persistVisualProfile(cwd, visualProfile)

  console.log(c('  ' + t('当前已保存的视觉配置', 'Saved visual configuration'), A.bold))
  for (const line of buildVisualProfileSummaryLines(visualProfile, t)) {
    console.log(c(`    ${line}`, A.dim))
  }
  console.log(c('  ✓ ' + t('已同步到工作区与全局 providers.json。', 'Synced to workspace and global providers.json.'), A.green))
  console.log()

  return { configured: true, changed: true, visualProfile }
}

// ─── main wizard ──────────────────────────────────────────────────────────────

export async function runOnboarding(localeHint: UiLocale, cwd?: string): Promise<OnboardingResult> {
  const isTTY = process.stdin.isTTY && process.stdout.isTTY

  if (!isTTY) {
    console.log('  Not an interactive terminal — set ANTHROPIC_API_KEY and restart.')
    console.log('  非交互终端，请设置 ANTHROPIC_API_KEY 后重启。')
    return { configured: false }
  }

  const locale = localeHint
  const zh = isChineseLocale(locale)
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })

  console.log()
  console.log(c('  ' + t('将引导你完成以下步骤：', 'This wizard will guide you through:'), A.white))
  console.log(c('    1. ' + t('配置主 AI Provider', 'Configure primary AI provider'), A.dim))
  console.log(c('    2. ' + t('配置副 AI Provider（双模型模式，可选）', 'Configure secondary AI provider (dual-model, optional)'), A.dim))
  console.log(c('    3. ' + t('配置视觉模型（图片/视频生成，可选）', 'Configure visual model (image/video generation, optional)'), A.dim))
  console.log(c('    4. ' + t('配置通讯桥（Telegram / Discord / WeChat，可选）', 'Configure communication bridges (Telegram / Discord / WeChat, optional)'), A.dim))
  console.log()

  // ─────────────────────────────────────────────────────────────────
  //  Phase 1: Primary AI provider
  // ─────────────────────────────────────────────────────────────────
  sectionHeader(
    t('▸ 步骤 1/3', '▸ Step 1/3'),
    t('主 AI Provider', 'Primary AI provider'),
    t('选择并配置用于日常对话的主模型', 'Select and configure the main model for conversations'),
  )

  const primary = await configureProvider(locale, 'primary', cwd)
  if (!primary) {
    console.log(c('  ' + t('未配置主 Provider，已退出配置向导。', 'Primary provider not configured — exiting wizard.'), A.yellow))
    return { configured: false }
  }

  console.log(c(`  ✓ ${t('主模型', 'Primary')}: ${primary.model}  (${primary.label})`, A.green))
  console.log()

  // ─────────────────────────────────────────────────────────────────
  //  Phase 2: Secondary AI provider (dual-model mode)
  // ─────────────────────────────────────────────────────────────────
  sectionHeader(
    t('▸ 步骤 2/3', '▸ Step 2/3'),
    t('副 AI Provider（可选）', 'Secondary AI provider (optional)'),
    t('双模型模式：轻量任务用主模型，复杂任务自动切换到副模型', 'Dual-model: primary for light tasks, secondary auto-switches for complex ones'),
  )

  let secondary: ProviderProfile | null = null
  const wantSecondary = await askYesNo(
    t,
    t('是否配置副 AI Provider（双模型模式）？', 'Configure secondary AI provider (dual-model mode)?'),
    false,
  )
  console.log()

  if (wantSecondary) {
    secondary = await configureProvider(locale, 'secondary', cwd)
    if (secondary) {
      console.log(c(`  ✓ ${t('副模型', 'Secondary')}: ${secondary.model}  (${secondary.label})`, A.green))
    } else {
      console.log(c('  ' + t('副 Provider 已跳过。', 'Secondary provider skipped.'), A.dim))
    }
    console.log()
  } else {
    console.log(c('  ' + t('已跳过，可之后用 artemis config 添加。', 'Skipped — add later with artemis config.'), A.dim))
    console.log()
  }

  // ─────────────────────────────────────────────────────────────────
  //  Phase 3: Visual model (image/video generation)
  // ─────────────────────────────────────────────────────────────────
  sectionHeader(
    t('▸ 步骤 3/4', '▸ Step 3/4'),
    t('视觉模型配置（可选）', 'Visual model configuration (optional)'),
    t('配置图片和视频生成功能，支持多种视觉模型提供商', 'Configure image and video generation with multiple visual model providers'),
  )

  let visualProfile: VisualModelConfig | null = null
  const store = new ProviderStore(cwd ?? HOME_DIR)
  const pData = await store.load()
  const initialVisual = store.getVisualProfile(pData)
  if (initialVisual && initialVisual.enabled) {
    console.log()
    const keepVisual = await askYesNo(
      t,
      t('保留现有的视觉模型配置？', 'Keep existing visual model configuration?'),
      true,
    )
    if (keepVisual) {
      visualProfile = initialVisual
    } else {
      visualProfile = await configureVisualModel(t, zh)
    }
  } else {
    visualProfile = await configureVisualModel(t, zh)
  }

  if (visualProfile) {
    await persistVisualProfile(cwd, visualProfile)
  }

  // ─────────────────────────────────────────────────────────────────
  //  Phase 4: Communication bridges
  // ─────────────────────────────────────────────────────────────────
  sectionHeader(
    t('▸ 步骤 4/4', '▸ Step 4/4'),
    t('通讯桥配置（可选）', 'Communication bridges (optional)'),
    t('让 Artemis 接入即时通讯软件，通过消息触发 AI', 'Connect Artemis to messaging apps to trigger AI via messages'),
  )

  const wantBridges = await askYesNo(
    t,
    t('是否现在配置通讯桥？', 'Configure communication bridges now?'),
    false,
  )
  console.log()

  const configuredBridges: BridgeResult[] = []

  if (wantBridges) {
    type PlatformChoice = { label: string; value: BragiPlatformId; description: string }
    const platformChoices: PlatformChoice[] = [
      { label: 'Telegram',               value: 'telegram', description: t('Telegram Bot', 'Telegram Bot') },
      { label: 'Discord',                value: 'discord',  description: t('Discord Bot', 'Discord Bot') },
      { label: 'WeChat 微信（个人号）',    value: 'wechat',   description: t('需要 wechaty 网关', 'Requires wechaty gateway') },
    ]

    let keepAdding = true
    while (keepAdding) {
      const remaining = platformChoices.filter(p => !configuredBridges.find(b => b.platform === p.value))
      if (remaining.length === 0) break

      let chosen: BragiPlatformId | '__done__'
      try {
        chosen = await chooseInteractiveOption<BragiPlatformId | '__done__'>({
          title: t('选择要配置的通讯平台', 'Choose a messaging platform to configure'),
          hint: t('↑↓ 移动  Enter 确认  Esc 完成', '↑↓ move  Enter confirm  Esc done'),
          escapeValue: '__done__',
          choices: [
            ...remaining,
            { label: c(t('─── 完成，不再添加 ───', '─── Done, no more bridges ───'), A.dim), value: '__done__' as const },
          ],
        })
      } catch { break }

      if (chosen === '__done__') { keepAdding = false; break }

      console.log()
      const result = await configureBridge(t, chosen as BragiPlatformId)
      console.log()

      if (result) {
        configuredBridges.push(result)
        const label = platformChoices.find(p => p.value === chosen)?.label ?? chosen
        console.log(c(`  ✓ ${label} ${t('已配置', 'configured')}`, A.green))
        console.log()

        const addMore = await askYesNo(t, t('是否继续配置下一个通讯平台？', 'Configure another platform?'), false)
        console.log()
        if (!addMore) keepAdding = false
      } else {
        console.log(c('  ' + t('跳过该平台。', 'Platform skipped.'), A.dim))
        console.log()
      }
    }
  } else {
    console.log(c('  ' + t('已跳过，可之后用 artemis config 添加。', 'Skipped — add later with artemis config.'), A.dim))
    console.log()
  }

  // ─────────────────────────────────────────────────────────────────
  //  Save all config
  // ─────────────────────────────────────────────────────────────────
  try {
    // Provider profiles
    const targets: ProviderStore[] = []
    if (cwd) targets.push(new ProviderStore(cwd))
    targets.push(new ProviderStore(HOME_DIR))

    for (const store of targets) {
      const data = await store.load()
      // Remove old profiles with same ids before inserting
      const idsToReplace = [primary.id, secondary?.id].filter(Boolean) as string[]
      data.profiles = data.profiles.filter(p => !idsToReplace.includes(p.id))
      data.profiles.push(primary)
      if (secondary) data.profiles.push(secondary)
      data.defaultMainProfileId = primary.id
      if (secondary) data.specialistProfileId = secondary.id
      await store.save(data)
    }

    // Bridge configs
    if (configuredBridges.length > 0) {
      const bragiTargets: BragiStore[] = []
      if (cwd) bragiTargets.push(new BragiStore(cwd))
      bragiTargets.push(new BragiStore(HOME_DIR))

      for (const store of bragiTargets) {
        for (const bridge of configuredBridges) {
          await store.upsertPlatform(bridge.platform, {
            enabled: true,
            autoStartOnLaunch: true,
            credentials: bridge.credentials,
            allowedTargets: [],
            ...bridge.extra,
          })
        }
      }

      // Each bridge also persists credentials to its own platform store (which the bridge runtime reads).
      // BragiStore holds the "registry" copy; the platform store holds the live copy used at runtime.
      const dirs = [...(cwd ? [cwd] : []), HOME_DIR]

      const telegramBridge = configuredBridges.find(b => b.platform === 'telegram')
      if (telegramBridge) {
        const botToken = telegramBridge.credentials['botToken'] ?? ''
        if (botToken) {
          for (const dir of dirs) {
            const ts = new TelegramStore(dir)
            await ts.setBotToken(botToken)
            await ts.setAutoStartOnLaunch(true)
          }
        }
      }

      const wechatBridge = configuredBridges.find(b => b.platform === 'wechat')
      if (wechatBridge) {
        const gatewayUrl   = wechatBridge.extra['gatewayUrl'] ?? ''
        const gatewayToken = wechatBridge.credentials['gatewayToken'] ?? ''
        if (gatewayUrl && gatewayToken) {
          for (const dir of dirs) {
            const ws = new WeChatStore(dir)
            await ws.setCredentials({ gatewayUrl, gatewayToken })
            await ws.setAutoStartOnLaunch(true)
          }
        }
      }
    }

    // Mark onboarding complete
    const settingsTarget = cwd ?? HOME_DIR
    const settingsStore = new CliSettingsStore(settingsTarget)
    await settingsStore.update({ onboardingCompleted: true }).catch(() => {})

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(c('  ✗ ' + t('保存失败: ', 'Save failed: ') + msg, A.red))
    return { configured: false }
  }

  // ─────────────────────────────────────────────────────────────────
  //  Phase 3.5: Bundle polisher (only when dual-model is configured)
  // ─────────────────────────────────────────────────────────────────
  if (secondary) {
    sectionHeader(
      t('▸ Bundle 润色增强（可选）', '▸ Bundle polisher (optional)'),
      t('提示词自动改写', 'Auto-rewrite prompts'),
      t('配了副模型就能用它做提示词润色，长输入时弹"原版 vs 增强版"对比',
        'With the secondary model set up, Bundle can rewrite prompts and show original-vs-enhanced on long input'),
    )
    const settingsStoreForBundle = new CliSettingsStore(cwd ?? HOME_DIR)
    const { runBundleOnboarding } = await import('./bundleOnboarding.js')
    await runBundleOnboarding({
      locale,
      settingsStore: settingsStoreForBundle,
      printPanel: (title, lines) => {
        console.log()
        console.log(c('  ' + title, A.cyan + A.bold))
        for (const line of lines) console.log(c('    ' + line, A.dim))
        console.log()
      },
    }).catch(() => { /* non-fatal */ })
  }

  // ─────────────────────────────────────────────────────────────────
  //  Phase 3.6: Docs search engine picker (quick, one-question)
  // ─────────────────────────────────────────────────────────────────
  try {
    sectionHeader(
      t('▸ 文档搜索引擎', '▸ Docs search engine'),
      t('选择 lookup_docs 工具用的引擎', 'Choose the engine for lookup_docs'),
      t('bing 免 key 可用；google 需要 GOOGLE_CSE_ID + GOOGLE_API_KEY',
        'bing works out of the box; google needs GOOGLE_CSE_ID + GOOGLE_API_KEY'),
    )
    const picked = await chooseInteractiveOption<'bing' | 'google' | '__skip__'>({
      title: t('用哪个搜索引擎？', 'Which search engine?'),
      hint:  t('↑ ↓ 选择   Enter 确认   Esc 默认 bing',
               '↑ ↓ select   Enter confirm   Esc default bing'),
      escapeValue: '__skip__',
      initialIndex: 0,
      choices: [
        { label: 'Bing',   value: 'bing',   description: t('默认，免 API key', 'Default, no API key') },
        { label: 'Google', value: 'google', description: t('质量更高但需环境变量', 'Higher quality, needs env vars') },
      ],
    })
    const engine: 'bing' | 'google' = picked === '__skip__' ? 'bing' : picked
    const settingsStoreForDocs = new CliSettingsStore(cwd ?? HOME_DIR)
    await settingsStoreForDocs.setDocsSearchEngine(engine).catch(() => {})
    console.log(c(`  ✓ ${t('搜索引擎', 'Search engine')}: ${engine}`, A.green))
    console.log()
  } catch { /* non-fatal */ }

  // ─────────────────────────────────────────────────────────────────
  //  Phase 4: Summary HUD
  // ─────────────────────────────────────────────────────────────────
  renderOnboardingSummary(t, primary, secondary, visualProfile, configuredBridges)

  // Brief pause so the user can read the summary, then show a clear
  // launch indicator before the screen transitions to the REPL splash.
  await new Promise(r => setTimeout(r, 350))
  process.stdout.write(c('  ' + t('▸ 正在启动 Artemis...', '▸ Launching Artemis...'), A.cyan + A.bold))
  await new Promise(r => setTimeout(r, 400))
  process.stdout.write('\r' + c('  ✓ ' + t('准备就绪，加载对话界面...', 'Ready — loading chat interface...'), A.green))
  await new Promise(r => setTimeout(r, 300))
  process.stdout.write('\n')
  return { configured: true, apiKey: primary.apiKey, model: primary.model }
}
