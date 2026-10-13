#!/usr/bin/env node
/**
 * Artemis CLI dev-mode launcher.
 *
 * Runs the TypeScript source directly via tsx (same as `npm run`):
 *   node bin/artemis-cli.js --help
 *
 * For the published package, npm uses dist/cli.js (see package.json "bin").
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Project root (bin/ -> ..)
const projectRoot = join(__dirname, '..');

const tsxCli = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const entryPoint = join(projectRoot, 'src', 'cli.ts');

if (!existsSync(tsxCli)) {
  console.error('❌ 错误：tsx 依赖未安装');
  console.error('请运行：npm install');
  process.exit(1);
}

if (!existsSync(entryPoint)) {
  console.error(`❌ 错误：CLI 入口不存在：${entryPoint}`);
  process.exit(1);
}

const args = process.argv.slice(2);

const child = spawn(
  process.execPath,
  [
    '--no-warnings',
    '--disable-warning=DEP0005',
    tsxCli,
    entryPoint,
    ...args,
  ],
  {
    cwd: projectRoot,
    stdio: 'inherit',
  }
);

child.on('error', (err) => {
  console.error('❌ 无法启动 CLI：', err.message);
  process.exit(1);
});

// Forward the child's exit code / signal so `node bin/artemis-cli.js` behaves
// exactly like running the CLI directly.
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
