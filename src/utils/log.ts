/**
 * utils/log.ts — minimal logging helpers
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { inspect } from 'node:util'
import { redactText } from './redact.js'

export type RuntimeLogLevel = 'info' | 'warn' | 'error'

export type RuntimeLogEntry = {
  level: RuntimeLogLevel
  message: string
}

export type RuntimeLogSink = (entry: RuntimeLogEntry) => void | Promise<void>

const runtimeLogSink = new AsyncLocalStorage<RuntimeLogSink>()

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack ?? arg.message
      return inspect(arg, { depth: 4, colors: false, breakLength: 120 })
    })
    .join(' ')
}

export async function withRuntimeLogSink<T>(
  sink: RuntimeLogSink | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sink) return fn()
  return runtimeLogSink.run(sink, fn)
}

export function emitRuntimeLog(level: RuntimeLogLevel, ...args: unknown[]): void {
  const message = redactText(formatLogArgs(args).trim())
  if (!message) return

  const sink = runtimeLogSink.getStore()
  if (sink) {
    void Promise.resolve(sink({ level, message })).catch(() => {})
    return
  }

  if (process.env.DEBUG) {
    const prefix = '[artemis]'
    if (level === 'error') console.error(prefix, message)
    else if (level === 'warn') console.warn(prefix, message)
    else console.log(prefix, message)
  }
}

export function toolLog(...args: unknown[]): void {
  emitRuntimeLog('info', ...args)
}

export function toolWarn(...args: unknown[]): void {
  emitRuntimeLog('warn', ...args)
}

export function toolError(...args: unknown[]): void {
  emitRuntimeLog('error', ...args)
}

export function logError(error: unknown): void {
  emitRuntimeLog('error', '[artemis error]', error)
}
