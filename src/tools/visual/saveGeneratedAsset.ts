import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, ensureNotSensitivePath } from '../../utils/fs.js';
import type { ToolExecutionContext } from '../types.js';
import { resolveToolPathWithWorkspaceAccess } from '../workspaceAccess.js';

function parseDataUrl(dataUrl: string): Buffer | null {
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) {
    return null;
  }
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? '';
  return isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
}

async function readGeneratedAsset(assetPath: string, context: ToolExecutionContext): Promise<Buffer> {
  const dataBuffer = parseDataUrl(assetPath);
  if (dataBuffer) {
    return dataBuffer;
  }

  if (/^https?:\/\//i.test(assetPath)) {
    const res = await fetch(assetPath);
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const absoluteSource = path.isAbsolute(assetPath)
    ? assetPath
    : path.resolve(context.cwd, assetPath);
  return readFile(absoluteSource);
}

export async function saveGeneratedAssetToWorkspace(options: {
  assetPath: string;
  targetPath: string;
  defaultExtension: string;
  toolName: string;
  context: ToolExecutionContext;
}): Promise<string> {
  const targetWithExtension = path.extname(options.targetPath)
    ? options.targetPath
    : `${options.targetPath}${options.defaultExtension}`;
  const { absolute } = await resolveToolPathWithWorkspaceAccess({
    inputPath: targetWithExtension,
    toolName: options.toolName,
    context: options.context,
  });
  ensureNotSensitivePath(absolute, targetWithExtension);

  const buffer = await readGeneratedAsset(options.assetPath, options.context);
  await ensureDir(path.dirname(absolute));
  await writeFile(absolute, buffer);
  return absolute;
}
