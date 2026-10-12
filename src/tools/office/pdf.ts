/**
 * tools/office/pdf.ts — PDF export through LibreOffice (headless).
 *
 * LibreOffice (MPL-2.0) is optional: the hosted toolbox installs it, a
 * desktop may not have it. Each conversion runs with its own throwaway
 * profile (so parallel runs do not fight over one), a timeout, and writes
 * into a private temporary folder before the PDF is moved into place.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rename, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const CANDIDATES = [
  process.env.ARTEMIS_SOFFICE_BIN,
  'soffice',
  'libreoffice',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
  '/opt/libreoffice/program/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
].filter((c): c is string => Boolean(c));

let cached: { bin: string | undefined } | undefined;

/** The LibreOffice binary, or undefined when it is not installed. */
export async function findSoffice(): Promise<string | undefined> {
  if (cached) return cached.bin;
  for (const candidate of CANDIDATES) {
    if (path.isAbsolute(candidate) && !existsSync(candidate)) continue;
    try {
      await execFileAsync(candidate, ['--version'], { timeout: 20_000 });
      cached = { bin: candidate };
      return candidate;
    } catch {
      // Not this one.
    }
  }
  cached = { bin: undefined };
  return undefined;
}

/** For tests. */
export function resetSofficeCache(): void {
  cached = undefined;
}

const CONVERT_TIMEOUT_MS = 180_000;

/**
 * Converts `file` to PDF at `target` (default: next to it, same name).
 * Returns the PDF path, or an error message in plain words.
 */
export async function exportPdf(file: string, target = file.replace(/\.[^.\\/]+$/, '') + '.pdf'): Promise<{ pdf: string } | { error: string }> {
  const result = await convertWithSoffice(file, 'pdf', target);
  return 'error' in result ? result : { pdf: result.file };
}

/**
 * Converts `file` with LibreOffice to `format` (its filter name, e.g. pdf
 * or xlsx) at `target`. Returns the new file, or an error in plain words.
 */
export async function convertWithSoffice(
  file: string,
  format: string,
  target: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ file: string } | { error: string }> {
  const what = format === 'pdf' ? 'PDF export' : `Conversion to .${format}`;
  const bin = await findSoffice();
  if (!bin) return { error: `${what} needs LibreOffice, which is not installed on this machine` };
  const work = await mkdtemp(path.join(os.tmpdir(), 'artemis-office-pdf-'));
  try {
    const profile = path.join(work, 'profile');
    const out = path.join(work, 'out');
    // A copy with a plain name: LibreOffice is picky about some characters.
    const input = path.join(work, `input${path.extname(file)}`);
    await copyFile(file, input);
    await execFileAsync(bin, [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--convert-to',
      format,
      '--outdir',
      out,
      input,
    ], {
      timeout: options.timeoutMs ?? CONVERT_TIMEOUT_MS,
      env: { ...process.env, HOME: work },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const produced = (await readdir(out).catch(() => [] as string[])).find((name) => name.endsWith(`.${format}`));
    if (!produced) return { error: `LibreOffice did not produce a .${format} file` };
    await rename(path.join(out, produced), target).catch(async () => {
      await copyFile(path.join(out, produced), target);
    });
    return { file: target };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: /timed out|ETIMEDOUT|SIGTERM|abort/i.test(message) ? `${what} took too long and was stopped` : `${what} failed: ${message.split('\n')[0]}` };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** The text of each page of a PDF (pdftotext from poppler), or undefined when it cannot be read. */
export async function pdfPageTexts(pdf: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-enc', 'UTF-8', pdf, '-'], { timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
    const pages = stdout.split('\f');
    if (pages.length && !pages[pages.length - 1]!.trim()) pages.pop();
    return pages;
  } catch {
    return undefined;
  }
}

/**
 * The page each title first appears on, in order and never going back
 * (titles are headings in reading order); skips the first `fromPage` pages
 * (the contents pages themselves). Undefined entries were not found.
 */
export function locateHeadings(pages: string[], titles: string[], fromPage: number): Array<number | undefined> {
  const squash = (s: string) => s.replace(/\s+/g, '');
  const squashed = pages.map(squash);
  let page = fromPage;
  return titles.map((title) => {
    const needle = squash(title);
    if (!needle) return undefined;
    for (let p = page; p < squashed.length; p += 1) {
      if (squashed[p]!.includes(needle)) {
        page = p;
        return p + 1;
      }
    }
    return undefined;
  });
}
