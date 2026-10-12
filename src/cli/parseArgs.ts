import path from 'node:path'
import { DEFAULT_AGENT_MAX_TURNS, MAX_AGENT_MAX_TURNS, WHOSYOURDADDY_FLAG, WHOSYOURDADDY_MIN_TURNS, getBrandingAttribution, getBrandingHeading } from './branding.js'
import { pickLocale } from './locale.js'
import type { UiLocale } from './locale.js'
import {
  isPermissionModeInput,
  normalizePermissionMode,
  type CanonicalPermissionMode,
  type PermissionModeInput,
} from '../security/permissionModes.js'

export type PermissionMode = CanonicalPermissionMode

export type CliCommand =
  | 'chat'
  | 'help'
  | 'version'
  | 'config'
  | 'config visual'
  | 'config memory'
  | 'setup'
  | 'doctor'
  | 'resume'
  | 'tasks'
  | 'runtimes'
  | 'tool'
  | 'analyze'
  | 'execute'
  | 'skill'
  | 'skills'
  | 'audit'
  | 'session'
  | 'run'
  | 'athena'
  | 'design'
  | 'niko'
  | 'contest'
  | 'nidhogg'
  | 'wordup'
  | 'bragi'
  | 'gateway'
  | 'mcp'
  | 'heimdall'
  | 'memory'
  | 'goal'
  | 'dream'
  | 'browser-host'

export interface ParsedArgs {
  command: CliCommand
  cwd: string
  model?: string
  baseUrl?: string
  apiKey?: string
  prompt?: string
  promptArgs?: string[]
  sessionId?: string
  /** execute/analyze: images the user attached to the prompt (--image, repeatable). */
  imagePaths?: string[]
  /** execute/analyze: what the user picked in the app (--intent video|long_video|image|research|reminder|slides|document|spreadsheet). */
  intent?: string
  /** execute: answer a pending approval request of --session (--approve <id> | --deny <id> [--reason <text>]). */
  approvalAnswer?: { id: string; decision: 'approve' | 'deny'; reason?: string; expectDigest?: string; signature?: string }
  /** execute: take the session's last exchange out and run again (--retry; a prompt replaces the last message). */
  retry?: boolean
  /** execute --retry: the owner message id of the exchange to replace (--retry-of <id>); another one refuses. */
  retryOf?: string
  keepApprovals?: boolean
  /** execute/analyze: `stream-json` writes progress events to stdout as NDJSON (services/streamJson.ts). */
  outputFormat?: 'text' | 'stream-json'
  resumeLast: boolean
  maxTurns: number
  maxTurnsExplicit: boolean
  permissionMode: PermissionMode
  permissionModeExplicit: boolean
  autoDrive: boolean
  testProviders: boolean
  background: boolean
  setup: boolean
}

// athena / design / niko / contest are hidden aliases kept for old scripts:
// they open chat with "/<name> <prompt>", which the workflow router treats as
// natural language with a hint (see core/workflowRouter.ts).
const CLI_COMMANDS = new Set<CliCommand>([
  'chat', 'help', 'version', 'config', 'setup', 'doctor',
  'resume', 'tasks', 'runtimes', 'tool', 'analyze', 'execute', 'skill', 'skills', 'audit', 'session',
  'run', 'athena', 'design', 'niko', 'contest', 'nidhogg',
  'wordup', 'bragi', 'gateway', 'mcp', 'heimdall', 'memory', 'goal', 'dream',
  // For a platform host only (not in the help): the live browser host in the foreground.
  'browser-host',
])

function isCliCommand(value: string | undefined): value is CliCommand {
  return CLI_COMMANDS.has(value as CliCommand)
}

function isPermissionMode(value: string | undefined): value is PermissionModeInput {
  return isPermissionModeInput(value)
}

function looksLikeSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
}

function extractSessionIdToken(value: string): string | undefined {
  const trimmed = value.trim()
  if (looksLikeSessionId(trimmed)) return trimmed
  return trimmed.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
}

export function getHelpText(locale: UiLocale = 'en'): string {
  const t = (zh: string, en: string) => pickLocale(locale, { zh, en })
  return `
${getBrandingHeading()}
${getBrandingAttribution()}

${t('用法', 'Usage')}:
  artemis [command] [options] [prompt]

${t('命令', 'Commands')}:
  chat              ${t('交互式对话（默认）', 'Interactive chat (default)')}
  setup [section]   ${t('完整配置向导；section 可为 model/bundle/skills/visual/gateway/memory/cron/terminal/tts/session', 'Setup wizard; section can be model/bundle/skills/visual/gateway/memory/cron/terminal/tts/session')}
  config [section]  ${t('查看配置；或用 --setup / section 进入配置向导', 'View config; use --setup or a section to enter setup')}
  doctor            ${t('检查环境健康状况', 'Check environment health')}
  resume [id]       ${t('恢复会话', 'Resume a session')}
  run <prompt>      ${t('执行一次任务；工作流按任务和复杂度自动选择', 'Run a task; the workflow is chosen automatically from the task and its complexity')}
  nidhogg <prompt>  ${t('执行深度批判/审查工作流', 'Run the critique/review workflow')}
  tool              ${t('列出或执行注册工具', 'List or execute registered tools')}
  analyze <query>   ${t('无界面只读分析（--session <id> 继续已有会话；--image <路径> 附图，可多次）', 'Headless read-only analysis (--session <id> continues a session; --image <path> attaches an image, repeatable)')}
  execute <query>   ${t('无界面执行完整 agent（--session <id> 继续已有会话；--image <路径> 附图，可多次；--intent video|long_video|image|research|reminder|slides|document|spreadsheet 传入用户选择的意图）', 'Headless full agent run (--session <id> continues a session; --image <path> attaches an image, repeatable; --intent video|long_video|image|research|reminder|slides|document|spreadsheet states what the user picked)')}
                    ${t('需要你同意的操作会暂停（退出码 10）；用 --session <id> --approve <请求id> 同意，或 --deny <请求id> [--reason <理由>] 拒绝；--signature <签名> 由宿主签发，--expect-digest <actionDigest> 核对请求未被改动', 'Actions that need approval pause the run (exit code 10); answer with --session <id> --approve <request id>, or --deny <request id> [--reason <text>]; --signature <sig> is the host\'s signature, --expect-digest <actionDigest> checks the request was not changed')}
                    ${t('--retry 配合 --session：撤下上一轮再执行（不带 query 即原样重发，带 query 即编辑后重发）；--retry-of <消息 id> 只在它仍是最后一轮时执行', '--retry with --session: takes the last exchange out and runs again (no query: the same message; a query: the edited message); --retry-of <message id> only if that is still the last exchange')}
                    ${t('--output-format stream-json：进度以 NDJSON 事件写到 stdout（带版本号：文字、工具、计划、子代理、用量、心跳、确认请求、结果）；stderr 的进度行不变', '--output-format stream-json: progress as versioned NDJSON events on stdout (text, tools, plan, sub-agents, usage, heartbeats, approval requests, result); the stderr lines stay as they are')}
                    ${t('--keep-approvals：消息不是你本人发的（定时任务、触发器等），会话里等你同意的请求保持不变', '--keep-approvals: the message is not the owner\'s (a scheduled task, a trigger, …): requests waiting in the conversation stay as they are')}
  skill             ${t('列出或查看本地技能', 'List or inspect local skills')}
  audit             ${t('运行安全/注册表审计', 'Run security/registry audit')}
  session           ${t('管理会话记录（list/show/search/last-turn/undo/delete）', 'Manage session records (list/show/search/last-turn/undo/delete)')}
  gateway           ${t('管理第三方通讯后台服务/登录自启', 'Manage messaging background service / login auto-start')}
  version           ${t('显示版本', 'Show version')}
  help              ${t('显示帮助', 'Show help')}
  memory            ${t('管理长期学习认知', 'Manage long-term AI memory')}
  dream             ${t('无界面写一篇梦境日记并配图后退出（--out <目录>；--no-image；--video；--date YYYY-MM-DD；--require-activity；--json）', 'Write one dream diary with a picture headlessly and exit (--out <dir>; --no-image; --video; --date YYYY-MM-DD; --require-activity; --json)')}

${t('选项', 'Options')}:
  --model <name>
  --base-url <url>
  --api-key <key>
  --max-turns <n>
  --permission-mode <PRODUCER|GHOSTWRITER|WRITER>
  --bg
  ${WHOSYOURDADDY_FLAG}    ${t('危险：强制 PRODUCER 并持续执行', 'Dangerous: force PRODUCER + keep running')}
  --cwd <path>
`.trim()
}

export function parseArgs(argv: string[]): ParsedArgs {
  let command: CliCommand = 'chat'
  const promptParts: string[] = []
  let sessionId: string | undefined
  const imagePaths: string[] = []
  let intent: string | undefined
  let approvalAnswer: ParsedArgs['approvalAnswer']
  let approvalReason: string | undefined
  let expectDigest: string | undefined
  let signature: string | undefined
  let retry = false
  let retryOf: string | undefined
  let outputFormat: ParsedArgs['outputFormat']
  let keepApprovals = false
  let resumeLast = false
  let model: string | undefined = process.env.ARTEMIS_MODEL
  let baseUrl: string | undefined = process.env.ARTEMIS_BASE_URL
  let apiKey: string | undefined = process.env.ARTEMIS_API_KEY
  let maxTurns = DEFAULT_AGENT_MAX_TURNS
  let maxTurnsExplicit = false
  let permissionMode: PermissionMode = 'PRODUCER'
  let permissionModeExplicit = false
  let autoDrive = false
  let testProviders = false
  let background = false
  let setup = false
  let cwd = process.cwd()

  const args = [...argv]

  // shorthand flags
  if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    return base('help', cwd, { model, baseUrl, apiKey, resumeLast, maxTurns, maxTurnsExplicit, permissionMode, permissionModeExplicit, autoDrive, testProviders, background, setup: false })
  }
  if (args[0] === 'version' || args[0] === '--version' || args[0] === '-v') {
    return base('version', cwd, { model, baseUrl, apiKey, resumeLast, maxTurns, maxTurnsExplicit, permissionMode, permissionModeExplicit, autoDrive, testProviders, background, setup: false })
  }

  // command token
  if (isCliCommand(args[0])) {
    command = args.shift() as CliCommand
  }

  while (args.length > 0) {
    const cur = args.shift()
    if (!cur) break

    if (cur === '--model')           { model = args.shift(); continue }
    if (cur === '--base-url')        { baseUrl = args.shift(); continue }
    if (cur === '--api-key')         { apiKey = args.shift(); continue }
    if (cur === '--cwd') {
      const v = args.shift()
      if (!v) throw new Error('--cwd requires a path.')
      cwd = path.resolve(v)
      continue
    }
    if (cur === '--bg') { background = true; continue }
    if (cur === '--setup') { setup = true; continue }
    if (cur === '--test-providers')  { testProviders = true; continue }
    if (cur === '--max-turns') {
      const v = Number(args.shift())
      if (!Number.isInteger(v) || v <= 0 || v > MAX_AGENT_MAX_TURNS) throw new Error(`--max-turns must be an integer between 1 and ${MAX_AGENT_MAX_TURNS}.`)
      maxTurns = v
      maxTurnsExplicit = true
      continue
    }
    if (cur === '--permission-mode') {
      const v = args.shift()
      const normalized = v?.toUpperCase()
      const mode = isPermissionMode(normalized) ? normalized : v
      if (!isPermissionMode(mode)) throw new Error('Invalid --permission-mode value.')
      permissionMode = normalizePermissionMode(mode)
      permissionModeExplicit = true
      if (permissionMode !== 'PRODUCER') autoDrive = false
      continue
    }
    if (cur === WHOSYOURDADDY_FLAG) {
      permissionMode = 'PRODUCER'
      permissionModeExplicit = true
      autoDrive = true
      if (!maxTurnsExplicit) maxTurns = Math.max(maxTurns, WHOSYOURDADDY_MIN_TURNS)
      continue
    }
    if (command === 'resume' && cur === '--last') { resumeLast = true; sessionId = undefined; continue }
    // Headless hosts (e.g. a web server driving one turn per process) continue a conversation by id.
    if ((command === 'execute' || command === 'analyze') && cur === '--session') {
      const v = args.shift()
      const extracted = v ? extractSessionIdToken(v) : undefined
      if (!extracted) throw new Error(`${command} --session requires a valid session id.`)
      sessionId = extracted
      continue
    }
    if ((command === 'execute' || command === 'analyze') && (cur === '--intent' || cur.startsWith('--intent='))) {
      const v = cur === '--intent' ? args.shift() : cur.slice('--intent='.length)
      if (!v?.trim()) throw new Error(`${command} --intent requires a name (video, long_video, image, research, reminder, slides, document or spreadsheet).`)
      intent = v.trim()
      continue
    }
    if (command === 'execute' && (cur === '--approve' || cur === '--deny')) {
      const v = args.shift()?.trim()
      if (!v || !/^apr_[0-9a-f]{20}$/.test(v)) throw new Error(`execute ${cur} requires an approval request id (apr_…).`)
      if (approvalAnswer) throw new Error('execute takes one --approve or --deny at a time.')
      approvalAnswer = { id: v, decision: cur === '--approve' ? 'approve' : 'deny' }
      continue
    }
    if (command === 'execute' && cur === '--expect-digest') {
      const v = args.shift()?.trim().toLowerCase()
      if (!v || !/^[0-9a-f]{64}$/.test(v)) throw new Error('execute --expect-digest requires the request\'s actionDigest (64 hex characters).')
      expectDigest = v
      continue
    }
    if (command === 'execute' && cur === '--signature') {
      const v = args.shift()?.trim()
      if (!v || !/^[A-Za-z0-9+/_=-]{40,200}$/.test(v)) throw new Error('execute --signature requires the host\'s signature of the answer.')
      signature = v
      continue
    }
    if (command === 'execute' && cur === '--reason') {
      const v = args.shift()
      if (v === undefined) throw new Error('execute --reason requires a text.')
      approvalReason = v.slice(0, 2_000)
      continue
    }
    if ((command === 'execute' || command === 'analyze') && (cur === '--output-format' || cur.startsWith('--output-format='))) {
      const v = (cur === '--output-format' ? args.shift() : cur.slice('--output-format='.length))?.trim()
      if (v !== 'text' && v !== 'stream-json') throw new Error(`${command} --output-format requires text or stream-json.`)
      outputFormat = v
      continue
    }
    if (command === 'execute' && cur === '--retry') { retry = true; continue }
    if (command === 'execute' && cur === '--keep-approvals') { keepApprovals = true; continue }
    if (command === 'execute' && cur === '--retry-of') {
      const v = args.shift()
      if (!v || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(v)) throw new Error('execute --retry-of requires a message id.')
      retry = true
      retryOf = v
      continue
    }
    if ((command === 'execute' || command === 'analyze') && cur === '--image') {
      const v = args.shift()
      if (!v?.trim()) throw new Error(`${command} --image requires a file path.`)
      imagePaths.push(v)
      continue
    }
    if (command === 'resume' && cur === '--session') {
      const v = args.shift()
      const extracted = v ? extractSessionIdToken(v) : undefined
      if (!extracted) throw new Error('resume --session requires a valid session id.')
      sessionId = extracted
      resumeLast = false
      continue
    }
    // first positional after resume/tasks may be a session id
    if ((command === 'resume' || command === 'tasks') && !sessionId && !(command === 'resume' && resumeLast)) {
      if (command === 'tasks' && !looksLikeSessionId(cur)) {
        promptParts.push(cur)
        continue
      }
      sessionId = cur
      continue
    }
    promptParts.push(cur)
  }

  if (approvalAnswer && !sessionId) throw new Error(`execute --${approvalAnswer.decision} requires --session <id>.`)
  if (approvalAnswer && retry) throw new Error(`execute --${approvalAnswer.decision} cannot be combined with --retry.`)
  if (approvalReason !== undefined && approvalAnswer?.decision !== 'deny') throw new Error('execute --reason goes with --deny.')
  if (approvalAnswer && approvalReason?.trim()) approvalAnswer.reason = approvalReason.trim()
  if (expectDigest !== undefined && !approvalAnswer) throw new Error('execute --expect-digest goes with --approve or --deny.')
  if (approvalAnswer && expectDigest) approvalAnswer.expectDigest = expectDigest
  if (signature !== undefined && !approvalAnswer) throw new Error('execute --signature goes with --approve or --deny.')
  if (approvalAnswer && signature) approvalAnswer.signature = signature
  return {
    command, cwd, model, baseUrl, apiKey,
    prompt: promptParts.length > 0 ? promptParts.join(' ') : undefined,
    promptArgs: promptParts.length > 0 ? [...promptParts] : undefined,
    sessionId, resumeLast, maxTurns, maxTurnsExplicit, permissionMode, permissionModeExplicit,
    autoDrive, testProviders, background, setup,
    ...(imagePaths.length ? { imagePaths } : {}),
    ...(intent !== undefined ? { intent } : {}),
    ...(approvalAnswer ? { approvalAnswer } : {}),
    ...(retry ? { retry } : {}),
    ...(retryOf ? { retryOf } : {}),
    ...(keepApprovals ? { keepApprovals } : {}),
    ...(outputFormat ? { outputFormat } : {}),
  }
}

function base(
  command: CliCommand,
  cwd: string,
  rest: Omit<ParsedArgs, 'command' | 'cwd'>
): ParsedArgs {
  return { command, cwd, ...rest }
}
