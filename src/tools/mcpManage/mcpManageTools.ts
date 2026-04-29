/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * MCP self-management tools — give brain agency over the MCP server roster.
 *
 * Before this, brain could only TELL the user "go run /mcp enable xxx in the
 * CLI" — which broke the ambient agent flow when the user is on Telegram.
 * Now brain can list, enable, disable, and get suggestions itself.
 *
 * Safety: enabling an MCP causes the configured stdio command to be spawned
 * (or HTTP endpoint to be hit). Most MCPs need API keys / OAuth that the
 * user provides separately. Enabling without those credentials just means
 * the MCP is "active" in config but its first call will fail until creds
 * are configured. We surface this clearly in the output.
 */

import os from 'node:os';
import path from 'node:path';
import { McpServerStore } from '../../mcp/store.js';
import { suggestMcpServersForIntent } from '../../mcp/runtime.js';

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: { code: string; message: string };
}

function getStore(): McpServerStore {
  // Use home dir as the store root — that's where ~/.artemis/mcp-servers.json lives.
  return new McpServerStore(os.homedir());
}

// ── mcp_list ────────────────────────────────────────────────────────────

export interface McpListAction {
  type: 'mcp_list';
  filter?: string; // substring on id or surface name
  status?: 'all' | 'enabled' | 'disabled';
}

export async function executeMcpList(action: McpListAction): Promise<ToolResult> {
  try {
    const store = getStore();
    const data = await store.load();
    let servers = data.servers;
    const status = action.status ?? 'all';
    if (status === 'enabled') servers = servers.filter((s) => s.enabled);
    if (status === 'disabled') servers = servers.filter((s) => !s.enabled);
    if (action.filter && action.filter.trim().length > 0) {
      const kw = action.filter.trim().toLowerCase();
      servers = servers.filter((s) => {
        const name = (s.surface?.serverName ?? '').toLowerCase();
        return s.id.toLowerCase().includes(kw) || name.includes(kw);
      });
    }
    const total = data.servers.length;
    const enabled = data.servers.filter((s) => s.enabled).length;
    const lines: string[] = [
      `MCP servers: ${servers.length} matched · ${enabled}/${total} enabled overall`,
    ];
    for (const s of servers.slice(0, 50)) {
      const flag = s.enabled ? 'ON ' : 'off';
      const transport = s.transport;
      const surface = s.surface?.serverName ?? '';
      const url = s.url ? ` ${s.url}` : s.command ? ` ${s.command}` : '';
      lines.push(`  [${flag}] ${s.id} (${transport})${surface ? ` "${surface}"` : ''}${url}`);
    }
    if (servers.length > 50) lines.push(`  ... +${servers.length - 50} more (refine filter)`);
    return { ok: true, output: lines.join('\n') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `MCP list 失败：${msg}`, error: { code: 'mcp_list_error', message: msg } };
  }
}

// ── mcp_enable ──────────────────────────────────────────────────────────

export interface McpEnableAction {
  type: 'mcp_enable';
  id: string;
}

export async function executeMcpEnable(action: McpEnableAction): Promise<ToolResult> {
  if (!action.id || action.id.trim().length === 0) {
    return {
      ok: false,
      output: 'id 必填',
      error: { code: 'invalid_input', message: 'id required' },
    };
  }
  try {
    const store = getStore();
    const data = await store.load();
    let target = data.servers.find((s) => s.id === action.id.trim());
    if (!target) {
      // Try fuzzy match
      const matches = data.servers.filter((s) => s.id.includes(action.id.trim()));
      if (matches.length === 0) {
        return {
          ok: false,
          output: `未找到 id 为 "${action.id}" 的 MCP。先用 mcp_list 或 mcp_suggest 找正确 id。`,
          error: { code: 'not_found', message: 'id not found' },
        };
      }
      if (matches.length > 1) {
        return {
          ok: false,
          output: `id "${action.id}" 模糊匹配到多个：\n  ${matches.map((m) => m.id).join('\n  ')}\n请提供更精确的 id。`,
          error: { code: 'ambiguous', message: 'multiple matches' },
        };
      }
      target = matches[0]!;
    }
    if (target.enabled) {
      return { ok: true, output: `${target.id} 已经是启用状态，无需重复启用。` };
    }
    target.enabled = true;
    await store.save(data);
    return {
      ok: true,
      output: `✓ 已启用：${target.id}\n   ⚠  注意：很多 MCP 需要 API key / OAuth；首次调用前可能需要在 ~/.artemis/mcp-servers.json 里补凭证。`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `MCP enable 失败：${msg}`, error: { code: 'mcp_enable_error', message: msg } };
  }
}

// ── mcp_disable ─────────────────────────────────────────────────────────

export interface McpDisableAction {
  type: 'mcp_disable';
  id: string;
}

export async function executeMcpDisable(action: McpDisableAction): Promise<ToolResult> {
  if (!action.id || action.id.trim().length === 0) {
    return {
      ok: false,
      output: 'id 必填',
      error: { code: 'invalid_input', message: 'id required' },
    };
  }
  try {
    const store = getStore();
    const data = await store.load();
    const target = data.servers.find((s) => s.id === action.id.trim());
    if (!target) {
      return {
        ok: false,
        output: `未找到 id "${action.id}"`,
        error: { code: 'not_found', message: 'id not found' },
      };
    }
    if (!target.enabled) {
      return { ok: true, output: `${target.id} 已经是禁用状态。` };
    }
    target.enabled = false;
    await store.save(data);
    return { ok: true, output: `✓ 已禁用：${target.id}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `MCP disable 失败：${msg}`, error: { code: 'mcp_disable_error', message: msg } };
  }
}

// ── mcp_suggest ─────────────────────────────────────────────────────────

export interface McpSuggestAction {
  type: 'mcp_suggest';
  intent: string;
}

export async function executeMcpSuggest(action: McpSuggestAction): Promise<ToolResult> {
  if (!action.intent || action.intent.trim().length === 0) {
    return {
      ok: false,
      output: 'intent 必填（描述你想要做什么，如"机票查询"、"git 操作"）',
      error: { code: 'invalid_input', message: 'intent required' },
    };
  }
  try {
    const store = getStore();
    const data = await store.load();
    // We pass cwd as homedir so the suggester reads the same store
    const suggestions = await suggestMcpServersForIntent(os.homedir(), action.intent, data.servers);
    if (suggestions.length === 0) {
      return {
        ok: true,
        output: `没找到与 "${action.intent}" 相关的 MCP。可能：(1) 该领域没人做 MCP；(2) 关键词太宽，试试更具体的；(3) 全部都已启用了。`,
      };
    }
    const lines: string[] = [`MCP 推荐 — intent: "${action.intent}"`];
    for (const s of suggestions.slice(0, 10)) {
      const surface = (s as any).surface?.serverName;
      const flag = s.enabled ? 'ON ' : 'off';
      lines.push(`  [${flag}] ${s.id}${surface ? ` "${surface}"` : ''}`);
    }
    lines.push('');
    lines.push('启用合适的：调用 mcp_enable(id="...")');
    return { ok: true, output: lines.join('\n') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: `MCP suggest 失败：${msg}`, error: { code: 'mcp_suggest_error', message: msg } };
  }
}
