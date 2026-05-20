import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Root directory for all visual outputs (images, videos, saga long-videos).
 *
 * Platform defaults:
 *   - macOS:   ~/Pictures/Artemis
 *   - Windows: %USERPROFILE%\Downloads\Artemis
 *   - Linux:   ~/Pictures/Artemis
 *
 * Override with the ARTEMIS_MEDIA_OUTPUT_ROOT environment variable.
 *
 * Note: a per-call `outputPath` argument still takes precedence over this default
 * in every generate_* tool.
 */
export function getMediaOutputRoot(): string {
  const override = process.env.ARTEMIS_MEDIA_OUTPUT_ROOT?.trim();
  if (override) return override;

  if (process.platform === 'win32') {
    return path.join(homedir(), 'Downloads', 'Artemis');
  }
  // macOS + Linux: Pictures/Artemis
  return path.join(homedir(), 'Pictures', 'Artemis');
}
