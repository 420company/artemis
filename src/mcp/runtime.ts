import type { AgentRole } from '../core/types.js';
import {
  McpServerStore,
  type McpAuthState,
  type McpPromptDescriptor,
  type McpRuntimeSnapshot,
  type McpServerConfig,
  type McpServerSurface,
  type McpToolDescriptor,
} from './store.js';

type ExecutionProfile = 'main' | AgentRole;

type RuntimeSuccessOptions = {
  server: McpServerConfig;
  authState: McpAuthState;
  surface?: McpServerSurface;
  checkedAt?: string;
  contentType?: string;
  serverSignature?: string;
  sampledHeaders?: string[];
  notes?: string[];
  connection?: McpRuntimeSnapshot['connection'];
};

function now(): string {
  return new Date().toISOString();
}

function summarizeServerSurfaceCounts(
  surface: McpServerSurface | undefined,
  fallback: McpServerConfig['runtime'],
): {
  toolsCount: number;
  resourcesCount: number;
  promptsCount: number;
  commandsCount: number;
} {
  return {
    toolsCount: surface?.tools.length ?? fallback?.toolsCount ?? 0,
    resourcesCount: surface?.resources.length ?? fallback?.resourcesCount ?? 0,
    promptsCount: surface?.prompts.length ?? fallback?.promptsCount ?? 0,
    commandsCount: surface?.commands.length ?? fallback?.commandsCount ?? 0,
  };
}

export function buildRuntimeSnapshotFromSurface(
  options: RuntimeSuccessOptions,
): McpRuntimeSnapshot {
  const checkedAt = options.checkedAt ?? now();
  const previous = options.server.runtime;
  const counts = summarizeServerSurfaceCounts(options.surface, previous);

  return {
    connection: options.connection ?? 'connected',
    auth: options.authState,
    toolsCount: counts.toolsCount,
    resourcesCount: counts.resourcesCount,
    promptsCount: counts.promptsCount,
    commandsCount: counts.commandsCount,
    source: options.surface ? options.surface.source : previous?.source ?? 'manual',
    lastSeenAt: checkedAt,
    lastReachableAt: checkedAt,
    lastAuthFailureAt:
      options.authState === 'expired' || options.authState === 'error'
        ? checkedAt
        : previous?.lastAuthFailureAt,
    contentType: options.contentType ?? previous?.contentType,
    serverSignature:
      options.serverSignature ??
      options.surface?.serverName ??
      previous?.serverSignature,
    sampledHeaders: options.sampledHeaders ?? previous?.sampledHeaders,
    toolSample:
      options.surface?.tools.slice(0, 5).map((tool) => tool.name) ??
      previous?.toolSample,
    resourceSample:
      options.surface?.resources.slice(0, 5).map((resource) => resource.uri) ??
      previous?.resourceSample,
    promptSample:
      options.surface?.prompts.slice(0, 5).map((prompt) => prompt.name) ??
      previous?.promptSample,
    commandSample:
      options.surface?.commands.slice(0, 5).map((command) => command.name) ??
      previous?.commandSample,
    notes: options.notes ?? previous?.notes,
  };
}

export function applyMcpRuntimeSuccess(
  options: RuntimeSuccessOptions,
): McpServerConfig {
  const checkedAt = options.checkedAt ?? now();

  return {
    ...options.server,
    authState: options.authState,
    lastCheckedAt: checkedAt,
    lastError: undefined,
    runtime: buildRuntimeSnapshotFromSurface(options),
  };
}

/**
 * Phase C: MCP Auto-Discovery and Suggestion logic.
 * Analyzes user intent and suggests relevant MCP servers that are not yet enabled or configured.
 */
export async function suggestMcpServersForIntent(
  cwd: string,
  intent: string,
  allServers: McpServerConfig[],
): Promise<McpServerConfig[]> {
  const lowerIntent = intent.toLowerCase();
  const suggestions: McpServerConfig[] = [];

  for (const server of allServers) {
    // Skip already enabled servers
    if (server.enabled) continue;

    const metadata = [
      server.id,
      server.surface?.serverName,
      ...(server.runtime?.toolSample ?? []),
      ...(server.runtime?.resourceSample ?? []),
      ...(server.runtime?.promptSample ?? []),
    ].map(s => s?.toLowerCase()).filter(Boolean);

    // Simple keyword matching for discovery
    const isRelevant = metadata.some(meta => {
      const words = meta!.split(/[^a-z0-9]+/);
      return words.some((word: string) => word.length > 2 && lowerIntent.includes(word));
    });

    if (isRelevant) {
      suggestions.push(server);
    }
  }

  return suggestions.slice(0, 3);
}

export function applyMcpRuntimeFailure(options: {
  server: McpServerConfig;
  authState: McpAuthState;
  message: string;
  checkedAt?: string;
}): McpServerConfig {
  const checkedAt = options.checkedAt ?? now();
  const previous = options.server.runtime;
  const counts = summarizeServerSurfaceCounts(options.server.surface, previous);

  return {
    ...options.server,
    authState: options.authState,
    lastCheckedAt: checkedAt,
    lastError: options.message,
    runtime: {
      connection: 'attention',
      auth: options.authState,
      toolsCount: counts.toolsCount,
      resourcesCount: counts.resourcesCount,
      promptsCount: counts.promptsCount,
      commandsCount: counts.commandsCount,
      source: previous?.source ?? options.server.surface?.source ?? 'manual',
      lastSeenAt: checkedAt,
      lastReachableAt: previous?.lastReachableAt,
      lastAuthFailureAt:
        options.authState === 'expired' || options.authState === 'error'
          ? checkedAt
          : previous?.lastAuthFailureAt,
      contentType: previous?.contentType,
      serverSignature:
        previous?.serverSignature ?? options.server.surface?.serverName,
      sampledHeaders: previous?.sampledHeaders,
      toolSample:
        options.server.surface?.tools.slice(0, 5).map((tool) => tool.name) ??
        previous?.toolSample,
      resourceSample:
        options.server.surface?.resources
          .slice(0, 5)
          .map((resource) => resource.uri) ?? previous?.resourceSample,
      promptSample:
        options.server.surface?.prompts.slice(0, 5).map((prompt) => prompt.name) ??
        previous?.promptSample,
      commandSample:
        options.server.surface?.commands
          .slice(0, 5)
          .map((command) => command.name) ?? previous?.commandSample,
      notes: [options.message],
    },
    updatedAt: checkedAt,
  };
}

export function findMcpToolDescriptor(
  server: McpServerConfig,
  toolName: string,
): McpToolDescriptor | undefined {
  return server.surface?.tools.find((tool) => tool.name === toolName);
}

function buildToolLine(tool: McpToolDescriptor): string {
  const flags = [
    tool.readOnly === true ? 'readOnly=true' : '',
    tool.alwaysLoad === true ? 'alwaysLoad=true' : '',
    tool.destructive === true ? 'destructive=true' : '',
    tool.openWorld === true ? 'openWorld=true' : '',
  ]
    .filter(Boolean)
    .map((flag) => `[${flag}]`)
    .join(' ');

  return [
    `- ${tool.name}`,
    tool.title ? `(${tool.title})` : '',
    flags,
    tool.description ? `: ${tool.description}` : '',
    tool.searchHint ? `hint=${tool.searchHint}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildPromptLine(prompt: McpPromptDescriptor): string {
  const argumentSummary = prompt.arguments?.length
    ? ` args=${prompt.arguments
        .map((argument) =>
          argument.required === true
            ? `${argument.name}*`
            : argument.name,
        )
        .join(', ')}`
    : '';

  return [
    `- ${prompt.name}`,
    prompt.title ? `(${prompt.title})` : '',
    argumentSummary,
    prompt.description ? `: ${prompt.description}` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function buildServerSection(server: McpServerConfig): string {
  const lines = [
    [
      `- ${server.id}`,
      `[${server.transport}]`,
      `auth=${server.authType}/${server.authState}`,
      server.runtime ? `runtime=${server.runtime.connection}` : '',
      server.surface?.serverName ? `server=${server.surface.serverName}` : '',
      server.surface?.serverVersion
        ? `version=${server.surface.serverVersion}`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
  ];

  if (server.surface?.tools.length) {
    lines.push('  tools:');
    for (const tool of server.surface.tools) {
      lines.push(`  ${buildToolLine(tool)}`);
    }
  }

  if (server.surface?.resources.length) {
    lines.push('  resources:');
    for (const resource of server.surface.resources) {
      lines.push(
        [
          `  - ${resource.uri}`,
          resource.name ? `(${resource.name})` : '',
          resource.description ? `: ${resource.description}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }

  if (server.surface?.prompts.length) {
    lines.push('  prompts:');
    for (const prompt of server.surface.prompts) {
      lines.push(`  ${buildPromptLine(prompt)}`);
    }
  }

  if (server.surface?.commands.length) {
    lines.push('  commands:');
    for (const command of server.surface.commands) {
      lines.push(
        [
          `  - ${command.name}`,
          command.description ? `: ${command.description}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }
  }

  return lines.join('\n');
}

export async function buildMcpRuntimeSections(
  cwd: string,
  profile: ExecutionProfile,
): Promise<string[]> {
  const store = new McpServerStore(cwd);
  if (!(await store.exists())) {
    return [];
  }
  const data = await store.load();
  const activeServers = data.servers
    .filter((server) => server.enabled && server.surface)
    .sort((left, right) => left.id.localeCompare(right.id));

  if (activeServers.length === 0) {
    return [];
  }

  const undiscovered = data.servers
    .filter((server) => server.enabled && !server.surface)
    .map((server) => server.id)
    .sort((left, right) => left.localeCompare(right));

  const lines = [
    'MCP runtime surfaces:',
    profile === 'main'
      ? 'Use mcp_call_tool for MCP tools, mcp_read_resource for MCP resources, and mcp_get_prompt for MCP prompts/templates. If a tool is marked readOnly=true, preserve that hint in the action.'
      : 'This profile may use discovered MCP resources and prompts, but runtime policy still limits mutating or delegated actions.',
    ...activeServers.map((server) => buildServerSection(server)),
  ];

  if (undiscovered.length > 0) {
    lines.push(
      `Configured MCP servers without a discovered surface: ${undiscovered.join(', ')}`,
    );
  }

  return [lines.join('\n\n')];
}
