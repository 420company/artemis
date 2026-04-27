/**
 * MCP awareness — inject a summary of available MCP servers into the brain's
 * system prompt so it knows what third-party integrations exist BEFORE it
 * tries hacky workarounds like osascript / curl for tasks that need a
 * proper API.
 *
 * Without this, brain encountering "play my Spotify liked songs" would
 * spiral into 24 rounds of failing AppleScript attempts. With this, brain
 * knows up front: "no spotify-music MCP enabled — tell user to enable or
 * give up gracefully."
 */

import { McpServerStore } from '../mcp/store.js';
import os from 'node:os';

interface McpEntry {
  id: string;
  enabled: boolean;
  url?: string;
  command?: string;
  serverName?: string;
}

async function loadAllMcpServers(cwd: string): Promise<McpEntry[]> {
  const seen = new Set<string>();
  const result: McpEntry[] = [];

  // Load both local and global stores. Differentiate ENOENT (file doesn't
  // exist — silent) from JSON parse / IO errors (log so user can repair a
  // corrupt config rather than silently see "no MCP configured").
  for (const root of [cwd, os.homedir()]) {
    try {
      const store = new McpServerStore(root);
      const data = await store.load();
      for (const s of data.servers) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        result.push({
          id: s.id,
          enabled: s.enabled,
          url: s.url,
          command: s.command,
          serverName: s.surface?.serverName,
        });
      }
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === 'ENOENT') {
        // No config at this scope — expected, skip silently
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[mcpAwareness] failed to load MCP store at ${root}: ${msg}`);
    }
  }
  return result;
}

/**
 * Categorize MCP id (cco-<plugin>-<server>) into a coarse domain bucket so
 * the brain can match user intent against domains rather than exact ids.
 */
function inferDomain(id: string): string {
  const s = id.toLowerCase();
  if (/aws|gcp|azure|cloudflare|vercel|netlify|firebase|supabase|railway|fly\.io/.test(s)) return 'cloud';
  if (/github|gitlab|sourcegraph/.test(s)) return 'source-control';
  if (/slack|notion|atlassian|jira|linear|asana|miro|zoom|gmail|gcal|google-drive/.test(s)) return 'collaboration';
  if (/stripe|shopify|sumup|adspirer|amplitude|posthog|circleback/.test(s)) return 'business';
  if (/sentry|datadog|opsera|pagerduty/.test(s)) return 'observability';
  if (/postgres|mysql|mongo|redis|prisma|cockroach|alloydb|pinecone|sanity/.test(s)) return 'data';
  if (/figma|chrome-devtools|playwright/.test(s)) return 'design-frontend';
  if (/spotify|music|audio|youtube/.test(s)) return 'media';
  if (/aikido|semgrep|nightvision|sonarqube|zscaler|vanta/.test(s)) return 'security';
  return 'other';
}

/**
 * Build a compact MCP-awareness hint to inject into the brain's system
 * prompt. Lists enabled servers in detail, summarizes disabled ones by
 * domain, and gives behavioral rules for when no MCP exists.
 */
export async function buildMcpAwarenessHint(cwd: string): Promise<string> {
  const servers = await loadAllMcpServers(cwd);
  if (servers.length === 0) {
    return `\n\n## 外部集成（MCP 服务）

当前未配置任何 MCP 服务。如果用户要求接外部服务（Spotify、Notion、Slack 等），用户要先用 \`/mcp\` 配置。如遇此情形：
- 先尝试用本地工具完成（read/write/run_command）
- 完不成的，**主动告诉用户**："这个任务需要外部服务集成，目前没装相关 MCP，建议你跑 \`/mcp suggest <意图>\` 找一找。"
- 不要硬上 osascript/curl 模拟，那不是真正的解决方案`;
  }

  const enabled = servers.filter((s) => s.enabled);
  const disabled = servers.filter((s) => !s.enabled);

  // Group disabled by domain for compact display
  const byDomain: Record<string, number> = {};
  for (const s of disabled) {
    const d = inferDomain(s.id);
    byDomain[d] = (byDomain[d] ?? 0) + 1;
  }

  const lines: string[] = ['', '', '## 外部集成（MCP 服务）当前状态'];

  if (enabled.length > 0) {
    lines.push('');
    lines.push(`已启用 (${enabled.length}) — 你可以直接调用对应工具：`);
    for (const s of enabled.slice(0, 30)) {
      const tag = s.url ? '[http]' : s.command ? '[stdio]' : '';
      lines.push(`  • ${s.serverName ?? s.id} ${tag}  (id: ${s.id})`);
    }
    if (enabled.length > 30) lines.push(`  • … +${enabled.length - 30} 更多`);
  } else {
    lines.push('');
    lines.push('已启用：0 个');
  }

  if (disabled.length > 0) {
    lines.push('');
    lines.push(`未启用但已配置 (${disabled.length}) — 按领域分布：`);
    const domainEntries = Object.entries(byDomain).sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of domainEntries) {
      lines.push(`  • ${domain.padEnd(18)} ${count}`);
    }
  }

  lines.push('');
  lines.push('## 决策规则');
  lines.push('用户要求的任务需要外部服务（Spotify/Notion/Slack/AWS/GitHub 等）时：');
  lines.push('1. 任务是 "纯本地文件/代码/命令" 吗？是 → 用你的本地工具直接做');
  lines.push('2. 需要外部服务 API 吗？是 → 看上面 MCP 列表：');
  lines.push('   a. 已启用 → 直接调用 MCP 工具');
  lines.push('   b. 已配置但未启用 → 告诉用户："请先跑 `/mcp enable <id>` 启用对应服务"，给出建议的 id');
  lines.push('   c. 没配置 → **主动告诉用户**："这事我做不了，因为没集成相应 API。可跑 `/mcp suggest <意图>` 看看"，');
  lines.push('       **不要尝试用 osascript / curl / 模拟登录 等方式硬干**——那只会消耗你的工具回合而拿不到结果');
  lines.push('3. 如果用户明确说"用 osascript 帮我"，那当然可以；否则默认按上面 (c) 处理');
  lines.push('');
  lines.push('一个反例：用户说"播放 Spotify 点赞歌曲"——AppleScript 没有 Liked Songs 接口。如果没有合适 MCP，直接告诉用户做不到，不要怼 20 轮 osascript');

  return lines.join('\n');
}
