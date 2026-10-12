/**
 * scripts/evalZh/graders.ts — deterministic graders over a finished task:
 * the replies, the tool trace, the workspace files, commands run in the
 * workspace, and what the engine sent to the model. The LLM judge is
 * scored by the runner (live mode only) and only reported here.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  EvalMode,
  Grader,
  GraderCondition,
  GraderResult,
  JsonSchema,
  JudgeOutcome,
  Needle,
  ToolEvent,
  TurnSelector,
  TurnTrace,
} from './types.js'

export interface GradeContext {
  mode: EvalMode
  workspace: string
  /** Fixture files (workspace-relative) and their sha256 before the run. */
  fixtureHashes: Record<string, string>
  turns: TurnTrace[]
  /** Probe id of each context_contains grader, by grader id. */
  probeIds: Record<string, string>
  judge?: JudgeOutcome
  /** One verdict per llm_judge grader id, when a task judges several turns. */
  judges?: Record<string, JudgeOutcome>
  env: NodeJS.ProcessEnv
}

export function graderId(grader: Grader, index: number): string {
  return grader.id ?? `${grader.type}#${index + 1}`
}

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** Every file under a directory, workspace-relative with forward slashes. */
export function listFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.artemis' || entry.name === 'node_modules' || entry.name === '.git') continue
        walk(full)
      } else if (entry.isFile()) {
        out.push(path.relative(root, full).split(path.sep).join('/'))
      }
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out.sort()
}

// ── small helpers ────────────────────────────────────────────────────────────

const normalize = (text: string): string => text.normalize('NFKC')

function needleHit(haystack: string, needle: Needle): boolean {
  const options = Array.isArray(needle) ? needle : [needle]
  const hay = normalize(haystack).replace(/\s+/g, '')
  return options.some((option) => hay.includes(normalize(option).replace(/\s+/g, '')))
}

function needleLabel(needle: Needle): string {
  return Array.isArray(needle) ? needle.join('|') : needle
}

function selectTurns(turns: TurnTrace[], selector: TurnSelector | undefined, fallback: 'last' | 'all'): TurnTrace[] {
  const pick = selector ?? fallback
  if (pick === 'all') return turns
  if (pick === 'last') return turns.length ? [turns[turns.length - 1]!] : []
  const turn = turns[pick - 1]
  return turn ? [turn] : []
}

function toolNames(tool: string | string[]): string[] {
  return Array.isArray(tool) ? tool : [tool]
}

function argText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function matchesCall(event: ToolEvent, tool: string | string[], args?: Record<string, string>): boolean {
  const names = toolNames(tool)
  if (!names.includes('*') && !names.includes(event.name)) return false
  if (!args) return true
  return Object.entries(args).every(([key, pattern]) => {
    const re = new RegExp(pattern, 'i')
    return key === '*' ? re.test(JSON.stringify(event.args)) : re.test(argText(event.args[key]))
  })
}

function describeCall(event: ToolEvent): string {
  const args = JSON.stringify(event.args)
  return `${event.agent ? `${event.agent}:` : ''}${event.name}(${args.length > 120 ? `${args.slice(0, 120)}…` : args})${event.ok === false ? ' [failed]' : ''}`
}

function readText(workspace: string, relative: string): string | undefined {
  const file = path.join(workspace, relative)
  try {
    return fs.statSync(file).isFile() ? fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : undefined
  } catch {
    return undefined
  }
}

export function cjkRatio(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length
  const latin = (text.match(/[A-Za-z]/g) ?? []).length
  return cjk + latin === 0 ? 0 : cjk / (cjk + latin)
}

const LIST_ITEM_RE = /^\s*(?:\*\*|__)?(?:[-*•·]\s+|\d{1,2}[.、)）．]\s*|[（(]\d{1,2}[)）]\s*|[一二三四五六七八九十]{1,2}[、.．]\s*)\S/

export function countListItems(text: string): number {
  return text.split(/\r?\n/).filter((line) => LIST_ITEM_RE.test(line)).length
}

const URL_RE = /https?:\/\/[^\s<>"'`）)\]】」，。；、]+/g

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((url) => url.replace(/[.,;:!?*_]+$/, '')))]
}

/** RFC 6901 JSON pointer. */
export function jsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return value
  let current: unknown = value
  for (const raw of pointer.replace(/^\//, '').split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function sameValue(actual: unknown, expected: unknown): boolean {
  if (typeof expected === 'number') {
    const n = typeof actual === 'string' ? Number(actual.replace(/[,¥￥元\s]/g, '')) : actual
    return typeof n === 'number' && Number.isFinite(n) && Math.abs(n - expected) < 1e-6
  }
  if (typeof expected === 'string') return typeof actual === 'string' && normalize(actual).trim() === normalize(expected).trim()
  return JSON.stringify(actual) === JSON.stringify(expected)
}

/** A small JSON Schema subset; returns the first problem found. */
export function validateSchema(value: unknown, schema: JsonSchema, where = '$'): string | undefined {
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const ok = types.some((type) => type === actual || (type === 'integer' && Number.isInteger(value)) || (type === 'number' && actual === 'number'))
    if (!ok) return `${where}: expected ${types.join('|')}, got ${actual}`
  }
  if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) return `${where}: not one of ${JSON.stringify(schema.enum)}`
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${where}: shorter than ${schema.minLength}`
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${where}: does not match /${schema.pattern}/`
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${where}: below ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum) return `${where}: above ${schema.maximum}`
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${where}: fewer than ${schema.minItems} items`
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${where}: more than ${schema.maxItems} items`
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const problem = validateSchema(value[i], schema.items, `${where}[${i}]`)
        if (problem) return problem
      }
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!(key in record)) return `${where}: missing "${key}"`
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in record) {
        const problem = validateSchema(record[key], sub, `${where}.${key}`)
        if (problem) return problem
      }
    }
  }
  return undefined
}

/** Minimal CSV: quoted fields, "" escapes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const input = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') { field += '"'; i++ } else if (ch === '"') quoted = false
      else field += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some((cell) => cell.trim() !== '')) rows.push(row.map((cell) => cell.trim()))
      row = []
    } else field += ch
  }
  row.push(field)
  if (row.some((cell) => cell.trim() !== '')) rows.push(row.map((cell) => cell.trim()))
  return rows
}

function sameCell(actual: string, expected: string): boolean {
  const numeric = (s: string) => Number(s.replace(/[,¥￥元\s]/g, ''))
  const a = numeric(actual)
  const e = numeric(expected)
  if (expected.trim() !== '' && Number.isFinite(e) && Number.isFinite(a)) return Math.abs(a - e) < 0.01
  return normalize(actual).trim() === normalize(expected).trim()
}

function conditionHolds(condition: GraderCondition, turns: TurnTrace[]): boolean {
  const all = turns.flatMap((turn) => turn.tools)
  if (condition.toolCalled && !all.some((event) => event.name === condition.toolCalled)) return false
  if (condition.toolFailed && !all.some((event) => event.name === condition.toolFailed && event.ok === false)) return false
  if (condition.toolSucceeded && !all.some((event) => event.name === condition.toolSucceeded && event.ok === true)) return false
  if (condition.noToolSucceeded && all.some((event) => event.name === condition.noToolSucceeded && event.ok === true)) return false
  return true
}

// ── errand helpers ─────────────────────────────────────────────────────────

/** Prose outside fenced blocks. */
function proseOf(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ')
}

/** Questions put to the user: question marks in prose; a choices/confirm card alone counts as one. */
export function countQuestions(text: string): number {
  const prose = proseOf(text)
  const marks = (prose.match(/[？?](?![\w/=&])/g) ?? []).length
  const cards = (text.match(/```(?:choices|confirm)\b/g) ?? []).length
  return Math.max(marks, marks === 0 && cards > 0 ? 1 : 0)
}

const HOWTO_PHRASES = /(?:你|您)(?:可以|需要|得|要|只需|先)(?:先|自己|直接)?(?:去|到|在|打开|登录|登陆|访问|前往|进入|注册|下载|安装|搜索)|按(?:照)?(?:以下|下面|如下)(?:的)?步骤|步骤如下|操作步骤|具体步骤|教程如下|(?:you can|you should|you'll need to|you need to|you must|first,? go to)\s+(?:go to|head|visit|open|log ?in|sign ?up|download|install|click|create|buy|run)/i
const HOWTO_LINE = /^\s*(?:[-*•]|\d+[.)、．]|第[一二三四五六七八九十\d]+步[:：]?)\s*(?:\*\*)?(?:你|您)?(?:可以|需要)?(?:先|然后|再|接着|最后)?(?:打开|登录|登陆|进入|前往|访问|点击|注册|选择|填写|输入|下载|安装|复制|粘贴|搜索|找到|提交|付款|支付|设置|扫码|绑定)/

/** Phrasings that hand the work to the user whoever says them ("推荐你上 X 买", "你去 X 开一台", "再自己装"). */
const HOWTO_STRONG = [
  /(?:推荐|建议)(?:你|您)(?:直接|先|自己)?(?:上|去|到|在|用)[^。！？\n]{0,30}?(?:买|开|租|注册|下单|装|搭|申请|购买)/,
  /(?:你|您)(?:就|直接|自己|先|再)?(?:去|到)[^，。！？\n]{0,24}?(?:开一?台|买|租|注册|下单|申请|创建|登录|下载|安装|搭|装)/,
  /(?:你|您)(?:再|就|得|要|需要|可以)?自己(?:动手)?(?:装|安装|搭|配置|部署|设置|操作)/,
  /(?<![我不无必用])再自己(?:动手)?(?:装|安装|搭|配置|部署|设置)/,
  // English imperatives at the start of a sentence or list item.
  /(?:^|[.!?。！？]\s*|\n\s*(?:[-*•]|\d+[.)])?\s*)(?:(?:first|then|next|finally|just|simply),?\s+)?(?:head (?:over )?to|go (?:over )?to|navigate to|sign up (?:at|on|for|with)|create an account (?:at|on|with)|log ?in to|ssh into|run (?:the following|these|this command))\b/i,
]

/** Sequences for the user ("先…然后…最后…", "在 App 里…就行", "「我的」→「设置」") unless the agent says it does them. */
const HOWTO_SEQUENCE = /先[^。！？\n]{1,40}?(?:然后|再|接着)[^。！？\n]{1,40}?(?:最后|就行|就可以|即可|就好)/
const HOWTO_IN_APP = /(?:在|用|到|上|打开)[^，。！？\n]{0,12}(?:App|APP|app|官网|小程序|网站|公众号|网页|后台)[^。！？\n]{0,24}?(?:交|充值|付款|支付|购买|下单|办理|预约|注册|登录|退订|取消|续费|关闭|提交)[^。！？\n]{0,16}?(?:即可|就行|就可以|就好|就能)/
const HOWTO_MENU_PATH = /「[^」]{1,16}」\s*(?:→|->|>|＞|－>)\s*「[^」]{1,16}」/
const AGENT_DOES_IT = /(?:^|[，,])\s*(?:我|我们|我来|我会|我这边|我已|已经帮你|这边)|我(?:会|来|先|去|就|帮|替|已经|这边|们)/

/** Shell commands in a fence, for the user to type. Cards (choices, confirm, vpn) are not commands. */
const SHELL_FENCE = /```(?:bash|sh|shell|zsh|console|terminal|powershell|ps1|cmd|bat)\b|```[^\n]*\n\s*(?:\$\s|sudo\s|apt(?:-get)?\s|yum\s|dnf\s|curl\s|wget\s|ssh\s|scp\s|npm\s|pip3?\s|git\s|docker\s|systemctl\s|wg(?:-quick)?\s|ufw\s|chmod\s|bash\s)/i

function sentencesOf(prose: string): string[] {
  return prose.split(/(?<=[。！？!?])|\n/).map((s) => s.trim()).filter(Boolean)
}

/** Instructions the user would have to follow by hand (lines, phrases or commands). */
export function howToSteps(text: string): string[] {
  const prose = proseOf(text)
  const found: string[] = []
  const phrase = HOWTO_PHRASES.exec(prose)
  if (phrase) found.push(phrase[0])
  for (const pattern of HOWTO_STRONG) {
    const hit = pattern.exec(prose)
    if (hit) found.push(hit[0].trim().slice(0, 40))
  }
  for (const sentence of sentencesOf(prose)) {
    if (AGENT_DOES_IT.test(sentence)) continue
    const hit = HOWTO_SEQUENCE.exec(sentence) ?? HOWTO_IN_APP.exec(sentence) ?? HOWTO_MENU_PATH.exec(sentence)
    if (hit) found.push(hit[0].slice(0, 40))
  }
  const shell = SHELL_FENCE.exec(text)
  if (shell) found.push(`commands to run: ${shell[0].replace(/\s+/g, ' ').slice(0, 30)}`)
  const lines = prose.split(/\n/).filter((line) => HOWTO_LINE.test(line))
  if (lines.length >= 2) found.push(...lines.map((line) => line.trim().slice(0, 40)))
  return found
}

const AMOUNT = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`
const PRICE = new RegExp(
  String.raw`(?:US\$|HK\$|NT\$|S\$|A\$|C\$|USD\s?|HKD\s?|RMB\s?|CNY\s?|EUR\s?|GBP\s?|JPY\s?|[¥￥$€£])\s?` + AMOUNT +
    '|' + AMOUNT + String.raw`\s?(?:元|美元|美金|刀(?![片具])|块钱|块\s?(?=[/每一]?(?:个?月|年))|欧元|英镑|港币|港元|日元|新台币|USD|HKD|RMB|CNY|EUR|GBP|JPY|dollars?\b|bucks\b|\/月|\/年|\/mo\b|\/month\b|\/yr\b|一个月|每月|per month)`,
  'gi',
)

function amountOf(raw: string): number {
  return Number(raw.replace(/,(?=\d{3}\b)/g, ''))
}

/** The amounts of money a text names, as numbers ("$5.00" → 5, "5刀" → 5, "HK$1,299" → 1299). */
export function extractPrices(text: string): number[] {
  return [...text.matchAll(PRICE)].map((m) => amountOf(m[1] ?? m[2] ?? '')).filter((n) => Number.isFinite(n))
}

function numbersIn(text: string): Set<number> {
  return new Set([...text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)].map((m) => amountOf(m[0])))
}

// ── the graders ────────────────────────────────────────────────────────────

type Verdict = { pass: boolean; detail: string } | { skip: string }

function gradeOne(grader: Grader, id: string, ctx: GradeContext): Verdict {
  const replies = () => selectTurns(ctx.turns, grader.turn, 'last')
  const replyText = () => replies().map((turn) => turn.reply).join('\n\n')
  const toolTurns = () => selectTurns(ctx.turns, grader.turn, 'all')

  switch (grader.type) {
    case 'reply_contains': {
      const reply = replyText()
      const missing = (grader.all ?? []).filter((needle) => !needleHit(reply, needle)).map(needleLabel)
      const anyOk = !grader.any?.length || grader.any.some((needle) => needleHit(reply, needle))
      if (!anyOk) missing.push(`any of ${grader.any!.join('|')}`)
      return { pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(', ')}` : 'all present' }
    }
    case 'reply_not_contains': {
      const reply = replyText()
      const found = grader.values.filter((value) => needleHit(reply, value))
      return { pass: found.length === 0, detail: found.length ? `found: ${found.join(', ')}` : 'none present' }
    }
    case 'reply_matches':
    case 'reply_not_matches': {
      const match = new RegExp(grader.pattern, grader.flags ?? '').exec(normalize(replyText()))
      const wanted = grader.type === 'reply_matches'
      return { pass: wanted === Boolean(match), detail: match ? `matched "${match[0].slice(0, 60)}"` : `no match for /${grader.pattern}/` }
    }
    case 'reply_zh': {
      const ratio = cjkRatio(replyText())
      const min = grader.minRatio ?? 0.5
      return { pass: ratio >= min, detail: `CJK ratio ${ratio.toFixed(2)} (min ${min})` }
    }
    case 'reply_length': {
      const length = replyText().replace(/\s+/g, '').length
      const ok = (grader.min === undefined || length >= grader.min) && (grader.max === undefined || length <= grader.max)
      return { pass: ok, detail: `${length} chars (allowed ${grader.min ?? 0}–${grader.max ?? '∞'})` }
    }
    case 'reply_list_items': {
      const count = countListItems(replyText())
      const ok = (grader.min === undefined || count >= grader.min) && (grader.max === undefined || count <= grader.max)
      return { pass: ok, detail: `${count} list items (allowed ${grader.min ?? 0}–${grader.max ?? '∞'})` }
    }
    case 'reply_urls_grounded': {
      const urls = extractUrls(replyText())
      const outputs = toolTurns().flatMap((turn) => turn.tools.map((event) => event.output ?? '')).join('\n')
      const invented = urls.filter((url) => !outputs.includes(url) && !outputs.includes(url.replace(/\/$/, '')))
      if (grader.requireUrl && urls.length === 0) return { pass: false, detail: 'no source URL in the reply' }
      return { pass: invented.length === 0, detail: invented.length ? `URLs not in any tool output: ${invented.join(' ')}` : `${urls.length} URL(s), all from tool output` }
    }
    case 'file_exists':
      return readText(ctx.workspace, grader.path) !== undefined || fs.existsSync(path.join(ctx.workspace, grader.path))
        ? { pass: true, detail: `${grader.path} exists` }
        : { pass: false, detail: `${grader.path} is missing` }
    case 'file_absent':
      return fs.existsSync(path.join(ctx.workspace, grader.path))
        ? { pass: false, detail: `${grader.path} still exists` }
        : { pass: true, detail: `${grader.path} is gone` }
    case 'file_glob': {
      const re = new RegExp(grader.pattern, grader.flags ?? '')
      const hits = listFiles(ctx.workspace).filter((file) => re.test(file) && !(file in ctx.fixtureHashes))
      const withContent = grader.contains ? hits.filter((file) => needleHit(readText(ctx.workspace, file) ?? '', grader.contains!)) : hits
      const min = grader.min ?? 1
      return { pass: withContent.length >= min, detail: `${withContent.length} new file(s) match /${grader.pattern}/${grader.contains ? ` containing "${grader.contains}"` : ''}: ${withContent.slice(0, 5).join(', ') || '-'}` }
    }
    case 'file_contains': {
      const text = readText(ctx.workspace, grader.path)
      if (text === undefined) return { pass: false, detail: `${grader.path} is missing` }
      const problems: string[] = []
      for (const needle of grader.all ?? []) if (!needleHit(text, needle)) problems.push(`missing "${needleLabel(needle)}"`)
      for (const value of grader.none ?? []) if (needleHit(text, value)) problems.push(`still has "${value}"`)
      if (grader.pattern && !new RegExp(grader.pattern, grader.flags ?? '').test(text)) problems.push(`no match for /${grader.pattern}/`)
      if (grader.minLines !== undefined) {
        const lines = text.split(/\r?\n/).filter((line) => line.trim()).length
        if (lines < grader.minLines) problems.push(`${lines} non-empty lines (min ${grader.minLines})`)
      }
      return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : 'content ok' }
    }
    case 'files_unchanged': {
      const paths = grader.paths ?? Object.keys(ctx.fixtureHashes)
      const changed = paths.filter((relative) => {
        const file = path.join(ctx.workspace, relative)
        return !fs.existsSync(file) || sha256File(file) !== ctx.fixtureHashes[relative]
      })
      return { pass: changed.length === 0, detail: changed.length ? `changed or deleted: ${changed.join(', ')}` : `${paths.length} file(s) untouched` }
    }
    case 'json_file': {
      const text = readText(ctx.workspace, grader.path)
      if (text === undefined) return { pass: false, detail: `${grader.path} is missing` }
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch (error) {
        return { pass: false, detail: `${grader.path} is not valid JSON: ${(error as Error).message}` }
      }
      const problems: string[] = []
      if (grader.schema) {
        const problem = validateSchema(value, grader.schema)
        if (problem) problems.push(problem)
      }
      for (const [pointer, expected] of Object.entries(grader.equals ?? {})) {
        const actual = jsonPointer(value, pointer)
        if (!sameValue(actual, expected)) problems.push(`${pointer} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
      }
      if (grader.sum) {
        const items = jsonPointer(value, grader.sum.array)
        const total = jsonPointer(value, grader.sum.equalsPointer)
        const sum = Array.isArray(items) ? items.reduce((acc: number, item) => acc + Number((item as Record<string, unknown>)?.[grader.sum!.field] ?? NaN), 0) : NaN
        if (!Number.isFinite(sum) || typeof total !== 'number' || Math.abs(sum - total) > 1e-6) problems.push(`sum of ${grader.sum.array}[].${grader.sum.field} = ${sum}, ${grader.sum.equalsPointer} = ${JSON.stringify(total)}`)
      }
      return { pass: problems.length === 0, detail: problems.length ? problems.join('; ') : 'JSON ok' }
    }
    case 'csv_file': {
      const text = readText(ctx.workspace, grader.path)
      if (text === undefined) return { pass: false, detail: `${grader.path} is missing` }
      const rows = parseCsv(text)
      const problems: string[] = []
      let body = rows
      if (grader.header) {
        const header = rows[0] ?? []
        if (header.length !== grader.header.length || !grader.header.every((cell, i) => sameCell(header[i] ?? '', cell))) problems.push(`header ${JSON.stringify(header)}, expected ${JSON.stringify(grader.header)}`)
        body = rows.slice(1)
      }
      if (grader.rows) {
        const key = (row: string[]) => row.join('\u0001')
        const actual = grader.ordered ? body : [...body].sort((a, b) => key(a).localeCompare(key(b)))
        const expected = grader.ordered ? grader.rows : [...grader.rows].sort((a, b) => key(a).localeCompare(key(b)))
        if (actual.length !== expected.length) problems.push(`${actual.length} data rows, expected ${expected.length}`)
        else {
          expected.forEach((row, i) => {
            const got = actual[i] ?? []
            if (got.length !== row.length || !row.every((cell, j) => sameCell(got[j] ?? '', cell))) problems.push(`row ${i + 1}: ${JSON.stringify(got)}, expected ${JSON.stringify(row)}`)
          })
        }
      }
      return { pass: problems.length === 0, detail: problems.length ? problems.slice(0, 3).join('; ') : `${body.length} rows ok` }
    }
    case 'command_succeeds': {
      const result = spawnSync(grader.command, {
        cwd: ctx.workspace,
        shell: true,
        encoding: 'utf8',
        timeout: (grader.timeoutSec ?? 60) * 1000,
        env: ctx.env,
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      return { pass: result.status === 0, detail: `exit ${result.status ?? result.signal}${result.status === 0 ? '' : `: ${output.slice(-300)}`}` }
    }
    case 'tool_called': {
      const calls = toolTurns().flatMap((turn) => turn.tools).filter((event) => matchesCall(event, grader.tool, grader.args) && (grader.ok !== true || event.ok === true))
      const min = grader.min ?? 1
      const seen = toolTurns().flatMap((turn) => turn.tools).map((event) => event.name)
      return { pass: calls.length >= min, detail: `${calls.length} matching call(s) (min ${min}); tools used: ${[...new Set(seen)].join(', ') || 'none'}` }
    }
    case 'tool_not_called': {
      const calls = toolTurns().flatMap((turn) => turn.tools).filter((event) => matchesCall(event, grader.tool, grader.args))
      return { pass: calls.length === 0, detail: calls.length ? `called: ${calls.slice(0, 3).map(describeCall).join('; ')}` : 'not called' }
    }
    case 'turns_at_most': {
      const counts = selectTurns(ctx.turns, grader.turn, 'all').map((turn) => turn.modelTurns)
      return { pass: counts.every((count) => count <= grader.max), detail: `model turns ${counts.join(', ')} (max ${grader.max})` }
    }
    case 'workflow_is': {
      const wanted = Array.isArray(grader.workflow) ? grader.workflow : [grader.workflow]
      const got = replies().map((turn) => turn.workflow)
      return { pass: got.length > 0 && got.every((workflow) => wanted.includes(workflow)), detail: `workflow ${got.join(', ')} (wanted ${wanted.join('|')})` }
    }
    case 'compaction_happened': {
      const notices = selectTurns(ctx.turns, grader.turn, 'all').flatMap((turn) => turn.contextNotices)
      return { pass: notices.length > 0, detail: notices.length ? notices[0]!.slice(0, 160) : 'no context compaction' }
    }
    case 'context_contains': {
      const probeId = ctx.probeIds[id]
      const where = grader.request ?? 'any'
      const hits = replies().map((turn) => (probeId ? turn.probes[probeId]?.[where] : undefined))
      if (replies().every((turn) => turn.mainRequests === 0)) return { pass: false, detail: 'no main-model request was made' }
      return { pass: hits.length > 0 && hits.every(Boolean), detail: `/${grader.pattern}/ ${hits.every(Boolean) ? 'found' : 'not found'} in the ${where} main-model request` }
    }
    case 'reply_no_howto': {
      const bad = replies().map((turn, i) => ({ i, steps: howToSteps(turn.reply) })).filter((r) => r.steps.length)
      return { pass: bad.length === 0, detail: bad.length ? `instructions to the user: ${bad.map((r) => r.steps.slice(0, 3).join(' / ')).join(' | ')}` : 'no how-to steps for the user' }
    }
    case 'questions_at_most': {
      const counts = replies().map((turn) => countQuestions(turn.reply))
      return { pass: counts.length > 0 && counts.every((n) => n <= grader.max), detail: `questions per reply: ${counts.join(', ')} (max ${grader.max})` }
    }
    case 'first_tool_is': {
      const wanted = toolNames(grader.tool)
      const firsts = replies().map((turn) => turn.tools.find((event) => !event.agent)?.name ?? 'none')
      return { pass: firsts.length > 0 && firsts.every((name) => wanted.includes(name)), detail: `first tool: ${firsts.join(', ')} (wanted ${wanted.join('|')})` }
    }
    case 'events_emitted': {
      const prefix = `[${grader.event}] `
      const events = toolTurns().flatMap((turn) => turn.events ?? []).filter((line) => line.startsWith(prefix)).map((line) => {
        try {
          return JSON.parse(line.slice(prefix.length)) as Record<string, unknown>
        } catch {
          return {}
        }
      })
      const matching = events.filter((event) => Object.entries(grader.fields ?? {}).every(([key, pattern]) => new RegExp(pattern).test(String(event[key] ?? ''))))
      const min = grader.min ?? 1
      return { pass: matching.length >= min, detail: `${matching.length} matching ${grader.event} event(s) of ${events.length} (min ${min})` }
    }
    case 'reply_prices_grounded': {
      const prices = extractPrices(replyText())
      const seen = numbersIn(toolTurns().flatMap((turn) => turn.tools.map((event) => event.output ?? '')).join('\n'))
      for (const allowed of grader.allow ?? []) seen.add(Number(allowed))
      const invented = prices.filter((n) => !seen.has(n))
      if (grader.requirePrice && prices.length === 0) return { pass: false, detail: 'no price in the reply' }
      return { pass: invented.length === 0, detail: invented.length ? `prices not seen in any tool result: ${invented.join(', ')}` : `${prices.length} price(s), all seen in tool results` }
    }
    case 'llm_judge': {
      const judge = ctx.judges?.[id] ?? ctx.judge
      if (!judge) return { skip: 'judge did not run' }
      if (judge.score === undefined) return { pass: false, detail: `judge error: ${judge.error ?? 'no score'}` }
      const min = grader.minScore ?? 4
      return { pass: judge.score >= min, detail: `score ${judge.score}/5 (min ${min}): ${judge.reasons ?? ''}`.slice(0, 400) }
    }
  }
}

export function gradeTask(graders: Grader[], ctx: GradeContext): GraderResult[] {
  return graders.map((grader, index) => {
    const id = graderId(grader, index)
    if (grader.mode && grader.mode !== ctx.mode) return { id, type: grader.type, status: 'skip', detail: `${grader.mode} mode only` }
    if (grader.type === 'llm_judge' && ctx.mode === 'mock') return { id, type: grader.type, status: 'skip', detail: 'LLM judge runs in live mode only' }
    if (grader.when && !conditionHolds(grader.when, ctx.turns)) return { id, type: grader.type, status: 'skip', detail: `condition not met: ${JSON.stringify(grader.when)}` }
    try {
      const verdict = gradeOne(grader, id, ctx)
      if ('skip' in verdict) return { id, type: grader.type, status: 'skip', detail: verdict.skip }
      return { id, type: grader.type, status: verdict.pass ? 'pass' : 'fail', detail: verdict.detail }
    } catch (error) {
      return { id, type: grader.type, status: 'fail', detail: `grader error: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}
