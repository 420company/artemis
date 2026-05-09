import { existsSync } from 'node:fs'
import path from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { broadcastToBridges } from './bridgeNotifier.js'
import type { ComposeDreamResult } from './dreamComposer.js'
import { getDreamsRoot, type DreamEntry } from './dreamStore.js'
import type { UiLocale } from '../cli/locale.js'
import { DEFAULT_UI_LOCALE, pickLocale } from '../cli/locale.js'

export const DREAM_SYSTEM_NAME = 'Dream System'

export const FIRST_DREAM_ZH = 'Artemis 第一次进入梦境系统。请写一段轻盈、克制、带有初醒感的梦境，不要虚构用户已经说过的话。'

export const FIRST_DREAM_EN = 'Artemis is entering the dream system for the first time. Write a light, restrained dream with a sense of first awakening, without inventing anything the user has said.'

const FIRST_DREAM_MARKER_FILE = path.join(getDreamsRoot(), 'first-dream-shown.json')

function formatDreamPathField(label: string, filePath: string): string {
  return `${label}: ${formatDreamFileName(filePath)} ${filePath}`
}

function formatDreamPathFieldWithSep(label: string, sep: string, filePath: string): string {
  const normalizedSep = sep.endsWith(' ') ? sep : `${sep} `
  return `${label}${normalizedSep}${formatDreamFileName(filePath)} ${filePath}`
}

function formatDreamFileName(filePath: string): string {
  return path.basename(filePath).replace(/^\d{4}-\d{2}-\d{2}/, '')
}

function pickLocaleList(locale: UiLocale, values: { zh: string[]; en: string[] }): string[] {
  return locale === 'zh-CN' ? values.zh : values.en
}

async function shouldShowFirstDream(): Promise<boolean> {
  if (existsSync(FIRST_DREAM_MARKER_FILE)) return false
  await mkdir(getDreamsRoot(), { recursive: true })
  await writeFile(FIRST_DREAM_MARKER_FILE, JSON.stringify({ shownAt: new Date().toISOString() }, null, 2), 'utf8')
  return true
}

export async function notifyDreamSystemStartup(latest?: DreamEntry | null, locale: UiLocale = DEFAULT_UI_LOCALE): Promise<number> {
  let text: string
  if (latest) {
    text = [
        `${pickLocale(locale, { zh: '上一枚梦的种子', en: 'Previous dream seed' })}: ${latest.preview}`,
        formatDreamPathField(pickLocale(locale, { zh: '我的日记', en: 'My journal' }), latest.mdPath),
        ...(latest.imagePath ? [formatDreamPathField(pickLocale(locale, { zh: '梦境画面', en: 'Dream image' }), latest.imagePath)] : []),
      ].join('\n')
  } else {
    await shouldShowFirstDream().catch(() => false)
    return 0
  }

  const result = await broadcastToBridges({ text, imagePath: latest?.imagePath, source: 'dream-system-startup' })
  return result.sent
}

export async function notifyDreamStarted(trigger: DreamEntry['trigger'], locale: UiLocale = DEFAULT_UI_LOCALE): Promise<number> {
  const variants = trigger === 'idle-auto'
    ? pickLocaleList(locale, {
        zh: [
          '空闲的门槛微微发亮。Artemis 正在拾起对话、工具与代码留下的微光，把它们收进一枚安静的新梦。',
          '白日的噪声慢慢退去，工作区留下几处发光的脚印。Artemis 会把它们折成今晚的梦境卷轴。',
        ],
        en: [
          'The threshold of idleness is softly lit. Artemis is gathering the glimmers left by conversations, tools, and code into a quiet new dream.',
          'The noise of the day is receding, leaving a few luminous footprints in the workspace. Artemis will fold them into tonight\'s dream scroll.',
        ],
      })
    : trigger === 'scheduled'
      ? pickLocaleList(locale, {
          zh: [
            '今夜的月光已落到工作区。Artemis 正在收拢今日的回声，让它们沉入一枚新的梦。',
            '一枚安静的梦正在生成。今日散落的片段会被轻轻蒸馏，凝成 Artemis 的梦境笔记。',
          ],
          en: [
            'Tonight\'s moonlight has reached the workspace. Artemis is gathering the day\'s echoes and letting them sink into a new dream.',
            'A quiet dream is being made. The scattered fragments of today are being gently distilled into an Artemis dream note.',
          ],
        })
      : pickLocaleList(locale, {
          zh: [
            '手动点燃的梦火已经升起。Artemis 正在整理眼前的碎片，让它们沿着柔软的光线成形。',
            '梦的卷轴被你轻轻展开。Artemis 会把这一刻的回声织进去，留下一枚新的夜色标记。',
          ],
          en: [
            'The manually lit dream-fire has risen. Artemis is arranging the fragments at hand, letting them take shape along a soft line of light.',
            'You have gently opened the dream scroll. Artemis will weave the echoes of this moment into a small mark of night.',
          ],
        })
  const line = variants[Math.floor(Math.random() * variants.length)] ?? variants[0]
  const text = [
    pickLocale(locale, { zh: '🌙 梦境系统开始做梦。', en: '🌙 The dream system is starting to dream.' }),
    '',
    line,
  ].join('\n')

  const result = await broadcastToBridges({ text, source: 'dream-started' })
  return result.sent
}

export async function notifyDreamFinished(result: ComposeDreamResult, locale: UiLocale = DEFAULT_UI_LOCALE): Promise<number> {
  const sep = pickLocale(locale, { zh: '：', en: ': ' })
  const text = result.ok && result.entry
    ? [
        pickLocale(locale, {
          zh: '✨ 刚刚好像发生了一些奇怪的事情…',
          en: '✨ Something strange seems to have happened just now…',
        }),
        '',
        pickLocale(locale, {
          zh: '新的梦已经落进卷轴，信息素完成了一次柔软的结晶。',
          en: 'A new dream has fallen into the scroll; its faint signals have crystallized softly.',
        }),
        `${pickLocale(locale, { zh: '梦境片段', en: 'Dream fragment' })}${sep}${result.entry.preview}`,
        formatDreamPathFieldWithSep(pickLocale(locale, { zh: '我的日记', en: 'My journal' }), sep, result.entry.mdPath),
        ...(result.entry.imagePath ? [formatDreamPathFieldWithSep(pickLocale(locale, { zh: '梦境画面', en: 'Dream image' }), sep, result.entry.imagePath)] : []),
      ].join('\n')
    : [
        pickLocale(locale, {
          zh: '🌘 刚刚好像发生了一些奇怪的事情…',
          en: '🌘 Something strange seems to have happened just now…',
        }),
        '',
        pickLocale(locale, {
          zh: `这一次梦雾没有凝成完整卷轴：${result.reason ?? '未知原因'}`,
          en: `This time, the dream-fog did not form a complete scroll: ${result.reason ?? 'unknown reason'}`,
        }),
      ].join('\n')

  const broadcast = await broadcastToBridges({
    text,
    imagePath: result.ok ? result.entry?.imagePath : undefined,
    source: 'dream-finished',
  })
  return broadcast.sent
}
