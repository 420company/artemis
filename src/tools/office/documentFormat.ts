/**
 * tools/office/documentFormat.ts — which files read_document reads, by
 * extension. Kept apart from office/read.ts so read_file can send PDF and
 * Office files there without loading the readers.
 */

import path from 'node:path';

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'legacy';

const LEGACY_EXTENSIONS = new Set(['.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.rtf']);
/** Older spreadsheets: converted to .xlsx (rows kept) rather than to PDF. */
export const LEGACY_SHEET_EXTENSIONS = new Set(['.xls', '.ods']);

/** The format read_document reads `file` as, from its extension; undefined for anything else. */
export function documentFormatOf(file: string): DocumentFormat | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  // Macro-enabled files are the same formats; their macros are never run.
  if (ext === '.docx' || ext === '.dotx' || ext === '.docm') return 'docx';
  if (ext === '.pptx' || ext === '.potx' || ext === '.pptm') return 'pptx';
  if (ext === '.xlsx' || ext === '.xltx' || ext === '.xlsm') return 'xlsx';
  if (LEGACY_EXTENSIONS.has(ext)) return 'legacy';
  return undefined;
}

/** File names read_file should send to read_document instead (binary documents). */
export function isReadableDocument(file: string): boolean {
  return documentFormatOf(file) !== undefined;
}
