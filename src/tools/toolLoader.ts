/**
 * WP-18 phase 1: built-in tool lazy loading.
 *
 * `load_tools` returns the full usage schema of registered tools on demand so
 * that, once the manifest switches to core-only (phase 2), the model can fetch
 * schemas for on-demand tools instead of guessing parameters.
 *
 * Circular-import note:
 * - registry.ts imports this module to put `load_tools` into `toolDefs`.
 * - This module therefore must NOT statically import runtime values from
 *   registry.ts. Registry lookups are injected via `createLoadToolsToolDef(deps)`.
 * - providerNativeTools.ts (schema builder) is loaded lazily via dynamic import
 *   inside `execute`, because it is likely to depend on the registry itself.
 * - Type-only imports are erased at compile time and are safe.
 */

import type { AgentAction, AgentActionType } from '../core/types.js';
import { ALL_AGENT_ACTION_TYPES } from '../core/types.js';
import type { ToolDefinition, ToolKind } from '../core/toolDef.js';
import type { ToolLoadTier } from './registry.js';

export const LOAD_TOOLS_TYPE = 'load_tools' as const;
export const LOAD_TOOLS_MAX_PER_CALL = 10;
export const NO_STRUCTURED_SCHEMA_NOTE = 'no structured input schema; see description';

export interface ToolLoaderDeps {
  /** Registry lookup. Called lazily at validate/execute time, never at module load. */
  getToolDefinition: (toolType: string) => ToolDefinition | undefined;
  getToolLoadTier: (toolType: string) => ToolLoadTier;
  isToolAvailableForProvider: (toolType: string) => boolean;
}

export interface LoadedToolSchema {
  type: string;
  description: string;
  kind: ToolKind;
  permissionCategory: ToolDefinition['permissionCategory'];
  executionMode: ToolDefinition['executionMode'];
  parallelSafe: boolean;
  loadTier: ToolLoadTier;
  /** Whether the tool can be invoked as an action by the model. */
  providerCallable: boolean;
  searchHint?: string;
  tags?: string[];
  /** JSON schema of the action input; null when no structured schema exists. */
  inputSchema: unknown | null;
  inputSchemaNote?: string;
}

export interface LoadToolsResultData {
  tools: LoadedToolSchema[];
  unknown: string[];
}

type SchemaBuilder = (type: AgentActionType) => unknown;

// ---------------------------------------------------------------------------
// Lazy helpers
// ---------------------------------------------------------------------------

let actionTypeSetCache: ReadonlySet<string> | undefined;

function getActionTypeSet(): ReadonlySet<string> {
  if (!actionTypeSetCache) {
    // Works whether ALL_AGENT_ACTION_TYPES is a readonly array or a Set.
    actionTypeSetCache = new Set<string>(ALL_AGENT_ACTION_TYPES as Iterable<string>);
  }
  return actionTypeSetCache;
}

let schemaBuilderPromise: Promise<SchemaBuilder | null> | undefined;

// ---------------------------------------------------------------------------
// WP-18 phase 2: session-level loaded-tool cache.
// ---------------------------------------------------------------------------
// Maps sessionId -> (toolName -> LoadedToolSchema). A tool loaded once in a
// session is served from cache on subsequent load_tools calls, avoiding
// redundant schema builds. Keyed by sessionId string (from
// ToolExecutionContext.sessionId) rather than Session object to avoid a
// circular import with core/session.ts. Entries live as long as the process;
// call clearLoadedToolSchemas(sessionId) on session teardown, or
// clearLoadedToolSchemas() to drop everything (e.g. in tests).
const sessionLoadedSchemas = new Map<string, Map<string, LoadedToolSchema>>();

export function getLoadedToolSchemasForSession(sessionId: string): ReadonlyMap<string, LoadedToolSchema> {
  return sessionLoadedSchemas.get(sessionId) ?? new Map();
}

export function clearLoadedToolSchemas(sessionId?: string): void {
  if (sessionId === undefined) {
    sessionLoadedSchemas.clear();
  } else {
    sessionLoadedSchemas.delete(sessionId);
  }
}

function cacheLoadedSchemas(sessionId: string | undefined, tools: LoadedToolSchema[]): void {
  if (!sessionId) return;
  let perSession = sessionLoadedSchemas.get(sessionId);
  if (!perSession) {
    perSession = new Map();
    sessionLoadedSchemas.set(sessionId, perSession);
  }
  for (const tool of tools) {
    perSession.set(tool.type, tool);
  }
}

function loadSchemaBuilder(): Promise<SchemaBuilder | null> {
  if (!schemaBuilderPromise) {
    schemaBuilderPromise = import('../core/providerNativeTools.js')
      .then((mod) =>
        typeof mod.buildActionParametersSchema === 'function'
          ? (mod.buildActionParametersSchema as SchemaBuilder)
          : null,
      )
      .catch(() => {
        // Allow a retry on the next call instead of caching the failure forever.
        schemaBuilderPromise = undefined;
        return null;
      });
  }
  return schemaBuilderPromise;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

function readRawToolsField(action: AgentAction): unknown {
  return (action as unknown as { tools?: unknown }).tools;
}

interface ParsedRequest {
  errors: string[];
  /** Trimmed, de-duplicated names in request order. Empty when errors exist. */
  names: string[];
}

function parseRequestedTools(raw: unknown): ParsedRequest {
  const errors: string[] = [];

  if (!Array.isArray(raw)) {
    return { errors: ['load_tools: "tools" must be an array of tool names.'], names: [] };
  }
  if (raw.length === 0) {
    return { errors: ['load_tools: "tools" must contain at least one tool name.'], names: [] };
  }
  if (raw.length > LOAD_TOOLS_MAX_PER_CALL) {
    errors.push(
      `load_tools: at most ${LOAD_TOOLS_MAX_PER_CALL} tools per call (got ${raw.length}). Split into multiple calls.`,
    );
  }

  const names: string[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`load_tools: tools[${index}] must be a non-empty string.`);
      return;
    }
    const name = item.trim();
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  });

  return errors.length > 0 ? { errors, names: [] } : { errors, names };
}

// ---------------------------------------------------------------------------
// Schema assembly
// ---------------------------------------------------------------------------

function buildLoadedToolSchema(
  name: string,
  def: ToolDefinition,
  deps: ToolLoaderDeps,
  schemaBuilder: SchemaBuilder | null,
): LoadedToolSchema {
  const entry: LoadedToolSchema = {
    type: def.type,
    description: def.description,
    kind: def.kind,
    permissionCategory: def.permissionCategory,
    executionMode: def.executionMode,
    parallelSafe: def.parallelSafe,
    loadTier: deps.getToolLoadTier(name),
    providerCallable: safeBool(() => deps.isToolAvailableForProvider(name)),
    inputSchema: null,
  };
  if (def.searchHint) entry.searchHint = def.searchHint;
  if (def.tags && def.tags.length > 0) entry.tags = [...def.tags];

  if (!getActionTypeSet().has(name)) {
    entry.inputSchemaNote = NO_STRUCTURED_SCHEMA_NOTE;
    return entry;
  }

  if (!schemaBuilder) {
    entry.inputSchemaNote = `schema builder unavailable; ${NO_STRUCTURED_SCHEMA_NOTE}`;
    return entry;
  }

  try {
    entry.inputSchema = schemaBuilder(name as AgentActionType) ?? null;
    if (entry.inputSchema === null) entry.inputSchemaNote = NO_STRUCTURED_SCHEMA_NOTE;
  } catch (error) {
    entry.inputSchema = null;
    entry.inputSchemaNote = `failed to build input schema (${errorMessage(error)}); ${NO_STRUCTURED_SCHEMA_NOTE}`;
  }
  return entry;
}

function safeBool(fn: () => boolean): boolean {
  try {
    return fn();
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// ToolDefinition factory
// ---------------------------------------------------------------------------

const LOAD_TOOLS_DESCRIPTION = [
  'Fetch the full usage schema of tools that are not listed in full in the tool manifest.',
  'When you need a tool that is not currently listed in full, call load_tools first with the tool names',
  `(up to ${LOAD_TOOLS_MAX_PER_CALL} per call) to get each tool's description, kind, permission category,`,
  'execution mode, parallel safety and input parameter schema, then call the tool.',
  'Do not guess parameters for a tool you have not loaded; always load first.',
  'Input: { "tools": ["tool_name", ...] }. Unknown names are reported in `unknown` and do not block the others.',
].join(' ');

export function createLoadToolsToolDef(deps: ToolLoaderDeps): ToolDefinition {
  return {
    type: LOAD_TOOLS_TYPE,
    description: LOAD_TOOLS_DESCRIPTION,
    kind: 'function',
    permissionCategory: 'read',
    executionMode: 'blocking',
    parallelSafe: true,
    searchHint: 'load tool schema, fetch tool usage, on-demand tools, tool parameters',
    tags: ['meta', 'tools', 'lazy-loading'],

    validate(action: AgentAction): string[] {
      const { errors, names } = parseRequestedTools(readRawToolsField(action));
      if (errors.length > 0) return errors;

      // Partially unknown requests are allowed through: execute reports them in
      // `unknown` without blocking the known ones. Only a request where *every*
      // name is unknown is rejected, since there is nothing to load.
      const unknown = names.filter((name) => !deps.getToolDefinition(name));
      if (unknown.length === names.length) {
        return [
          `load_tools: none of the requested tools exist: ${unknown.join(', ')}. ` +
            'Use tool names exactly as listed in the tool manifest.',
        ];
      }
      return [];
    },

    async execute(
      action: AgentAction,
      context?: any,
    ): Promise<{ success: boolean; data?: LoadToolsResultData; error?: string }> {
      const { errors, names } = parseRequestedTools(readRawToolsField(action));
      if (errors.length > 0) {
        // Defensive: validate normally runs first; never throw from execute.
        return { success: false, error: errors.join('\n') };
      }

      const sessionId: string | undefined =
        typeof context?.sessionId === 'string' ? context.sessionId : undefined;
      const cached = sessionId ? sessionLoadedSchemas.get(sessionId) : undefined;

      const schemaBuilder = await loadSchemaBuilder();
      const tools: LoadedToolSchema[] = [];
      const unknown: string[] = [];
      const freshlyBuilt: LoadedToolSchema[] = [];

      for (const name of names) {
        const hit = cached?.get(name);
        if (hit) {
          tools.push(hit);
          continue;
        }
        const def = deps.getToolDefinition(name);
        if (!def) {
          unknown.push(name);
          continue;
        }
        const schema = buildLoadedToolSchema(name, def, deps, schemaBuilder);
        tools.push(schema);
        freshlyBuilt.push(schema);
      }

      // Cache freshly built schemas for this session so repeat loads are free.
      cacheLoadedSchemas(sessionId, freshlyBuilt);

      return { success: true, data: { tools, unknown } };
    },
  };
}
