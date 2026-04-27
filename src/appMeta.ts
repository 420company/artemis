import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_NAME = 'Artemis';
export const APP_PUBLISHER = 'www.420.company';

function loadPackageVersion(): string {
  try {
    const currentFilename = fileURLToPath(import.meta.url);
    const currentDir = dirname(currentFilename);
    const pkgPath = join(currentDir, '..', 'package.json');
    const pkgData = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(pkgData) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.trim()
      ? parsed.version.trim()
      : '0.4.46';
  } catch {
    return '0.4.46';
  }
}

export const APP_VERSION = loadPackageVersion();
export const APP_USER_AGENT = `${APP_NAME}/${APP_VERSION} (+https://${APP_PUBLISHER})`;
