/**
 * Per-run MCP headers handed over on an inherited file descriptor.
 *
 * A host that starts the engine (artemis-online) can give each run its own
 * secret headers for an MCP server, such as a token telling the server which
 * run is calling. An environment variable would leave them readable in
 * /proc/<pid>/environ by every process of the same OS user for the whole
 * life of the process (deleting it from process.env does not change that
 * file), and every tool subprocess would inherit them. So instead:
 *
 *   ARTEMIS_MCP_HEADERS_FD=<n>   (n >= 3; says where to read, holds no secret)
 *
 * and on fd <n> a JSON object, read to end-of-file:
 *
 *   { "<server id>": { "<header name>": "<value>", ... }, ... }
 *
 * or, binding each server's headers to the URL the host expects for it:
 *
 *   { "v": 2, "servers": { "<server id>": { "url": "<url>", "headers": { ... } } } }
 *
 * Server ids match exactly (an entry the agent added as `Artemis-Online`
 * does not get `artemis_online`'s headers), and with v2 the headers go only
 * to an entry whose URL is the one the host named: an entry pointed
 * somewhere else, or a look-alike, never carries the run's token.
 *
 * The engine reads it once at startup, before any tool can run, keeps it in
 * memory only, closes the descriptor (so no child process inherits it) and
 * drops the variable from its environment (so no child tries to read it).
 * Hosts pass a socket (a pipe end of a socketpair): /proc/<pid>/fd/<n> of a
 * socket cannot be opened by another process, unlike a pipe or a file.
 */
import { closeSync, fstatSync, readSync } from 'node:fs';

export const MCP_HEADERS_FD_ENV = 'ARTEMIS_MCP_HEADERS_FD';

/** Generous for a few headers; anything longer is not what a host sends. */
const MAX_BYTES = 64 * 1024;
/** How long a non-blocking descriptor may keep the engine waiting for end-of-file. */
const WAIT_LIMIT_MS = 5_000;

let loaded = false;
type ServerHeaders = { url?: string; headers: Record<string, string> };
const headersByServer = new Map<string, ServerHeaders>();

/** URLs compare without a trailing slash. */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function cleanHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === 'string' && name.trim()) clean[name.trim().toLowerCase()] = value.trim();
  }
  return clean;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readToEnd(fd: number): Buffer {
  const chunks: Buffer[] = [];
  let total = 0;
  const deadline = Date.now() + WAIT_LIMIT_MS;
  const buffer = Buffer.alloc(4096);
  for (;;) {
    let count: number;
    try {
      count = readSync(fd, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A descriptor someone left non-blocking: wait for the host's end-of-file, briefly.
      if ((code === 'EAGAIN' || code === 'EWOULDBLOCK') && Date.now() < deadline) {
        sleepSync(5);
        continue;
      }
      if (code === 'EINTR') continue;
      throw error;
    }
    if (count === 0) break;
    total += count;
    if (total > MAX_BYTES) throw new Error('per-run MCP headers are too long');
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks);
}

function parse(text: string): Map<string, ServerHeaders> {
  const result = new Map<string, ServerHeaders>();
  if (!text.trim()) return result;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('per-run MCP headers must be a JSON object');
  }
  const object = parsed as Record<string, unknown>;
  if (object.v === 2) {
    const servers = object.servers;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('per-run MCP headers (v2) need a servers object');
    for (const [serverId, entry] of Object.entries(servers as Record<string, unknown>)) {
      const id = serverId.trim();
      const { url, headers } = (entry && typeof entry === 'object' ? entry : {}) as { url?: unknown; headers?: unknown };
      const clean = cleanHeaders(headers);
      // v2 always names the URL: without one, the headers go nowhere.
      if (!id || !clean || typeof url !== 'string' || !url.trim()) continue;
      result.set(id, { url: normalizeUrl(url), headers: clean });
    }
    return result;
  }
  for (const [serverId, headers] of Object.entries(object)) {
    const id = serverId.trim();
    const clean = cleanHeaders(headers);
    if (!id || !clean) continue;
    result.set(id, { headers: { ...(result.get(id)?.headers ?? {}), ...clean } });
  }
  return result;
}

/**
 * Reads the per-run headers from the descriptor named by
 * ARTEMIS_MCP_HEADERS_FD, once; later calls do nothing. Whatever happens, the
 * descriptor is closed and the variable removed. Returns an error message
 * when the variable was set but the headers could not be read (the engine
 * then runs without them, which the host treats as the most restricted run).
 */
export function loadInheritedMcpHeaders(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (loaded) return undefined;
  loaded = true;
  const raw = env[MCP_HEADERS_FD_ENV];
  if (raw === undefined) return undefined;
  delete env[MCP_HEADERS_FD_ENV];
  const fd = /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  // 0-2 are stdio: never ours to read or close.
  if (!Number.isInteger(fd) || fd < 3) return `${MCP_HEADERS_FD_ENV} must name a descriptor from 3 up`;
  try {
    fstatSync(fd);
  } catch {
    return `${MCP_HEADERS_FD_ENV}=${fd} is not an open descriptor`;
  }
  try {
    const parsed = parse(readToEnd(fd).toString('utf8'));
    for (const [id, headers] of parsed) headersByServer.set(id, headers);
    return undefined;
  } catch (error) {
    return `could not read per-run MCP headers: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }
}

/**
 * The per-run headers for this MCP server (a copy; empty when none were
 * given): the server id must match exactly, and when the host bound them to
 * a URL, `url` (the entry's own) must be that URL.
 */
export function inheritedMcpHeaders(serverId: string, url: string | undefined): Record<string, string> {
  const entry = headersByServer.get(serverId.trim());
  if (!entry) return {};
  if (entry.url !== undefined && (url === undefined || normalizeUrl(url) !== entry.url)) return {};
  return { ...entry.headers };
}

/** For tests: forget what was loaded, so the next load reads again. */
export function resetInheritedMcpHeadersForTest(): void {
  loaded = false;
  headersByServer.clear();
}
