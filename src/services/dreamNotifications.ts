import { broadcastToBridges } from './bridgeNotifier.js'
import type { ComposeDreamResult } from './dreamComposer.js'
import type { DreamEntry } from './dreamStore.js'

export const DREAM_SYSTEM_NAME = '梦境系统'

export async function notifyDreamSystemStartup(latest?: DreamEntry | null): Promise<number> {
  const text = latest
    ? [
        '🌙 奇幻梦境已启动。',
        '',
        '梦境系统已经醒来，细小的信息素会被收集、沉淀，并在空闲时编织成新的梦境。',
        `上一枚梦的种子：${latest.preview}`,
        `梦境卷轴：${latest.mdPath}`,
        ...(latest.imagePath ? [`梦境画面：${latest.imagePath}`] : []),
      ].join('\n')
    : [
        '🌙 奇幻梦境已启动。',
        '',
        '梦境系统已经醒来，系统将收集产生的信息素记录，等风安静时编织成为新的梦境。',
        '目前还没有旧梦，第一枚梦的种子正在等待夜色或空闲时刻。',
      ].join('\n')

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
        `梦境卷轴：${result.entry.mdPath}`,
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
