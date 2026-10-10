/**
 * tools/officeDocuments.ts — create_presentation, create_document and
 * create_spreadsheet: real .pptx / .docx / .xlsx files from a JSON spec.
 *
 * Each file gets its spec saved next to it as a hidden sidecar
 * (`deck.pptx` → `.deck.pptx.json`). A later call with the same `path` and
 * `edits` (JSON-Pointer operations) changes the saved spec and rebuilds the
 * file, so "把第3页标题改成…" is one small call instead of a rewrite.
 * `pdf: true` also exports a PDF next to the file (LibreOffice).
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { ensureNotSensitivePath, invalidateWalkFilesCache } from '../utils/fs.js';
import { buildDocument, documentOutline, tocHeadings } from './office/docx.js';
import { markdownToDocSpec } from './office/markdown.js';
import { exportPdf, findSoffice, locateHeadings, pdfPageTexts } from './office/pdf.js';
import { buildPresentation, deckOutline } from './office/pptx.js';
import {
  applySpecEdits,
  normalizeDeckSpec,
  normalizeDocSpec,
  normalizeWorkbookSpec,
  SpecError,
  type DeckSpec,
  type DocSpec,
  type WorkbookSpec,
} from './office/spec.js';
import { slugify } from './office/text.js';
import { isKnownTheme, resolveTheme, THEME_IDS } from './office/themes.js';
import { buildWorkbook, workbookOutline } from './office/xlsx.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';
import { resolveToolPathWithWorkspaceAccess } from './workspaceAccess.js';

export type OfficeKind = 'presentation' | 'document' | 'spreadsheet';
type OfficeAction = Extract<AgentAction, { type: 'create_presentation' | 'create_document' | 'create_spreadsheet' }>;

const KIND_OF: Record<OfficeAction['type'], OfficeKind> = {
  create_presentation: 'presentation',
  create_document: 'document',
  create_spreadsheet: 'spreadsheet',
};
const EXT: Record<OfficeKind, string> = { presentation: '.pptx', document: '.docx', spreadsheet: '.xlsx' };
const DEFAULT_DIR = 'outputs';
const SIDECAR_VERSION = 1;

interface Sidecar {
  version: number;
  kind: OfficeKind;
  spec: unknown;
  updatedAt: string;
}

/** `outputs/deck.pptx` → `outputs/.deck.pptx.json`. */
export function sidecarPath(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.json`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A spec may arrive as a JSON string (some models send nested objects that way). */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function withExtension(requested: string, ext: string): string {
  const current = path.extname(requested).toLowerCase();
  if (current === ext) return requested;
  // A different office extension is replaced; anything else is kept and extended.
  if (['.pptx', '.ppt', '.docx', '.doc', '.xlsx', '.xls', '.pdf', '.md', '.json', '.csv'].includes(current)) return requested.slice(0, -current.length) + ext;
  return requested + ext;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(() => true, () => false);
}

/** outputs/<slug>.<ext>, with -2, -3 … when taken. */
async function defaultPath(cwd: string, title: string | undefined, kind: OfficeKind): Promise<string> {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const stem = slugify(title, `${kind}-${stamp}`);
  for (let n = 1; n < 1000; n += 1) {
    const candidate = path.join(cwd, DEFAULT_DIR, `${stem}${n === 1 ? '' : `-${n}`}${EXT[kind]}`);
    if (!(await exists(candidate))) return candidate;
  }
  return path.join(cwd, DEFAULT_DIR, `${stem}-${Date.now()}${EXT[kind]}`);
}

async function readSidecar(file: string, kind: OfficeKind): Promise<Sidecar | undefined> {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath(file), 'utf8')) as Sidecar;
    if (parsed && parsed.kind === kind && isRecord(parsed.spec)) return parsed;
  } catch {
    // Missing or unreadable.
  }
  return undefined;
}

/** Writes through a temporary file, so a reader never sees half a file. */
async function writeAtomic(file: string, data: Buffer | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const partial = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.part`);
  try {
    await writeFile(partial, data);
    await rename(partial, file);
  } catch (error) {
    await rm(partial, { force: true });
    if ((error as NodeJS.ErrnoException).code === 'EBUSY' || (error as NodeJS.ErrnoException).code === 'EPERM') {
      throw new Error(`${path.basename(file)} is open in another program; close it and try again`);
    }
    throw error;
  }
}

function failure(action: OfficeAction, message: string, code = 'tool_invalid_arguments'): ToolExecutionResult {
  return { action, ok: false, output: message, error: { code, message, retryable: code === 'tool_invalid_arguments' } };
}

function specProblems(error: SpecError, kind: OfficeKind): string {
  const example = kind === 'presentation'
    ? 'Example: {"title":"…","theme":"business","slides":[{"layout":"title","title":"…"},{"layout":"bullets","title":"…","bullets":["…"]}]}'
    : kind === 'document'
      ? 'Example: {"title":"…","blocks":[{"type":"heading","text":"…"},{"type":"paragraph","text":"…"}]} — or pass markdown instead of spec.'
      : 'Example: {"sheets":[{"name":"Sales","columns":[{"header":"Month"},{"header":"Amount","format":"number"}],"rows":[["Jan",120]]}]}';
  return [`The ${kind} spec needs changes:`, ...error.problems.map((p) => `- ${p}`), example].join('\n');
}

function display(file: string, cwd: string): string {
  const relative = path.relative(cwd, file);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : file;
}

/** The PDF next to `file`; for documents with contents, the contents get page numbers first. */
async function maybeExportPdf(file: string, wanted: boolean): Promise<{ pdf?: string; note?: string }> {
  if (!wanted) return {};
  const result = await exportPdf(file);
  return 'pdf' in result ? { pdf: result.pdf } : { note: result.error };
}

/**
 * Renders the document once to find the page of each heading, then
 * rebuilds it with those numbers in the table of contents. Skipped (entries
 * stay without numbers) when LibreOffice or pdftotext is missing.
 */
async function tocPageNumbers(buffer: Buffer, spec: DocSpec): Promise<Array<number | undefined> | undefined> {
  if (!(await findSoffice())) return undefined;
  const work = path.join(os.tmpdir(), `artemis-office-toc-${process.pid}-${Date.now()}`);
  try {
    await mkdir(work, { recursive: true });
    const draft = path.join(work, 'draft.docx');
    await writeFile(draft, buffer);
    const result = await exportPdf(draft);
    if (!('pdf' in result)) return undefined;
    const pages = await pdfPageTexts(result.pdf);
    if (!pages) return undefined;
    const marker = pages.findIndex((page) => /目录|Contents/.test(page));
    return locateHeadings(pages, tocHeadings(spec).map((h) => h.title), marker >= 0 ? marker + 1 : 0);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function executeOfficeDocument(action: OfficeAction, context: ToolExecutionContext): Promise<ToolExecutionResult> {
  const kind = KIND_OF[action.type];
  const raw = action as OfficeAction & { spec?: unknown; markdown?: unknown; edits?: unknown; path?: string; pdf?: boolean; theme?: string };
  const specInput = parseMaybeJson(raw.spec);
  const markdown = kind === 'document' && typeof raw.markdown === 'string' && raw.markdown.trim() ? raw.markdown : undefined;
  const edits = parseMaybeJson(raw.edits);
  if (specInput === undefined && !markdown && edits === undefined) {
    return failure(action, `Pass spec${kind === 'document' ? ' (or markdown)' : ''} to create a ${kind}, or path + edits to change one made earlier.`);
  }
  if (specInput !== undefined && !isRecord(specInput)) return failure(action, 'spec must be a JSON object');

  // Where the file goes.
  let target: string;
  let cwd = context.cwd;
  if (raw.path?.trim()) {
    const resolved = await resolveToolPathWithWorkspaceAccess({ inputPath: withExtension(raw.path.trim(), EXT[kind]), toolName: action.type, context });
    target = resolved.absolute;
    cwd = resolved.cwd;
    if (context.permissionMode !== 'full-access') ensureNotSensitivePath(target, raw.path);
  } else {
    if (edits !== undefined && specInput === undefined && !markdown) return failure(action, 'edits need the path of the file to change');
    const title = isRecord(specInput) && typeof specInput.title === 'string' ? specInput.title : markdown ? /^#\s+(.+)$/m.exec(markdown)?.[1] : undefined;
    target = await defaultPath(context.cwd, title, kind);
  }

  // The spec: given, from Markdown, or the saved one.
  let base: unknown;
  if (markdown) base = markdownToDocSpec(markdown, isRecord(specInput) ? (({ blocks: _drop, ...meta }) => meta)(specInput) as Partial<DocSpec> : {});
  else if (specInput !== undefined) base = specInput;
  else {
    const saved = await readSidecar(target, kind);
    if (!saved) {
      const there = await exists(target);
      return failure(action, there
        ? `${display(target, cwd)} was not made by this tool (no saved outline next to it), so it cannot be edited this way. Recreate it with a full spec.`
        : `${display(target, cwd)} does not exist. Create it with a full spec first.`);
    }
    base = saved.spec;
  }
  if (typeof raw.theme === 'string' && isRecord(base)) base = { ...base, theme: raw.theme };

  let normalized: DeckSpec | DocSpec | WorkbookSpec;
  try {
    const edited = edits !== undefined ? applySpecEdits(base, edits) : base;
    normalized = kind === 'presentation' ? normalizeDeckSpec(edited) : kind === 'document' ? normalizeDocSpec(edited) : normalizeWorkbookSpec(edited);
  } catch (error) {
    if (error instanceof SpecError) return failure(action, specProblems(error, kind));
    throw error;
  }

  const notes: string[] = [];
  if (normalized.theme && !isKnownTheme(normalized.theme)) notes.push(`Unknown theme "${normalized.theme}"; used minimal. Themes: ${THEME_IDS.join(', ')}.`);
  const theme = resolveTheme(normalized.theme);

  let buffer: Buffer;
  let summary: string[];
  let warnings: string[];
  if (kind === 'presentation') {
    const deck = normalized as DeckSpec;
    const built = await buildPresentation(deck, cwd);
    buffer = built.buffer;
    warnings = built.warnings;
    summary = [`Slides: ${built.slideCount}`, 'Outline (slide n is /slides/n-1 in edits):', ...deckOutline(deck).map((line) => `  ${line}`)];
  } else if (kind === 'document') {
    const doc = normalized as DocSpec;
    let built = await buildDocument(doc, cwd);
    if (built.hasToc) {
      const pages = await tocPageNumbers(built.buffer, doc).catch(() => undefined);
      if (pages?.some((p) => p !== undefined)) built = await buildDocument(doc, cwd, { tocPages: pages });
    }
    buffer = built.buffer;
    warnings = built.warnings;
    const outline = documentOutline(doc);
    summary = [`Blocks: ${doc.blocks.length}, headings: ${built.headings}`, ...(outline.length ? ['Headings ([n] is /blocks/n in edits):', ...outline.map((line) => `  ${line}`)] : [])];
  } else {
    const book = normalized as WorkbookSpec;
    const built = await buildWorkbook(book);
    buffer = built.buffer;
    warnings = built.warnings;
    summary = [`Sheets: ${book.sheets.length}, formulas: ${built.formulas}, charts: ${built.charts}`, 'Sheets ([n] is /sheets/n in edits; rows/i is the i-th data row):', ...workbookOutline(book, built.sheets).map((line) => `  ${line}`)];
  }

  const existed = await exists(target);
  await writeAtomic(target, buffer);
  const sidecar: Sidecar = { version: SIDECAR_VERSION, kind, spec: normalized, updatedAt: new Date().toISOString() };
  await writeAtomic(sidecarPath(target), JSON.stringify(sidecar, null, 2));
  invalidateWalkFilesCache(cwd);

  const pdf = await maybeExportPdf(target, raw.pdf === true);
  const label = kind === 'presentation' ? 'Presentation' : kind === 'document' ? 'Document' : 'Spreadsheet';
  const output = [
    `${label} ${existed ? 'updated' : 'saved'}: ${target}`,
    `Theme: ${theme.id}`,
    ...summary,
    ...(pdf.pdf ? [`PDF: ${pdf.pdf}`] : []),
    ...(pdf.note ? [`PDF not made: ${pdf.note}.`] : []),
    ...warnings.map((w) => `Warning: ${w}`),
    ...notes,
    `To change it later, call this tool again with path "${display(target, cwd)}" and edits, e.g. [{"op":"set","path":"${kind === 'presentation' ? '/slides/0/title' : kind === 'document' ? '/blocks/0/text' : '/sheets/0/rows/0/1'}","value":"…"}]; ops: set, insert, remove, merge.`,
    'Tell the user the file path above so the file shows up for them.',
  ].join('\n');
  return {
    action,
    ok: true,
    output,
    data: { path: target, kind, theme: theme.id, ...(pdf.pdf ? { pdf: pdf.pdf } : {}), warnings },
  };
}
