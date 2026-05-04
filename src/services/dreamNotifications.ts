import { existsSync } from 'node:fs'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { broadcastToBridges } from './bridgeNotifier.js'
import type { ComposeDreamResult } from './dreamComposer.js'
import { getDreamsRoot, type DreamEntry } from './dreamStore.js'
import type { UiLocale } from '../cli/locale.js'

export const DREAM_SYSTEM_NAME = '梦境系统'

export const FIRST_DREAM_ZH = [
  '你：欢迎来到这场奇幻之旅。',
  'Artemis：我正在努力拼凑记忆碎片，让它们慢慢形成梦境。',
].join('\n')

export const FIRST_DREAM_EN = [
  'You: Welcome to this fantastical journey.',
  'Artemis: I am carefully piecing together fragments of memory, letting them slowly become a dream.',
].join('\n')

const FIRST_DREAM_MARKER_FILE = path.join(getDreamsRoot(), 'first-dream-shown.json')

async function shouldShowFirstDream(): Promise<boolean> {
  if (existsSync(FIRST_DREAM_MARKER_FILE)) return false
  await mkdir(getDreamsRoot(), { recursive: true })
  await writeFile(FIRST_DREAM_MARKER_FILE, JSON.stringify({ shownAt: new Date().toISOString() }, null, 2), 'utf8')
  return true
}

export async function notifyDreamSystemStartup(latest?: DreamEntry | null, locale: UiLocale = 'en'): Promise<number> {
  let text: string
  if (latest) {
    text = [
        `上一枚梦的种子：${latest.preview}`,
        `我的日记：${latest.mdPath}`,
        ...(latest.imagePath ? [`梦境画面：${latest.imagePath}`] : []),
      ].join('\n')
  } else if (await shouldShowFirstDream()) {
    text = locale === 'zh-CN'
      ? [
          '🌙 Artemis 初梦',
          '',
          FIRST_DREAM_ZH,
          '',
          '梦境系统已经醒来。此后它会把对话的回声、工具的脚印和代码森林里的微光，沉淀成新的梦。',
        ].join('\n')
      : [
          '🌙 Artemis First Dream',
          '',
          FIRST_DREAM_EN,
          '',
          'The dream system has awakened. From now on, it will settle the echoes of conversations, the footprints of tools, and the glimmers in the code forest into new dreams.',
        ].join('\n')
  } else {
    text = [
      '🌙 梦境系统已醒来。',
      '',
      '初梦已经点亮过一次；现在这里不再重复旧的月光。',
      '等用户自己的梦境生成后，主界面会显示最近一枚梦的片段、卷轴与画面路径。',
    ].join('\n')
  }

  const result = await broadcastToBridges({ text, source: 'dream-system-startup' })
  return result.sent
}

export async function notifyDreamStarted(trigger: DreamEntry['trigger']): Promise<number> {
  const triggerText = trigger === 'idle-auto'
    ? '空闲的门槛已经亮起'
    : trigger === 'scheduled'
      ? '约定的钟声已经响起'
      : '手动点燃的梦火已经升起'
  const text = [
    '🌙 梦境系统开始做梦。',
    '',
    `${triggerText}，Artemis 正在收集今日散落的信息素：对话的回声、工具的脚印、代码森林里的微光。`,
    '它们会被记录、蒸馏，并编织成一枚新的梦境。',
  ].join('\n')

  const result = await broadcastToBridges({ text, source: 'dream-started' })
  return result.sent
}

export async function notifyDreamFinished(result: ComposeDreamResult): Promise<number> {
  const text = result.ok && result.entry
    ? [
        '✨ 梦境系统做梦结束。',
        '',
        '新的梦已经落进卷轴，信息素完成了一次柔软的结晶。',
        `梦境片段：${result.entry.preview}`,
        `我的日记：${result.entry.mdPath}`,
        ...(result.entry.imagePath ? [`梦境画面：${result.entry.imagePath}`] : []),
      ].join('\n')
    : [
        '🌘 梦境系统做梦结束。',
        '',
        `这一次梦雾没有凝成完整卷轴：${result.reason ?? '未知原因'}`,
      ].join('\n')

  const broadcast = await broadcastToBridges({
    text,
    imagePath: result.ok ? result.entry?.imagePath : undefined,
    source: 'dream-finished',
  })
  return broadcast.sent
}
