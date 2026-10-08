// Downloads a generated asset from the URL an image or video provider
// returned. The URL comes from a remote response, so it must not point the
// agent's own server at internal addresses (cloud metadata, the VPS's local
// services, the LAN). Every hop, redirects included, must reach a public
// address. The check runs inside the socket's DNS lookup, so the address that
// is checked is the address that is connected to (no DNS-rebinding window).
// Loopback is allowed only when the provider itself is configured on loopback.

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
  ['192.168.0.0', 16],
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

/** An IPv4-mapped IPv6 address (::ffff:a.b.c.d) is checked as IPv4. */
function unmapped(address: string): string {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return match ? match[1]! : address;
}

export function isNonPublicAddress(address: string, options: { allowLoopback?: boolean } = {}): boolean {
  const ip = unmapped(address);
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
  options: { lookup: LookupFunction; signal: AbortSignal },
) => Promise<{ status: number; location?: string; body: Buffer }>;

const systemResolver: AssetHostResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const nodeTransport: AssetTransport = (url, { lookup, signal }) =>
  new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { lookup, signal }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        resolve({ status, location: res.headers.location, body: Buffer.alloc(0) });
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
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

/**
 * Fetches a provider-returned asset URL, following redirects by hand so each
 * hop is checked. Throws AssetDownloadError (with the HTTP status when there
 * is one) on refusal or failure.
 */
export async function downloadProviderAsset(
  rawUrl: string,
  options: { timeoutMs: number; allowLoopback?: boolean; signal?: AbortSignal },
): Promise<Buffer> {
  const allowLoopback = options.allowLoopback === true;
  const timeout = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const lookup = createGuardedLookup(allowLoopback);
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await checkUrl(current, allowLoopback);
    let res: Awaited<ReturnType<AssetTransport>>;
    try {
      res = await transport(url, { lookup, signal });
    } catch (error) {
      if (error instanceof AssetDownloadError) throw error;
      throw new AssetDownloadError(`download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new AssetDownloadError(`download failed: HTTP ${res.status} without a Location header`, res.status);
      current = new URL(res.location, url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      throw new AssetDownloadError(`download failed: HTTP ${res.status}`, res.status);
    }
    return res.body;
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
