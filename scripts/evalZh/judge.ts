/**
 * scripts/evalZh/judge.ts — the optional LLM-judge rubric for open-ended
 * writing (live mode only). A Chinese rubric, a 1–5 score with reasons.
 */

export const JUDGE_SYSTEM = '你是一名严格、公正的中文写作评审。你只根据评分标准打分，只输出一个 JSON 对象，不输出其他内容。'

export function buildJudgePrompt(request: string, reply: string, rubric: string): string {
  return [
    '请评估下面这次 AI 助手的回复。',
    '',
    '【用户的请求】',
    request,
    '',
    '【助手的回复】',
    reply,
    '',
    '【评分标准】',
    rubric,
    '',
    '打分规则：1 分 = 完全不符合要求；2 分 = 有明显缺陷；3 分 = 基本可用但需要修改；4 分 = 良好，只有小问题；5 分 = 优秀，可直接使用。',
    '只输出如下格式的 JSON：{"score": <1-5 的整数>, "reasons": "<两三句中文理由，指出主要优点和不足>"}',
  ].join('\n')
}

/** Parse the judge's answer; a score outside 1–5 or an unreadable reply is an error. */
export function parseJudgeReply(text: string): { score: number; reasons: string } | { error: string } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { error: 'judge reply has no JSON object' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return { error: 'judge reply is not valid JSON' }
  }
  const record = parsed as { score?: unknown; reasons?: unknown }
  const score = typeof record.score === 'string' ? Number(record.score) : record.score
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
    return { error: `judge score out of range: ${JSON.stringify(record.score)}` }
  }
  return { score, reasons: typeof record.reasons === 'string' ? record.reasons : '' }
}
