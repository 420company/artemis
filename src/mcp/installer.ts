import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { McpServerConfig } from './store.js';

const execFileAsync = promisify(execFile);

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const USER_MCP_PACKAGES_DIR = path.join(os.homedir(), '.artemis', 'mcp-packages');
const BUNDLED_MCP_PACKAGES_DIR = path.join(CLI_ROOT, 'mcp-packages');
const CLI_MCP_PACKAGES_DIR = existsSync(path.join(USER_MCP_PACKAGES_DIR, 'node_modules'))
  ? USER_MCP_PACKAGES_DIR
  : BUNDLED_MCP_PACKAGES_DIR;

export type McpRuntimeRequirement =
  | { kind: 'npm'; package: string }
  | { kind: 'bun_runtime' }
  | { kind: 'uvx_runtime' }
  | { kind: 'jbang_runtime' }
  | { kind: 'external_binary'; binary: string; installHint: string };

export type McpDependencyInfo = {
  serverId: string;
  requirement: McpRuntimeRequirement;
  installInstructions: string;
  canAutoInstall: boolean;
};

const EXTERNAL_BINARY_HINTS: Record<string, string> = {
  semgrep: 'pip install semgrep  或  brew install semgrep',
  'fiftyone-mcp': 'pip install fiftyone-mcp',
  toolbox: '从 https://www.cockroachlabs.com/docs/stable/cockroach-demo 安装 CockroachDB Toolbox',
};

export function detectDependencyRequirement(
  server: McpServerConfig,
): McpRuntimeRequirement | null {
  if (server.transport !== 'stdio') return null;
  const cmd = server.command ?? '';

  if (cmd === 'npx') {
    const args = server.commandArgs ?? [];
    const pkg = args.find((a) => !a.startsWith('-') && !a.startsWith('git+'));
    if (pkg) {
      // Strip @version suffix for display
      const pkgName = pkg.replace(/@[^@/]+$/, '').replace(/@latest$/, '');
      return { kind: 'npm', package: pkgName };
    }
  }

  if (cmd === 'bun') return { kind: 'bun_runtime' };
  if (cmd === 'uvx') return { kind: 'uvx_runtime' };
  if (cmd === 'jbang') return { kind: 'jbang_runtime' };

  const hint = EXTERNAL_BINARY_HINTS[cmd];
  if (hint) return { kind: 'external_binary', binary: cmd, installHint: hint };

  return null;
}

export function buildDependencyInfo(
  server: McpServerConfig,
  requirement: McpRuntimeRequirement,
): McpDependencyInfo {
  switch (requirement.kind) {
    case 'npm':
      return {
        serverId: server.id,
        requirement,
        installInstructions: `需要安装 npm 包 "${requirement.package}"（约几 MB），将自动下载安装。`,
        canAutoInstall: true,
      };
    case 'bun_runtime':
      return {
        serverId: server.id,
        requirement,
        installInstructions:
          '需要安装 Bun 运行时：\n  macOS/Linux: curl -fsSL https://bun.sh/install | bash\n  Windows: powershell -c "irm bun.sh/install.ps1 | iex"',
        canAutoInstall: false,
      };
    case 'uvx_runtime':
      return {
        serverId: server.id,
        requirement,
        installInstructions:
          '需要安装 uv/uvx（Python 包管理器）：\n  curl -LsSf https://astral.sh/uv/install.sh | sh',
        canAutoInstall: false,
      };
    case 'jbang_runtime':
      return {
        serverId: server.id,
        requirement,
        installInstructions:
          '需要安装 JBang（Java 运行时）：\n  curl -Ls https://sh.jbang.dev | bash -s - app setup\n  或 brew install jbangdev/tap/jbang',
        canAutoInstall: false,
      };
    case 'external_binary':
      return {
        serverId: server.id,
        requirement,
        installInstructions: `需要手动安装 "${requirement.binary}"：\n  ${requirement.installHint}`,
        canAutoInstall: false,
      };
  }
}

export async function installNpmMcpPackage(packageName: string): Promise<void> {
  await execFileAsync('npm', ['install', '--prefix', CLI_MCP_PACKAGES_DIR, packageName, '--no-audit', '--no-fund'], {
    timeout: 120_000,
  });
}

export function isMissingExecutableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /enoent|not recognized|cannot find|failed to start stdio server|spawn .+ enoent/i.test(msg);
}

export function formatDependencyPrompt(info: McpDependencyInfo, locale: 'zh' | 'en' = 'zh'): string {
  if (locale === 'zh') {
    const canAuto = info.canAutoInstall
      ? '我可以自动安装它，是否现在安装？（回复"是"或"安装"）'
      : '需要手动安装，安装完成后可以重试。';
    return `⚠️ **缺少运行环境**\n\n插件 \`${info.serverId}\` 无法启动。\n\n${info.installInstructions}\n\n${canAuto}`;
  }
  const canAuto = info.canAutoInstall
    ? 'I can install it automatically. Shall I do it now? (Reply "yes" or "install")'
    : 'This requires manual installation. Please install it and retry.';
  return `⚠️ **Missing dependency**\n\nPlugin \`${info.serverId}\` failed to start.\n\n${info.installInstructions}\n\n${canAuto}`;
}
