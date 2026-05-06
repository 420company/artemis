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
  | 'odin'
  | 'heimdall'
  | 'memory'

export interface ParsedArgs {
  command: CliCommand
  cwd: string
  model?: string
  baseUrl?: string
  apiKey?: string
  prompt?: string
  sessionId?: string
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

const CLI_COMMANDS = new Set<CliCommand>([
  'chat', 'help', 'version', 'config', 'setup', 'doctor',
  'resume', 'tasks', 'runtimes', 'tool', 'analyze', 'execute', 'skill', 'skills', 'audit', 'session',
  'run', 'athena', 'design', 'niko', 'contest', 'nidhogg',
  'wordup', 'bragi', 'gateway', 'mcp', 'odin', 'heimdall', 'memory'
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
  run <prompt>      ${t('执行一次普通任务工作流', 'Run a single task workflow')}
  design <prompt>   ${t('执行设计工作流', 'Run the design workflow')}
  athena <prompt>   ${t('执行研究/规划工作流', 'Run the research/planning workflow')}
  niko <prompt>     ${t('执行工程构建工作流', 'Run the engineering build workflow')}
  contest <prompt>  ${t('执行多方案竞赛工作流', 'Run the multi-variant contest workflow')}
  nidhogg <prompt>  ${t('执行深度批判/审查工作流', 'Run the critique/review workflow')}
  tool              ${t('列出或执行注册工具', 'List or execute registered tools')}
  analyze <query>   ${t('用查询引擎分析输入', 'Analyze input with the query engine')}
  execute <query>   ${t('用查询引擎执行输入', 'Execute input with the query engine')}
  skill             ${t('列出或查看本地技能', 'List or inspect local skills')}
  audit             ${t('运行安全/注册表审计', 'Run security/registry audit')}
  session           ${t('管理会话记录', 'Manage session records')}
  gateway           ${t('管理第三方通讯后台服务/登录自启', 'Manage messaging background service / login auto-start')}
  version           ${t('显示版本', 'Show version')}
  help              ${t('显示帮助', 'Show help')}
  memory            ${t('管理长期学习认知', 'Manage long-term AI memory')}

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

  return {
    command, cwd, model, baseUrl, apiKey,
    prompt: promptParts.length > 0 ? promptParts.join(' ') : undefined,
    sessionId, resumeLast, maxTurns, maxTurnsExplicit, permissionMode, permissionModeExplicit,
    autoDrive, testProviders, background, setup,
  }
}

function base(
  command: CliCommand,
  cwd: string,
  rest: Omit<ParsedArgs, 'command' | 'cwd'>
): ParsedArgs {
  return { command, cwd, ...rest }
}
