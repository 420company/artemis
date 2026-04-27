import Anthropic from '@anthropic-ai/sdk';
import type { AgentActionType } from '../core/types.js';
import { buildActionParametersSchema } from '../core/providerNativeTools.js';
import type { ProviderNativeFunctionTool } from '../providers/types.js';
import { getToolDefinition, isDirectlyExecutableTool } from './registry.js';
import { buildExtraToolDefs } from './extras.js';

const BUILTIN_DIRECT_TOOL_CANDIDATES: readonly AgentActionType[] = [
  'list_files',
  'read_file',
  'search_files',
  'lookup_docs',
  'write_file',
  'insert_in_file',
  'replace_in_file',
  'apply_patch',
  'run_command',
  'generate_image',
  'generate_video',
  // ── Spotify integration ──────────────────────────────────────────────
  'spotify_play_liked',
  'spotify_search_and_play',
  'spotify_play_playlist',
  'spotify_resume',
  'spotify_pause',
  'spotify_skip_next',
  'spotify_skip_previous',
  'spotify_set_volume',
  'spotify_now_playing',
  'spotify_set_device',
];

export const BUILTIN_DIRECT_TOOL_TYPES: readonly AgentActionType[] =
  BUILTIN_DIRECT_TOOL_CANDIDATES.filter((type) => isDirectlyExecutableTool(type));

const HTTP_REQUEST_DESCRIPTION =
  'Make an HTTP request to any URL and return the response body (up to 50 KB). Use for fetching web pages, calling REST APIs, or downloading data.';

const HTTP_REQUEST_PARAMETERS: {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
} = {
  type: 'object',
  properties: {
    url: { type: 'string', description: 'Target URL (must include http:// or https://)' },
    method: { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE, PATCH (default: GET)' },
    body: { type: 'string', description: 'Request body (for POST/PUT)' },
    headers: { type: 'object', description: 'Optional request headers as key-value pairs' },
  },
  required: ['url'],
};

let cachedDirectTools: readonly Anthropic.Tool[] | undefined;
let cachedDirectNativeFunctionTools: readonly ProviderNativeFunctionTool[] | undefined;

function isSharedDirectTool(name: string): boolean {
  // Notebook tools are runtime-managed stateful helpers, not general provider
  // tools. Keeping them out preserves the compact 51-tool shared manifest.
  return !name.startsWith('notebook_');
}

function filterNamedTools<T extends { name: string }>(
  tools: readonly T[],
  allowedToolNames?: Iterable<string>,
): T[] {
  if (!allowedToolNames) {
    return [...tools];
  }

  const allow = new Set(
    [...allowedToolNames]
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
  if (allow.size === 0) {
    return [];
  }

  return tools.filter((tool) => allow.has(tool.name));
}

function getAllDirectTools(): readonly Anthropic.Tool[] {
  if (!cachedDirectTools) {
    const builtIns: Anthropic.Tool[] = BUILTIN_DIRECT_TOOL_TYPES.map((type) => {
    const toolDef = getToolDefinition(type);
    return {
      name: type,
      description: toolDef?.description || 'No description available',
      input_schema: buildActionParametersSchema(type) as Anthropic.Tool['input_schema'],
    };
  }).filter(tool => tool.description !== 'No description available');

    cachedDirectTools = [
      ...builtIns,
      ...buildExtraToolDefs().filter((tool) => isSharedDirectTool(tool.name)),
      {
        name: 'http_request',
        description: HTTP_REQUEST_DESCRIPTION,
        input_schema: HTTP_REQUEST_PARAMETERS,
      },
    ];
  }
  return cachedDirectTools;
}

function getAllDirectNativeFunctionTools(): readonly ProviderNativeFunctionTool[] {
  if (!cachedDirectNativeFunctionTools) {
    const builtIns: ProviderNativeFunctionTool[] = BUILTIN_DIRECT_TOOL_TYPES.map((type) => {
      const toolDef = getToolDefinition(type);
      return {
        type: 'function',
        name: type,
        description: toolDef?.description ?? '',
        parameters: buildActionParametersSchema(type),
      };
    });

    const extras: ProviderNativeFunctionTool[] = buildExtraToolDefs()
      .filter((tool) => isSharedDirectTool(tool.name))
      .map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema as Record<string, unknown>,
      }));

    cachedDirectNativeFunctionTools = [
      ...builtIns,
      ...extras,
      {
        type: 'function',
        name: 'http_request',
        description: HTTP_REQUEST_DESCRIPTION,
        parameters: HTTP_REQUEST_PARAMETERS,
      },
    ];
  }
  return cachedDirectNativeFunctionTools;
}

export function buildDirectTools(options?: {
  allowedToolNames?: Iterable<string>;
}): Anthropic.Tool[] {
  return filterNamedTools(getAllDirectTools(), options?.allowedToolNames);
}

export function buildDirectNativeFunctionTools(options?: {
  allowedToolNames?: Iterable<string>;
}): ProviderNativeFunctionTool[] {
  return filterNamedTools(
    getAllDirectNativeFunctionTools(),
    options?.allowedToolNames,
  );
}

export function listDirectToolNames(): string[] {
  return getAllDirectNativeFunctionTools().map((tool) => tool.name);
}

export function getDirectToolCount(): number {
  return getAllDirectNativeFunctionTools().length;
}
