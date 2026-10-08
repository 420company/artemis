// Downloads a generated asset from the URL an image provider returned. The URL
// comes from a remote response, so it must not point the agent's own server at
// internal addresses (cloud metadata, the VPS's local services, the LAN): every
// hop, redirects included, must resolve to public addresses. Loopback is
// allowed only when the provider itself is configured on loopback.

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
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

async function assertPublicUrl(rawUrl: string, allowLoopback: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AssetDownloadError('the provider returned an invalid image URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new AssetDownloadError(`the provider returned a non-http(s) image URL (${url.protocol})`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    } catch {
      throw new AssetDownloadError(`could not resolve the image host ${url.hostname}`);
    }
  }
  if (addresses.length === 0 || addresses.some((address) => isNonPublicAddress(address, { allowLoopback }))) {
    throw new AssetDownloadError(`refused to download from ${url.hostname}: it resolves to a private, link-local or loopback address`);
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
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicUrl(current, allowLoopback);
    let res: Response;
    try {
      res = await fetch(url, { redirect: 'manual', signal });
    } catch (error) {
      throw new AssetDownloadError(`download failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new AssetDownloadError(`download failed: HTTP ${res.status} without a Location header`, res.status);
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) {
      throw new AssetDownloadError(`download failed: HTTP ${res.status}`, res.status);
    }
    return Buffer.from(await res.arrayBuffer());
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
