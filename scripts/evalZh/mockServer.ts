/**
 * scripts/evalZh/mockServer.ts — a deterministic OpenAI-compatible model for
 * mock mode. Requests with tools attached are the agent's own turns and get
 * the task's scripted responses in order; requests without tools are helper
 * calls (context summarizer, skill/memory curators, judge) and get the first
 * matching aux reply. Runs in the worker process, on 127.0.0.1 only.
 */

import * as http from 'node:http'
import type { MockAuxReply, MockStep } from './types.js'

/** Default helper replies, after the task's own aux entries. */
const DEFAULT_AUX: MockAuxReply[] = [
  { match: 'distil reusable procedures', reply: '{"op":"skip"}' },
  {
    match: 'summar|摘要|压缩|compact',
    reply: '<summary>（模拟摘要）用户与助手此前讨论了若干日常问题，助手逐一给出了建议；没有尚未完成的任务。</summary>',
  },
]

/** Rough token count for the mock usage numbers (CJK ~1 token per char, other text ~4 chars per token). */
function estimateTokens(text: string): number {
  let cjk = 0
  for (const ch of text) if (/[㐀-鿿]/.test(ch)) cjk++
  return cjk + Math.ceil((text.length - cjk) / 4)
}

function messageText(message: unknown): string {
  const content = (message as { content?: unknown })?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : String((part as { text?: unknown })?.text ?? ''))).join('\n')
  }
  return ''
}

export interface MockServerHandle {
  baseUrl: string
  /** Scripted steps consumed so far. */
  stepsUsed(): number
  close(): Promise<void>
}

export async function startMockServer(steps: MockStep[], aux: MockAuxReply[]): Promise<MockServerHandle> {
  let next = 0
  let callCounter = 0
  const auxRules = [...aux, ...DEFAULT_AUX].map((rule) => ({ re: new RegExp(rule.match, 'i'), reply: rule.reply }))

  const respond = (body: Record<string, any>): Record<string, unknown> => {
    const messages: unknown[] = Array.isArray(body.messages) ? body.messages : []
    const promptTokens = estimateTokens(JSON.stringify(messages)) + (Array.isArray(body.tools) ? estimateTokens(JSON.stringify(body.tools)) : 0)
    const isMain = Array.isArray(body.tools) && body.tools.length > 0
    let message: Record<string, unknown>
    if (isMain) {
      // Past the script: repeat the last text (an engine reminder asked again), never its tools.
      const step: MockStep = next < steps.length ? steps[next]! : { say: [...steps].reverse().find((s) => s.say)?.say ?? '完成。' }
      next++
      message = {
        role: 'assistant',
        content: step.say ?? '',
        ...(step.tools?.length
          ? {
            tool_calls: step.tools.map((call) => ({
              id: `call_${++callCounter}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            })),
          }
          : {}),
      }
    } else {
      const text = messages.map(messageText).join('\n')
      const rule = auxRules.find((candidate) => candidate.re.test(text))
      message = { role: 'assistant', content: rule ? rule.reply : '{}' }
    }
    const completionTokens = estimateTokens(JSON.stringify(message))
    return {
      id: `mock-${Date.now()}`,
      object: 'chat.completion',
      model: 'eval-mock',
      choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    }
  }

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (part: Buffer) => chunks.push(part))
    req.on('end', () => {
      let body: Record<string, any> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* empty body */ }
      if (!/chat\/completions/.test(req.url ?? '')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `mock: unsupported endpoint ${req.url}` } }))
        return
      }
      // A JSON body even for stream:true; the provider falls back to it.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(respond(body)))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stepsUsed: () => next,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
