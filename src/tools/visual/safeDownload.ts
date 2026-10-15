// Downloads a generated asset from the URL an image or video provider
// returned. The URL comes from a remote response, so it must not point the
// agent's own server at internal addresses (cloud metadata, the VPS's local
// services, the LAN). Every hop, redirects included, must reach a public
// address. The check runs inside the socket's DNS lookup, so the address that
// is checked is the address that is connected to (no DNS-rebinding window).
// Loopback is allowed only when the provider itself is configured on loopback.
// The same guard serves the check_url / download_file tools (tools/extras.ts).

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { isLoopbackHostname } from '../vidarMedia.js';

const MAX_REDIRECTS = 5;

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

export class AssetDownloadError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'AssetDownloadError';
  }
}

function ipFamily(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 6 ? 'ipv6' : 'ipv4';
}

/** The 16 bytes of an IPv6 address (with or without a dotted IPv4 tail), or undefined. */
function ipv6Bytes(address: string): number[] | undefined {
  let text = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const quad = tail[1]!.split('.').map(Number);
    if (quad.some((n) => n > 255)) return undefined;
    text = `${text.slice(0, -tail[1]!.length)}${((quad[0]! << 8) | quad[1]!).toString(16)}:${((quad[2]! << 8) | quad[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(':') : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 0 : missing !== 0) return undefined;
  const groups = [...head, ...Array(Math.max(0, missing)).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
}

/**
 * The IPv4 address an IPv6 address carries, for the forms that reach an IPv4
 * host: IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64
 * (64:ff9b::/96 and the local-use 64:ff9b:1::/48) and 6to4 (2002::/16).
 */
export function embeddedIpv4(address: string): string | undefined {
  if (isIP(address.replace(/^\[|\]$/g, '').split('%')[0]!) !== 6) return undefined;
  const b = ipv6Bytes(address);
  if (!b) return undefined;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4 = (at: number) => b.slice(at, at + 4).join('.');
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12);
  if (zero(0, 12) && !zero(12, 16)) return v4(12);
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    if (zero(4, 12)) return v4(12);
    if (b[4] === 0x00 && b[5] === 0x01) return v4(12);
  }
  if (b[0] === 0x20 && b[1] === 0x02) return v4(2);
  return undefined;
}

export function isNonPublicAddress(address: string, options: { allowLoopback?: boolean } = {}): boolean {
  const ip = embeddedIpv4(address) ?? address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = ipFamily(ip);
  if (options.allowLoopback && LOOPBACK.check(ip, family)) return false;
  return NON_PUBLIC.check(ip, family);
}

export type ResolvedAddress = { address: string; family: number };
/** Resolves a hostname to all of its addresses. */
export type AssetHostResolver = (hostname: string) => Promise<ResolvedAddress[]>;
/** One HTTP GET without following redirects; `lookup` must be used for the connection. */
export type AssetTransport = (
  url: URL,
  options: { lookup: LookupFunction; signal: AbortSignal; method?: 'GET' | 'HEAD'; maxBytes?: number },
) => Promise<{ status: number; location?: string; contentType?: string; body: Buffer; statusText?: string }>;

const systemResolver: AssetHostResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const nodeTransport: AssetTransport = (url, { lookup, signal, method, maxBytes }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: method ?? 'GET', lookup, signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        resolve({ status, statusText: res.statusMessage, location: res.headers.location, body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        // Stop reading a body over the caller's limit instead of holding all of it.
        if (maxBytes !== undefined && received > maxBytes) {
          req.destroy(new AssetDownloadError(`download failed: larger than ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, statusText: res.statusMessage, contentType: res.headers['content-type'], body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });

let resolver: AssetHostResolver = systemResolver;
let transport: AssetTransport = nodeTransport;

/** Test hook: replace DNS resolution (undefined restores the system resolver). */
export function setAssetDownloadResolverForTests(next?: AssetHostResolver): void {
  resolver = next ?? systemResolver;
}

/** Test hook: replace the HTTP transport (undefined restores node:http/https). */
export function setAssetDownloadTransportForTests(next?: AssetTransport): void {
  transport = next ?? nodeTransport;
}

function refusal(host: string, address: string): AssetDownloadError {
  return new AssetDownloadError(
    `refused to download from ${host}: it resolves to ${address}, a private, link-local or loopback address`,
  );
}

async function resolvePublicAddresses(hostname: string, allowLoopback: boolean): Promise<ResolvedAddress[]> {
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new AssetDownloadError(`could not resolve the asset host ${hostname}`);
  }
  if (addresses.length === 0) throw new AssetDownloadError(`could not resolve the asset host ${hostname}`);
  const blocked = addresses.find((entry) => isNonPublicAddress(entry.address, { allowLoopback }));
  if (blocked) throw refusal(hostname, blocked.address);
  return addresses;
}

/**
 * A socket `lookup` that resolves the host itself and fails the connection
 * when any address is non-public, so the connection can only use addresses
 * that passed the check.
 */
export function createGuardedLookup(allowLoopback: boolean): LookupFunction {
  return ((hostname: string, options: { family?: number | string; all?: boolean }, callback: (...args: any[]) => void) => {
    resolvePublicAddresses(hostname, allowLoopback).then(
      (addresses) => {
        const family = options?.family === 6 || options?.family === 'IPv6' ? 6 : options?.family === 4 || options?.family === 'IPv4' ? 4 : 0;
        const usable = family ? addresses.filter((entry) => entry.family === family) : addresses;
        if (usable.length === 0) {
          callback(new AssetDownloadError(`no IPv${family} address for ${hostname}`));
        } else if (options?.all) {
          callback(null, usable.map((entry) => ({ address: entry.address, family: entry.family })));
        } else {
          callback(null, usable[0]!.address, usable[0]!.family);
        }
      },
      (error) => callback(error),
    );
  }) as LookupFunction;
}

/** Checks scheme and, for IP-literal hosts (which skip DNS lookup), the address itself. */
async function checkUrl(rawUrl: string, allowLoopback: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AssetDownloadError('the provider returned an invalid asset URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AssetDownloadError(`the provider returned a non-http(s) asset URL (${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isNonPublicAddress(host, { allowLoopback })) throw refusal(url.hostname, host);
  } else {
    // Fail early with a clear message; the connect-time lookup checks again.
    await resolvePublicAddresses(host, allowLoopback);
  }
  return url;
}

type GuardedDownloadOptions = {
  timeoutMs: number;
  allowLoopback?: boolean;
  signal?: AbortSignal;
  /** Refuse a body larger than this many bytes (stops reading once it is passed). */
  maxBytes?: number;
};

/**
 * Fetches a provider-returned asset URL, following redirects by hand so each
 * hop is checked. Throws AssetDownloadError (with the HTTP status when there
 * is one) on refusal or failure.
 */
export async function downloadProviderAsset(rawUrl: string, options: GuardedDownloadOptions): Promise<Buffer> {
  return (await downloadGuardedUrl(rawUrl, options)).body;
}

/**
 * The same guarded download for any URL the agent did not choose itself (a
 * provider result, a soundtrack link from a message or a page), also
 * returning the final response's content type.
 */
export async function downloadGuardedUrl(
  rawUrl: string,
  options: GuardedDownloadOptions,
): Promise<{ body: Buffer; contentType?: string }> {
  const res = await guardedRequest(rawUrl, options);
  if (res.status < 200 || res.status >= 300) {
    throw new AssetDownloadError(`download failed: HTTP ${res.status}`, res.status);
  }
  return { body: res.body, contentType: res.contentType };
}

/**
 * One guarded request (GET or HEAD): every hop's address is checked, the
 * connection uses the checked address, and redirects are followed by hand
 * (each one checked again). Returns the final response whatever its status;
 * throws AssetDownloadError on a refusal or a network failure.
 */
export async function guardedRequest(
  rawUrl: string,
  options: GuardedDownloadOptions & { method?: 'GET' | 'HEAD' },
): Promise<{ status: number; statusText?: string; contentType?: string; body: Buffer; url: string }> {
  const allowLoopback = options.allowLoopback === true;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const lookup = createGuardedLookup(allowLoopback);
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await checkUrl(current, allowLoopback);
    let res: Awaited<ReturnType<AssetTransport>>;
    try {
      res = await transport(url, { lookup, signal, ...(options.method ? { method: options.method } : {}), ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) });
    } catch (error) {
      if (error instanceof AssetDownloadError) throw error;
      throw new AssetDownloadError(`download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new AssetDownloadError(`download failed: HTTP ${res.status} without a Location header`, res.status);
      current = new URL(res.location, url).toString();
      continue;
    }
    if (options.maxBytes !== undefined && res.body.length > options.maxBytes) throw new AssetDownloadError(`download failed: larger than ${options.maxBytes} bytes`);
    return { status: res.status, statusText: res.statusText, contentType: res.contentType, body: res.body, url: url.toString() };
  }
  throw new AssetDownloadError(`download failed: more than ${MAX_REDIRECTS} redirects`);
}

/** True when a configured base URL points at loopback, so its asset URLs may too. */
export function baseUrlIsLoopback(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return isLoopbackHostname(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}
