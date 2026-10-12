/**
 * Where calls are handled: the owner's server on this machine (the hosted
 * platform's agent server), reached through the MCP endpoint it registers
 * in the engine's MCP config (`<data root>/mcp-servers.json`, id
 * `artemis_online`, a loopback URL and a bearer token).
 *
 * The call tools there (phone_call_request / phone_call_status /
 * phone_call_hangup) are not listed to the model; place_call is the one way
 * in. The token is only ever sent to a loopback address.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveDataRootDir } from '../../utils/fs.js';

export const CALL_HOST_SERVER_ID = 'artemis_online';

export interface CallHost {
  url: string;
  token: string;
}

export class CallHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CallHostError';
  }
}

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//i;

/** The owner's server entry from an MCP config's JSON; undefined when there is none (not hosted). */
export function callHostFromConfig(raw: unknown): CallHost | undefined {
  const servers = (raw as { servers?: unknown })?.servers;
  if (!Array.isArray(servers)) return undefined;
  const entry = servers.find((s) => (s as { id?: unknown })?.id === CALL_HOST_SERVER_ID) as Record<string, unknown> | undefined;
  if (!entry || entry.enabled === false) return undefined;
  const url = typeof entry.url === 'string' ? entry.url : '';
  const token = typeof entry.bearerToken === 'string' ? entry.bearerToken : '';
  if (!LOOPBACK.test(url) || !token) return undefined;
  return { url, token };
}

export async function resolveCallHost(cwd: string): Promise<CallHost | undefined> {
  try {
    return callHostFromConfig(JSON.parse(await readFile(path.join(resolveDataRootDir(cwd), 'mcp-servers.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

let rpcId = 0;

/** One tools/call on the owner's server; a tool error becomes a CallHostError with its code. */
export async function callHostRpc(
  host: CallHost,
  name: string,
  args: Record<string, unknown>,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 90_000);
  let res: Response;
  try {
    res = await fetchImpl(host.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    });
  } catch (err) {
    throw new CallHostError('host_unreachable', `The owner's server did not answer: ${String(err)}`);
  }
  if (!res.ok) throw new CallHostError('host_error', `The owner's server answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] };
    error?: { message?: string };
  };
  if (body.error) throw new CallHostError('host_error', body.error.message ?? 'The owner\'s server refused the request');
  const result = body.result ?? {};
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) {
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string };
      throw new CallHostError(parsed.error ?? 'host_error', parsed.message ?? text);
    } catch (err) {
      if (err instanceof CallHostError) throw err;
      throw new CallHostError('host_error', text || 'The call tool failed');
    }
  }
  if (result.structuredContent) return result.structuredContent;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CallHostError('host_error', 'The owner\'s server answered without a result');
  }
}
