/* eslint-disable no-case-declarations */
import type { AgentAction, PermissionMode } from '../core/types.js';
import { getToolPermissionCategory } from '../tools/registry.js';
import type { ToolPermissionCategory } from '../tools/types.js';
import { chooseInteractiveOption } from '../cli/prompt.js';
import { isReadOnlyCommand } from './commandPolicy.js';
import { normalizePermissionMode, type PermissionModeInput } from './permissionModes.js';

export type PermissionCategory = ToolPermissionCategory;

export function getPermissionCategoryForActionType(
  type: AgentAction['type'],
): PermissionCategory {
  return getToolPermissionCategory(type);
}

function getCategory(action: AgentAction): PermissionCategory {
  if (action.type === 'run_command' && isReadOnlyCommand(action.command)) {
    return 'read';
  }

  if (action.type === 'mcp_call_tool' && action.readOnly === true) {
    return 'read';
  }

  return getPermissionCategoryForActionType(action.type);
}

function describeAction(action: AgentAction): string {
  switch (action.type) {
    case 'list_files':
      return action.pattern
        ? `list files matching ${action.pattern}`
        : 'list files';
    case 'read_file':
      return `read file ${action.path}${
        action.startLine || action.endLine
          ? ` lines ${action.startLine ?? 1}-${action.endLine ?? 'end'}`
          : ''
      }`;
    case 'search_files':
      return `search files${action.pattern ? ` pattern=${action.pattern}` : ''}${action.query ? ` query=${action.query}` : ''}`;
    case 'lookup_docs':
      return `look up docs for ${action.query}${action.library ? ` library=${action.library}` : ''}${action.version ? ` version=${action.version}` : ''}`;
    case 'deep_research':
      return `run Gemini Deep Research for ${action.query}`;
    case 'mcp_call_tool':
      return `call MCP tool ${action.toolName} on server ${action.serverId}`;
    case 'mcp_read_resource':
      return `read MCP resource ${action.uri} on server ${action.serverId}`;
    case 'mcp_get_prompt':
      return `get MCP prompt ${action.promptName} on server ${action.serverId}`;
    case 'write_file':
      return `write file ${action.path}`;
    case 'insert_in_file':
      return `insert content in file ${action.path}`;
    case 'replace_in_file':
      return `replace text in file ${action.path}`;
    case 'apply_patch':
      return 'apply a structured patch';
    case 'run_command':
      return `${
        isReadOnlyCommand(action.command) ? 'run read-only command' : 'run command'
      } ${action.command}`;
    case 'delegate_task':
      return `delegate task to ${action.role}`;
    case 'approve_builder_execution':
      return `approve builder execution for session ${action.sessionId}`;
    case 'odin_search_skills':
      return `search skills for ${action.query}`;
    case 'odin_execute_task':
      return `execute task with skill: ${action.task}`;
    case 'odin_fix_skill':
      return `fix skill ${action.skillId}`;
    case 'odin_upload_skill':
      return `upload skill ${action.skillId}`;
    case 'odin_import_cloud_skills':
      return `import cloud skills${action.query ? ` matching "${action.query}"` : ''}`;
    case 'generate_image':
      return `generate image via BytePlus Seedream (${action.model ?? 'seedream-5-0-260128'})`;
    case 'generate_video':
      return `generate video via BytePlus Seedance (${action.model ?? 'seedance-1-5-pro-251215'})`;
    case 'synthesize_speech':
      return `synthesize speech with configured TTS${action.outputPath ? ` to ${action.outputPath}` : ''}`;
    case 'transcribe_audio':
      return `transcribe audio locally from ${action.inputPath}`;
    case 'spawn_background_workflow':
      return `spawn a detached background workflow for ${action.command}`;
    case 'request_freya_visual_asset':
      return `request Freya visual asset (${action.assetType})`;
    case 'agent':
      const permissionSummary = `agent action=${action.action}`;
      if (action.id) {
        return `${permissionSummary} id=${action.id}`;
      }
      if (action.name) {
        return `${permissionSummary} name=${action.name}`;
      }
      return permissionSummary;
    case 'search_web':
      const searchPermissionSummary = `search web for ${action.query}`;
      if (action.backend && action.backend !== 'auto') {
        return `${searchPermissionSummary} using ${action.backend}`;
      }
      if (action.limit && action.limit !== 5) {
        return `${searchPermissionSummary} (${action.limit} results)`;
      }
      return searchPermissionSummary;
    // ── Spotify integration ──────────────────────────────────────────────
    case 'spotify_play_liked':
      return `spotify: play liked songs${action.shuffle === false ? '' : ' (shuffle)'}`;
    case 'spotify_search_and_play':
      return `spotify: search and play "${action.query}"`;
    case 'spotify_play_playlist':
      return `spotify: play playlist "${action.name}"`;
    case 'spotify_resume':
      return `spotify: resume playback`;
    case 'spotify_pause':
      return `spotify: pause`;
    case 'spotify_skip_next':
      return `spotify: skip to next track`;
    case 'spotify_skip_previous':
      return `spotify: skip to previous track`;
    case 'spotify_set_volume':
      return `spotify: set volume to ${action.volume}%`;
    case 'spotify_now_playing':
      return `spotify: get currently playing`;
    case 'spotify_set_device':
      return `spotify: transfer playback to "${action.deviceHint}"`;
    // ── Ambient agent integrations ──────────────────────────────────────
    case 'weather_current':
      return `weather: current at ${action.location}`;
    case 'weather_forecast':
      return `weather: ${action.days ?? 3}-day forecast at ${action.location}`;
    case 'world_clock':
      return `world_clock: ${action.cities.join(', ')}`;
    case 'time_diff':
      return `time_diff: ${action.fromCity} → ${action.toCity}`;
    case 'currency_convert':
      return `currency: ${action.amount} ${action.from} → ${action.to}`;
    case 'currency_rates':
      return `currency: rates for ${action.base}`;
    case 'flight_lookup':
      return `flight: lookup ${action.callsign}`;
    case 'calendar_list_today':
      return `calendar: list today`;
    case 'calendar_list_upcoming':
      return `calendar: list next ${action.daysAhead ?? 7} days`;
    case 'calendar_add_event':
      return `calendar: add "${action.title}" at ${action.startISO}`;
    case 'reminders_list':
      return `reminders: list${action.list ? ` (${action.list})` : ''}`;
    case 'reminders_add':
      return `reminders: add "${action.title}"`;
    case 'reminders_complete':
      return `reminders: complete "${action.title}"`;
    // ── Browser automation ──────────────────────────────────────────────
    case 'browser_navigate':
      return `browser: navigate to ${action.url}`;
    case 'browser_screenshot':
      return `browser: screenshot${action.fullPage ? ' (full page)' : ''}`;
    case 'browser_extract_text':
      return `browser: extract text${action.selector ? ` from ${action.selector}` : ''}`;
    case 'browser_click':
      return `browser: click ${action.selector ?? action.text ?? '?'}`;
    case 'browser_type':
      return `browser: type into ${action.selector}`;
    case 'browser_wait_for':
      return `browser: wait for ${action.selector ?? action.text ?? '?'}`;
    case 'browser_close':
      return 'browser: close';
    // ── MCP self-management ─────────────────────────────────────────────
    case 'mcp_list':
      return `mcp: list${action.filter ? ` (filter: ${action.filter})` : ''}`;
    case 'mcp_enable':
      return `mcp: enable ${action.id}`;
    case 'mcp_disable':
      return `mcp: disable ${action.id}`;
    case 'mcp_suggest':
      return `mcp: suggest for "${action.intent}"`;
    case 'bridge_send_image':
      return `bridge: send image ${action.imagePath}${action.platform ? ` to ${action.platform}` : ''}`;
    case 'request_user_confirmation':
      return `confirmation: ${action.question}`;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

type SessionGrantState = Record<Exclude<PermissionCategory, 'read'>, boolean>;

export class PermissionManager {
  private mode: PermissionMode;
  private readonly interactive: boolean;
  private readonly sessionGrants: SessionGrantState = {
    none: false,
    write: false,
    execute: false,
    sensitive: false,
    admin: false,
    agent: false,
  };

  constructor(mode: PermissionModeInput, interactive: boolean) {
    this.mode = normalizePermissionMode(mode);
    this.interactive = interactive;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  getInteractive(): boolean {
    return this.interactive;
  }

  setMode(mode: PermissionModeInput): void {
    this.mode = normalizePermissionMode(mode);
  }

  fork(mode: PermissionModeInput = this.mode): PermissionManager {
    const next = new PermissionManager(normalizePermissionMode(mode), this.interactive);
    next.sessionGrants.write = this.sessionGrants.write;
    next.sessionGrants.execute = this.sessionGrants.execute;
    next.sessionGrants.sensitive = this.sessionGrants.sensitive;
    next.sessionGrants.admin = this.sessionGrants.admin;
    return next;
  }

  async authorize(action: AgentAction): Promise<{ allowed: boolean; reason: string }> {
    const category = getCategory(action);

    if (category === 'read') {
      return { allowed: true, reason: 'read access allowed' };
    }

    if (this.mode === 'read-only') {
      return { allowed: false, reason: `${category} blocked by read-only mode` };
    }

    if (this.mode === 'PRODUCER') {
      return { allowed: true, reason: `allowed by ${this.mode} mode` };
    }

    if (this.mode === 'WRITER') {
      if (category === 'write') {
        return { allowed: true, reason: `allowed by ${this.mode} mode` };
      }
      return this.prompt(action, category);
    }

    if (this.sessionGrants[category]) {
      return { allowed: true, reason: `allowed by session ${category} grant` };
    }

    return this.prompt(action, category);
  }

  private async prompt(
    action: AgentAction,
    category: Exclude<PermissionCategory, 'read'>,
  ): Promise<{ allowed: boolean; reason: string }> {
    if (!this.interactive) {
      return {
        allowed: false,
        reason: `${category} denied because prompt mode is non-interactive`,
      };
    }

    const decision = await chooseInteractiveOption({
      title: `Permission required to ${describeAction(action)}.`,
      choices: [
        {
          label: 'Allow once',
          value: 'once' as const,
          description: 'Approve only this action.',
        },
        {
          label: `Allow ${category} for this session`,
          value: 'session' as const,
          description: `Approve future ${category} actions for this session.`,
        },
        {
          label: 'Deny',
          value: 'deny' as const,
          description: 'Block this action.',
        },
      ],
      initialIndex: 2,
    });

    if (decision === 'session') {
      this.sessionGrants[category] = true;
      return { allowed: true, reason: `allowed ${category} for this session` };
    }

    if (decision === 'once') {
      return { allowed: true, reason: 'allowed once by user' };
    }

    return { allowed: false, reason: 'denied by user' };
  }
}
