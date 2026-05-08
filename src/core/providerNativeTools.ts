import {
  type AgentAction,
  type AgentActionType,
} from './types.js';
import {
  getProviderCallableActionTypes,
  getToolDefinition,
  validateToolAction,
} from '../tools/registry.js';
import type { ToolError } from '../tools/types.js';
import {
  McpServerStore,
  type McpPromptDescriptor,
  type McpResourceDescriptor,
  type McpServerConfig,
  type McpToolDescriptor,
} from '../mcp/store.js';
import type {
  ProviderNativeFunctionTool,
  ProviderNativeToolCall,
} from '../providers/types.js';

type JsonSchema = Record<string, unknown>;
type ProviderNativeMcpProjection = {
  kind: 'tool' | 'prompt' | 'resource';
  serverId: string;
  toolName: string;
  readOnly?: boolean;
  uri?: string;
};

export type ProviderNativeToolRuntime = {
  tools: ProviderNativeFunctionTool[];
  projectedMcpTools: Map<string, ProviderNativeMcpProjection>;
  totalProjectedTools: number;
  selectedProjectedTools: number;
  alwaysLoadedProjectedTools: number;
  stickyProjectedTools: number;
  selectedProjectedToolNames: string[];
};

const MAX_PROJECTED_MCP_DESCRIPTION_LENGTH = 2_048;
const DEFAULT_MAX_PROJECTED_MCP_TOOLS = 96;
let cachedBuiltInTools: ProviderNativeFunctionTool[] | undefined;

type BuildProviderNativeToolRuntimeOptions = {
  requestContext?: string;
  maxProjectedMcpTools?: number;
  stickyProjectedToolNames?: string[];
  allowedActionTypes?: readonly AgentActionType[];
  allowReadOnlyMcpToolCalls?: boolean;
};

type ProjectedMcpFunctionCandidate = {
  kind: 'tool' | 'prompt' | 'resource';
  serverId: string;
  toolName: string;
  readOnly?: boolean;
  uri?: string;
  description: string;
  parameters: JsonSchema;
  baseName: string;
  alwaysLoad: boolean;
  sticky: boolean;
  score: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function integerSchema(description: string): JsonSchema {
  return {
    type: 'integer',
    minimum: 1,
    description,
  };
}

function nonEmptyStringSchema(description: string): JsonSchema {
  return {
    type: 'string',
    minLength: 1,
    description,
  };
}

function optionalStringSchema(description: string): JsonSchema {
  return {
    type: 'string',
    description,
  };
}

function normalizeNameForMcpProjection(name: string): string {
  const normalized = name
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'unnamed';
}

function normalizeDescriptionFragment(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateProjectedDescription(description: string): string {
  if (description.length <= MAX_PROJECTED_MCP_DESCRIPTION_LENGTH) {
    return description;
  }

  return `${description.slice(0, MAX_PROJECTED_MCP_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

function tokenizeMcpProjectionText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_:-]+/i)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length >= 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseMcpProjectionName(name: string): {
  parts: string[];
  full: string;
} {
  const parts = name
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/__/g, ' ')
    .replace(/[:/_-]+/g, ' ')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return {
    parts,
    full: parts.join(' '),
  };
}

function scoreProjectedMcpCandidate(options: {
  requestTokens: string[];
  nameText: string;
  titleText?: string;
  descriptionText?: string;
  searchHintText?: string;
  serverText: string;
}): number {
  if (options.requestTokens.length === 0) {
    return 0;
  }

  const requestTerms = [...new Set(options.requestTokens)];
  const name = parseMcpProjectionName(options.nameText);
  const title = parseMcpProjectionName(options.titleText ?? '');
  const server = parseMcpProjectionName(options.serverText);
  const normalizedRequest = options.requestTokens.join(' ');
  const normalizedDescription = (options.descriptionText ?? '').toLowerCase();
  const normalizedSearchHint = (options.searchHintText ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const normalizedTitle = (options.titleText ?? '').toLowerCase();

  let score = 0;
  if (
    normalizedSearchHint &&
    normalizedRequest &&
    normalizedRequest.includes(normalizedSearchHint)
  ) {
    score += 24;
  }

  for (const term of requestTerms) {
    const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`);
    let nameMatched = false;

    if (name.parts.includes(term)) {
      score += 12;
      nameMatched = true;
    } else if (name.parts.some((part) => part.includes(term))) {
      score += 6;
      nameMatched = true;
    }

    if (!nameMatched && name.full.includes(term)) {
      score += 3;
    }

    if (server.parts.includes(term)) {
      score += 8;
    } else if (server.parts.some((part) => part.includes(term))) {
      score += 4;
    }

    if (title.parts.includes(term)) {
      score += 8;
    } else if (title.parts.some((part) => part.includes(term))) {
      score += 4;
    } else if (normalizedTitle && pattern.test(normalizedTitle)) {
      score += 2;
    }

    if (normalizedSearchHint && pattern.test(normalizedSearchHint)) {
      score += 14;
    }

    if (pattern.test(normalizedDescription)) {
      score += 2;
    }
  }

  return score;
}

function buildProjectedMcpToolName(
  serverId: string,
  toolName: string,
): string {
  return `mcp__${normalizeNameForMcpProjection(serverId)}__${normalizeNameForMcpProjection(toolName)}`;
}

function buildProjectedMcpPromptName(
  serverId: string,
  promptName: string,
): string {
  return `mcp_prompt__${normalizeNameForMcpProjection(serverId)}__${normalizeNameForMcpProjection(promptName)}`;
}

function buildProjectedMcpResourceName(
  serverId: string,
  resource: McpResourceDescriptor,
): string {
  const slugSource = resource.name?.trim() || resource.uri;
  return `mcp_resource__${normalizeNameForMcpProjection(serverId)}__${normalizeNameForMcpProjection(slugSource)}`;
}

function buildPermissiveObjectSchema(description: string): JsonSchema {
  return {
    type: 'object',
    description,
    additionalProperties: true,
  };
}

// Keys that are valid in JSON Schema meta-schemas but rejected by Anthropic/OpenAI
// when passed as function tool parameter schemas.
const UNSUPPORTED_SCHEMA_META_KEYS = new Set([
  '$schema',
  '$id',
  '$anchor',
  '$defs',
  '$ref',
  '$comment',
  'definitions',
]);

// Schema-valued keywords that contain a single child schema (object).
const SCHEMA_OBJECT_KEYWORDS = new Set([
  'additionalProperties',
  'not',
  'if',
  'then',
  'else',
  'contains',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
  'items',
]);

// Schema-valued keywords that contain an array of child schemas.
const SCHEMA_ARRAY_KEYWORDS = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
]);

// Strip provider-unsupported JSON Schema meta-keywords from the top level of a
// schema object so it can be safely passed to Anthropic / OpenAI function tools.
// Recurses into all schema-valued positions (properties, items, anyOf, etc.)
// so that $ref and other meta-keys are stripped at every nesting level.
function sanitizeMcpInputSchema(schema: Record<string, unknown>): JsonSchema {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_META_KEYS.has(key)) {
      continue;
    }
    // Recursively sanitize map of named property schemas.
    if (key === 'properties' && isRecord(value)) {
      const sanitizedProps: Record<string, unknown> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        sanitizedProps[propName] = isRecord(propSchema)
          ? sanitizeMcpInputSchema(propSchema)
          : propSchema;
      }
      result[key] = sanitizedProps;
      continue;
    }
    // Recursively sanitize single-schema-valued keywords.
    if (SCHEMA_OBJECT_KEYWORDS.has(key) && isRecord(value)) {
      result[key] = sanitizeMcpInputSchema(value);
      continue;
    }
    // Recursively sanitize array-of-schemas keywords.
    if (SCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      result[key] = value.map((element) =>
        isRecord(element) ? sanitizeMcpInputSchema(element) : element,
      );
      continue;
    }
    result[key] = value;
  }
  return result;
}

function normalizeProjectedMcpToolSchema(
  serverId: string,
  tool: McpToolDescriptor,
): JsonSchema {
  const fallbackDescription = `Arguments for discovered MCP tool ${serverId}/${tool.name}.`;
  if (!isRecord(tool.inputSchema)) {
    return buildPermissiveObjectSchema(fallbackDescription);
  }

  const schema = sanitizeMcpInputSchema({ ...tool.inputSchema });
  if (schema.type === undefined && isRecord(schema.properties)) {
    schema.type = 'object';
  }
  if (schema.type !== 'object') {
    return buildPermissiveObjectSchema(fallbackDescription);
  }
  if (
    !('additionalProperties' in schema) &&
    !('properties' in schema) &&
    !('patternProperties' in schema)
  ) {
    schema.additionalProperties = true;
  }
  if (typeof schema.description !== 'string' || !schema.description.trim()) {
    schema.description = fallbackDescription;
  }
  return schema;
}

function buildProjectedMcpToolDescription(
  serverId: string,
  tool: McpToolDescriptor,
): string {
  const flags = [
    tool.readOnly === true ? 'readOnly=true' : '',
    tool.alwaysLoad === true ? 'alwaysLoad=true' : '',
    tool.destructive === true ? 'destructive=true' : '',
    tool.openWorld === true ? 'openWorld=true' : '',
  ].filter(Boolean);
  const header = [
    `Discovered MCP tool ${serverId}/${tool.name}`,
    tool.title?.trim() ? `(${normalizeDescriptionFragment(tool.title)})` : '',
    flags.length > 0 ? `[${flags.join(', ')}]` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const body = [
    tool.description?.trim()
      ? normalizeDescriptionFragment(tool.description)
      : '',
    tool.searchHint?.trim()
      ? `Search hint: ${normalizeDescriptionFragment(tool.searchHint)}`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return truncateProjectedDescription(
    body ? `${header}: ${body}` : header,
  );
}

function buildProjectedMcpPromptSchema(
  serverId: string,
  prompt: McpPromptDescriptor,
): JsonSchema {
  const description = `Arguments for discovered MCP prompt ${serverId}/${prompt.name}.`;
  // MCP prompt arguments are always strings per the MCP spec.
  const properties = Object.fromEntries(
    (prompt.arguments ?? []).map((argument) => [
      argument.name,
      {
        type: 'string',
        ...(argument.description?.trim()
          ? { description: argument.description.trim() }
          : {}),
      },
    ]),
  );
  const required = (prompt.arguments ?? [])
    .filter((argument) => argument.required === true)
    .map((argument) => argument.name);

  return {
    type: 'object',
    additionalProperties: true,
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
    ...(required.length > 0 ? { required } : {}),
    description,
  };
}

function buildProjectedMcpPromptDescription(
  serverId: string,
  prompt: McpPromptDescriptor,
): string {
  const argumentSummary = prompt.arguments?.length
    ? ` args=${prompt.arguments
        .map((argument) =>
          argument.required === true
            ? `${argument.name}*`
            : argument.name,
        )
        .join(', ')}`
    : '';
  const prefix = [
    `Discovered MCP prompt ${serverId}/${prompt.name}${argumentSummary}`,
    prompt.title?.trim() ? `(${normalizeDescriptionFragment(prompt.title)})` : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (prompt.description?.trim()) {
    return truncateProjectedDescription(
      `${prefix}: ${normalizeDescriptionFragment(prompt.description)}`,
    );
  }

  return truncateProjectedDescription(prefix);
}

function buildProjectedMcpResourceSchema(
  serverId: string,
  resource: McpResourceDescriptor,
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    description: `Arguments for discovered MCP resource ${serverId}/${resource.uri}. This projected resource does not accept arguments.`,
  };
}

function buildProjectedMcpResourceDescription(
  serverId: string,
  resource: McpResourceDescriptor,
): string {
  const prefix = `Discovered MCP resource ${serverId}/${resource.uri}`;
  const name = resource.name?.trim() ? ` (${resource.name.trim()})` : '';
  const mimeType = resource.mimeType?.trim()
    ? ` [mime=${resource.mimeType.trim()}]`
    : '';
  if (resource.description?.trim()) {
    return truncateProjectedDescription(
      `${prefix}${name}${mimeType}: ${normalizeDescriptionFragment(resource.description)}`,
    );
  }

  return truncateProjectedDescription(`${prefix}${name}${mimeType}`);
}

function buildProjectedMcpFunctionTools(
  servers: McpServerConfig[],
  options: BuildProviderNativeToolRuntimeOptions = {},
): {
  tools: ProviderNativeFunctionTool[];
  projectedMcpTools: Map<string, ProviderNativeMcpProjection>;
  totalProjectedTools: number;
  selectedProjectedTools: number;
  alwaysLoadedProjectedTools: number;
  stickyProjectedTools: number;
  selectedProjectedToolNames: string[];
} {
  const candidates: ProjectedMcpFunctionCandidate[] = [];
  const requestTokens = [...new Set(
    tokenizeMcpProjectionText(options.requestContext ?? ''),
  )];
  const projectedMcpTools = new Map<string, ProviderNativeMcpProjection>();
  const usedNames = new Set<string>();
  const stickyProjectedToolNames = new Set(
    (options.stickyProjectedToolNames ?? [])
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const allowedActionTypes = options.allowedActionTypes
    ? new Set(options.allowedActionTypes)
    : undefined;

  function projectionAllowed(kind: ProjectedMcpFunctionCandidate['kind'], readOnly?: boolean): boolean {
    if (!allowedActionTypes) {
      return true;
    }

    if (kind === 'prompt') {
      return allowedActionTypes.has('mcp_get_prompt');
    }

    if (kind === 'resource') {
      return allowedActionTypes.has('mcp_read_resource');
    }

    if (allowedActionTypes.has('mcp_call_tool')) {
      return true;
    }

    return readOnly === true && options.allowReadOnlyMcpToolCalls === true;
  }

  for (const server of servers) {
    if (!server.enabled || !server.surface) {
      continue;
    }

    for (const tool of server.surface.tools) {
      if (!tool.name.trim()) {
        continue;
      }

      candidates.push({
        kind: 'tool',
        serverId: server.id,
        toolName: tool.name,
        readOnly: tool.readOnly,
        description: buildProjectedMcpToolDescription(server.id, tool),
        parameters: normalizeProjectedMcpToolSchema(server.id, tool),
        baseName: buildProjectedMcpToolName(server.id, tool.name),
        alwaysLoad: tool.alwaysLoad === true,
        sticky: stickyProjectedToolNames.has(
          buildProjectedMcpToolName(server.id, tool.name),
        ),
        score: scoreProjectedMcpCandidate({
          requestTokens,
          nameText: tool.name,
          titleText: tool.title,
          descriptionText: tool.description,
          searchHintText: tool.searchHint,
          serverText: server.id,
        }),
      });
    }

    for (const prompt of server.surface.prompts ?? []) {
      if (!prompt.name.trim()) {
        continue;
      }

      candidates.push({
        kind: 'prompt',
        serverId: server.id,
        toolName: prompt.name,
        description: buildProjectedMcpPromptDescription(server.id, prompt),
        parameters: buildProjectedMcpPromptSchema(server.id, prompt),
        baseName: buildProjectedMcpPromptName(server.id, prompt.name),
        alwaysLoad: false,
        sticky: stickyProjectedToolNames.has(
          buildProjectedMcpPromptName(server.id, prompt.name),
        ),
        score: scoreProjectedMcpCandidate({
          requestTokens,
          nameText: prompt.name,
          titleText: prompt.title,
          descriptionText: prompt.description,
          serverText: server.id,
        }),
      });
    }

    for (const resource of server.surface.resources ?? []) {
      if (!resource.uri.trim()) {
        continue;
      }

      candidates.push({
        kind: 'resource',
        serverId: server.id,
        toolName: resource.name?.trim() || resource.uri,
        uri: resource.uri,
        description: buildProjectedMcpResourceDescription(server.id, resource),
        parameters: buildProjectedMcpResourceSchema(server.id, resource),
        baseName: buildProjectedMcpResourceName(server.id, resource),
        alwaysLoad: false,
        sticky: stickyProjectedToolNames.has(
          buildProjectedMcpResourceName(server.id, resource),
        ),
        score: scoreProjectedMcpCandidate({
          requestTokens,
          nameText: resource.name?.trim() || resource.uri,
          descriptionText: resource.description,
          serverText: server.id,
        }),
      });
    }
  }

  const visibleCandidates = candidates.filter((candidate) =>
    projectionAllowed(candidate.kind, candidate.readOnly),
  );
  const totalProjectedTools = visibleCandidates.length;
  const alwaysLoadedProjectedTools = candidates.filter(
    (entry) => projectionAllowed(entry.kind, entry.readOnly) && entry.alwaysLoad,
  ).length;
  const stickyProjectedTools = candidates.filter(
    (entry) => projectionAllowed(entry.kind, entry.readOnly) && entry.sticky,
  ).length;
  const pinnedProjectedTools = candidates.filter(
    (entry) =>
      projectionAllowed(entry.kind, entry.readOnly) &&
      (entry.alwaysLoad || entry.sticky),
  ).length;
  const maxProjectedMcpTools = Math.max(
    options.maxProjectedMcpTools ?? DEFAULT_MAX_PROJECTED_MCP_TOOLS,
    pinnedProjectedTools,
  );
  const sortedCandidates = [...visibleCandidates].sort((left, right) => {
    if (left.alwaysLoad !== right.alwaysLoad) {
      return left.alwaysLoad ? -1 : 1;
    }
    if (left.sticky !== right.sticky) {
      return left.sticky ? -1 : 1;
    }
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.kind !== right.kind) {
      return left.kind.localeCompare(right.kind);
    }
    const leftKey = `${left.serverId}:${left.baseName}`;
    const rightKey = `${right.serverId}:${right.baseName}`;
    return leftKey.localeCompare(rightKey);
  });
  const selectedCandidates = sortedCandidates.slice(0, maxProjectedMcpTools);
  const tools: ProviderNativeFunctionTool[] = [];
  const selectedProjectedToolNames: string[] = [];

  for (const candidate of selectedCandidates) {
    let uniqueName = candidate.baseName;
    let suffix = 2;
    while (usedNames.has(uniqueName)) {
      uniqueName = `${candidate.baseName}_${suffix}`;
      suffix += 1;
    }
    usedNames.add(uniqueName);
    selectedProjectedToolNames.push(candidate.baseName);

    tools.push({
      type: 'function',
      name: uniqueName,
      description: candidate.description,
      parameters: candidate.parameters,
    });
    projectedMcpTools.set(uniqueName, {
      kind: candidate.kind,
      serverId: candidate.serverId,
      toolName: candidate.toolName,
      readOnly: candidate.readOnly,
      uri: candidate.uri,
    });
  }

  return {
    tools,
    projectedMcpTools,
    totalProjectedTools,
    selectedProjectedTools: selectedCandidates.length,
    alwaysLoadedProjectedTools,
    stickyProjectedTools,
    selectedProjectedToolNames,
  };
}

export function buildActionParametersSchema(type: AgentActionType): JsonSchema {
  switch (type) {
    case 'list_files':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: optionalStringSchema(
            'Optional path glob or substring filter inside the working directory.',
          ),
          maxResults: integerSchema('Optional limit for the number of returned paths.'),
        },
      };
    case 'read_file':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: nonEmptyStringSchema('Repository-relative UTF-8 text file path.'),
          startLine: integerSchema('Optional 1-based starting line.'),
          endLine: integerSchema('Optional 1-based ending line, inclusive.'),
        },
      };
    case 'search_files':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          pattern: optionalStringSchema('Optional filename/path pattern filter.'),
          query: optionalStringSchema('Optional text query to search file contents.'),
          maxResults: integerSchema('Optional limit for returned matches.'),
        },
      };
    case 'lookup_docs':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: nonEmptyStringSchema('Documentation question or search query.'),
          library: optionalStringSchema('Optional library or framework name.'),
          version: optionalStringSchema('Optional library version hint.'),
          maxResults: integerSchema('Optional limit for returned documentation matches.'),
        },
      };
    case 'search_web':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: nonEmptyStringSchema('Web search query. Use for third-party protocols, undocumented APIs, SDK/gateway schemas, or unstable external facts before guessing from local code. Prefer official docs, upstream source, raw type definitions, and maintained client implementations.'),
          limit: integerSchema('Optional limit for returned search results.'),
          backend: {
            type: 'string',
            description: 'Optional backend: auto, bing, google, duckduckgo, or wikipedia.',
          },
        },
      };
    case 'deep_research':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: nonEmptyStringSchema('Broad research prompt to send to Gemini Deep Research.'),
          systemInstruction: optionalStringSchema('Optional system instruction override.'),
          maxPolls: integerSchema('Optional max poll attempts for the long-running task.'),
          pollIntervalMs: integerSchema('Optional poll interval in milliseconds.'),
        },
      };
    case 'mcp_call_tool':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['serverId', 'toolName'],
        properties: {
          serverId: nonEmptyStringSchema('Configured MCP server id.'),
          toolName: nonEmptyStringSchema('Discovered MCP tool name.'),
          args: {
            type: 'object',
            description: 'Optional MCP tool arguments object.',
            additionalProperties: true,
          },
          readOnly: {
            type: 'boolean',
            description:
              'Set to true when the MCP tool is explicitly marked readOnly in the discovered surface.',
          },
          timeoutMs: integerSchema('Optional timeout in milliseconds.'),
        },
      };
    case 'mcp_read_resource':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['serverId', 'uri'],
        properties: {
          serverId: nonEmptyStringSchema('Configured MCP server id.'),
          uri: nonEmptyStringSchema('Discovered MCP resource URI.'),
          timeoutMs: integerSchema('Optional timeout in milliseconds.'),
        },
      };
    case 'mcp_get_prompt':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['serverId', 'promptName'],
        properties: {
          serverId: nonEmptyStringSchema('Configured MCP server id.'),
          promptName: nonEmptyStringSchema('Discovered MCP prompt/template name.'),
          args: {
            type: 'object',
            description: 'Optional MCP prompt arguments object.',
            additionalProperties: true,
          },
          timeoutMs: integerSchema('Optional timeout in milliseconds.'),
        },
      };
    case 'write_file':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
            description: 'Repository-relative file path to create or overwrite.',
          },
          content: {
            type: 'string',
            description: 'Full UTF-8 file contents to write.',
          },
        },
      };
    case 'insert_in_file':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
            description: 'Repository-relative file path to update.',
          },
          content: {
            type: 'string',
            description: 'Content to insert.',
          },
          after: nonEmptyStringSchema('Use exactly one anchor. Insert after this exact non-empty anchor string.'),
          before: nonEmptyStringSchema('Use exactly one anchor. Insert before this exact non-empty anchor string.'),
          atLine: integerSchema('Use exactly one anchor. Insert at this exact 1-based line number.'),
        },
      };
    case 'replace_in_file':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'find', 'replace'],
        properties: {
          path: nonEmptyStringSchema('Repository-relative file path to update.'),
          find: nonEmptyStringSchema('Exact text to find.'),
          replace: {
            type: 'string',
            description: 'Replacement text.',
          },
          replaceAll: {
            type: 'boolean',
            description: 'When true, replace every exact occurrence.',
          },
        },
      };
    case 'apply_patch':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['patch'],
        properties: {
          patch: nonEmptyStringSchema(
            'Patch body using *** Begin Patch / *** End Patch format.',
          ),
        },
      };
    case 'run_command':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: {
          command: nonEmptyStringSchema('Shell command to execute inside the workspace.'),
          timeoutMs: integerSchema('Optional timeout in milliseconds.'),
        },
      };
    case 'delegate_task':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'task'],
        properties: {
          role: {
            type: 'string',
            description: 'Specialist role to delegate to.',
          },
          task: nonEmptyStringSchema('Focused delegated subtask.'),
          maxTurns: integerSchema('Optional max turns for the delegated specialist.'),
          runInBackground: {
            type: 'boolean',
            description: 'Run asynchronously only when the main thread can continue without this result until a later turn. Omit or false when the next step depends on the delegated answer.',
          },
        },
      };
    case 'spawn_background_workflow':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['command', 'prompt'],
        properties: {
          command: {
            type: 'string',
            description:
              'Workflow entrypoint to run in the background: run, athena, design, niko, contest, or nidhogg.',
            enum: ['run', 'athena', 'design', 'niko', 'contest', 'nidhogg'],
          },
          prompt: nonEmptyStringSchema('Prompt to execute in the detached workflow.'),
          maxTurns: integerSchema('Optional max turns for the background workflow.'),
        },
      };
    case 'approve_builder_execution':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['sessionId'],
        properties: {
          sessionId: nonEmptyStringSchema('Builder session id to approve for execution.'),
          summary: optionalStringSchema('Optional short approval summary.'),
          maxTurns: integerSchema('Optional max turns for the builder execution pass.'),
        },
      };
    case 'odin_search_skills':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: nonEmptyStringSchema('Search query to find matching skills.'),
          scope: {
            type: 'string',
            description: 'Optional scope: local, cloud, or all (default: all).',
          },
          limit: integerSchema('Optional maximum number of results to return.'),
          autoImport: {
            type: 'boolean',
            description: 'When true, automatically import the best matching skill.',
          },
        },
      };
    case 'odin_execute_task':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['task'],
        properties: {
          task: nonEmptyStringSchema('Task description to find and execute a matching skill for.'),
          searchScope: {
            type: 'string',
            description: 'Optional scope to search for matching skills.',
          },
          maxIterations: integerSchema('Optional maximum execution iterations.'),
        },
      };
    case 'odin_fix_skill':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['skillId'],
        properties: {
          skillId: nonEmptyStringSchema('Identifier of the skill to repair.'),
          errorContext: optionalStringSchema('Optional error message or context to guide the fix.'),
          summary: optionalStringSchema('Optional short summary of the intended fix.'),
        },
      };
    case 'odin_upload_skill':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['skillId'],
        properties: {
          skillId: nonEmptyStringSchema('Identifier of the local skill to publish.'),
          visibility: {
            type: 'string',
            description: 'Visibility level for the uploaded skill.',
          },
          notes: optionalStringSchema('Optional release notes for this skill version.'),
        },
      };
    case 'odin_import_cloud_skills':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: optionalStringSchema('Optional keyword query to filter which cloud skills to import.'),
          limit: integerSchema('Maximum number of skills to import. Defaults to 10.'),
        },
      };
    case 'generate_image':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: nonEmptyStringSchema('Text description of the image to generate.'),
          model: optionalStringSchema('Optional image generation model ID. Defaults to the configured visual provider model.'),
          size: {
            type: 'string',
            description: 'Output size preset or provider-specific size. Examples: 1K, 2K, 4K, 1024x1024, 1536x1024. Default: configured visual profile size.',
          },
          quality: optionalStringSchema('Optional image quality. For gpt-image-2: low, medium, high, or auto. Default: configured visual profile quality.'),
          outputFormat: optionalStringSchema('Optional output format. For gpt-image-2: png, jpeg, or webp. Default: configured visual profile output format or png.'),
          outputCompression: {
            type: 'integer',
            minimum: 0,
            maximum: 100,
            description: 'Optional JPEG/WebP compression level, 0-100. Ignored for PNG.',
          },
          background: optionalStringSchema('Optional background mode. For gpt-image-2: auto or opaque. transparent is not supported by gpt-image-2.'),
          count: integerSchema('Number of images to generate (1-4). Default: 1.'),
          outputPath: optionalStringSchema('Local path to save the image. Default: .artemis/images/{timestamp}.png (relative to cwd).'),
          watermark: {
            type: 'boolean',
            description: 'Request a provider watermark when supported. Default: configured visual profile setting.',
          },
          runInBackground: {
            type: 'boolean',
            description: 'Run asynchronously only when the generated file path is not needed before the next user turn. Omit or false when the current answer/workflow needs the image result.',
          },
        },
      };
    case 'generate_video':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: nonEmptyStringSchema('Text description of the video to generate.'),
          model: optionalStringSchema('Optional video generation model name.'),
          ratio: optionalStringSchema('Optional aspect ratio (e.g., 16:9).'),
          duration: integerSchema('Optional duration in seconds (1-60).'),
          outputPath: optionalStringSchema('Optional local file path to save the generated video.'),
          referenceImageUrls: {
            type: 'array',
            description: 'Optional image reference URLs. The runtime sends them only to video models that accept image references.',
            items: { type: 'string' },
          },
          referenceVideoUrls: {
            type: 'array',
            description: 'Optional video reference URLs. The runtime sends them only to video models that accept video references.',
            items: { type: 'string' },
          },
          referenceAudioUrls: {
            type: 'array',
            description: 'Optional audio reference URLs. The runtime sends them only to video models that accept audio references.',
            items: { type: 'string' },
          },
          referenceImagePaths: {
            type: 'array',
            description: 'Optional local image reference paths. The runtime converts supported images to data URLs before sending them to compatible video models.',
            items: { type: 'string' },
          },
          referenceVideoPaths: {
            type: 'array',
            description: 'Optional local video reference paths. Requires a future upload/asset hosting step before models that require URLs can use them.',
            items: { type: 'string' },
          },
          referenceAudioPaths: {
            type: 'array',
            description: 'Optional local audio reference paths. Requires a future upload/asset hosting step before models that require URLs can use them.',
            items: { type: 'string' },
          },
          firstFrameImageUrls: {
            type: 'array',
            description: 'role:"first_frame" image URLs (literal first frame of the video). Bypasses the real-person privacy filter; use when the user supplies a real-person photo and wants it preserved literally as frame 1.',
            items: { type: 'string' },
          },
          firstFrameImagePaths: {
            type: 'array',
            description: 'role:"first_frame" local image paths. Same semantics as firstFrameImageUrls.',
            items: { type: 'string' },
          },
          lastFrameImageUrls: {
            type: 'array',
            description: 'role:"last_frame" image URLs (anchor closing frame).',
            items: { type: 'string' },
          },
          lastFrameImagePaths: {
            type: 'array',
            description: 'role:"last_frame" local image paths.',
            items: { type: 'string' },
          },
          generateAudio: {
            type: 'boolean',
            description: 'Optional flag to generate audio narration.',
          },
          watermark: {
            type: 'boolean',
            description: 'Optional flag to add a watermark.',
          },
          maxPolls: integerSchema('Optional max poll attempts.'),
          pollIntervalMs: integerSchema('Optional poll interval in milliseconds.'),
          runInBackground: {
            type: 'boolean',
            description: 'Run asynchronously only when the generated file path is not needed before the next user turn. Omit or false when the current answer/workflow needs the video result.',
          },
        },
      };
    case 'generate_long_video':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: nonEmptyStringSchema('Full user story (any length). Saga splits it into provider-safe shots, applies the continuity engine, and assembles a final MP4.'),
          title: optionalStringSchema('Concise, human-searchable video title. Used in default filenames and metadata so users can find the video later by title/date/time.'),
          story: optionalStringSchema('Optional separate story field. Falls back to prompt when omitted.'),
          referenceNotes: { type: 'array', description: 'Optional user notes describing supplied references, e.g. "this image is the character identity". Use them to set continuity; do not ignore them.', items: { type: 'string' } },
          shots: {
            type: 'array',
            description: 'Optional structured shot list. Each shot may include title, duration, storyBeat, visualPrompt, camera, continuity, transition, transitionKind, prompt.',
            items: { type: 'object' },
          },
          continuity: {
            type: 'object',
            description: 'Optional continuity bible: characters, wardrobe, props, locations, palette, lighting, cameraLanguage, mood. Saga treats character identity as a global hard rule; location/scene locks should be supplied only when the story needs scene consistency.',
          },
          model: optionalStringSchema('Optional video generation model. Defaults to the configured visual provider.'),
          ratio: optionalStringSchema('Optional aspect ratio: 16:9 / 9:16 / 1:1.'),
          duration: integerSchema('Optional total duration in seconds.'),
          totalDuration: integerSchema('Optional total duration in seconds (preferred over duration).'),
          projectId: optionalStringSchema('Optional Saga project id. Used to resume a previous run.'),
          outputPath: optionalStringSchema('Optional final MP4 output path. Omit this unless the user explicitly requested a location; Saga otherwise creates a unique searchable filename.'),
          assemblyMode: optionalStringSchema('Optional renderer mode: auto | ffmpeg | hyperframes | saga.'),
          resume: { type: 'boolean', description: 'Reuse previously generated segments when true (default true).' },
          chainReferenceFrames: optionalStringSchema('Frame chaining policy: auto (default) | always | off.'),
          continuityMode: optionalStringSchema('Continuity mode: auto (default) | strong-vision | text-only.'),
          crossfadeMs: integerSchema('Default transition duration in milliseconds.'),
          defaultTransition: optionalStringSchema('Default transition kind. See SagaTransitionKind catalog.'),
          colorMatch: { type: 'boolean', description: 'Apply colorbalance matching across segments.' },
          quality: optionalStringSchema('Render quality: draft | standard | high.'),
          fps: integerSchema('Render fps: 24 | 30 | 60.'),
          gpu: optionalStringSchema('GPU policy: auto | on | off.'),
          videoBitrate: optionalStringSchema('Optional bitrate spec, e.g. 10M.'),
          crf: integerSchema('Optional CRF override (0-63).'),
          referenceImageUrls: { type: 'array', description: 'Optional image reference URLs. Saga treats character/person references as global identity anchors across every segment.', items: { type: 'string' } },
          referenceVideoUrls: { type: 'array', description: 'Optional video reference URLs for the first segment.', items: { type: 'string' } },
          referenceAudioUrls: { type: 'array', description: 'Optional audio reference URLs for the first segment.', items: { type: 'string' } },
          referenceImagePaths: { type: 'array', description: 'Optional local image reference paths. Saga treats character/person references as global identity anchors across every segment.', items: { type: 'string' } },
          referenceVideoPaths: { type: 'array', description: 'Optional local video reference paths for the first segment.', items: { type: 'string' } },
          referenceAudioPaths: { type: 'array', description: 'Optional local audio reference paths for the first segment.', items: { type: 'string' } },
          firstFrameImageUrls: { type: 'array', description: 'role:"first_frame" image URLs (literal first frame of the video). Bypasses the real-person privacy filter that role:"reference_image" enforces. Use when the user supplies a real-person photo and you want it preserved literally as frame 1.', items: { type: 'string' } },
          firstFrameImagePaths: { type: 'array', description: 'role:"first_frame" local image paths.', items: { type: 'string' } },
          lastFrameImageUrls: { type: 'array', description: 'role:"last_frame" image URLs (anchor closing frame).', items: { type: 'string' } },
          lastFrameImagePaths: { type: 'array', description: 'role:"last_frame" local image paths.', items: { type: 'string' } },
          generateAudio: { type: 'boolean', description: 'Default true. Saga retries with audio off when a provider safety filter rejects.' },
          watermark: { type: 'boolean', description: 'Optional watermark flag.' },
          maxPolls: integerSchema('Optional max poll attempts per segment.'),
          pollIntervalMs: integerSchema('Optional poll interval per segment.'),
          runInBackground: { type: 'boolean', description: 'Run asynchronously when the generated file path is not needed before the next user turn.' },
          narrativeEntities: {
            type: 'object',
            description: 'Saga narrative entity map. The Saga workflow ALREADY computes this from the user input and embeds it in the [Saga Narrative Entity Map] block of the prompt. Pass it through verbatim — it drives the pre-flight critic that detects protagonist hijacking, prop fatigue, and other narrative violations, and powers the self-dialogue rewriter that fixes them. Do NOT invent or omit fields.',
            properties: {
              protagonist: {
                type: 'object',
                description: 'The "god" of the video — the entity every shot must orbit around.',
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['character', 'product', 'environment'] },
                  confidence: { type: 'number' },
                  evidence: { type: 'string' },
                },
              },
              supportingCharacters: { type: 'array', items: { type: 'string' } },
              props: { type: 'array', items: { type: 'string' } },
              environments: { type: 'array', items: { type: 'string' } },
              relationships: { type: 'array', items: { type: 'string' } },
              actions: { type: 'array', items: { type: 'string' } },
              mode: { type: 'string', enum: ['character', 'product', 'environment', 'mixed', 'unclear'] },
              modeRationale: { type: 'string' },
              source: { type: 'string', enum: ['llm', 'user-clarification', 'keyword-fallback'] },
            },
          },
        },
      };
    case 'synthesize_speech':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: nonEmptyStringSchema('Text to synthesize into speech.'),
          voice: optionalStringSchema('Optional Microsoft Edge voice name, e.g. en-US-AriaNeural or zh-CN-XiaoxiaoNeural. Defaults to setup configuration.'),
          language: optionalStringSchema('Optional BCP-47 language code, e.g. en-US or zh-CN.'),
          outputPath: optionalStringSchema('Optional local MP3 output path. Defaults to .artemis/tts/{timestamp}.mp3 relative to cwd.'),
          playAudio: {
            type: 'boolean',
            description: 'On macOS, play the generated MP3 after synthesis. Default: false for tool calls.',
          },
          rate: {
            type: 'number',
            minimum: 0.5,
            maximum: 2,
            description: 'Speech rate multiplier. 1 is normal.',
          },
          pitch: {
            type: 'number',
            minimum: 0.5,
            maximum: 2,
            description: 'Speech pitch multiplier. 1 is normal.',
          },
        },
      };
    case 'transcribe_audio':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['inputPath'],
        properties: {
          inputPath: nonEmptyStringSchema('Local audio file path to transcribe. Supports formats accepted by the installed local Whisper engine.'),
          language: optionalStringSchema('Optional language hint, e.g. en, zh, ja. Empty lets Whisper auto-detect.'),
          model: {
            type: 'string',
            enum: ['tiny', 'base', 'small', 'medium', 'large-v3'],
            description: 'Local Whisper model size. Defaults to setup configuration or base.',
          },
          modelPath: optionalStringSchema('Optional whisper.cpp ggml model path, e.g. /path/to/ggml-base.bin.'),
          engine: {
            type: 'string',
            enum: ['auto', 'whisper.cpp', 'openai-whisper'],
            description: 'Local engine selection. auto tries whisper.cpp first, then Python whisper.',
          },
          command: optionalStringSchema('Optional executable path/name override, e.g. whisper-cli or whisper.'),
        },
      };
    case 'request_freya_visual_asset':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['assetType', 'contextDescription'],
        properties: {
          assetType: {
            type: 'string',
            description: 'Type of visual asset to request (image, video, or icon).',
            enum: ['image', 'video', 'icon'],
          },
          contextDescription: nonEmptyStringSchema('Detailed description of the UI or component context.'),
          preferredStyle: optionalStringSchema('Optional preferred visual style.'),
        },
      };
    case 'agent':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            description: 'Agent management action.',
            enum: ['create', 'list', 'run', 'stop', 'status', 'result'],
          },
          id: optionalStringSchema('Optional agent id.'),
          name: optionalStringSchema('Optional agent name.'),
          description: optionalStringSchema('Optional agent description.'),
          task: optionalStringSchema('Optional task for create/run flows.'),
          context: {
            type: 'object',
            description: 'Optional JSON object to pass as agent context.',
            additionalProperties: true,
          },
          toolsets: {
            type: 'array',
            description: 'Optional list of toolset names to scope the agent.',
            items: { type: 'string' },
          },
          timeout: integerSchema('Optional timeout in milliseconds.'),
          maxIterations: integerSchema('Optional maximum iterations.'),
          priority: {
            type: 'string',
            description: 'Optional scheduling priority.',
            enum: ['low', 'medium', 'high'],
          },
        },
      };
    // ── Spotify integration ──────────────────────────────────────────────
    case 'spotify_play_liked':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          shuffle: { type: 'boolean', description: 'Whether to shuffle the queue. Default: true.' },
          deviceHint: optionalStringSchema('Optional device name substring (e.g. "MacBook" or "HomePod"). Default: smart pick.'),
        },
      };
    case 'spotify_search_and_play':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: nonEmptyStringSchema('Search query (artist, song, mood, genre, etc.).'),
          kind: { type: 'string', enum: ['track', 'playlist', 'auto'], description: 'What to prefer. auto = playlist first then track. Default: auto.' },
          deviceHint: optionalStringSchema('Optional device name substring. Default: smart pick.'),
        },
      };
    case 'spotify_play_playlist':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: nonEmptyStringSchema('Playlist name (matches user own first, then public).'),
          deviceHint: optionalStringSchema('Optional device name substring.'),
        },
      };
    case 'spotify_resume':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          deviceHint: optionalStringSchema('Optional device name substring.'),
        },
      };
    case 'spotify_pause':
    case 'spotify_skip_next':
    case 'spotify_skip_previous':
    case 'spotify_now_playing':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {},
      };
    case 'spotify_set_volume':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['volume'],
        properties: {
          volume: { type: 'integer', minimum: 0, maximum: 100, description: 'Volume percent (0-100).' },
        },
      };
    case 'spotify_set_device':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['deviceHint'],
        properties: {
          deviceHint: nonEmptyStringSchema('Device name substring (e.g. "HomePod", "MacBook Pro").'),
          startPlaying: { type: 'boolean', description: 'Whether to start playback after transfer. Default: false.' },
        },
      };

    // ── Ambient agent: weather ───────────────────────────────────────
    case 'weather_current':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['location'],
        properties: {
          location: nonEmptyStringSchema('City name (Chinese or English) or "lat,lng".'),
        },
      };
    case 'weather_forecast':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['location'],
        properties: {
          location: nonEmptyStringSchema('City name or "lat,lng".'),
          days: { type: 'integer', minimum: 1, maximum: 3, description: 'Number of days (1-3). Default: 3.' },
        },
      };

    // ── Ambient agent: world clock ───────────────────────────────────
    case 'world_clock':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['cities'],
        properties: {
          cities: {
            type: 'array',
            description: 'List of city names or IANA timezones (e.g. ["Bangkok", "Asia/Tokyo", "纽约"]).',
            items: { type: 'string' },
            minItems: 1,
          },
        },
      };
    case 'time_diff':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['fromCity', 'toCity'],
        properties: {
          fromCity: nonEmptyStringSchema('Source city or timezone.'),
          toCity: nonEmptyStringSchema('Target city or timezone.'),
        },
      };

    // ── Ambient agent: currency ──────────────────────────────────────
    case 'currency_convert':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['amount', 'from', 'to'],
        properties: {
          amount: { type: 'number', description: 'Amount to convert.' },
          from: nonEmptyStringSchema('Source ISO 4217 currency code (USD, CNY, THB, EUR...).'),
          to: nonEmptyStringSchema('Target ISO 4217 currency code.'),
        },
      };
    case 'currency_rates':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['base'],
        properties: {
          base: nonEmptyStringSchema('Base ISO 4217 currency code.'),
          targets: {
            type: 'array',
            description: 'Optional list of target currencies. Defaults to common ones.',
            items: { type: 'string' },
          },
        },
      };

    // ── Ambient agent: flight tracking ───────────────────────────────
    case 'flight_lookup':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['callsign'],
        properties: {
          callsign: nonEmptyStringSchema('Flight number / callsign (e.g. "TG681", "BA12", "CA988").'),
        },
      };

    // ── Apple Calendar (macOS) ───────────────────────────────────────
    case 'calendar_list_today':
      return { type: 'object', additionalProperties: false, properties: {} };
    case 'calendar_list_upcoming':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          daysAhead: { type: 'integer', minimum: 1, maximum: 30, description: 'How many days ahead to look. Default: 7.' },
        },
      };
    case 'calendar_add_event':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'startISO'],
        properties: {
          title: nonEmptyStringSchema('Event title.'),
          startISO: nonEmptyStringSchema('Start time in ISO 8601 (e.g. "2026-04-29T19:00:00").'),
          endISO: optionalStringSchema('Optional end time ISO 8601. Defaults to start + 1 hour.'),
          notes: optionalStringSchema('Optional event notes / description.'),
          calendarName: optionalStringSchema('Optional calendar name. Defaults to first writable calendar.'),
        },
      };

    // ── Apple Reminders (macOS) ──────────────────────────────────────
    case 'reminders_list':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          list: optionalStringSchema('Optional reminder list name. Default: all lists.'),
          includeCompleted: { type: 'boolean', description: 'Include completed reminders. Default: false.' },
        },
      };
    case 'reminders_add':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: nonEmptyStringSchema('Reminder title.'),
          list: optionalStringSchema('Optional list name. Default: default list.'),
          dueISO: optionalStringSchema('Optional due date in ISO 8601.'),
          notes: optionalStringSchema('Optional notes.'),
        },
      };
    case 'reminders_complete':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          title: nonEmptyStringSchema('Reminder title to mark completed (exact match preferred, then substring).'),
          list: optionalStringSchema('Optional list name to scope the search.'),
        },
      };

    // ── Browser automation ─────────────────────────────────────────────
    case 'browser_navigate':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: nonEmptyStringSchema('URL to navigate to (must include scheme).'),
          waitFor: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle'], description: 'Page lifecycle event to wait for. Default: domcontentloaded.' },
          extractText: { type: 'boolean', description: 'Whether to also extract visible body text in the response. Default: true.' },
        },
      };
    case 'browser_screenshot':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          fullPage: { type: 'boolean', description: 'Capture full scrollable page. Default: false (viewport only).' },
          width: { type: 'number', description: 'Optional viewport width before capture, e.g. 1440 for desktop or 390 for mobile.' },
          height: { type: 'number', description: 'Optional viewport height before capture, e.g. 900 for desktop or 844 for mobile.' },
        },
      };
    case 'browser_extract_text':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: optionalStringSchema('Optional CSS selector. Default: extract entire body innerText.'),
        },
      };
    case 'browser_click':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: optionalStringSchema('CSS selector for the target element.'),
          text: optionalStringSchema('Alternatively, visible text content of the clickable element.'),
        },
      };
    case 'browser_type':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['selector', 'text'],
        properties: {
          selector: nonEmptyStringSchema('CSS selector for the input field.'),
          text: { type: 'string', description: 'Text to type.' },
          pressEnter: { type: 'boolean', description: 'Press Enter after typing. Default: false.' },
        },
      };
    case 'browser_wait_for':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          selector: optionalStringSchema('CSS selector to wait for.'),
          text: optionalStringSchema('Visible text to wait for.'),
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 60000, description: 'Timeout in milliseconds. Default: 15000.' },
        },
      };
    case 'browser_close':
      return { type: 'object', additionalProperties: false, properties: {} };

    // ── MCP self-management ────────────────────────────────────────────
    case 'mcp_list':
      return {
        type: 'object',
        additionalProperties: false,
        properties: {
          filter: optionalStringSchema('Optional substring filter (matches id or surface name).'),
          status: { type: 'string', enum: ['all', 'enabled', 'disabled'], description: 'Filter by status. Default: all.' },
        },
      };
    case 'mcp_enable':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: nonEmptyStringSchema('MCP server id (use mcp_list / mcp_suggest to find).'),
        },
      };
    case 'mcp_disable':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: nonEmptyStringSchema('MCP server id.'),
        },
      };
    case 'mcp_suggest':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['intent'],
        properties: {
          intent: nonEmptyStringSchema('Natural-language description of what you want to do (e.g. "flight search", "git operations").'),
        },
      };
    case 'bridge_send_video':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['videoPath'],
        properties: {
          videoPath: nonEmptyStringSchema('Local MP4 video file path to send as a real attachment. Use exactly "latest_dream_video" when the user asks to receive the latest Artemis dream video.'),
          caption: optionalStringSchema('Optional caption shown with the video.'),
          platform: {
            type: 'string',
            enum: ['telegram', 'discord', 'wechat', 'all'],
            description: 'Target platform. Defaults to all.',
          },
          targetId: optionalStringSchema('Optional platform target id/chat id/channel id. Defaults to configured or live bridge targets.'),
        },
      };
    case 'bridge_send_image':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['imagePath'],
        properties: {
          imagePath: nonEmptyStringSchema('Local image file path to send as a real attachment. Images only. Use exactly "latest_dream" for latest Artemis dream image. If the user mentions video, MP4, dream video, or latest_dream_video, use bridge_send_video instead.'),
          caption: optionalStringSchema('Optional caption shown with the image.'),
          platform: {
            type: 'string',
            enum: ['telegram', 'discord', 'wechat', 'all'],
            description: 'Target platform. Defaults to all.',
          },
          targetId: optionalStringSchema('Optional platform target id/chat id/channel id. Defaults to configured or live bridge targets.'),
        },
      };
  default:
    return { type: 'object', properties: {}, additionalProperties: true };
  }
}

export function buildProviderNativeFunctionTools(
  allowedActionTypes?: readonly AgentActionType[],
): ProviderNativeFunctionTool[] {
  if (allowedActionTypes) {
    const allowed = new Set(allowedActionTypes);
    return getProviderCallableActionTypes()
      .filter((type) => allowed.has(type))
      .map((type) => {
        const tool = getToolDefinition(type);
        return {
          type: 'function',
          name: type,
          description: tool?.description || `Tool for ${type}`,
          parameters: buildActionParametersSchema(type),
        };
      });
  }

  if (!cachedBuiltInTools) {
    cachedBuiltInTools = getProviderCallableActionTypes().map((type) => {
      const tool = getToolDefinition(type);
      return {
        type: 'function',
        name: type,
        description: tool?.description || `Tool for ${type}`,
        parameters: buildActionParametersSchema(type),
      };
    });
  }

  return cachedBuiltInTools;
}

export async function buildProviderNativeToolRuntime(
  cwd: string,
  options: BuildProviderNativeToolRuntimeOptions = {},
): Promise<ProviderNativeToolRuntime> {
  const builtInTools = buildProviderNativeFunctionTools(options.allowedActionTypes);
  const store = new McpServerStore(cwd);
  if (!(await store.exists())) {
    return {
      tools: builtInTools,
      projectedMcpTools: new Map(),
      totalProjectedTools: 0,
      selectedProjectedTools: 0,
      alwaysLoadedProjectedTools: 0,
      stickyProjectedTools: 0,
      selectedProjectedToolNames: [],
    };
  }
  const data = await store.load();
  const projected = buildProjectedMcpFunctionTools(data.servers, options);
  return {
    tools: [...builtInTools, ...projected.tools],
    projectedMcpTools: projected.projectedMcpTools,
    totalProjectedTools: projected.totalProjectedTools,
    selectedProjectedTools: projected.selectedProjectedTools,
    alwaysLoadedProjectedTools: projected.alwaysLoadedProjectedTools,
    stickyProjectedTools: projected.stickyProjectedTools,
    selectedProjectedToolNames: projected.selectedProjectedToolNames,
  };
}

export function mapProviderNativeToolCallToAction(
  call: ProviderNativeToolCall,
  projectedMcpTools?: ReadonlyMap<string, ProviderNativeMcpProjection>,
):
  | { ok: true; action: AgentAction }
  | { ok: false; error: ToolError } {
  const providerCallableTools = getProviderCallableActionTypes();
  const projectedMcpTool = projectedMcpTools?.get(call.name);

  let parsedArguments: unknown = {};
  try {
    parsedArguments = call.arguments.trim()
      ? JSON.parse(call.arguments)
      : {};
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'tool_invalid_json',
        message: `Tool ${call.name} arguments were not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      },
    };
  }

  if (!parsedArguments || typeof parsedArguments !== 'object' || Array.isArray(parsedArguments)) {
    return {
      ok: false,
      error: {
        code: 'tool_invalid_arguments',
        message: `Tool ${call.name} arguments must decode to a JSON object.`,
        retryable: true,
      },
    };
  }

  if (projectedMcpTool) {
    const action: AgentAction =
      projectedMcpTool.kind === 'tool'
        ? {
            type: 'mcp_call_tool',
            serverId: projectedMcpTool.serverId,
            toolName: projectedMcpTool.toolName,
            args: parsedArguments as Record<string, unknown>,
            readOnly: projectedMcpTool.readOnly,
          }
        : projectedMcpTool.kind === 'prompt'
          ? {
              type: 'mcp_get_prompt',
              serverId: projectedMcpTool.serverId,
              promptName: projectedMcpTool.toolName,
              args: parsedArguments as Record<string, unknown>,
            }
          : {
              type: 'mcp_read_resource',
              serverId: projectedMcpTool.serverId,
              uri: projectedMcpTool.uri ?? projectedMcpTool.toolName,
            };
    const validationErrors = validateToolAction(action);
    if (validationErrors.length > 0) {
      return {
        ok: false,
        error: {
          code: 'tool_invalid_arguments',
          message: [
            `Invalid arguments for tool ${call.name}:`,
            ...validationErrors.map((entry) => `- ${entry}`),
          ].join('\n'),
          retryable: true,
          details: {
            errors: validationErrors,
          },
        },
      };
    }

    return {
      ok: true,
      action,
    };
  }

  if (!providerCallableTools.includes(call.name as AgentActionType)) {
    return {
      ok: false,
      error: {
        code: 'tool_unavailable',
        message: `Unsupported native tool call: ${call.name}`,
        retryable: true,
        availableTools: providerCallableTools,
      },
    };
  }

  const action = {
    type: call.name,
    ...parsedArguments,
  } as AgentAction;
  const validationErrors = validateToolAction(action);
  if (validationErrors.length > 0) {
    return {
      ok: false,
      error: {
        code: 'tool_invalid_arguments',
        message: [
          `Invalid arguments for tool ${call.name}:`,
          ...validationErrors.map((entry) => `- ${entry}`),
        ].join('\n'),
        retryable: true,
        details: {
          errors: validationErrors,
        },
      },
    };
  }

  return {
    ok: true,
    action,
  };
}
