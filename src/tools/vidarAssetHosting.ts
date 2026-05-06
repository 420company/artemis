import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { ProviderStore } from '../providers/store.js';
import type { ProviderStoreData, VidarAssetHostingConfig } from '../providers/types.js';
import type { ToolExecutionContext } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';

export type HostedReferenceKind = 'video' | 'audio';

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
  const ext = path.extname(filePath).toLowerCase() || (kind === 'video' ? '.mp4' : '.mp3');
  const safeBase = path.basename(filePath, ext).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || kind;
  const objectPath = `${kind}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safeBase}${ext}`;
  return config.prefix ? `${config.prefix}/${objectPath}` : objectPath;
}

function buildPublicUrl(config: ResolvedAssetHostingConfig, objectKey: string): string {
  return `${normalizePublicBaseUrl(config.publicBaseUrl)}/${encodeObjectKey(objectKey)}`;
}

function requiredConfigError(): Error {
  return new Error(
    'generate_video: local video/audio references need Vidar asset hosting. Configure visualProfile.assetHosting or VIDAR_ASSET_* environment variables for an S3/R2-compatible public bucket.',
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
    if (hosting?.enabled) return hosting;
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
    throw new Error(`generate_video: Vidar asset upload failed (HTTP ${res.status}): ${raw.slice(0, 500)}`);
  }
}

export async function uploadLocalReferenceAssets(
  paths: string[] | undefined,
  kind: HostedReferenceKind,
  context: ToolExecutionContext,
): Promise<string[]> {
  const rawPaths = Array.isArray(paths) ? paths.map((value) => value.trim()).filter(Boolean) : [];
  if (rawPaths.length === 0) return [];

  const config = await resolveVidarAssetHostingConfig(context.cwd);
  if (!config) throw requiredConfigError();

  const urls: string[] = [];
  for (const rawPath of rawPaths) {
    const resolved = await resolveToolPathWithWorkspaceAccess({
      inputPath: rawPath,
      toolName: 'generate_video',
      context,
    });
    const info = await stat(resolved.absolute);
    if (info.size > config.maxUploadBytes) {
      throw new Error(`generate_video: local ${kind} reference is too large for Vidar asset upload (${Math.round(info.size / 1024 / 1024)} MB > ${Math.round(config.maxUploadBytes / 1024 / 1024)} MB): ${rawPath}`);
    }
    const body = await readFile(resolved.absolute);
    const objectKey = buildObjectKey(config, resolved.absolute, kind);
    await putS3Object(config, objectKey, body, inferContentType(resolved.absolute, kind));
    urls.push(buildPublicUrl(config, objectKey));
  }
  return urls;
}
