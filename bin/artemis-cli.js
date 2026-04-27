#!/usr/bin/env node
/**
 * Artemis CLI 入口文件
 * 使用 tsx 直接运行 TypeScript 源码
 */

import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// 获取当前文件的目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 项目根目录
const projectRoot = join(__dirname, '..');

// 获取命令参数
const args = process.argv.slice(2);

console.log('项目根目录:', projectRoot);

// 检查 tsx 是否可用
exec('npm list tsx', { cwd: projectRoot }, (err, stdout, stderr) => {
  if (err) {
    console.error('❌ 错误：tsx 依赖未安装');
    console.error('请运行：npm install');
    process.exit(1);
  }

  console.log('tsx 版本信息:', stdout);

  // 构建 tsx 命令
  const tsxPath = 'node --no-warnings --disable-warning=DEP0005 node_modules/tsx/dist/cli.mjs';
  const entryPoint = join(projectRoot, 'src', 'cli.ts');
  const quotedEntryPoint = entryPoint.includes(' ') ? `"${entryPoint}"` : entryPoint;
  const command = `${tsxPath} ${quotedEntryPoint} ${args.join(' ')}`;
  console.log('执行命令:', command);

  // 执行 tsx 命令
  exec(command, { cwd: projectRoot }, (err, stdout, stderr) => {
    if (err) {
      console.error('❌ 命令执行失败:', err);
      console.error('标准错误:', stderr);
      process.exit(err.code || 1);
    }
    
    console.log('标准输出:', stdout);
  });
});