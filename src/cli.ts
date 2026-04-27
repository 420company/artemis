#!/usr/bin/env node
import { runCli } from './cli/runCli.js'

// 直接调用 Artemis 的完整 CLI 入口
runCli(process.argv.slice(2)).catch((err) => {
  console.error('CLI Error:', err)
  process.exit(1)
})