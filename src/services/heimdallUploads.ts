import path from 'node:path';
import { copyFile, stat } from 'node:fs/promises';
import type { HeimdallArtifactRecord, SessionRecord } from '../core/types.js';
import {
  type HeimdallThreadState,
  getHeimdallThreadPaths,
  persistHeimdallThreadState,
  prepareHeimdallThreadState,
  readHeimdallThreadState,
  recordHeimdallEvent,
  toHeimdallVirtualPath,
} from '../core/heimdall.js';
import { SessionStore } from '../storage/sessions.js';
import { ensureDir, pathExists } from '../utils/fs.js';

function now(): string {
  return new Date().toISOString();
}

function inferMimeType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    case '.json':
      return 'application/json';
    case '.md':
      return 'text/markdown';
    case '.txt':
    case '.log':
      return 'text/plain';
    default:
      return undefined;
  }
}

async function allocateStoredUploadPath(
  uploadsDir: string,
  inputPath: string,
): Promise<string> {
  const baseName = path.basename(inputPath);
  const parsed = path.parse(baseName);
  let candidate = path.join(uploadsDir, baseName);
  let attempt = 1;

  while (await pathExists(candidate)) {
    candidate = path.join(
      uploadsDir,
      `${parsed.name}-${String(attempt).padStart(2, '0')}${parsed.ext}`,
    );
    attempt += 1;
  }

  return candidate;
}

async function loadOrPrepareThreadState(options: {
  cwd: string;
  session: SessionRecord;
}): Promise<HeimdallThreadState> {
  const rootSessionId = options.session.rootSessionId ?? options.session.id;
  const existing = await readHeimdallThreadState(options.cwd, rootSessionId);
  if (existing) {
    return existing;
  }
  return prepareHeimdallThreadState({
    cwd: options.cwd,
    session: options.session,
    permissionMode: 'GHOSTWRITER',
  });
}

function upsertUploadArtifact(
  state: HeimdallThreadState,
  artifact: HeimdallArtifactRecord,
): void {
  const artifactMap = new Map(
    state.artifacts.map((entry) => [entry.path, entry] as const),
  );
  artifactMap.set(artifact.path, artifact);
  state.artifacts = [...artifactMap.values()]
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .slice(-128);
}

function syncMediaInventory(state: HeimdallThreadState): void {
  const mediaPaths: string[] = [];
  let imageCount = 0;
  let documentCount = 0;
  let audioVideoCount = 0;

  for (const upload of state.uploads) {
    const mime = upload.mimeType?.toLowerCase() ?? '';
    if (mime.startsWith('image/')) {
      imageCount += 1;
      mediaPaths.push(upload.storedPath);
      continue;
    }
    if (mime === 'application/pdf') {
      documentCount += 1;
      mediaPaths.push(upload.storedPath);
      continue;
    }
    if (mime.startsWith('audio/') || mime.startsWith('video/')) {
      audioVideoCount += 1;
      mediaPaths.push(upload.storedPath);
    }
  }

  state.mediaInventory = {
    totalCount: mediaPaths.length,
    imageCount,
    documentCount,
    audioVideoCount,
    latestMediaPaths: mediaPaths.slice(-5),
    updatedAt: now(),
  };
}

export async function ingestHeimdallUploads(options: {
  cwd: string;
  session: SessionRecord;
  sessionStore: SessionStore;
  inputPaths: string[];
}): Promise<{
  state: HeimdallThreadState;
  imported: HeimdallThreadState['uploads'];
  skipped: Array<{ inputPath: string; reason: string }>;
}> {
  const state = await loadOrPrepareThreadState(options);
  const imported: HeimdallThreadState['uploads'] = [];
  const skipped: Array<{ inputPath: string; reason: string }> = [];
  const paths = getHeimdallThreadPaths(options.cwd, state.rootSessionId);
  await ensureDir(paths.uploads);

  for (const inputPath of options.inputPaths) {
    const resolved = path.resolve(options.cwd, inputPath);
    let fileStat;
    try {
      fileStat = await stat(resolved);
    } catch {
      skipped.push({
        inputPath,
        reason: 'not found',
      });
      continue;
    }

    if (!fileStat.isFile()) {
      skipped.push({
        inputPath,
        reason: 'not a file',
      });
      continue;
    }

    const storedAbsolutePath = await allocateStoredUploadPath(paths.uploads, resolved);
    await copyFile(resolved, storedAbsolutePath);
    const createdAt = now();
    const storedRelativePath = path.relative(options.cwd, storedAbsolutePath);
    const uploadRecord = {
      id: `upload:${createdAt}:${path.basename(storedAbsolutePath)}`,
      originalPath: resolved,
      storedPath: storedRelativePath,
      filename: path.basename(storedAbsolutePath),
      sizeBytes: fileStat.size,
      mimeType: inferMimeType(resolved),
      createdAt,
      updatedAt: createdAt,
      sessionId: options.session.id,
      metadata: {
        thread_root: paths.threadRoot,
        virtual_path: toHeimdallVirtualPath(
          options.cwd,
          state.rootSessionId,
          storedAbsolutePath,
        ),
      },
    } satisfies HeimdallThreadState['uploads'][number];

    state.uploads = [...state.uploads, uploadRecord].slice(-128);
    upsertUploadArtifact(state, {
      id: `artifact:${uploadRecord.id}`,
      path: uploadRecord.storedPath,
      kind: 'upload',
      source: 'heimdall.uploads',
      createdAt: uploadRecord.createdAt,
      updatedAt: uploadRecord.updatedAt,
      sessionId: options.session.id,
      existsInWorkspace: true,
      metadata: {
        original_path: uploadRecord.originalPath,
        filename: uploadRecord.filename,
        virtual_path: uploadRecord.metadata?.virtual_path ?? uploadRecord.storedPath,
        ...(uploadRecord.mimeType ? { mime_type: uploadRecord.mimeType } : {}),
        ...(typeof uploadRecord.sizeBytes === 'number'
          ? { size_bytes: String(uploadRecord.sizeBytes) }
          : {}),
      },
    });
    imported.push(uploadRecord);
  }

  if (imported.length > 0) {
    syncMediaInventory(state);
    await persistHeimdallThreadState(state);
    await recordHeimdallEvent(options.sessionStore, options.session, {
      kind: 'upload_ingested',
      summary: `Heimdall ingested ${imported.length} upload${imported.length === 1 ? '' : 's'}.`,
      sessionId: options.session.id,
      metadata: {
        upload_count: String(imported.length),
        skipped_count: String(skipped.length),
        latest_upload: imported.at(-1)?.storedPath,
      },
    });
    await options.sessionStore.save(options.session);
  }

  return {
    state,
    imported,
    skipped,
  };
}
