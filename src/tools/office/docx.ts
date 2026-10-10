/**
 * tools/office/docx.ts — builds a .docx from a DocSpec.
 *
 * Real Word structure, so the file stays editable: Heading 1–3 styles (the
 * navigation pane and the table of contents use them), list numbering,
 * tables with a header row that repeats across pages, pictures with
 * captions, page numbers. Every run names a Latin face and an East Asian
 * face, so Chinese text renders in the theme's CJK font.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { Bullet, DocBlock, DocSpec, TableSpec } from './spec.js';
import { loadImage } from './images.js';
import { formatCellNumber, hasCjk, parseInline, plainText, textWidthEm } from './text.js';
import { resolveTheme, type OfficeTheme } from './themes.js';

export interface BuiltDocument {
  buffer: Buffer;
  headings: number;
  hasToc: boolean;
  warnings: string[];
}

const PAGE = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
};
const MARGIN_X = 1247;
const MARGIN_Y = 1304;
/** Pixels per inch docx uses for picture sizes. */
const PX_PER_IN = 96;

interface Ctx {
  theme: OfficeTheme;
  cwd: string;
  warnings: string[];
  textWidthTwips: number;
  listInstance: number;
  tableCount: number;
  figureCount: number;
  cjk: boolean;
  tocPages?: Array<number | undefined>;
}

function font(theme: OfficeTheme, head = false) {
  return head
    ? { ascii: theme.fonts.headLatin, hAnsi: theme.fonts.headLatin, eastAsia: theme.fonts.headEa, cs: theme.fonts.headLatin }
    : { ascii: theme.fonts.bodyLatin, hAnsi: theme.fonts.bodyLatin, eastAsia: theme.fonts.bodyEa, cs: theme.fonts.bodyLatin };
}

/** Runs with inline emphasis. */
function inline(ctx: Ctx, text: string, extra: { color?: string; size?: number; bold?: boolean; italics?: boolean } = {}): TextRun[] {
  return parseInline(text).map((run) => new TextRun({
    text: run.text,
    ...(extra.color ? { color: extra.color } : {}),
    ...(extra.size ? { size: extra.size } : {}),
    // Only set when on: an explicit "off" would override the paragraph style (headings are bold).
    ...(run.bold || extra.bold ? { bold: true } : {}),
    // Slanted CJK is a fake oblique; emphasis there is color, not italics.
    ...((run.italic || extra.italics) && !hasCjk(run.text) ? { italics: true } : {}),
    ...(run.italic && hasCjk(run.text) ? { color: ctx.theme.colors.accent } : {}),
    ...(run.code ? { font: { ascii: 'Courier New', hAnsi: 'Courier New', eastAsia: ctx.theme.fonts.bodyEa }, shading: { type: ShadingType.CLEAR, fill: ctx.theme.colors.surface, color: 'auto' } } : {}),
  }));
}

function titleBlock(ctx: Ctx, spec: DocSpec): Paragraph[] {
  const c = ctx.theme.colors;
  const out: Paragraph[] = [];
  if (!spec.title) return out;
  out.push(new Paragraph({ style: 'Title', children: inline(ctx, spec.title) }));
  if (spec.subtitle) out.push(new Paragraph({ style: 'Subtitle', children: inline(ctx, spec.subtitle) }));
  const byline = [spec.author, spec.date].filter(Boolean).join('  ·  ');
  out.push(new Paragraph({
    spacing: { before: 60, after: 360 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: c.accent, space: 8 } },
    children: byline ? [new TextRun({ text: byline, color: c.muted, size: 20 })] : [],
  }));
  return out;
}

function bulletList(ctx: Ctx, items: Bullet[], ordered: boolean): Paragraph[] {
  ctx.listInstance += 1;
  const reference = ordered ? 'ordered' : 'bullets';
  const out: Paragraph[] = [];
  for (const item of items) {
    const main = typeof item === 'string' ? item : item.text;
    out.push(new Paragraph({ numbering: { reference, level: 0, instance: ctx.listInstance }, spacing: { after: 80 }, children: inline(ctx, main) }));
    if (typeof item !== 'string') {
      for (const sub of item.sub ?? []) {
        out.push(new Paragraph({ numbering: { reference, level: 1, instance: ctx.listInstance }, spacing: { after: 60 }, children: inline(ctx, sub, { color: ctx.theme.colors.text }) }));
      }
    }
  }
  return out;
}

function caption(ctx: Ctx, text: string, before = false): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: before ? { before: 200, after: 100 } : { before: 80, after: 240 },
    keepNext: before,
    children: inline(ctx, text, { color: ctx.theme.colors.muted, size: 19 }),
  });
}

function table(ctx: Ctx, spec: TableSpec, captionText?: string): Array<Paragraph | Table> {
  const c = ctx.theme.colors;
  const columns = Math.max(spec.header?.length ?? 0, ...spec.rows.map((r) => r.length), 1);
  const weights = spec.columnWidths?.length
    ? Array.from({ length: columns }, (_, i) => spec.columnWidths![i] ?? 1)
    : Array.from({ length: columns }, (_, i) => 2 + Math.min(16, Math.max(2, ...[spec.header?.[i] ?? '', ...spec.rows.map((r) => String(r[i] ?? ''))].map((t) => textWidthEm(t)))));
  const sum = weights.reduce((a, b) => a + b, 0);
  const widths = weights.map((w) => Math.round((w / sum) * ctx.textWidthTwips));
  const border = { style: BorderStyle.SINGLE, size: 4, color: c.line };
  const numeric = (value: string | number) => typeof value === 'number' || /^[-+]?[\d,.]+%?$|^[¥$€£][\d,.]+$/.test(String(value).trim());
  const cell = (value: string | number, i: number, header: boolean, stripe: boolean) => new TableCell({
    width: { size: widths[i]!, type: WidthType.DXA },
    shading: header ? { type: ShadingType.CLEAR, fill: c.accent, color: 'auto' } : stripe ? { type: ShadingType.CLEAR, fill: c.surface, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 110, right: 110 },
    children: [new Paragraph({
      spacing: { before: 0, after: 0, line: 300, lineRule: LineRuleType.AUTO },
      alignment: !header && i > 0 && numeric(value) ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: inline(ctx, formatCellNumber(value), header ? { color: c.onAccent, bold: true, size: 20 } : { size: 20 }),
    })],
  });
  const rows: TableRow[] = [];
  if (spec.header) rows.push(new TableRow({ tableHeader: true, cantSplit: true, children: Array.from({ length: columns }, (_, i) => cell(spec.header![i] ?? '', i, true, false)) }));
  spec.rows.forEach((row, r) => rows.push(new TableRow({ cantSplit: true, children: Array.from({ length: columns }, (_, i) => cell(row[i] ?? '', i, false, r % 2 === 1)) })));
  ctx.tableCount += 1;
  const out: Array<Paragraph | Table> = [];
  if (captionText) out.push(caption(ctx, `${ctx.cjk ? `表 ${ctx.tableCount}\u3000` : `Table ${ctx.tableCount}. `}${captionText}`, true));
  out.push(new Table({
    width: { size: ctx.textWidthTwips, type: WidthType.DXA },
    columnWidths: widths,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows,
  }));
  // A table followed directly by text needs a little air.
  out.push(new Paragraph({ spacing: { before: 0, after: 120 }, children: [] }));
  return out;
}

async function image(ctx: Ctx, block: DocBlock, index: number): Promise<Paragraph[]> {
  const loaded = await loadImage(block.path ?? '', ctx.cwd);
  if ('error' in loaded) {
    ctx.warnings.push(`block ${index + 1}: ${loaded.error}; it was left out`);
    return [];
  }
  const maxW = (ctx.textWidthTwips / 1440) * PX_PER_IN * (block.width ?? 1);
  let w = Math.min(maxW, loaded.width);
  let h = (w * loaded.height) / loaded.width;
  const maxH = 8.2 * PX_PER_IN;
  if (h > maxH) {
    h = maxH;
    w = (h * loaded.width) / loaded.height;
  }
  ctx.figureCount += 1;
  const out = [new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 160, after: block.caption ? 0 : 200, line: 240, lineRule: LineRuleType.AUTO },
    keepNext: Boolean(block.caption),
    children: [new ImageRun({ type: loaded.type, data: loaded.data, transformation: { width: Math.round(w), height: Math.round(h) }, altText: { name: block.caption ?? 'image', description: block.caption ?? '', title: block.caption ?? '' } })],
  })];
  if (block.caption) out.push(caption(ctx, `${ctx.cjk ? `图 ${ctx.figureCount}\u3000` : `Figure ${ctx.figureCount}. `}${block.caption}`));
  return out;
}

async function blockToChildren(ctx: Ctx, block: DocBlock, index: number, spec: DocSpec): Promise<Array<Paragraph | Table | TableOfContents>> {
  const c = ctx.theme.colors;
  switch (block.type) {
    case 'heading': {
      const level = block.level ?? 1;
      const heading = level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return [new Paragraph({ heading, children: inline(ctx, block.text ?? '') })];
    }
    case 'paragraph':
      return [new Paragraph({ children: inline(ctx, block.text ?? '') })];
    case 'bullets':
      return bulletList(ctx, block.items ?? [], block.ordered === true);
    case 'table':
      return block.table ? table(ctx, block.table, block.caption) : [];
    case 'image':
      return image(ctx, block, index);
    case 'quote': {
      const out = [new Paragraph({
        indent: { left: 400, right: 400 },
        spacing: { before: 200, after: block.author ? 40 : 240, line: 380, lineRule: LineRuleType.AUTO },
        border: { left: { style: BorderStyle.SINGLE, size: 24, color: c.accent, space: 14 } },
        children: inline(ctx, block.text ?? '', { color: c.text, italics: true, size: 24 }),
      })];
      if (block.author) out.push(new Paragraph({ indent: { left: 400 }, spacing: { after: 240 }, children: [new TextRun({ text: `— ${block.author}`, color: c.muted, size: 20 })] }));
      return out;
    }
    case 'callout': {
      const shading = { type: ShadingType.CLEAR, fill: c.surface, color: 'auto' };
      const border = { left: { style: BorderStyle.SINGLE, size: 24, color: c.accent2, space: 10 } };
      const out: Paragraph[] = [];
      if (block.title) out.push(new Paragraph({ shading, border, indent: { left: 200, right: 200 }, spacing: { before: 200, after: 0 }, keepNext: true, children: inline(ctx, block.title, { bold: true }) }));
      out.push(new Paragraph({ shading, border, indent: { left: 200, right: 200 }, spacing: { before: block.title ? 40 : 200, after: 240 }, children: inline(ctx, block.text ?? '') }));
      return out;
    }
    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })];
    case 'divider':
      return [new Paragraph({ spacing: { before: 120, after: 240 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: c.line, space: 1 } }, children: [] })];
    case 'toc':
      return tocBlock(ctx, spec);
  }
}

/** The headings a table of contents lists (levels 1–2), in order. */
export function tocHeadings(spec: DocSpec): Array<{ title: string; level: number }> {
  return spec.blocks
    .filter((b) => b.type === 'heading' && (b.level ?? 1) <= 2)
    .map((b) => ({ title: plainText(b.text ?? ''), level: b.level ?? 1 }));
}

function tocBlock(ctx: Ctx, spec: DocSpec): Array<Paragraph | TableOfContents> {
  const entries = tocHeadings(spec).map((entry, i) => ({ ...entry, ...(ctx.tocPages?.[i] ? { page: ctx.tocPages[i] } : {}) }));
  return [
    new Paragraph({ style: 'TocHeading', children: [new TextRun(ctx.cjk ? '目录' : 'Contents')] }),
    // Entries are written in so the contents read right everywhere (page
    // numbers when a first rendering found them); Word refreshes the field.
    new TableOfContents(ctx.cjk ? '目录' : 'Contents', { hyperlink: true, headingStyleRange: '1-2', cachedEntries: entries }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

export async function buildDocument(spec: DocSpec, cwd: string, options: { tocPages?: Array<number | undefined> } = {}): Promise<BuiltDocument> {
  const theme = resolveTheme(spec.theme);
  const c = theme.colors;
  const page = PAGE[spec.pageSize ?? 'A4'];
  const allText = [spec.title ?? '', ...spec.blocks.slice(0, 40).map((b) => b.text ?? '')].join('');
  const ctx: Ctx = {
    theme,
    cwd,
    warnings: [],
    textWidthTwips: page.width - 2 * MARGIN_X,
    listInstance: 0,
    tableCount: 0,
    figureCount: 0,
    cjk: hasCjk(allText),
    ...(options.tocPages ? { tocPages: options.tocPages } : {}),
  };
  const children: Array<Paragraph | Table | TableOfContents> = [...titleBlock(ctx, spec)];
  const blocks = spec.toc && !spec.blocks.some((b) => b.type === 'toc') ? [{ type: 'toc' } as DocBlock, ...spec.blocks] : spec.blocks;
  for (const [index, block] of blocks.entries()) children.push(...(await blockToChildren(ctx, block, index, spec)));
  const hasToc = blocks.some((b) => b.type === 'toc');

  const bodyFont = font(theme);
  const headFont = font(theme, true);
  const doc = new Document({
    creator: spec.author ?? 'Artemis',
    title: spec.title ?? '',
    ...(hasToc ? { features: { updateFields: true } } : {}),
    styles: {
      default: {
        document: {
          run: { font: bodyFont, size: 22, color: c.text, language: { value: 'en-US', eastAsia: 'zh-CN' } },
          paragraph: { spacing: { after: 140, line: 360, lineRule: LineRuleType.AUTO } },
        },
        title: { run: { font: headFont, size: 52, bold: true, color: c.text }, paragraph: { spacing: { before: 0, after: 120, line: 300, lineRule: LineRuleType.AUTO } } },
        heading1: { run: { font: headFont, size: 34, bold: true, color: c.accent }, paragraph: { spacing: { before: 420, after: 160, line: 320, lineRule: LineRuleType.AUTO }, keepNext: true, keepLines: true } },
        heading2: { run: { font: headFont, size: 28, bold: true, color: c.text }, paragraph: { spacing: { before: 300, after: 120, line: 320, lineRule: LineRuleType.AUTO }, keepNext: true, keepLines: true } },
        heading3: { run: { font: headFont, size: 24, bold: true, color: c.text }, paragraph: { spacing: { before: 220, after: 100, line: 320, lineRule: LineRuleType.AUTO }, keepNext: true, keepLines: true } },
      },
      paragraphStyles: [
        { id: 'Subtitle', name: 'Subtitle', basedOn: 'Normal', next: 'Normal', run: { font: bodyFont, size: 28, color: c.muted }, paragraph: { spacing: { after: 80 } } },
        { id: 'TocHeading', name: 'TOC Heading', basedOn: 'Normal', next: 'Normal', run: { font: headFont, size: 30, bold: true, color: c.text }, paragraph: { spacing: { before: 120, after: 240 } } },
      ],
    },
    numbering: {
      config: [
        {
          reference: 'bullets',
          levels: [
            { level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 440, hanging: 280 } }, run: { color: c.accent } } },
            { level: 1, format: LevelFormat.BULLET, text: '–', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 880, hanging: 280 } }, run: { color: c.muted } } },
          ],
        },
        {
          reference: 'ordered',
          levels: [
            { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 440, hanging: 340 } } } },
            { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2)', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 880, hanging: 340 } } } },
          ],
        },
      ],
    },
    sections: [{
      properties: {
        page: {
          size: { width: page.width, height: page.height },
          margin: { top: MARGIN_Y, bottom: MARGIN_Y, left: MARGIN_X, right: MARGIN_X, header: 600, footer: 600 },
        },
      },
      ...(spec.header ? {
        headers: {
          default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: spec.header, color: c.muted, size: 18 })] })] }),
        },
      } : {}),
      ...(spec.pageNumbers !== false ? {
        footers: {
          default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], color: c.muted, size: 18 })] })] }),
        },
      } : {}),
      children,
    }],
  });
  const buffer = await Packer.toBuffer(doc);
  return { buffer, headings: spec.blocks.filter((b) => b.type === 'heading').length, hasToc, warnings: ctx.warnings };
}

/** One line per heading: "2.1 市场规模". */
export function documentOutline(spec: DocSpec): string[] {
  const out: string[] = [];
  spec.blocks.forEach((block, index) => {
    if (block.type === 'heading') out.push(`${'  '.repeat((block.level ?? 1) - 1)}[${index}] ${plainText(block.text ?? '').slice(0, 70)}`);
  });
  return out;
}
