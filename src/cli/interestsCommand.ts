/**
 * `artemis interests` — derive the owner's news interest topics headlessly and exit.
 *
 * For hosts that build a daily news feed (a server's morning job). Like
 * `artemis dream`, it runs as the agent (it reads the agent's own persona,
 * profile, memory and recent session digests, which the host must not read
 * itself) and never prompts. It asks the cheapest configured model (the
 * worker profile, else the main one) once, with no tools, and prints one
 * machine-readable line:
 *
 *   [interests:result] {"v":1,"status":"ok"|"skipped"|"failed","topics":[...],...}
 *
 * Only short, generic topic queries leave the command (services/interestProfile.ts
 * checks every one); the material itself never does.
 *
 * Options:
 *   --since-hours <n>    recent sessions of the last n hours (1-168, default 72)
 *   --locale zh-CN|en    language of the labels
 *   --model <id>         the cheap model to use (a host's helper model)
 *   --json               print only the result line
 *
 * Exit code: 0 when topics were derived or there was nothing to derive them from
 * ("skipped", no model call), 1 when it failed, 2 on bad arguments.
 */
import type { UiLocale } from './locale.js'

export const INTERESTS_RESULT_MARKER = '[interests:result]'

export interface InterestsCommandOptions {
  sinceHours: number
  locale?: UiLocale
  model?: string
  json: boolean
}

export interface InterestsCommandResult {
  v: 1
  status: 'ok' | 'skipped' | 'failed'
  /** For logs; not meant for end users. */
  reason?: string
  topics: import('../services/interestProfile.js').InterestTopic[]
  locale: UiLocale
  /** Tokens of the one model call, when there was one. */
  usage?: { input: number; output: number }
}

export class InterestsArgsError extends Error {}

const INTERESTS_TIMEOUT_MS = 60_000
const MAX_OUTPUT_TOKENS = 600

export function parseInterestsArgs(args: readonly string[]): InterestsCommandOptions {
  const options: InterestsCommandOptions = { sinceHours: 72, json: false }
  const rest = [...args]
  while (rest.length > 0) {
    const cur = rest.shift()!
    const [flag, inline] = cur.startsWith('--') && cur.includes('=') ? [cur.slice(0, cur.indexOf('=')), cur.slice(cur.indexOf('=') + 1)] : [cur, undefined]
    const value = (): string => {
      const v = inline ?? rest.shift()
      if (v === undefined || v === '' || (inline === undefined && v.startsWith('--'))) throw new InterestsArgsError(`${flag} requires a value`)
      return v
    }
    switch (flag) {
      case '--json':
        options.json = true
        break
      case '--locale': {
        const v = value().toLowerCase()
        if (v.startsWith('zh')) options.locale = 'zh-CN'
        else if (v.startsWith('en')) options.locale = 'en'
        else throw new InterestsArgsError('--locale must be zh-CN or en')
        break
      }
      case '--model': {
        const v = value()
        if (!/^[\w.:/@+-]{1,200}$/.test(v)) throw new InterestsArgsError('--model must be a model id')
        options.model = v
        break
      }
      case '--since-hours': {
        const n = Number(value())
        if (!Number.isFinite(n) || n < 1 || n > 168) throw new InterestsArgsError('--since-hours must be between 1 and 168')
        options.sinceHours = n
        break
      }
      default:
        throw new InterestsArgsError(`Unknown option for interests: ${cur}`)
    }
  }
  return options
}

export function formatInterestsResultLine(result: InterestsCommandResult): string {
  return `${INTERESTS_RESULT_MARKER} ${JSON.stringify(result)}`
}

/**
 * The cheap model: `model` on the main profile's endpoint (the host's helper
 * model), else the worker profile. Never the main model itself: without
 * either this throws.
 */
async function cheapProvider(cwd: string, model: string | undefined) {
  const { createTrackedProviderFromConfig } = await import('../providers/telemetry.js')
  let config
  if (model) {
    const { resolveMainProviderConfig } = await import('../providers/onboarding.js')
    config = { ...(await resolveMainProviderConfig({ cwd, config: {} })), model }
  } else {
    const { ProviderStore, createGlobalProviderStore } = await import('../providers/store.js')
    const local = new ProviderStore(cwd)
    config = local.getWorkerProfile(await local.load())
    if (!config) {
      const global = createGlobalProviderStore()
      config = global.getWorkerProfile(await global.load())
    }
    if (!config) throw new Error('no cheap model: no --model and no worker profile')
  }
  const id = (config as unknown as { id?: unknown }).id
  return createTrackedProviderFromConfig(config, { cwd, profileId: typeof id === 'string' ? id : undefined, profileLabel: 'interests' })
}

export async function runInterestsCommand(input: {
  cwd: string
  locale: UiLocale
  args: readonly string[]
  /** The global `--model` flag (parseArgs takes it before the subcommand sees its arguments). */
  model?: string
  now?: () => Date
  write?: (line: string) => void
}): Promise<{ exitCode: number; result?: InterestsCommandResult }> {
  const write = input.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  let options: InterestsCommandOptions
  try {
    options = parseInterestsArgs(input.args)
  } catch (err) {
    process.stderr.write(`interests: ${err instanceof Error ? err.message : String(err)}\n`)
    return { exitCode: 2 }
  }
  const locale = options.locale ?? input.locale
  const finish = (result: InterestsCommandResult, exitCode: number) => {
    write(formatInterestsResultLine(result))
    return { exitCode, result }
  }
  const untilMs = (input.now?.() ?? new Date()).getTime()
  const { gatherInterestMaterial, isEmptyMaterial, materialPrompt, interestSystemPrompt, parseInterestTopics } = await import('../services/interestProfile.js')
  const material = await gatherInterestMaterial({ cwd: input.cwd, sinceMs: untilMs - options.sinceHours * 3_600_000, untilMs })
  if (isEmptyMaterial(material)) return finish({ v: 1, status: 'skipped', reason: 'no_material', topics: [], locale }, 0)
  const prompt = materialPrompt(material, locale)

  let provider
  try {
    provider = await cheapProvider(input.cwd, options.model ?? input.model)
  } catch (err) {
    return finish({ v: 1, status: 'failed', reason: err instanceof Error ? err.message.slice(0, 200) : 'no model is configured', topics: [], locale }, 1)
  }
  const at = new Date().toISOString()
  let text = ''
  let usage: InterestsCommandResult['usage']
  let timer: NodeJS.Timeout | undefined
  try {
    // A plain completion: no tools are offered, so nothing in the material can make it act.
    const response = await Promise.race([
      provider.complete(
        [
          { id: 'interests-sys', role: 'system' as const, content: interestSystemPrompt(locale), createdAt: at },
          { id: 'interests-usr', role: 'user' as const, content: prompt, createdAt: at },
        ],
        { maxOutputTokens: MAX_OUTPUT_TOKENS, locale },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), INTERESTS_TIMEOUT_MS)
      }),
    ])
    text = (response.text ?? '').trim()
    if (response.usage) usage = { input: response.usage.promptTokens ?? 0, output: response.usage.completionTokens ?? 0 }
  } catch (err) {
    return finish({ v: 1, status: 'failed', reason: `model call failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), topics: [], locale }, 1)
  } finally {
    if (timer) clearTimeout(timer)
  }
  const topics = parseInterestTopics(text, prompt)
  if (topics.length === 0) return finish({ v: 1, status: 'failed', reason: 'no usable topic in the answer', topics: [], locale, ...(usage ? { usage } : {}) }, 1)
  return finish({ v: 1, status: 'ok', topics, locale, ...(usage ? { usage } : {}) }, 0)
}
