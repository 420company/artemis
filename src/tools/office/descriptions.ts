/**
 * tools/office/descriptions.ts — what the model is told about the office
 * tools: the descriptions, the JSON schemas of the native function tools,
 * and argument validation.
 */

import { SLIDE_LAYOUTS } from './spec.js';
import { THEME_IDS } from './themes.js';

const THEMES = THEME_IDS.join(' | ');

const COMMON = [
  `Themes: ${THEMES} (minimal 简约 light, dark 深色, business 商务 navy+gold, vivid 活力 violet+coral, nature 清新 green, warm 雅致 serif/terracotta). Pick one that suits the audience; keep the same theme for a deck and its companion document.`,
  'Text may use **bold**, *italic* and `code`. Chinese and other CJK text renders correctly.',
  'The file is saved under outputs/ unless you give `path`; its spec is saved beside it, so later changes are `path` + `edits` (JSON Pointer, zero-based: {"op":"set","path":"/slides/2/title","value":"…"} sets the 3rd slide\'s title; ops: set, insert, remove, merge). Pass a full `spec` instead to rebuild from scratch.',
  '`pdf: true` also exports a PDF next to it.',
  'Mention the saved file path in your reply so the user sees the file.',
].join('\n');

export const CREATE_PRESENTATION_DESCRIPTION = [
  'Make a PowerPoint deck (.pptx): real, editable slides with a designed theme, native charts and tables, pictures and speaker notes. Use it for 做PPT / 幻灯片 / 演示文稿 / 汇报 / 路演 / deck / slides requests instead of writing HTML or Markdown.',
  `spec: { title, subtitle?, author?, date?, theme?, footer?, slides: [...] }. Slide layouts: ${SLIDE_LAYOUTS.join(', ')}.`,
  '- title: {layout:"title", title, subtitle?} — the cover; also good for a closing "谢谢 / Q&A" slide.',
  '- section: {layout:"section", title, subtitle?, number?} — a divider between parts.',
  '- bullets: {layout:"bullets", title, bullets: ["…", {text:"…", sub:["…"]}], text?} — 3–6 short bullets; `text` is a lead sentence.',
  '- two-column: {layout:"two-column", title, left:{heading, bullets}, right:{heading, bullets}} — compare, pros/cons, before/after.',
  '- image-text: {layout:"image-text", title, image:"<file path>", bullets?, text?, imageSide?:"left"|"right", caption?} — use a file generate_image made, or a downloaded picture (PNG/JPEG).',
  '- chart: {layout:"chart", title, chart:{type:"column"|"bar"|"line"|"pie"|"doughnut"|"area", categories:[…], series:[{name, values:[numbers]}], unit?, showValues?, stacked?}, caption?} — real numbers only; cite the source in caption.',
  '- table: {layout:"table", title, table:{header:[…], rows:[[…]]}, caption?} — up to ~12 rows.',
  '- quote: {layout:"quote", quote, author?}.',
  '- stats: {layout:"stats", title, stats:[{value:"38%", label:"增长", detail?}]} — 2–4 key numbers.',
  'Every slide may have notes (speaker notes). A good deck: cover, agenda or summary, sections, one idea per slide, a closing slide; 8–15 slides unless asked otherwise.',
  COMMON,
].join('\n');

export const CREATE_DOCUMENT_DESCRIPTION = [
  'Make a Word document (.docx) with real headings, lists, tables, pictures, a table of contents and page numbers. Use it for 文档 / 报告 / 方案 / 合同 / 简历 / 说明书 / Word / report requests.',
  'Give either `markdown` (headings #/##/###, paragraphs, - and 1. lists, | tables |, > quotes, > [!NOTE] callouts, ![caption](path) pictures, --- dividers, [TOC]) or `spec`: { title, subtitle?, author?, date?, theme?, toc?, header?, pageNumbers?, pageSize?:"A4"|"Letter", blocks: [...] }.',
  'Blocks: {type:"heading", text, level:1|2|3}, {type:"paragraph", text}, {type:"bullets", items:[…], ordered?}, {type:"table", table:{header, rows}, caption?}, {type:"image", path, caption?, width?:0.2–1}, {type:"quote", text, author?}, {type:"callout", text, title?}, {type:"pageBreak"}, {type:"toc"}, {type:"divider"}.',
  'With markdown, `spec` may still carry title/subtitle/author/date/theme/toc/header. A single leading "# Title" becomes the document title.',
  COMMON,
].join('\n');

export const CREATE_SPREADSHEET_DESCRIPTION = [
  'Make an Excel workbook (.xlsx) with typed cells, live formulas, number formats, column widths, frozen header, filters and native charts. Use it for 表格 / Excel / 数据表 / 预算 / 清单 / spreadsheet requests.',
  'spec: { title?, theme?, sheets: [{ name, title?, columns:[{header, width?, format?, align?}], rows:[[…]], freeze?, autoFilter?, zebra?, merges?:["A1:C1"], charts?:[…] }] }.',
  'Layout: row 1 is the header (columns) and data starts in row 2; with a sheet `title`, the title is row 1, the header row 2 and data starts in row 3. Write formulas for that layout, e.g. "=SUM(B2:B13)", "=B2*C2", "=\'Sheet 2\'!B5".',
  'Cells: numbers, text, booleans, null, "=FORMULA", or {value|formula, format?, bold?, italic?, color?, fill?, align?}. Formats: number, integer, percent, currency, cny, usd, eur, date, datetime, text, or an Excel code like "#,##0.0". Dates as "2026-03-31" in a date column.',
  'Charts: {type:"column"|"bar"|"line"|"pie"|"doughnut"|"area", title?, categories:"A2:A13", series:[{name?, values:"B2:B13"}], position?:"H2", width?, height?} — ranges on the same sheet (or \'Other\'!A2:A9).',
  COMMON,
].join('\n');

const editsSchema = {
  type: 'array',
  description: 'Changes to the file made earlier at `path` (its saved spec). JSON Pointer paths, zero-based indexes.',
  items: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['set', 'insert', 'remove', 'merge'], description: 'set: replace the value; insert: into an array at the index ("-" = end); remove; merge: shallow-merge an object.' },
      path: { type: 'string', description: 'e.g. /slides/2/title, /slides/4, /blocks/0/text, /sheets/0/rows/3/2, /theme' },
      value: { description: 'The new value (any JSON).' },
    },
    required: ['op', 'path'],
  },
};

const common = {
  path: { type: 'string', description: 'Where to save (relative to the workspace). Default: outputs/<title>.<ext>. To edit a file made earlier, its path.' },
  edits: editsSchema,
  pdf: { type: 'boolean', description: 'Also export a PDF next to the file.' },
  theme: { type: 'string', description: `Theme override: ${THEMES}.` },
};

// Mixed-type fields are described rather than typed: some providers reject
// type arrays and anyOf in function schemas.
const bullets = { type: 'array', items: { description: 'A bullet: a string, or {"text": "…", "sub": ["…"]} for second-level points.' } };
const tableSchema = {
  type: 'object',
  properties: {
    header: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { description: 'A cell: text or a number.' } } },
  },
};

export function officeToolSchema(type: 'create_presentation' | 'create_document' | 'create_spreadsheet'): Record<string, unknown> {
  if (type === 'create_presentation') {
    return {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description: 'The whole deck. Omit when only applying edits to an existing file.',
          properties: {
            title: { type: 'string' },
            subtitle: { type: 'string' },
            author: { type: 'string' },
            date: { type: 'string' },
            theme: { type: 'string', description: THEMES },
            footer: { type: 'string' },
            slides: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  layout: { type: 'string', enum: [...SLIDE_LAYOUTS] },
                  title: { type: 'string' },
                  subtitle: { type: 'string' },
                  bullets,
                  text: { type: 'string' },
                  left: { type: 'object', properties: { heading: { type: 'string' }, bullets, text: { type: 'string' } } },
                  right: { type: 'object', properties: { heading: { type: 'string' }, bullets, text: { type: 'string' } } },
                  image: { type: 'string', description: 'Picture file path (PNG/JPEG).' },
                  imageSide: { type: 'string', enum: ['left', 'right'] },
                  caption: { type: 'string' },
                  chart: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['column', 'bar', 'line', 'pie', 'doughnut', 'area'] },
                      categories: { type: 'array', items: { type: 'string' } },
                      series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'array', items: { type: 'number' } } }, required: ['values'] } },
                      unit: { type: 'string' },
                      showValues: { type: 'boolean' },
                      stacked: { type: 'boolean' },
                    },
                  },
                  table: tableSchema,
                  quote: { type: 'string' },
                  author: { type: 'string' },
                  stats: { type: 'array', items: { type: 'object', properties: { value: { type: 'string' }, label: { type: 'string' }, detail: { type: 'string' } }, required: ['value', 'label'] } },
                  number: { type: 'string' },
                  notes: { type: 'string', description: 'Speaker notes.' },
                },
                required: ['layout'],
              },
            },
          },
          required: ['slides'],
        },
        ...common,
      },
    };
  }
  if (type === 'create_document') {
    return {
      type: 'object',
      properties: {
        markdown: { type: 'string', description: 'The document as Markdown (the easiest way to write a long document).' },
        spec: {
          type: 'object',
          description: 'Document metadata and/or blocks. Omit blocks when passing markdown.',
          properties: {
            title: { type: 'string' },
            subtitle: { type: 'string' },
            author: { type: 'string' },
            date: { type: 'string' },
            theme: { type: 'string', description: THEMES },
            toc: { type: 'boolean', description: 'Add a table of contents.' },
            header: { type: 'string' },
            pageNumbers: { type: 'boolean' },
            pageSize: { type: 'string', enum: ['A4', 'Letter'] },
            blocks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['heading', 'paragraph', 'bullets', 'table', 'image', 'quote', 'callout', 'pageBreak', 'toc', 'divider'] },
                  text: { type: 'string' },
                  level: { type: 'integer', minimum: 1, maximum: 3 },
                  items: bullets,
                  ordered: { type: 'boolean' },
                  table: tableSchema,
                  path: { type: 'string' },
                  caption: { type: 'string' },
                  width: { type: 'number' },
                  author: { type: 'string' },
                  title: { type: 'string' },
                },
                required: ['type'],
              },
            },
          },
        },
        ...common,
      },
    };
  }
  return {
    type: 'object',
    properties: {
      spec: {
        type: 'object',
        description: 'The whole workbook. Omit when only applying edits to an existing file.',
        properties: {
          title: { type: 'string' },
          theme: { type: 'string', description: THEMES },
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                title: { type: 'string', description: 'A title row above the header (shifts the header to row 2).' },
                columns: { type: 'array', items: { type: 'object', properties: { header: { type: 'string' }, width: { type: 'number' }, format: { type: 'string' }, align: { type: 'string', enum: ['left', 'center', 'right'] } }, required: ['header'] } },
                rows: { type: 'array', items: { type: 'array', items: { description: 'A cell: number, text, true/false, null, "=FORMULA" or {value|formula, format, bold, italic, color, fill, align}.' } } },
                freeze: { description: '"B2" or {rows, columns}.' },
                autoFilter: { type: 'boolean' },
                zebra: { type: 'boolean' },
                merges: { type: 'array', items: { type: 'string' } },
                charts: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['column', 'bar', 'line', 'pie', 'doughnut', 'area'] },
                      title: { type: 'string' },
                      categories: { type: 'string', description: 'A1 range, e.g. A2:A13' },
                      series: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, values: { type: 'string', description: 'A1 range, e.g. B2:B13' } }, required: ['values'] } },
                      position: { type: 'string', description: 'Top-left cell, e.g. H2' },
                      width: { type: 'number' },
                      height: { type: 'number' },
                    },
                    required: ['categories', 'series'],
                  },
                },
              },
              required: ['name', 'rows'],
            },
          },
        },
        required: ['sheets'],
      },
      ...common,
    },
  };
}

/** Argument checks before the tool runs (the tool itself explains spec problems). */
export function validateOfficeAction(action: Record<string, unknown> | undefined): string[] {
  const errors: string[] = [];
  const spec = action?.spec;
  const markdown = action?.markdown;
  const edits = action?.edits;
  if (spec === undefined && edits === undefined && (typeof markdown !== 'string' || !markdown.trim())) {
    errors.push(action?.type === 'create_document' ? 'spec or markdown is required (or path + edits).' : 'spec is required (or path + edits).');
  }
  if (spec !== undefined && typeof spec !== 'string' && (typeof spec !== 'object' || spec === null || Array.isArray(spec))) errors.push('spec must be an object.');
  if (edits !== undefined && typeof edits !== 'string' && !Array.isArray(edits)) errors.push('edits must be a list.');
  if (action?.path !== undefined && (typeof action.path !== 'string' || !action.path.trim())) errors.push('path must be a non-empty string.');
  if (action?.pdf !== undefined && typeof action.pdf !== 'boolean') errors.push('pdf must be true or false.');
  return errors;
}
