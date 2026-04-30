/* eslint-disable @typescript-eslint/no-unused-vars */
import type { SessionRecord } from './types.js'
import { summarizeOnce } from '../brain.js'
import { MemoryStore } from '../storage/memoryStore.js'
import { getMemoryProfile, MemoryEnhancementFactory } from './memoryEnhancement.js'

/**
 * Background routine that compresses a terminated session into permanent insights.
 * Functionally similar to Hermes's trajectory compressor to extract user intent
 * and build a deeper AI understanding over time.
 */
export async function compressTrajectory(
  cwd: string,
  session: SessionRecord,
  finalReply: string
): Promise<void> {
  try {
    // 1. Gather trajectory
    const msgs = session.messages.filter(m => m.role === 'user' || m.role === 'assistant')
    if (msgs.length <= 1) return // Too short to have meaningful trajectory habits

    const transcript = msgs
      .map(m => `[${m.role.toUpperCase()}]: ${m.content || '<multi-modal action>'}`)
      .join('\n')

    // 2. Instruct the Specialist model to extract permanent rules
    const prompt = `\
你是一个“人类习惯抽象提取器 (Trajectory Compressor)”。请阅读以下对话轨迹，提取出该用户强烈的代码偏好、特殊的工程架构要求或特定的工具习惯。
如果本次对话只是一般性问答没有显露出个人偏好习惯，则直接输出空数组 []。
提炼的规则必须具有“跨项目、长期的复用价值”。

请输出一个严格的 JSON 数组结构：
[
  {
    "content": "具体的规则描述，比如: 用户要求写CSS必须用 Vanilla CSS，拒绝使用 Tailwind",
    "category": "preference" // 
  }
]

对话轨迹：
\`\`\`
${transcript.slice(-24000)}
\`\`\``

    // 3. Extract JSON payload via the cheap pipeline
    const rawExtraction = await summarizeOnce(prompt)
    
    // Look for JSON array block natively. We do basic sanitization since different providers quote differently.
    const match = rawExtraction.match(/\[\s*\{[\s\S]*\}\s*\]/m)
    if (!match) return

    const parsedData = JSON.parse(match[0]) as { content?: string, category?: string }[]
    
    const validInsights = parsedData
      .filter((item): item is { content: string, category: 'preference' | 'skill' | 'architecture' } => {
        return typeof item.content === 'string' &&
               ['preference', 'skill', 'architecture'].includes(item.category as string)
      })

    if (validInsights.length === 0) return

    // 4. Flush to Global Memory Store
    const store = new MemoryStore(cwd)
    await store.addInsights(validInsights)

    const profile = await getMemoryProfile(cwd)
    if (profile.enabled) {
      const memory = await MemoryEnhancementFactory.create(profile, cwd)
      await memory.initialize()
      for (const insight of validInsights) {
        await memory.addMemory(insight.content, {
          category: insight.category,
          source: 'trajectory-compressor',
        })
      }
    }

  } catch (err) {
    // We swallow errors because Trajectory Compression is a passive background routine 
    // and should never panic or crash the active user terminal.
    // console.error('[Memory Loop Suppressed Error]:', err)
  }
}
