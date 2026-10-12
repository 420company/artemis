/**
 * tools/office/read.ts — the text of documents the agent is given to read
 * (read_document): PDF through poppler (pdftotext, pdfinfo, pdftoppm for
 * pages without a text layer), .docx / .pptx through the JSZip the office
 * builders already use, .xlsx through ExcelJS, older formats (.doc, .xls,
 * .ppt, OpenDocument, RTF) converted to PDF by the platform's sandboxed
 * converter (the artemis-office socket: its own throwaway user, no network)
 * or, where there is none (a local install), by LibreOffice run here with a
 * bare environment in its own process group.
 *
 * Every step has a cap: the file's size, what its ZIP parts inflate to
 * (counted while inflating, so a part that lies about its size is stopped
 * too: ExcelJS only ever sees parts that passed), pages and rows per read,
 * characters returned, and time. Nothing in a document runs: XML is read
 * with a scanner, never evaluated.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { findSoffice } from './pdf.js';
import { LEGACY_SHEET_EXTENSIONS } from './documentFormat.js';

export const READ_DOCUMENT_LIMITS = {
  /** Largest PDF read. */
  maxPdfBytes: 50 * 1024 * 1024,
  /** Largest Office file (.docx/.pptx/.xlsx and the older formats). */
  maxOfficeBytes: 25 * 1024 * 1024,
  /** What all of a ZIP's parts may inflate to, together. */
  maxInflatedBytes: 160 * 1024 * 1024,
  /** What one ZIP part may inflate to. */
  maxPartBytes: 48 * 1024 * 1024,
  /** A spreadsheet's parts together (ExcelJS builds objects from all of them). */
  maxXlsxInflatedBytes: 48 * 1024 * 1024,
  /** One spreadsheet part. */
  maxXlsxPartBytes: 24 * 1024 * 1024,
  /** Characters of document text in one result (about 15k tokens). */
  maxOutputChars: 60_000,
  /** PDF pages (or slides) read as text in one call. */
  maxTextPages: 50,
  /** Pages rendered as images in one call (the model sees at most 8 images per request). */
  maxImagePages: 4,
  /** Spreadsheet rows read in one call, over all sheets. */
  maxSheetRows: 1_000,
  /** One external program (pdftotext, pdftoppm, LibreOffice). */
  commandTimeoutMs: 45_000,
  /** The whole read. */
  totalTimeoutMs: 120_000,
} as const;

export class DocumentReadError extends Error {
  constructor(message: string, readonly code: string = 'read_document_failed') {
    super(message);
  }
}

export { documentFormatOf, isReadableDocument, LEGACY_SHEET_EXTENSIONS, type DocumentFormat } from './documentFormat.js';

// ── page ranges ─────────────────────────────────────────────────────────────

/**
 * "3", "2-5", "4-" or "1,3,7-9" as sorted 1-based numbers within 1..total
 * (total unknown: no upper bound). Undefined for an empty range; throws on
 * one that cannot be read.
 */
export function parsePageRange(spec: string | number | undefined, total?: number): number[] | undefined {
  if (spec === undefined || spec === null || String(spec).trim() === '') return undefined;
  const pages = new Set<number>();
  const top = total ?? Number.MAX_SAFE_INTEGER;
  for (const part of String(spec).split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const match = /^(\d+)\s*(?:(-|–|~|to)\s*(\d+)?)?$/i.exec(piece);
    if (!match) throw new DocumentReadError(`pages "${spec}" is not a page range (use e.g. "3", "2-5" or "1,4-6")`, 'bad_pages');
    const from = Number(match[1]);
    const to = match[2] ? (match[3] ? Number(match[3]) : top) : from;
    if (from < 1 || to < from) throw new DocumentReadError(`pages "${spec}" is not a page range (pages start at 1)`, 'bad_pages');
    // A runaway range ("1-999999999") never builds a huge set.
    for (let p = from; p <= Math.min(to, top, from + 10_000); p += 1) pages.add(p);
  }
  const sorted = [...pages].filter((p) => p <= top).sort((a, b) => a - b);
  return sorted.length ? sorted : undefined;
}

/** Consecutive runs of page numbers as "1-3, 5". */
export function describePages(pages: number[]): string {
  const runs: string[] = [];
  let start = pages[0];
  let prev = pages[0];
  for (const page of [...pages.slice(1), Number.NaN]) {
    if (page === (prev ?? 0) + 1) {
      prev = page;
      continue;
    }
    if (start !== undefined) runs.push(start === prev ? String(start) : `${start}-${prev}`);
    start = page;
    prev = page;
  }
  return runs.join(', ');
}

// ── external programs ───────────────────────────────────────────────────────

function run(bin: string, args: string[], options: { timeoutMs: number; signal?: AbortSignal; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DocumentReadError('stopped', 'aborted'));
      return;
    }
    const child = execFile(bin, args, {
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      ...(options.signal ? { signal: options.signal } : {}),
    }, (error, stdout, stderr) => {
      if (error) {
        const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (e.code === 'ENOENT') reject(new DocumentReadError(`${bin} is not installed on this machine`, 'tool_missing'));
        else if (options.signal?.aborted || e.name === 'AbortError') reject(new DocumentReadError('stopped', 'aborted'));
        else if (e.killed || e.signal === 'SIGKILL') reject(new DocumentReadError(`${bin} took too long and was stopped`, 'timeout'));
        else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new DocumentReadError(`${bin} produced too much output`, 'too_large'));
        else reject(new DocumentReadError(`${bin} failed: ${errorLine(String(stderr || e.message).split('\n').find((l) => l.trim()) ?? 'unknown error')}`, 'tool_failed'));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });
}

// ── PDF ─────────────────────────────────────────────────────────────────────

export interface PdfInfo {
  pages?: number;
  encrypted?: boolean;
  title?: string;
}

/** pdfinfo's page count and title (undefined fields when it cannot tell). */
export async function pdfInfo(file: string, signal?: AbortSignal): Promise<PdfInfo> {
  try {
    const { stdout } = await run('pdfinfo', ['-enc', 'UTF-8', file], { timeoutMs: READ_DOCUMENT_LIMITS.commandTimeoutMs, signal, maxBuffer: 1024 * 1024 });
    const pages = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
    const title = /^Title:\s+(.+)$/m.exec(stdout)?.[1]?.trim();
    return {
      ...(Number.isFinite(pages) && pages > 0 ? { pages } : {}),
      encrypted: /^Encrypted:\s+yes/m.test(stdout),
      ...(title ? { title } : {}),
    };
  } catch (error) {
    if (error instanceof DocumentReadError && /password|encrypt/i.test(error.message)) return { encrypted: true };
    if (error instanceof DocumentReadError && error.code === 'aborted') throw error;
    return {};
  }
}

/** The text of pages `first..last` (pdftotext, layout kept), one string per page. */
export async function pdfTextPages(file: string, first: number, last: number, signal?: AbortSignal): Promise<string[]> {
  try {
    const { stdout } = await run('pdftotext', ['-enc', 'UTF-8', '-layout', '-f', String(first), '-l', String(last), file, '-'], {
      timeoutMs: READ_DOCUMENT_LIMITS.commandTimeoutMs,
      signal,
    });
    const pages = stdout.split('\f');
    if (pages.length > last - first + 1 || (pages.length && !pages[pages.length - 1]!.trim())) pages.pop();
    return pages.map((page) => page.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim());
  } catch (error) {
    if (error instanceof DocumentReadError && /password|encrypt|Incorrect password/i.test(error.message)) {
      throw new DocumentReadError('the PDF is password-protected; ask the owner for an unlocked copy', 'encrypted');
    }
    throw error;
  }
}

/** Visible characters on a page, ignoring whitespace and page furniture like lone numbers. */
export function meaningfulChars(text: string): number {
  return text.replace(/\s+/g, '').replace(/^\d{1,4}$/, '').length;
}

/** A page with fewer visible characters than this has no usable text layer (a scan or a picture). */
export const SCANNED_PAGE_CHARS = 24;

/**
 * Renders `pages` as JPEGs into a new private folder (the caller removes it)
 * and returns their paths in page order.
 */
export async function renderPdfPages(file: string, pages: number[], signal?: AbortSignal): Promise<{ dir: string; images: Array<{ page: number; path: string }> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artemis-read-document-'));
  const images: Array<{ page: number; path: string }> = [];
  try {
    for (const page of pages) {
      const prefix = path.join(dir, `page-${page}`);
      await run('pdftoppm', ['-jpeg', '-jpegopt', 'quality=82', '-scale-to', '1600', '-f', String(page), '-l', String(page), '-singlefile', file, prefix], {
        timeoutMs: READ_DOCUMENT_LIMITS.commandTimeoutMs,
        signal,
        maxBuffer: 1024 * 1024,
      });
      images.push({ page, path: `${prefix}.jpg` });
    }
    return { dir, images };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

// ── ZIP parts, inflated under a cap ─────────────────────────────────────────

/** A loaded Office ZIP whose parts are inflated under one shared budget. */
export interface ZipCaps {
  /** All parts together. */
  total: number;
  /** One part. */
  part: number;
  /** Entries in the ZIP (counted in its central directory before anything is parsed). */
  entries: number;
}

/** Entries a .docx or .pptx may hold (real ones have tens to a few hundred). */
export const MAX_ZIP_ENTRIES = 10_000;
/** Entries a spreadsheet may hold. */
export const MAX_XLSX_ENTRIES = 4_000;

const DEFAULT_ZIP_CAPS: ZipCaps = { total: READ_DOCUMENT_LIMITS.maxInflatedBytes, part: READ_DOCUMENT_LIMITS.maxPartBytes, entries: MAX_ZIP_ENTRIES };

/**
 * How many entries a ZIP's central directory holds, counted by walking the
 * directory itself (the end record's count can lie), stopping past `cap`.
 * Undefined when the directory cannot be found or walked (the ZIP reader
 * then refuses the file).
 */
export function countZipEntries(bytes: Buffer, cap: number): number | undefined {
  // The end of central directory record: within the last 64 KiB + 22 bytes.
  const from = Math.max(0, bytes.length - 0xffff - 22);
  let end = -1;
  for (let i = bytes.length - 22; i >= from; i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return undefined;
  const declared = bytes.readUInt16LE(end + 10);
  if (declared !== 0xffff && declared > cap) return declared;
  // Where the central directory starts: where the record says, and where it
  // ends up when bytes were added in front of the ZIP (as JSZip reads it).
  const starts = [bytes.readUInt32LE(end + 16), end - bytes.readUInt32LE(end + 12)];
  // ZIP64: the real count, offset and size are in the ZIP64 end record.
  const locator = end - 20;
  if (locator >= 0 && bytes.readUInt32LE(locator) === 0x07064b50) {
    // Where the locator says the record is, and right before the locator
    // (where it sits when bytes were added in front of the ZIP).
    const stated = Number(bytes.readBigUInt64LE(locator + 8));
    for (const record of new Set([stated, locator - 56])) {
      if (!Number.isSafeInteger(record) || record < 0 || record + 56 > bytes.length || bytes.readUInt32LE(record) !== 0x06064b50) continue;
      const count64 = Number(bytes.readBigUInt64LE(record + 32));
      if (count64 > cap) return count64;
      starts.push(Number(bytes.readBigUInt64LE(record + 48)), record - Number(bytes.readBigUInt64LE(record + 40)));
    }
  }
  // The headers themselves are counted (the record may claim fewer).
  let most = 0;
  for (const start of new Set(starts)) {
    if (!Number.isSafeInteger(start) || start < 0) continue;
    let count = 0;
    let at = start;
    while (at + 46 <= bytes.length && bytes.readUInt32LE(at) === 0x02014b50) {
      count += 1;
      if (count > cap) return count;
      at += 46 + bytes.readUInt16LE(at + 28) + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
    most = Math.max(most, count);
  }
  return most;
}

/** A parser's or the platform's error, as one clamped line (it may quote the file). */
export function errorLine(error: unknown, max = 160): string {
  const text = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export class CappedZip {
  private inflated = 0;

  private constructor(private readonly zip: JSZip, private readonly caps: ZipCaps) {}

  static async open(bytes: Buffer, caps: ZipCaps = DEFAULT_ZIP_CAPS): Promise<CappedZip> {
    // Too many entries is refused before the ZIP is parsed (each entry costs memory and time there).
    const entries = countZipEntries(bytes, caps.entries);
    if (entries !== undefined && entries > caps.entries) {
      throw new DocumentReadError(`the document holds more than ${caps.entries.toLocaleString('en-US')} parts, which is more than can be read`, 'too_large');
    }
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes, { checkCRC32: false });
    } catch (error) {
      throw new DocumentReadError(`the file is not a readable Office document (${errorLine(error)})`, 'unreadable');
    }
    if (Object.keys(zip.files).length > caps.entries) {
      throw new DocumentReadError(`the document holds more than ${caps.entries.toLocaleString('en-US')} parts, which is more than can be read`, 'too_large');
    }
    // What the parts say they inflate to: refused up front when it is too much
    // (a part that lies is stopped while it inflates, see bytes()).
    let declared = 0;
    for (const entry of Object.values(zip.files)) {
      const size = Number((entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0);
      declared += Number.isFinite(size) ? size : 0;
    }
    if (declared > caps.total) {
      throw new DocumentReadError(`the document unpacks to more than ${Math.round(caps.total / 1024 / 1024)} MB, which is more than can be read`, 'too_large');
    }
    return new CappedZip(zip, caps);
  }

  names(): string[] {
    return Object.keys(this.zip.files).filter((name) => !this.zip.files[name]!.dir);
  }

  has(name: string): boolean {
    return Boolean(this.zip.file(name));
  }

  /** A part's text, inflated chunk by chunk and stopped the moment it passes the caps. */
  async text(name: string): Promise<string | undefined> {
    return (await this.bytes(name))?.toString('utf8');
  }

  /** A part's bytes, inflated chunk by chunk and stopped the moment it passes the caps. */
  async bytes(name: string): Promise<Buffer | undefined> {
    const file = this.zip.file(name);
    if (!file) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = (file as unknown as { internalStream(type: 'uint8array'): JSZipStream }).internalStream('uint8array');
      let failed = false;
      stream
        .on('data', (chunk: Uint8Array) => {
          if (failed) return;
          size += chunk.length;
          this.inflated += chunk.length;
          if (size > this.caps.part || this.inflated > this.caps.total) {
            failed = true;
            stream.pause();
            reject(new DocumentReadError('a part of the document unpacks to more than can be read', 'too_large'));
            return;
          }
          chunks.push(chunk);
        })
        .on('error', (error: unknown) => {
          if (!failed) reject(new DocumentReadError(`a part of the document is damaged (${errorLine(error)})`, 'unreadable'));
        })
        .on('end', () => {
          if (!failed) resolve();
        })
        .resume();
    });
    return Buffer.concat(chunks);
  }

  /**
   * A new ZIP made only of the parts `keep` accepts, each inflated within
   * the caps (stored, not compressed): what a parser that inflates on its
   * own (ExcelJS) gets, so it never inflates anything unchecked.
   */
  async rebuild(keep: (name: string) => boolean, transform?: (name: string, data: Buffer) => Buffer): Promise<Buffer> {
    const out = new JSZip();
    for (const name of this.names()) {
      if (!keep(name)) continue;
      const data = await this.bytes(name);
      if (data) out.file(name, transform ? transform(name, data) : data);
    }
    return out.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  }
}

interface JSZipStream {
  on(event: 'data', cb: (chunk: Uint8Array) => void): JSZipStream;
  on(event: 'error', cb: (error: unknown) => void): JSZipStream;
  on(event: 'end', cb: () => void): JSZipStream;
  pause(): JSZipStream;
  resume(): JSZipStream;
}

// ── XML scanning ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlText(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`).exec(tag);
  return match ? decodeXmlText(match[1]!) : undefined;
}

/** One pass over the tags and the text between them. */
function* scanXml(xml: string): Generator<{ tag?: string; name?: string; closing?: boolean; selfClosing?: boolean; text?: string }> {
  const re = /<([^>]*)>|([^<]+)/g;
  for (let match = re.exec(xml); match; match = re.exec(xml)) {
    if (match[2] !== undefined) {
      yield { text: match[2] };
      continue;
    }
    const tag = match[1]!;
    if (tag.startsWith('?') || tag.startsWith('!')) continue;
    const closing = tag.startsWith('/');
    const name = (closing ? tag.slice(1) : tag).split(/[\s/]/, 1)[0]!;
    yield { tag, name, closing, selfClosing: tag.endsWith('/') };
  }
}

// ── .docx ───────────────────────────────────────────────────────────────────

/** Heading level of a paragraph style id or name ("Heading2", "heading 2", "Title", "标题 1"). */
function headingLevel(style: string | undefined): number {
  if (!style) return 0;
  if (/^(?:title|标题)$/i.test(style)) return 1;
  const match = /^(?:heading|标题)\s*(\d)$/i.exec(style.trim());
  return match ? Math.min(6, Number(match[1])) : 0;
}

/** Markdown-like text of a WordprocessingML body: headings, list items, tables as rows. */
export function docxXmlToText(xml: string): string {
  const out: string[] = [];
  let para = '';
  let style: string | undefined;
  let listItem = false;
  let inText = false;
  let tableDepth = 0;
  let row: string[] = [];
  let cell: string[] = [];
  const endParagraph = () => {
    const text = para.replace(/[ \t]+\n/g, '\n').trim();
    if (tableDepth > 0) {
      if (text) cell.push(text);
    } else if (text) {
      const level = headingLevel(style);
      out.push(level ? `${'#'.repeat(level)} ${text}` : listItem ? `- ${text}` : text);
    }
    para = '';
    style = undefined;
    listItem = false;
  };
  for (const token of scanXml(xml)) {
    if (token.text !== undefined) {
      if (inText) para += decodeXmlText(token.text);
      continue;
    }
    const { name, closing, selfClosing, tag } = token;
    switch (name) {
      case 'w:t':
        inText = !closing && !selfClosing;
        break;
      case 'w:tab':
        if (!closing) para += '\t';
        break;
      case 'w:br':
      case 'w:cr':
        if (!closing) para += '\n';
        break;
      case 'w:pStyle':
        style = attr(tag!, 'w:val');
        break;
      case 'w:numPr':
        if (!closing) listItem = true;
        break;
      case 'w:p':
        if (closing || selfClosing) endParagraph();
        else para = '';
        break;
      case 'w:tbl':
        if (closing) {
          tableDepth = Math.max(0, tableDepth - 1);
          if (tableDepth === 0) out.push('');
        } else {
          if (tableDepth === 0) out.push('');
          tableDepth += 1;
        }
        break;
      case 'w:tr':
        if (tableDepth === 1) {
          if (closing) out.push(`| ${row.join(' | ')} |`);
          else row = [];
        }
        break;
      case 'w:tc':
        if (tableDepth === 1) {
          if (closing) row.push(cell.join(' / ').replace(/\|/g, '\\|').replace(/\n/g, ' '));
          else cell = [];
        }
        break;
      default:
        break;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function readDocxText(zip: CappedZip): Promise<{ text: string; parts: string[] }> {
  const body = await zip.text('word/document.xml');
  if (body === undefined) throw new DocumentReadError('the file has no document body (word/document.xml); it may not be a Word document', 'unreadable');
  const parts = [docxXmlToText(body)];
  // Footnotes and comments carry text the body refers to.
  for (const [file, title] of [['word/footnotes.xml', 'Footnotes'], ['word/comments.xml', 'Comments']] as const) {
    const xml = await zip.text(file);
    const text = xml ? docxXmlToText(xml) : '';
    if (text.trim()) parts.push(`## ${title}\n${text}`);
  }
  return { text: parts.join('\n\n'), parts: ['document'] };
}

// ── .pptx ───────────────────────────────────────────────────────────────────

/** Paragraph text of a DrawingML part (a slide or its notes). */
export function drawingXmlToText(xml: string): string {
  const lines: string[] = [];
  let para = '';
  let inText = false;
  for (const token of scanXml(xml)) {
    if (token.text !== undefined) {
      if (inText) para += decodeXmlText(token.text);
      continue;
    }
    switch (token.name) {
      case 'a:t':
        inText = !token.closing && !token.selfClosing;
        break;
      case 'a:br':
        if (!token.closing) para += '\n';
        break;
      case 'a:tab':
        if (!token.closing) para += '\t';
        break;
      case 'a:p':
        if (token.closing || token.selfClosing) {
          if (para.trim()) lines.push(para.trim());
          para = '';
        }
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

function relTargets(xml: string | undefined, base: string): Map<string, { type: string; target: string }> {
  const map = new Map<string, { type: string; target: string }>();
  if (!xml) return map;
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(match[0], 'Id');
    const target = attr(match[0], 'Target');
    const type = attr(match[0], 'Type') ?? '';
    if (!id || !target) continue;
    map.set(id, { type, target: path.posix.normalize(path.posix.join(base, target)).replace(/^\/+/, '') });
  }
  return map;
}

/** Slide part names in presentation order (falling back to their numbers). */
export async function pptxSlideOrder(zip: CappedZip): Promise<string[]> {
  const presentation = await zip.text('ppt/presentation.xml');
  const rels = relTargets(await zip.text('ppt/_rels/presentation.xml.rels'), 'ppt');
  const ordered: string[] = [];
  if (presentation) {
    for (const match of presentation.matchAll(/<p:sldId\b[^>]*>/g)) {
      const rid = attr(match[0], 'r:id');
      const target = rid ? rels.get(rid)?.target : undefined;
      if (target && zip.has(target) && !ordered.includes(target)) ordered.push(target);
    }
  }
  if (ordered.length) return ordered;
  return zip
    .names()
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
}

export async function readPptxSlides(zip: CappedZip, wanted: number[] | undefined): Promise<{ total: number; slides: Array<{ number: number; text: string; notes?: string }> }> {
  const order = await pptxSlideOrder(zip);
  const numbers = (wanted ?? order.map((_, i) => i + 1)).filter((n) => n >= 1 && n <= order.length);
  const slides: Array<{ number: number; text: string; notes?: string }> = [];
  for (const number of numbers) {
    const part = order[number - 1]!;
    const text = drawingXmlToText((await zip.text(part)) ?? '');
    const rels = relTargets(await zip.text(part.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels')), path.posix.dirname(part));
    const notesPart = [...rels.values()].find((rel) => /\/notesSlide$/.test(rel.type))?.target;
    const notes = notesPart ? drawingXmlToText((await zip.text(notesPart)) ?? '').replace(/^\d+$/gm, '').trim() : '';
    slides.push({ number, text, ...(notes ? { notes } : {}) });
  }
  return { total: order.length, slides };
}

// ── .xlsx ───────────────────────────────────────────────────────────────────

function cellText(cell: ExcelJS.Cell): string {
  let text: string;
  try {
    text = cell.text ?? '';
  } catch {
    const value = cell.value as unknown;
    text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  if (cell.value instanceof Date && !Number.isNaN(cell.value.getTime())) text = cell.value.toISOString().replace(/T00:00:00\.000Z$/, '').replace(/\.000Z$/, 'Z');
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

export interface SheetRead {
  name: string;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
  rows: Array<{ number: number; cells: string[] }>;
  /** The next row to read when this read stopped early. */
  nextRow?: number;
}

/** The parts of a spreadsheet ExcelJS reads cell values from. */
export function isSheetTextPart(name: string): boolean {
  return name === '[Content_Types].xml'
    || name === '_rels/.rels'
    || name === 'xl/workbook.xml'
    || name === 'xl/_rels/workbook.xml.rels'
    || name === 'xl/sharedStrings.xml'
    || name === 'xl/styles.xml'
    || /^xl\/theme\/theme\d+\.xml$/.test(name)
    || /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
    || /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name)
    || /^xl\/tables\/table\d+\.xml$/.test(name);
}

const SHEET_RELS_PART = /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/;
const SHEET_PART = /^xl\/worksheets\/sheet\d+\.xml$/;

/** A sheet relationship kept in the rebuilt workbook: links out of the file, and tables (whose parts are kept). */
function keptSheetRelationship(tag: string): boolean {
  return /\sTargetMode="External"/.test(tag) || /\sType="[^"]*\/table"/.test(tag);
}

/**
 * Drops what points at parts left out of the rebuilt workbook (drawings,
 * charts, pictures, comments, embedded objects): the relationships go, and so
 * does every sheet element that names one of them, so ExcelJS never looks
 * for a part that is not there.
 */
export function sheetPartsWithoutMedia(keptIds: Map<string, Set<string>>) {
  return (name: string, data: Buffer): Buffer => {
    if (SHEET_RELS_PART.test(name)) {
      const xml = data.toString('utf8');
      return Buffer.from(xml.replace(/<Relationship\b[^>]*?(?:\/>|>\s*<\/Relationship>)/g, (tag) => (keptSheetRelationship(tag) ? tag : '')), 'utf8');
    }
    if (SHEET_PART.test(name)) {
      const kept = keptIds.get(name) ?? new Set<string>();
      const xml = data.toString('utf8');
      return Buffer.from(xml.replace(/<([A-Za-z][\w.-]*:)?([A-Za-z][\w.-]*)\b[^<>]*?\sr:id="([^"]*)"[^<>]*?\/>/g, (tag, _prefix, _local, id: string) => (kept.has(id) ? tag : '')), 'utf8');
    }
    return data;
  };
}

/** The relationship ids each sheet keeps, read from its relationships part. */
async function keptSheetRelationshipIds(zip: CappedZip): Promise<Map<string, Set<string>>> {
  const kept = new Map<string, Set<string>>();
  for (const name of zip.names()) {
    const match = /^xl\/worksheets\/_rels\/(sheet\d+\.xml)\.rels$/.exec(name);
    if (!match) continue;
    const xml = (await zip.text(name)) ?? '';
    const ids = new Set<string>();
    for (const tag of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
      const id = /\sId="([^"]*)"/.exec(tag)?.[1];
      if (id && keptSheetRelationship(tag)) ids.add(id);
    }
    kept.set(`xl/worksheets/${match[1]}`, ids);
  }
  return kept;
}

/**
 * Rows of the sheets (or of one sheet: its name or 1-based number), from
 * `fromRow`, until READ_DOCUMENT_LIMITS.maxSheetRows rows were read.
 */
export async function readXlsxSheets(bytes: Buffer, options: { sheet?: string; rows?: number[] } = {}): Promise<{ sheets: SheetRead[]; sheetNames: string[] }> {
  // Every part is inflated here under the spreadsheet caps (counted as it
  // inflates, whatever the file declares); ExcelJS gets a ZIP rebuilt from
  // those parts only, so it never inflates anything itself.
  const zip = await CappedZip.open(bytes, { total: READ_DOCUMENT_LIMITS.maxXlsxInflatedBytes, part: READ_DOCUMENT_LIMITS.maxXlsxPartBytes, entries: MAX_XLSX_ENTRIES });
  // Only the parts the cell values come from (no media, drawings, charts or embedded files).
  const checked = await zip.rebuild(isSheetTextPart, sheetPartsWithoutMedia(await keptSheetRelationshipIds(zip)));
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(checked as unknown as ArrayBuffer);
  } catch (error) {
    throw new DocumentReadError(`the spreadsheet cannot be read (${errorLine(error)})`, 'unreadable');
  }
  const all = workbook.worksheets;
  const sheetNames = all.map((ws) => ws.name);
  let chosen = all;
  if (options.sheet !== undefined && String(options.sheet).trim() !== '') {
    const key = String(options.sheet).trim();
    const byName = all.find((ws) => ws.name === key) ?? all.find((ws) => ws.name.toLowerCase() === key.toLowerCase());
    const byNumber = /^\d+$/.test(key) ? all[Number(key) - 1] : undefined;
    const ws = byName ?? byNumber;
    if (!ws) throw new DocumentReadError(`no sheet "${oneLineName(key)}"; the sheets are: ${listSheetNames(sheetNames)}`, 'bad_sheet');
    chosen = [ws];
  }
  const wanted = options.rows ? new Set(options.rows) : undefined;
  const first = options.rows?.[0] ?? 1;
  let budget: number = READ_DOCUMENT_LIMITS.maxSheetRows;
  const sheets: SheetRead[] = [];
  for (const ws of chosen) {
    const read: SheetRead = {
      name: ws.name,
      hidden: ws.state !== 'visible' && ws.state !== undefined,
      rowCount: ws.actualRowCount,
      columnCount: ws.actualColumnCount,
      rows: [],
    };
    ws.eachRow({ includeEmpty: false }, (row, number) => {
      if (read.nextRow !== undefined || number < first || (wanted && !wanted.has(number))) return;
      if (budget <= 0) {
        read.nextRow = number;
        return;
      }
      const cells: string[] = [];
      const width = Math.min(row.cellCount, 200);
      for (let col = 1; col <= width; col += 1) cells.push(cellText(row.getCell(col)));
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (!cells.length) return;
      read.rows.push({ number, cells });
      budget -= 1;
    });
    sheets.push(read);
  }
  return { sheets, sheetNames };
}

/** Column letters for a 1-based column number. */
export function columnName(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

// ── older formats ───────────────────────────────────────────────────────────

/** One line of a name the file chose (a sheet name, a title), clamped. */
export function oneLineName(text: string, max = 40): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f\u2028\u2029"]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** At most this many sheet names are named in one line. */
export const MAX_LISTED_SHEETS = 12;

/** The sheet names as one clamped line: quoted, at most MAX_LISTED_SHEETS, then how many more. */
export function listSheetNames(names: string[]): string {
  const shown = names.slice(0, MAX_LISTED_SHEETS).map((name) => `"${oneLineName(name)}"`);
  return names.length > MAX_LISTED_SHEETS ? `${shown.join(', ')} and ${names.length - MAX_LISTED_SHEETS} more` : shown.join(', ');
}

/** The platform's sandboxed office converter (artemis-office-agent.socket on a provisioned server). */
export function officeConvertSocket(env: NodeJS.ProcessEnv = process.env): string {
  return env.ARTEMIS_OFFICE_CONVERT_SOCKET?.trim() || '/run/artemis-office/agent.sock';
}

const SOCKET_TYPES = new Set(['doc', 'xls', 'ppt', 'odt', 'ods', 'odp', 'rtf']);
/** What the converter may send back (a PDF plus a page image and a thumbnail). */
const MAX_CONVERTER_OUTPUT = 96 * 1024 * 1024;

/**
 * Converts through the sandboxed converter: the file's bytes go in, a PDF
 * comes back (protocol: ARTEMIS-PREVIEW 1 <ext> <bytes> <max pages>, then
 * INFO, FILE <name> <bytes> frames and END, or ERR <reason>).
 */
export function convertViaSocket(socketPath: string, data: Buffer, ext: string, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = connect(socketPath);
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (error?: unknown, pdf?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(pdf!);
    };
    const timer = setTimeout(() => finish(new DocumentReadError('the converter took too long and was stopped', 'timeout')), timeoutMs);
    const onAbort = () => finish(new DocumentReadError('stopped', 'aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('error', (error) => finish(new DocumentReadError(`the converter cannot be reached (${errorLine(error)})`, 'tool_failed')));
    socket.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_CONVERTER_OUTPUT) return finish(new DocumentReadError('the converter answered with too much data', 'too_large'));
      chunks.push(chunk);
    });
    socket.once('end', () => {
      try {
        finish(undefined, pdfFromConverter(Buffer.concat(chunks)));
      } catch (error) {
        finish(error);
      }
    });
    socket.once('connect', () => {
      socket.write(`ARTEMIS-PREVIEW 1 ${ext} ${data.length} 1\n`);
      socket.write(data);
    });
  });
}

/** The PDF in the converter's answer. */
export function pdfFromConverter(out: Buffer): Buffer {
  let at = 0;
  const line = (): string => {
    const end = out.indexOf(0x0a, at);
    if (end < 0 || end - at > 512) throw new DocumentReadError('the converter gave an unreadable answer', 'tool_failed');
    const text = out.subarray(at, end).toString('utf8');
    at = end + 1;
    return text;
  };
  const first = line();
  if (first.startsWith('ERR ')) throw new DocumentReadError(`the converter could not read the file (${errorLine(first.slice(4), 80)})`, 'tool_failed');
  if (!first.startsWith('INFO ')) throw new DocumentReadError('the converter gave an unreadable answer', 'tool_failed');
  for (;;) {
    const next = line();
    if (next === 'END') break;
    const frame = /^FILE ([\w.-]{1,64}) (\d{1,10})$/.exec(next);
    if (!frame) throw new DocumentReadError('the converter gave an unreadable answer', 'tool_failed');
    const size = Number(frame[2]);
    if (at + size > out.length) throw new DocumentReadError('the converter answer was cut short', 'tool_failed');
    const body = out.subarray(at, at + size);
    at += size;
    if (frame[1] === 'document.pdf') return Buffer.from(body);
  }
  throw new DocumentReadError('the converter sent no PDF', 'tool_failed');
}

/**
 * LibreOffice on this machine (no sandboxed converter here: a local
 * install): a bare environment (PATH, a throwaway HOME, LANG), its own
 * process group, killed as a group on timeout or when the read stops.
 */
export async function convertLocally(file: string, format: 'pdf' | 'xlsx', target: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const bin = await findSoffice();
  if (!bin) {
    throw new DocumentReadError(`${path.extname(file)} files need LibreOffice to be read, and it is not installed here; ask for a PDF, .docx, .xlsx or .pptx copy`, 'tool_missing');
  }
  const work = await mkdtemp(path.join(os.tmpdir(), 'artemis-read-convert-'));
  try {
    const input = path.join(work, `input${path.extname(file).toLowerCase()}`);
    await copyFile(file, input);
    const out = path.join(work, 'out');
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, [
        `-env:UserInstallation=${pathToFileURL(path.join(work, 'profile')).href}`,
        '--headless', '--norestore', '--nolockcheck', '--convert-to', format, '--outdir', out, input,
      ], {
        cwd: work,
        detached: true,
        stdio: 'ignore',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: work, LANG: process.env.LANG?.trim() || 'C.UTF-8' },
      });
      let done = false;
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      };
      const end = (error?: DocumentReadError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) {
          killGroup();
          reject(error);
        } else resolve();
      };
      const timer = setTimeout(() => end(new DocumentReadError('LibreOffice took too long and was stopped', 'timeout')), timeoutMs);
      const onAbort = () => end(new DocumentReadError('stopped', 'aborted'));
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.once('error', (error) => end(new DocumentReadError(`LibreOffice could not start (${errorLine(error)})`, 'tool_failed')));
      child.once('exit', (code) => {
        // Anything it left behind in its group goes with it.
        killGroup();
        end(code === 0 ? undefined : new DocumentReadError(`LibreOffice could not convert the file (exit ${code})`, 'tool_failed'));
      });
    });
    const produced = (await readdir(out).catch(() => [] as string[])).find((name) => name.endsWith(`.${format}`));
    if (!produced) throw new DocumentReadError(`LibreOffice did not produce a .${format} file`, 'tool_failed');
    await copyFile(path.join(out, produced), target);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * Converts an older or OpenDocument file for reading. With the platform's
 * sandboxed converter (its socket exists): to PDF there. Otherwise (a local
 * install) with LibreOffice here: spreadsheets to .xlsx (structure kept),
 * the rest to PDF. The caller removes `dir`.
 */
export async function convertLegacy(file: string, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<{ dir: string; file: string; format: 'pdf' | 'xlsx' }> {
  const ext = path.extname(file).toLowerCase().slice(1);
  const socket = officeConvertSocket(env);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'artemis-read-legacy-'));
  try {
    if (existsSync(socket) && SOCKET_TYPES.has(ext)) {
      const pdf = await convertViaSocket(socket, await readFile(file), ext, READ_DOCUMENT_LIMITS.commandTimeoutMs * 2, signal);
      const target = path.join(dir, 'converted.pdf');
      await writeFile(target, pdf, { mode: 0o600 });
      return { dir, file: target, format: 'pdf' };
    }
    const format = LEGACY_SHEET_EXTENSIONS.has(`.${ext}`) ? 'xlsx' : 'pdf';
    const target = path.join(dir, `converted.${format}`);
    await convertLocally(file, format, target, READ_DOCUMENT_LIMITS.commandTimeoutMs * 2, signal);
    return { dir, file: target, format };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
