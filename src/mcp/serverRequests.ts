/**
 * `src/mcp/serverRequests.ts` — server-initiated MCP requests (E1.3-5).
 *
 * Artemis is an MCP *client*: it spawns/connects to MCP servers and calls
 * their tools. The MCP protocol (2024-11-05) also defines the reverse
 * direction — a *server* may ask the *client* (us) for things:
 *
 * - `sampling/createMessage` — the server asks the client/host to run an
 *   LLM completion and return the sampled message.
 * - `elicitation/create` — the server asks the client/host to collect a
 *   small structured input from the user (a form, not free text).
 *
 * Previously `src/mcp/client.ts` advertised `capabilities: {}` and silently
 * dropped every incoming server request, so any MCP server that relies on
 * sampling or elicitation simply hung or errored. This module provides:
 *
 * 1. Protocol types for both methods (2024-11-05).
 * 2. `McpServerRequestRouter` — handler registry, capability advertisement
 *    (`buildCapabilities()`), and method routing with parameter validation
 *    and result validation.
 * 3. JSON-RPC 2.0 response builders for replying to server requests.
 * 4. `createReadlineElicitationHandler()` — an interactive TTY elicitation
 *    handler the CLI/host can opt into; declines (with an explicit notice)
 *    when headless.
 * 5. Module-level default handlers so a host can register sampling /
 *    elicitation once for every MCP transport it creates afterwards.
 * 6. Router-level limits (`McpServerRequestLimits`): a per-router cap on
 *    concurrent in-flight server requests, a per-request handler timeout,
 *    and a rolling-window rate limit on `sampling/createMessage` so a
 *    malicious server cannot trigger unbounded (costly) LLM calls. Limit
 *    rejections reply with a JSON-RPC internal error and fire the optional
 *    `onLimitHit` callback for alerting/metrics.
 *
 * Wiring: each `RpcTransport` in `client.ts` owns a router, advertises
 * `router.buildCapabilities()` in `initialize`, and routes incoming
 * server→client requests (stdio frames, SSE stream entries, Streamable HTTP
 * SSE frames) back through the router, posting/writing the JSON-RPC reply
 * on the same transport.
 *
 * Ordering note: register handlers (via the module defaults or the
 * per-transport setters) *before* the first MCP request for a server, since
 * `initialize` is cached and capabilities are advertised once.
 */

import * as readline from 'node:readline';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 helpers
// ---------------------------------------------------------------------------

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;

export function buildJsonRpcResult(
  id: JsonRpcId,
  result: unknown,
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

export function buildJsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Sampling (server -> client: "please run an LLM completion for me")
// MCP 2024-11-05 § "Sampling"
// ---------------------------------------------------------------------------

export type McpSamplingRole = 'user' | 'assistant';

export interface McpSamplingTextContent {
  type: 'text';
  text: string;
}

export interface McpSamplingImageContent {
  type: 'image';
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
}

export type McpSamplingContent =
  | McpSamplingTextContent
  | McpSamplingImageContent;

export interface McpSamplingMessage {
  role: McpSamplingRole;
  content: McpSamplingContent;
}

export interface McpModelPreferences {
  hints?: Array<{ name?: string }>;
  costPriority?: number;
  speedPriority?: number;
  intelligencePriority?: number;
}

export interface McpSamplingRequest {
  messages: McpSamplingMessage[];
  modelPreferences?: McpModelPreferences;
  systemPrompt?: string;
  /** Defaults to 'none' when omitted. */
  includeContext?: 'none' | 'thisServer' | 'allServers';
  temperature?: number;
  maxTokens: number;
  stopSequences?: string[];
  metadata?: Record<string, unknown>;
}

export interface McpSamplingResult {
  role: McpSamplingRole;
  content: McpSamplingContent;
  /** The model that produced the completion. */
  model: string;
  stopReason?: 'endTurn' | 'stopSequence' | 'maxTokens' | string;
}

// ---------------------------------------------------------------------------
// Elicitation (server -> client: "please ask the user to fill this form")
// MCP 2024-11-05 § "Elicitation"
// ---------------------------------------------------------------------------

export type McpElicitationPrimitive = 'string' | 'number' | 'integer' | 'boolean';

export interface McpElicitationPropertySchema {
  type: McpElicitationPrimitive;
  title?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: 'email' | 'uri' | 'date' | 'date-time';
  enum?: Array<string | number>;
  enumNames?: string[];
  default?: string | number | boolean;
}

export interface McpElicitationRequestSchema {
  type: 'object';
  properties: Record<string, McpElicitationPropertySchema>;
  required?: string[];
}

export interface McpElicitationRequest {
  /** Human-readable prompt shown to the user above the form. */
  message: string;
  requestedSchema: McpElicitationRequestSchema;
}

export type McpElicitationAction = 'accept' | 'decline' | 'cancel';

export interface McpElicitationResult {
  action: McpElicitationAction;
  /**
   * Only present when `action === 'accept'`. Keys are a subset of the
   * requested schema's properties; values are primitives.
   */
  content?: Record<string, string | number | boolean>;
}

// ---------------------------------------------------------------------------
// Handler interfaces
// ---------------------------------------------------------------------------

/**
 * Context passed to server-request handlers: which server asked, over which
 * transport. Handlers run while an MCP call is in flight; keep them prompt —
 * the server is blocked waiting for the reply.
 */
export interface McpServerRequestContext {
  serverId: string;
  transport: 'stdio' | 'sse' | 'http';
}

/**
 * Fulfil a `sampling/createMessage` request, e.g. by calling the host's own
 * model. Throwing/rejecting produces a JSON-RPC internal error reply.
 */
export type McpSamplingHandler = (
  request: McpSamplingRequest,
  ctx: McpServerRequestContext,
) => Promise<McpSamplingResult>;

/**
 * Fulfil an `elicitation/create` request, e.g. by prompting the user.
 * Return `{ action: 'decline' }` when the user refuses, `{ action: 'cancel' }`
 * when they dismiss the prompt (Ctrl+C / EOF).
 */
export type McpElicitationHandler = (
  request: McpElicitationRequest,
  ctx: McpServerRequestContext,
) => Promise<McpElicitationResult>;

// ---------------------------------------------------------------------------
// Router limits
// ---------------------------------------------------------------------------

export interface McpServerRequestLimits {
  /** Max concurrent in-flight server requests per router. Default 4. */
  maxConcurrent: number;
  /** Per-request handler timeout in ms. Default 120_000. */
  handlerTimeoutMs: number;
  /** Max sampling requests per rolling window per router. Default 60. */
  maxSamplingPerWindow: number;
  /** Rolling window length in ms for the sampling rate limit. Default 60_000. */
  samplingWindowMs: number;
  /** Optional callback fired when a request is rejected by limits (for alerting/metrics). */
  onLimitHit?: (info: {
    method: string;
    reason: 'concurrency' | 'rate' | 'timeout';
    serverId: string;
  }) => void;
}

export const DEFAULT_LIMITS: Readonly<McpServerRequestLimits> = Object.freeze({
  maxConcurrent: 4,
  handlerTimeoutMs: 120_000,
  maxSamplingPerWindow: 60,
  samplingWindowMs: 60_000,
});

function positiveIntegerOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
    return Math.floor(value);
  }
  return fallback;
}

function resolveLimits(
  limits: Partial<McpServerRequestLimits> | undefined,
): McpServerRequestLimits {
  const resolved: McpServerRequestLimits = {
    maxConcurrent: positiveIntegerOr(
      limits?.maxConcurrent,
      DEFAULT_LIMITS.maxConcurrent,
    ),
    handlerTimeoutMs: positiveIntegerOr(
      limits?.handlerTimeoutMs,
      DEFAULT_LIMITS.handlerTimeoutMs,
    ),
    maxSamplingPerWindow: positiveIntegerOr(
      limits?.maxSamplingPerWindow,
      DEFAULT_LIMITS.maxSamplingPerWindow,
    ),
    samplingWindowMs: positiveIntegerOr(
      limits?.samplingWindowMs,
      DEFAULT_LIMITS.samplingWindowMs,
    ),
  };
  if (typeof limits?.onLimitHit === 'function') {
    resolved.onLimitHit = limits.onLimitHit;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Module-level defaults: register once, apply to every transport created
// afterwards (the router also consults these dynamically at route time, so
// late registration still works for servers whose initialize() has not run).
// ---------------------------------------------------------------------------

let defaultSamplingHandler: McpSamplingHandler | undefined;
let defaultElicitationHandler: McpElicitationHandler | undefined;

export function setDefaultMcpSamplingHandler(
  handler: McpSamplingHandler | undefined,
): void {
  defaultSamplingHandler = handler;
}

export function setDefaultMcpElicitationHandler(
  handler: McpElicitationHandler | undefined,
): void {
  defaultElicitationHandler = handler;
}

export function getDefaultMcpSamplingHandler(): McpSamplingHandler | undefined {
  return defaultSamplingHandler;
}

export function getDefaultMcpElicitationHandler():
  | McpElicitationHandler
  | undefined {
  return defaultElicitationHandler;
}

// ---------------------------------------------------------------------------
// Shared elicitation value checks (used by schema validation for defaults
// and by interactive input parsing)
// ---------------------------------------------------------------------------

const ELICITATION_PRIMITIVES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
]);

const ELICITATION_FORMATS: ReadonlySet<string> = new Set([
  'email',
  'uri',
  'date',
  'date-time',
]);

function isValidCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function checkStringFormat(
  text: string,
  format: McpElicitationPropertySchema['format'],
): string | undefined {
  switch (format) {
    case undefined:
      return undefined;
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
        ? undefined
        : 'Please enter a valid email address.';
    case 'uri':
      if (!text || /\s/.test(text)) return 'Please enter a valid uri.';
      try {
        new URL(text);
        return undefined;
      } catch {
        return 'Please enter a valid uri.';
      }
    case 'date':
      return isValidCalendarDate(text)
        ? undefined
        : 'Please enter a valid date (YYYY-MM-DD).';
    case 'date-time':
      return text && Number.isFinite(Date.parse(text))
        ? undefined
        : 'Please enter a valid date-time.';
    default:
      return 'Unsupported format.';
  }
}

/**
 * Check a primitive value against a property's own constraints. Returns an
 * error message (without the property key) or undefined when valid.
 */
function checkElicitationValue(
  value: string | number | boolean,
  schema: McpElicitationPropertySchema,
): string | undefined {
  switch (schema.type) {
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'Must be a boolean.';
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'Must be a number.';
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        return 'Must be an integer.';
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `Must be >= ${schema.minimum}.`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `Must be <= ${schema.maximum}.`;
      }
      if (
        schema.enum &&
        !schema.enum.some(
          (option) => option === value || String(option) === String(value),
        )
      ) {
        return `Must be one of: ${schema.enum.map(String).join(', ')}.`;
      }
      return undefined;
    }
    case 'string': {
      if (typeof value !== 'string') return 'Must be a string.';
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `Must be at least ${schema.minLength} characters.`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `Must be at most ${schema.maxLength} characters.`;
      }
      const formatError = checkStringFormat(value, schema.format);
      if (formatError) return formatError;
      if (
        schema.enum &&
        !schema.enum.some((option) => String(option) === value)
      ) {
        return `Must be one of: ${schema.enum.map(String).join(', ')}.`;
      }
      return undefined;
    }
    default:
      return 'Unsupported type.';
  }
}

// ---------------------------------------------------------------------------
// Parameter validation (MCP 2024-11-05)
// ---------------------------------------------------------------------------

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateElicitationProperty(
  key: string,
  prop: Record<string, unknown>,
): string | undefined {
  const base = `requestedSchema.properties.${key}`;
  if (typeof prop.type !== 'string' || !ELICITATION_PRIMITIVES.has(prop.type)) {
    return `${base}.type must be one of string, number, integer, boolean (no nested objects or arrays).`;
  }
  const type = prop.type as McpElicitationPrimitive;
  const isNumeric = type === 'number' || type === 'integer';

  // minLength / maxLength
  for (const field of ['minLength', 'maxLength'] as const) {
    if (prop[field] !== undefined) {
      if (type !== 'string') {
        return `${base}.${field} is only allowed when type is 'string'.`;
      }
      if (!isNonNegativeSafeInteger(prop[field])) {
        return `${base}.${field} must be a non-negative integer.`;
      }
    }
  }
  if (
    prop.minLength !== undefined &&
    prop.maxLength !== undefined &&
    (prop.minLength as number) > (prop.maxLength as number)
  ) {
    return `${base}.minLength must be <= maxLength.`;
  }

  // minimum / maximum
  for (const field of ['minimum', 'maximum'] as const) {
    if (prop[field] !== undefined) {
      if (!isNumeric) {
        return `${base}.${field} is only allowed when type is 'number' or 'integer'.`;
      }
      if (!isFiniteNumber(prop[field])) {
        return `${base}.${field} must be a finite number.`;
      }
    }
  }
  if (
    prop.minimum !== undefined &&
    prop.maximum !== undefined &&
    (prop.minimum as number) > (prop.maximum as number)
  ) {
    return `${base}.minimum must be <= maximum.`;
  }

  // format
  if (prop.format !== undefined) {
    if (type !== 'string') {
      return `${base}.format is only allowed when type is 'string'.`;
    }
    if (typeof prop.format !== 'string' || !ELICITATION_FORMATS.has(prop.format)) {
      return `${base}.format must be one of email, uri, date, date-time.`;
    }
  }

  // enum
  if (prop.enum !== undefined) {
    if (
      !Array.isArray(prop.enum) ||
      prop.enum.some((v) => typeof v !== 'string' && typeof v !== 'number')
    ) {
      return `${base}.enum must be an array of strings/numbers.`;
    }
    if (type === 'boolean') {
      return `${base}.enum is not allowed when type is 'boolean'.`;
    }
    if (
      type === 'integer' &&
      prop.enum.some((v) => typeof v !== 'number' || !Number.isInteger(v))
    ) {
      return `${base}.enum values must all be integers when type is 'integer'.`;
    }
  }

  // default
  if (prop.default !== undefined) {
    if (
      typeof prop.default !== 'string' &&
      typeof prop.default !== 'number' &&
      typeof prop.default !== 'boolean'
    ) {
      return `${base}.default must be a primitive.`;
    }
    const defaultError = checkElicitationValue(
      prop.default,
      prop as unknown as McpElicitationPropertySchema,
    );
    if (defaultError) {
      return `${base}.default is invalid: ${defaultError}`;
    }
  }
  return undefined;
}

function validateElicitationSchema(
  schema: unknown,
): { schema?: McpElicitationRequestSchema; error?: string } {
  if (!isRecord(schema)) {
    return { error: 'requestedSchema must be an object.' };
  }
  if (schema.type !== 'object') {
    return { error: "requestedSchema.type must be 'object'." };
  }
  if (!isRecord(schema.properties)) {
    return { error: 'requestedSchema.properties must be an object.' };
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!isRecord(prop)) {
      return { error: `requestedSchema.properties.${key} must be an object.` };
    }
    const propError = validateElicitationProperty(key, prop);
    if (propError) {
      return { error: propError };
    }
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      schema.required.some((k) => typeof k !== 'string') ||
      (schema.required as string[]).some(
        (k) => !Object.hasOwn(schema.properties as object, k),
      ))
  ) {
    return {
      error: 'requestedSchema.required must be an array of known property names.',
    };
  }
  return {
    schema: {
      type: 'object',
      properties: schema.properties as Record<
        string,
        McpElicitationPropertySchema
      >,
      required: schema.required as string[] | undefined,
    },
  };
}

function validateSamplingMessage(
  message: unknown,
): { message?: McpSamplingMessage; error?: string } {
  if (!isRecord(message)) {
    return { error: 'messages[] entries must be objects.' };
  }
  if (message.role !== 'user' && message.role !== 'assistant') {
    return { error: "message.role must be 'user' or 'assistant'." };
  }
  if (!isRecord(message.content) || typeof message.content.type !== 'string') {
    return { error: 'message.content must be an object with a type.' };
  }
  if (message.content.type === 'text') {
    if (typeof message.content.text !== 'string') {
      return { error: 'text content must have a string text field.' };
    }
    return {
      message: {
        role: message.role,
        content: { type: 'text', text: message.content.text },
      },
    };
  }
  if (message.content.type === 'image') {
    if (
      typeof message.content.data !== 'string' ||
      typeof message.content.mimeType !== 'string'
    ) {
      return { error: 'image content must have string data and mimeType.' };
    }
    return {
      message: {
        role: message.role,
        content: {
          type: 'image',
          data: message.content.data,
          mimeType: message.content.mimeType,
        },
      },
    };
  }
  return {
    error: `unsupported message content type '${message.content.type}'.`,
  };
}

function validateSamplingParams(
  params: unknown,
): { request?: McpSamplingRequest; error?: string } {
  if (!isRecord(params)) {
    return { error: 'sampling params must be an object.' };
  }
  if (!Array.isArray(params.messages) || params.messages.length === 0) {
    return { error: 'sampling params.messages must be a non-empty array.' };
  }
  const messages: McpSamplingMessage[] = [];
  for (const raw of params.messages) {
    const checked = validateSamplingMessage(raw);
    if (checked.error || !checked.message) {
      return { error: checked.error ?? 'invalid sampling message.' };
    }
    messages.push(checked.message);
  }
  if (
    typeof params.maxTokens !== 'number' ||
    !Number.isSafeInteger(params.maxTokens) ||
    params.maxTokens <= 0
  ) {
    return { error: 'sampling params.maxTokens must be a positive integer.' };
  }
  if (
    params.temperature !== undefined &&
    (typeof params.temperature !== 'number' ||
      params.temperature < 0 ||
      params.temperature > 2)
  ) {
    return { error: 'sampling params.temperature must be between 0 and 2.' };
  }
  const includeContext = params.includeContext;
  if (
    includeContext !== undefined &&
    includeContext !== 'none' &&
    includeContext !== 'thisServer' &&
    includeContext !== 'allServers'
  ) {
    return {
      error: "sampling params.includeContext must be 'none', 'thisServer' or 'allServers'.",
    };
  }
  return {
    request: {
      messages,
      modelPreferences: isRecord(params.modelPreferences)
        ? (params.modelPreferences as McpModelPreferences)
        : undefined,
      systemPrompt:
        typeof params.systemPrompt === 'string' ? params.systemPrompt : undefined,
      includeContext: (includeContext as McpSamplingRequest['includeContext']) ?? 'none',
      temperature:
        typeof params.temperature === 'number' ? params.temperature : undefined,
      maxTokens: params.maxTokens,
      stopSequences: Array.isArray(params.stopSequences)
        ? params.stopSequences.filter((s): s is string => typeof s === 'string')
        : undefined,
      metadata: isRecord(params.metadata)
        ? (params.metadata as Record<string, unknown>)
        : undefined,
    },
  };
}

/**
 * Validate the value returned by a sampling handler before relaying it to
 * the server. Returns a clean copy, or undefined when the shape is invalid.
 */
function validateSamplingResult(value: unknown): McpSamplingResult | undefined {
  if (!isRecord(value)) return undefined;
  if (value.role !== 'user' && value.role !== 'assistant') return undefined;
  if (typeof value.model !== 'string' || value.model.length === 0) {
    return undefined;
  }
  if (value.stopReason !== undefined && typeof value.stopReason !== 'string') {
    return undefined;
  }
  const content = value.content;
  if (!isRecord(content)) return undefined;
  let cleanContent: McpSamplingContent;
  if (content.type === 'text' && typeof content.text === 'string') {
    cleanContent = { type: 'text', text: content.text };
  } else if (
    content.type === 'image' &&
    typeof content.data === 'string' &&
    typeof content.mimeType === 'string'
  ) {
    cleanContent = {
      type: 'image',
      data: content.data,
      mimeType: content.mimeType,
    };
  } else {
    return undefined;
  }
  const result: McpSamplingResult = {
    role: value.role,
    content: cleanContent,
    model: value.model,
  };
  if (typeof value.stopReason === 'string') {
    result.stopReason = value.stopReason;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const MCP_PING_METHOD = 'ping';
export const MCP_SAMPLING_METHOD = 'sampling/createMessage';
export const MCP_ELICITATION_METHOD = 'elicitation/create';

type RoutedOk = { result: unknown };
type RoutedError = { error: { code: number; message: string } };

const HANDLER_TIMEOUT: unique symbol = Symbol('mcp-handler-timeout');

class HandlerTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HandlerTimeoutError';
  }
}

/**
 * Routes server-initiated JSON-RPC requests to the registered handlers.
 * Unknown methods (or methods with no handler) yield a JSON-RPC
 * "method not found" — the spec-correct reply when the client did not
 * advertise the capability.
 *
 * Known methods are subject to the router's limits (concurrency, handler
 * timeout, and — for sampling — a rolling-window rate limit).
 */
export class McpServerRequestRouter {
  private samplingHandler?: McpSamplingHandler;
  private elicitationHandler?: McpElicitationHandler;
  private readonly limits: McpServerRequestLimits;
  private inFlight = 0;
  private samplingTimestamps: number[] = [];

  constructor(limits?: Partial<McpServerRequestLimits>) {
    this.limits = resolveLimits(limits);
  }

  /** The resolved limits for this router (a copy). */
  getLimits(): McpServerRequestLimits {
    return { ...this.limits };
  }

  setSamplingHandler(handler: McpSamplingHandler | undefined): void {
    this.samplingHandler = handler;
  }

  setElicitationHandler(handler: McpElicitationHandler | undefined): void {
    this.elicitationHandler = handler;
  }

  private resolveSamplingHandler(): McpSamplingHandler | undefined {
    return this.samplingHandler ?? getDefaultMcpSamplingHandler();
  }

  private resolveElicitationHandler(): McpElicitationHandler | undefined {
    return this.elicitationHandler ?? getDefaultMcpElicitationHandler();
  }

  /**
   * The `capabilities` object the client sends in `initialize`. Only
   * advertises what actually has a handler, so servers never rely on an
   * unimplemented capability.
   */
  buildCapabilities(): {
    sampling?: Record<string, never>;
    elicitation?: Record<string, never>;
  } {
    const capabilities: {
      sampling?: Record<string, never>;
      elicitation?: Record<string, never>;
    } = {};
    if (this.resolveSamplingHandler()) {
      capabilities.sampling = {};
    }
    if (this.resolveElicitationHandler()) {
      capabilities.elicitation = {};
    }
    return capabilities;
  }

  private notifyLimitHit(
    method: string,
    reason: 'concurrency' | 'rate' | 'timeout',
    ctx: McpServerRequestContext,
  ): void {
    const callback = this.limits.onLimitHit;
    if (!callback) return;
    try {
      callback({ method, reason, serverId: ctx.serverId });
    } catch {
      // Never let a metrics/alerting callback break request routing.
    }
  }

  /**
   * Run a handler with the per-request timeout. On timeout, throws a
   * HandlerTimeoutError; the late handler outcome is ignored (its rejection
   * is swallowed so it never becomes an unhandled rejection).
   */
  private async runWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    const handlerPromise = Promise.resolve().then(fn);
    handlerPromise.catch(() => {
      // Swallow late rejections after a timeout.
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof HANDLER_TIMEOUT>((resolve) => {
      timer = setTimeout(
        () => resolve(HANDLER_TIMEOUT),
        this.limits.handlerTimeoutMs,
      );
    });
    try {
      const outcome = await Promise.race([handlerPromise, timeoutPromise]);
      if (outcome === HANDLER_TIMEOUT) {
        throw new HandlerTimeoutError(
          `handler timed out after ${this.limits.handlerTimeoutMs}ms`,
        );
      }
      return outcome as T;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private timeoutError(
    method: string,
    ctx: McpServerRequestContext,
  ): RoutedError {
    this.notifyLimitHit(method, 'timeout', ctx);
    return {
      error: {
        code: JSON_RPC_INTERNAL_ERROR,
        message: `Server request ${method} rejected: handler timeout exceeded (${this.limits.handlerTimeoutMs}ms).`,
      },
    };
  }

  async route(
    method: string,
    params: unknown,
    ctx: McpServerRequestContext,
  ): Promise<RoutedOk | RoutedError> {
    // A liveness check: answered at once with an empty result, outside the limits.
    if (method === MCP_PING_METHOD) {
      return { result: {} };
    }
    if (method !== MCP_SAMPLING_METHOD && method !== MCP_ELICITATION_METHOD) {
      return {
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `Method not found: ${method}.`,
        },
      };
    }

    if (this.inFlight >= this.limits.maxConcurrent) {
      this.notifyLimitHit(method, 'concurrency', ctx);
      return {
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message: `Server request ${method} rejected: concurrency limit reached (${this.limits.maxConcurrent} in flight).`,
        },
      };
    }

    if (method === MCP_SAMPLING_METHOD) {
      const now = Date.now();
      const cutoff = now - this.limits.samplingWindowMs;
      this.samplingTimestamps = this.samplingTimestamps.filter(
        (t) => t > cutoff,
      );
      if (this.samplingTimestamps.length >= this.limits.maxSamplingPerWindow) {
        this.notifyLimitHit(method, 'rate', ctx);
        return {
          error: {
            code: JSON_RPC_INTERNAL_ERROR,
            message: `Server request ${method} rejected: rate limit exceeded (${this.limits.maxSamplingPerWindow} per ${this.limits.samplingWindowMs}ms).`,
          },
        };
      }
      this.samplingTimestamps.push(now);
    }

    this.inFlight += 1;
    try {
      if (method === MCP_SAMPLING_METHOD) {
        return await this.routeSampling(method, params, ctx);
      }
      return await this.routeElicitation(method, params, ctx);
    } finally {
      this.inFlight -= 1;
    }
  }

  private async routeSampling(
    method: string,
    params: unknown,
    ctx: McpServerRequestContext,
  ): Promise<RoutedOk | RoutedError> {
    const handler = this.resolveSamplingHandler();
    if (!handler) {
      return {
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `Method not found: ${method} (no sampling handler registered).`,
        },
      };
    }
    const checked = validateSamplingParams(params);
    if (checked.error || !checked.request) {
      return {
        error: {
          code: JSON_RPC_INVALID_PARAMS,
          message: checked.error ?? 'Invalid sampling params.',
        },
      };
    }
    const request = checked.request;
    let raw: unknown;
    try {
      raw = await this.runWithTimeout(() => handler(request, ctx));
    } catch (error) {
      if (error instanceof HandlerTimeoutError) {
        return this.timeoutError(method, ctx);
      }
      return {
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message:
            error instanceof Error
              ? `Sampling handler failed: ${error.message}`
              : 'Sampling handler failed.',
        },
      };
    }
    const result = validateSamplingResult(raw);
    if (!result) {
      return {
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message: 'Sampling handler returned an invalid result.',
        },
      };
    }
    return { result };
  }

  private async routeElicitation(
    method: string,
    params: unknown,
    ctx: McpServerRequestContext,
  ): Promise<RoutedOk | RoutedError> {
    const handler = this.resolveElicitationHandler();
    if (!handler) {
      return {
        error: {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: `Method not found: ${method} (no elicitation handler registered).`,
        },
      };
    }
    if (!isRecord(params) || typeof params.message !== 'string') {
      return {
        error: {
          code: JSON_RPC_INVALID_PARAMS,
          message: 'elicitation params.message must be a string.',
        },
      };
    }
    const checked = validateElicitationSchema(params.requestedSchema);
    if (checked.error || !checked.schema) {
      return {
        error: {
          code: JSON_RPC_INVALID_PARAMS,
          message: checked.error ?? 'Invalid elicitation schema.',
        },
      };
    }
    const request: McpElicitationRequest = {
      message: params.message,
      requestedSchema: checked.schema,
    };
    let result: McpElicitationResult;
    try {
      result = await this.runWithTimeout(() => handler(request, ctx));
    } catch (error) {
      if (error instanceof HandlerTimeoutError) {
        return this.timeoutError(method, ctx);
      }
      return {
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message:
            error instanceof Error
              ? `Elicitation handler failed: ${error.message}`
              : 'Elicitation handler failed.',
        },
      };
    }
    if (
      !isRecord(result) ||
      (result.action !== 'accept' &&
        result.action !== 'decline' &&
        result.action !== 'cancel')
    ) {
      return {
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message: 'Elicitation handler returned an invalid action.',
        },
      };
    }
    return { result };
  }
}

// ---------------------------------------------------------------------------
// Interactive elicitation: prompt the user on a TTY via node:readline.
// Declines (with an explicit notice) when stdin is not interactive
// (CI, pipes, headless runs).
// ---------------------------------------------------------------------------

function formatElicitationDefault(value: string | number | boolean): string {
  return typeof value === 'string' ? value : String(value);
}

function parseElicitationInput(
  raw: string,
  schema: McpElicitationPropertySchema,
): { value?: string | number | boolean; error?: string } {
  const text = raw.trim();
  switch (schema.type) {
    case 'boolean': {
      const lowered = text.toLowerCase();
      if (['y', 'yes', 'true', '1'].includes(lowered)) return { value: true };
      if (['n', 'no', 'false', '0'].includes(lowered)) return { value: false };
      return { error: 'Please answer yes/no.' };
    }
    case 'integer': {
      if (!/^-?\d+$/.test(text)) return { error: 'Please enter an integer.' };
      const value = Number.parseInt(text, 10);
      if (!Number.isSafeInteger(value)) {
        return { error: 'Please enter an integer.' };
      }
      const error = checkElicitationValue(value, schema);
      return error ? { error } : { value };
    }
    case 'number': {
      if (!text) return { error: 'Please enter a number.' };
      const value = Number(text);
      if (!Number.isFinite(value)) return { error: 'Please enter a number.' };
      const error = checkElicitationValue(value, schema);
      return error ? { error } : { value };
    }
    case 'string': {
      const error = checkElicitationValue(text, schema);
      return error ? { error } : { value: text };
    }
    default:
      return { error: 'Unsupported field type.' };
  }
}

function sanitizeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function writeNotice(output: NodeJS.WritableStream, notice: string): void {
  const writable =
    (output as unknown as { writable?: unknown }).writable !== false;
  try {
    if (writable) {
      output.write(notice);
      return;
    }
  } catch {
    // fall through to stderr
  }
  try {
    process.stderr.write(notice);
  } catch {
    // Nothing more we can do; never throw from the notice path.
  }
}

/**
 * Build an elicitation handler that asks the user on the terminal.
 * - Not a TTY (piped/headless) → writes an explicit notice, then
 *   `{ action: 'decline' }`.
 * - Empty answer → the schema default, or decline the whole form when the
 *   field is required and has no default.
 * - EOF (Ctrl+D) → `{ action: 'cancel' }`.
 */
export function createReadlineElicitationHandler(options?: {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): McpElicitationHandler {
  return async (request) => {
    const input = options?.input ?? process.stdin;
    const output = options?.output ?? process.stdout;
    // NodeJS.ReadableStream has no isTTY; only real TTY streams do.
    const isInteractive =
      (input as unknown as { isTTY?: unknown }).isTTY === true;
    if (!isInteractive) {
      const message = typeof request.message === 'string' ? request.message : '';
      const preview = sanitizeForTerminal(
        message.length > 120 ? `${message.slice(0, 120)}...` : message,
      );
      writeNotice(
        output,
        `[MCP] elicitation requested ("${preview}") but stdin is not interactive — declining.\n`,
      );
      return { action: 'decline' };
    }

    const rl = readline.createInterface({ input, output });
    const ask = (prompt: string): Promise<string | null> =>
      new Promise((resolve) => {
        rl.question(prompt, (answer) => resolve(answer));
        rl.once('close', () => resolve(null));
      });

    try {
      output.write(`\n[MCP] ${request.message}\n`);
      const content: Record<string, string | number | boolean> = {};
      const required = new Set(request.requestedSchema.required ?? []);

      for (const [key, prop] of Object.entries(
        request.requestedSchema.properties,
      )) {
        const label = prop.title ?? key;
        const hint = prop.description ? ` — ${prop.description}` : '';
        const def =
          prop.default !== undefined
            ? ` [${formatElicitationDefault(prop.default)}]`
            : '';
        const req = required.has(key) ? ' (required)' : '';

        for (;;) {
          const answer = await ask(`  ${label}${hint}${req}${def}: `);
          if (answer === null) {
            return { action: 'cancel' };
          }
          const text = answer.trim();
          if (!text) {
            if (prop.default !== undefined) {
              content[key] = prop.default;
              break;
            }
            if (required.has(key)) {
              output.write('  (required — leaving it empty declines the request)\n');
              return { action: 'decline' };
            }
            break; // optional: omit the key
          }
          const parsed = parseElicitationInput(text, prop);
          if (parsed.error) {
            output.write(`  ${parsed.error}\n`);
            continue;
          }
          content[key] = parsed.value as string | number | boolean;
          break;
        }
      }

      return { action: 'accept', content };
    } finally {
      rl.close();
    }
  };
}