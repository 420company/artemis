#!/usr/bin/env node
import { installCrashHandler, checkPreviousCrash } from './core/crashHandler.js'
import { runCli } from './cli/runCli.js'

installCrashHandler()

async function main(): Promise<void> {
  const crash = await checkPreviousCrash().catch(() => null)
  if (crash) {
    const when = typeof crash.report.timestamp === 'string' ? ` at ${crash.report.timestamp}` : ''
    console.error(`⚠ Artemis exited abnormally last time${when} — report archived in ~/.artemis/crashes/`)
  }
  // 直接调用 Artemis 的完整 CLI 入口
  await runCli(process.argv.slice(2))
}

main().catch((err) => {
  console.error('CLI Error:', err)
  process.exit(1)
})
