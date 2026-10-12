import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { ProviderStore } from '../providers/store.js';
import type { ProviderStoreData, VidarAssetHostingConfig } from '../providers/types.js';
import type { ToolExecutionContext } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';
import { toolLog, toolWarn } from '../utils/log.js';

export type HostedReferenceKind = 'video' | 'audio' | 'image';

type ResolvedAssetHostingConfig = Required<Pick<VidarAssetHostingConfig, 'endpoint' | 'bucket' | 'accessKeyId' | 'secretAccessKey' | 'publicBaseUrl'>> & {
  provider: 's3' | 'r2';
  region: string;
  prefix: string;
  maxUploadBytes: number;
};

const DEFAULT_REGION = 'auto';
const DEFAULT_MAX_REFERENCE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function isEnabledFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true';
  return false;
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function normalizePublicBaseUrl(value: string): string {
  return value.replace(/\/+$/g, '');
}

function normalizePrefix(value: string | undefined): string {
  return (value || '').replace(/^\/+|\/+$/g, '');
}

function parseMaxUploadBytes(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value * 1024 * 1024);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed * 1024 * 1024);
  }
  return DEFAULT_MAX_REFERENCE_UPLOAD_BYTES;
}

function inferContentType(filePath: string, kind: HostedReferenceKind): string {
  const ext = path.extname(filePath).toLowerCase();
  if (kind === 'video') {
    if (ext === '.mov') return 'video/quicktime';
    if (ext === '.webm') return 'video/webm';
    if (ext === '.m4v') return 'video/x-m4v';
    return 'video/mp4';
  }
  if (kind === 'image') {
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.heic') return 'image/heic';
    if (ext === '.heif') return 'image/heif';
    if (ext === '.bmp') return 'image/bmp';
    if (ext === '.tiff' || ext === '.tif') return 'image/tiff';
    return 'image/png';
  }
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.ogg') return 'audio/ogg';
  return 'audio/mpeg';
}

function dateParts(now = new Date()): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signingKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeObjectKey(key: string): string {
  return key.split('/').map(encodePathSegment).join('/');
}

function buildObjectKey(config: ResolvedAssetHostingConfig, filePath: string, kind: HostedReferenceKind): string {
  const ext = path.extname(filePath).toLowerCase() || (kind === 'video' ? '.mp4' : kind === 'image' ? '.png' : '.mp3');
  const safeBase = path.basename(filePath, ext).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || kind;
  const objectPath = `${kind}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeBase}${ext}`;
  return config.prefix ? `${config.prefix}/${objectPath}` : objectPath;
}

function buildPublicUrl(config: ResolvedAssetHostingConfig, objectKey: string): string {
  return `${normalizePublicBaseUrl(config.publicBaseUrl)}/${encodeObjectKey(objectKey)}`;
}

function requiredConfigError(): Error {
  return new Error(
    'Video generation: local video/audio references need media asset hosting. Configure visualProfile.assetHosting or VIDAR_ASSET_* environment variables for an S3/R2-compatible public bucket.',
  );
}

async function loadHostingConfigFromStore(cwd: string): Promise<VidarAssetHostingConfig | undefined> {
  const stores = [new ProviderStore(cwd)];
  if (cwd !== homedir()) stores.push(new ProviderStore(homedir()));

  for (const store of stores) {
    let data: ProviderStoreData;
    try {
      data = await store.load();
    } catch {
      continue;
    }
    const hosting = data.visualProfile?.assetHosting;
    // A platform entry holds no bucket: resolvePlatformAssetHosting reads it (global store only).
    if (hosting?.enabled && hosting.provider !== 'platform') return hosting;
  }
  return undefined;
}

export async function resolveVidarAssetHostingConfig(cwd: string): Promise<ResolvedAssetHostingConfig | undefined> {
  const envEndpoint = envValue('VIDAR_ASSET_ENDPOINT');
  const envBucket = envValue('VIDAR_ASSET_BUCKET');
  const envAccessKeyId = envValue('VIDAR_ASSET_ACCESS_KEY_ID');
  const envSecretAccessKey = envValue('VIDAR_ASSET_SECRET_ACCESS_KEY');
  const envPublicBaseUrl = envValue('VIDAR_ASSET_PUBLIC_BASE_URL');

  const raw = envEndpoint || envBucket || envAccessKeyId || envSecretAccessKey || envPublicBaseUrl
    ? {
        enabled: isEnabledFlag(envValue('VIDAR_ASSET_ENABLED') ?? true),
        provider: (envValue('VIDAR_ASSET_PROVIDER') ?? 's3') as 's3' | 'r2',
        endpoint: envEndpoint,
        bucket: envBucket,
        region: envValue('VIDAR_ASSET_REGION'),
        accessKeyId: envAccessKeyId,
        secretAccessKey: envSecretAccessKey,
        publicBaseUrl: envPublicBaseUrl,
        prefix: envValue('VIDAR_ASSET_PREFIX'),
        maxUploadMegabytes: envValue('VIDAR_ASSET_MAX_UPLOAD_MB'),
      }
    : await loadHostingConfigFromStore(cwd);

  if (!raw || !raw.enabled) return undefined;
  if (!raw.endpoint || !raw.bucket || !raw.accessKeyId || !raw.secretAccessKey || !raw.publicBaseUrl) {
    throw requiredConfigError();
  }

  return {
    provider: raw.provider === 'r2' ? 'r2' : 's3',
    endpoint: raw.endpoint,
    bucket: raw.bucket,
    region: raw.region || DEFAULT_REGION,
    accessKeyId: raw.accessKeyId,
    secretAccessKey: raw.secretAccessKey,
    publicBaseUrl: raw.publicBaseUrl,
    prefix: normalizePrefix(raw.prefix),
    maxUploadBytes: parseMaxUploadBytes(raw.maxUploadMegabytes),
  };
}

async function putS3Object(config: ResolvedAssetHostingConfig, objectKey: string, body: Buffer, contentType: string): Promise<void> {
  const endpoint = new URL(config.endpoint);
  const encodedKey = encodeObjectKey(objectKey);
  const canonicalUri = `/${encodePathSegment(config.bucket)}/${encodedKey}`;
  const uploadUrl = new URL(canonicalUri, endpoint.origin);
  const { amzDate, dateStamp } = dateParts();
  const payloadHash = sha256Hex(body);
  const host = uploadUrl.host;
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
  ].join('\n') + '\n';
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['PUT', uploadUrl.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');
  const signature = createHmac('sha256', signingKey(config.secretAccessKey, dateStamp, config.region)).update(stringToSign, 'utf8').digest('hex');

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: new Uint8Array(body),
  });

  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error(`Video generation: reference upload failed (HTTP ${res.status}): ${raw.slice(0, 500)}`);
  }
}

/**
 * The hosted platform's reference hosting: the gateway signs one upload URL
 * per file under this account's own prefix (`POST <baseUrl>/assets/presign`)
 * and keeps the storage key itself. Only the global store is read (a
 * workspace's providers.json cannot point the platform key elsewhere).
 * `assetHosting: {provider: "platform", enabled: false}` turns it off.
 */
export type PlatformAssetHosting = { baseUrl: string; apiKey: string };

export function platformAssetHostingFromStore(data: Partial<ProviderStoreData> | undefined): PlatformAssetHosting | undefined {
  if (!data) return undefined;
  const hosting = data.visualProfile?.assetHosting;
  if (hosting && hosting.provider === 'platform' && !hosting.enabled) return undefined;
  // An own bucket is configured: that one is used, not the platform's.
  if (hosting && hosting.provider !== 'platform' && hosting.enabled) return undefined;
  const httpsOrigin = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    try {
      const url = new URL(v.trim());
      return url.protocol === 'https:' ? url.origin : undefined;
    } catch {
      return undefined;
    }
  };
  const isKey = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
  // The platform is the gateway the platform-managed profile talks to (https only): its key
  // goes nowhere else. The main profile when the platform manages it, else any profile it
  // manages (an owner's own main model, through a local proxy say, keeps hosting).
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  const managedBy = (p: (typeof profiles)[number] | undefined) => !!p && (p.capabilitiesSource === 'platform' || p.managedBy === 'platform');
  const mainProfile = profiles.find((p) => p?.id === (data.defaultMainProfileId ?? 'executor'));
  const main = managedBy(mainProfile) ? mainProfile : profiles.find((p) => managedBy(p) && httpsOrigin(p.baseUrl));
  const platformOrigin = main ? httpsOrigin(main.baseUrl) : undefined;
  if (!platformOrigin) return undefined;
  if (hosting?.provider === 'platform' && hosting.baseUrl !== undefined) {
    if (httpsOrigin(hosting.baseUrl) !== platformOrigin || !isKey(hosting.apiKey)) return undefined;
    return { baseUrl: hosting.baseUrl.trim(), apiKey: hosting.apiKey.trim() };
  }
  if (!isKey(main?.apiKey)) return undefined;
  return { baseUrl: main!.baseUrl.trim(), apiKey: main!.apiKey.trim() };
}

/** The platform said it does not host references now (`assetHosting: {provider: "platform", enabled: false}`). */
export function platformAssetHostingOff(data: Partial<ProviderStoreData> | undefined): boolean {
  const hosting = data?.visualProfile?.assetHosting;
  return !!hosting && hosting.provider === 'platform' && !hosting.enabled;
}

async function platformHostingSaysOff(): Promise<boolean> {
  try {
    const { createGlobalProviderStore } = await import('../providers/store.js');
    return platformAssetHostingOff(await createGlobalProviderStore().load());
  } catch {
    return false;
  }
}

const PLATFORM_HOSTING_OFF = 'Video generation: this platform does not host reference videos or audio right now. Use a public https URL for the reference instead.';

export async function resolvePlatformAssetHosting(): Promise<PlatformAssetHosting | undefined> {
  try {
    const { createGlobalProviderStore } = await import('../providers/store.js');
    return platformAssetHostingFromStore(await createGlobalProviderStore().load());
  } catch {
    return undefined;
  }
}

const PRESIGN_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 10 * 60_000;

/** One file through the platform: a signed upload URL for exactly this file, then the upload. */
export async function uploadViaPlatform(
  hosting: PlatformAssetHosting,
  file: { body: Buffer; contentType: string; kind: HostedReferenceKind; name: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let presign: Response;
  try {
    presign = await fetchImpl(`${hosting.baseUrl.replace(/\/+$/, '')}/assets/presign`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hosting.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: file.kind, contentType: file.contentType, bytes: file.body.length, name: file.name.slice(0, 120) }),
      signal: AbortSignal.timeout(PRESIGN_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Video generation: reference hosting is unreachable (${error instanceof Error ? error.message : String(error)}).`);
  }
  const answer = await presign.json().catch(() => ({})) as { uploadUrl?: unknown; headers?: unknown; publicUrl?: unknown; error?: { code?: unknown; message?: unknown } };
  if (!presign.ok) {
    const code = typeof answer.error?.code === 'string' ? answer.error.code : `HTTP ${presign.status}`;
    if (presign.status === 404 || code === 'asset_hosting_unavailable') {
      throw new Error(PLATFORM_HOSTING_OFF);
    }
    if (code === 'asset_too_large') throw new Error(`Video generation: the reference file is too large to upload (${Math.round(file.body.length / 1024 / 1024)} MB).`);
    if (code === 'asset_budget_exhausted') throw new Error('Video generation: today\'s reference uploads are used up. Use a public https URL for the reference, or try again tomorrow.');
    if (code === 'rate_limited') throw new Error('Video generation: too many reference uploads in the last hour; try again later.');
    if (code === 'insufficient_balance' || code === 'membership_inactive') throw new Error('Video generation: there is no quota left for reference uploads right now.');
    throw new Error(`Video generation: reference upload was refused (${code}).`);
  }
  if (typeof answer.uploadUrl !== 'string' || !/^https:\/\//i.test(answer.uploadUrl) || typeof answer.publicUrl !== 'string' || !/^https:\/\//i.test(answer.publicUrl)) {
    throw new Error('Video generation: reference hosting gave no usable upload address.');
  }
  // Only the headers the signature covers (content type, length); nothing of ours.
  const headers: Record<string, string> = {};
  if (answer.headers && typeof answer.headers === 'object' && !Array.isArray(answer.headers)) {
    for (const [key, value] of Object.entries(answer.headers as Record<string, unknown>)) {
      if (typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(key) && !/^(authorization|cookie)$/i.test(key)) headers[key] = value;
    }
  }
  headers['content-type'] ??= file.contentType;
  let res: Response;
  try {
    res = await fetchImpl(answer.uploadUrl, { method: 'PUT', headers, body: new Uint8Array(file.body), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Video generation: reference upload failed (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!res.ok) {
    // The store's own error body says nothing the model should relay.
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Video generation: the reference upload did not go through (HTTP ${res.status}). Try again, or use a public https URL for the reference.`);
  }
  return answer.publicUrl;
}

export async function uploadLocalReferenceAssets(
  paths: string[] | undefined,
  kind: HostedReferenceKind,
  context: ToolExecutionContext,
): Promise<string[]> {
  const rawPaths = Array.isArray(paths) ? paths.map((value) => value.trim()).filter(Boolean) : [];
  if (rawPaths.length === 0) return [];

  // An own bucket (env or store) first; else the hosted platform's signed uploads.
  const config = await resolveVidarAssetHostingConfig(context.cwd);
  const platform = config ? undefined : await resolvePlatformAssetHosting();
  if (!config && !platform) throw (await platformHostingSaysOff()) ? new Error(PLATFORM_HOSTING_OFF) : requiredConfigError();
  const maxUploadBytes = config?.maxUploadBytes ?? DEFAULT_MAX_REFERENCE_UPLOAD_BYTES;

  const urls: string[] = [];
  for (const rawPath of rawPaths) {
    const resolved = await resolveToolPathWithWorkspaceAccess({
      inputPath: rawPath,
      toolName: 'generate_video',
      context,
    });
    const info = await stat(resolved.absolute);
    if (info.size > maxUploadBytes) {
      throw new Error(`Video generation: local ${kind} reference is too large to upload (${Math.round(info.size / 1024 / 1024)} MB > ${Math.round(maxUploadBytes / 1024 / 1024)} MB): ${rawPath}`);
    }
    let body: Buffer = Buffer.from(await readFile(resolved.absolute));
    let uploadPath = resolved.absolute;
    // HEIC / HEIF auto-conversion. Apple devices export HEIC by default;
    // downstream video providers' image classifiers either fail to parse it
    // (some treat it as PNG due to content-type mislabel) or treat the iPhone
    // photo signal as "definitely real-person" and reject for deepfake
    // privacy. Converting to JPG in-memory before upload sidesteps both.
    // Pure-JS heic-convert keeps this working on Windows where sharp's
    // prebuilt binaries don't bundle libheif.
    if (kind === 'image' && isHeicFile(resolved.absolute, body)) {
      try {
        const converted = await convertHeicToJpeg(body);
        toolLog(`🖼️ HEIC 自动转 JPG: ${path.basename(resolved.absolute)} (${Math.round(body.length / 1024)}KB → ${Math.round(converted.length / 1024)}KB)`);
        body = converted;
        // Rename for the storage key so the uploaded object reflects the
        // actual content. The original local file is untouched.
        uploadPath = resolved.absolute.replace(/\.(heic|heif)$/i, '.jpg');
      } catch (error) {
        toolWarn(`⚠️ HEIC 转换失败，将按原始 HEIC 上传: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!config) {
      urls.push(await uploadViaPlatform(platform!, { body, contentType: inferContentType(uploadPath, kind), kind, name: path.basename(uploadPath) }));
      continue;
    }
    const objectKey = buildObjectKey(config, uploadPath, kind);
    await putS3Object(config, objectKey, body, inferContentType(uploadPath, kind));
    urls.push(buildPublicUrl(config, objectKey));
  }
  return urls;
}

function isHeicFile(filePath: string, body: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.heic' || ext === '.heif') return true;
  // Magic-bytes check: HEIC/HEIF use the ISO BMFF container. Bytes 4-11 are
  // 'ftyp' + brand. Common brands: heic, heix, hevc, mif1, msf1, heim, heis,
  // hevm, hevs. This catches misnamed files (e.g., user renames .heic to
  // .jpg manually without conversion).
  if (body.length < 12) return false;
  if (body.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = body.toString('ascii', 8, 12).toLowerCase();
  return ['heic', 'heix', 'hevc', 'hevm', 'hevs', 'heim', 'heis', 'mif1', 'msf1'].includes(brand);
}

async function convertHeicToJpeg(heicBuffer: Buffer): Promise<Buffer> {
  // Dynamic import keeps the heic-convert WASM payload out of the cold-start
  // path; only loaded when an HEIC file actually appears.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — heic-convert has no shipped TypeScript types
  const mod = await import('heic-convert');
  const convert: unknown = (mod as { default?: unknown }).default ?? mod;
  if (typeof convert !== 'function') {
    throw new Error('heic-convert module did not export a callable default');
  }
  // heic-convert expects a Node Buffer (or Uint8Array) directly; passing a
  // pre-sliced ArrayBuffer breaks heic-decode's internal magic-bytes check.
  const result: Uint8Array = await (convert as (opts: { buffer: Buffer; format: string; quality: number }) => Promise<Uint8Array>)({
    buffer: heicBuffer,
    format: 'JPEG',
    quality: 0.92,
  });
  return Buffer.from(result);
}
