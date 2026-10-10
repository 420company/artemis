/**
 * tools/office/pptx.ts — builds a .pptx from a DeckSpec.
 *
 * 16:9 slides (13.33 × 7.5 in), one theme for the whole deck. Every element
 * is a real, editable PowerPoint object: text boxes, native charts, tables,
 * pictures and speaker notes. Text sizes are chosen to fit their boxes, so
 * a long bullet list shrinks instead of running off the slide.
 *
 * After pptxgenjs writes the file, the XML is touched up: the East Asian
 * font of every run (pptxgenjs writes the Latin face there too) becomes the
 * theme's CJK face, the theme's font scheme names both, and bullets take the
 * accent color.
 */

import JSZip from 'jszip';
import PptxGenJSModule from 'pptxgenjs';
import type { Bullet, ChartSpec, DeckSpec, SlideColumn, SlideSpec, TableSpec } from './spec.js';
import { loadImage, type LoadedImage } from './images.js';
import { fitFontSize, formatCellNumber, hasCjk, parseInline, plainText, textWidthEm } from './text.js';
import { resolveTheme, tint, type OfficeTheme } from './themes.js';

// The package is CommonJS with an ESM build; depending on the loader the
// default import is the class or a namespace holding it.
const PptxGenJS = ((PptxGenJSModule as unknown as { default?: typeof PptxGenJSModule }).default ?? PptxGenJSModule) as typeof PptxGenJSModule;
type PptxGenJS = PptxGenJSModule;

const W = 13.333;
const H = 7.5;
const M = 0.75;
const CONTENT_W = W - 2 * M;
const TITLE_Y = 0.5;
const BODY_Y = 1.95;
const BODY_BOTTOM = 6.75;

type TextRun = PptxGenJSModule.TextProps;
type Slide = PptxGenJSModule.Slide;

export interface BuiltDeck {
  buffer: Buffer;
  slideCount: number;
  warnings: string[];
}

interface Ctx {
  pptx: PptxGenJS;
  theme: OfficeTheme;
  deck: DeckSpec;
  cwd: string;
  warnings: string[];
  sectionCount: number;
}

const lang = (text: string) => (hasCjk(text) ? 'zh-CN' : 'en-US');

/** Runs for one paragraph with inline emphasis; `base` options go on every run. */
function runs(text: string, base: PptxGenJSModule.TextPropsOptions, theme: OfficeTheme): TextRun[] {
  const parts = parseInline(text);
  return parts.map((part) => ({
    text: part.text,
    options: {
      ...base,
      lang: lang(text),
      ...(part.bold ? { bold: true, color: base.color === theme.colors.text ? theme.colors.text : base.color } : {}),
      ...(part.italic ? { italic: true } : {}),
      ...(part.code ? { fontFace: 'Courier New' } : {}),
    },
  }));
}

/** Paragraphs → one text array (inline emphasis split into runs). */
function paragraphs(items: Array<{ text: string; options: PptxGenJSModule.TextPropsOptions; first?: PptxGenJSModule.TextPropsOptions }>, theme: OfficeTheme): TextRun[] {
  const out: TextRun[] = [];
  items.forEach((item, index) => {
    const parts = runs(item.text, item.options, theme);
    parts.forEach((part, i) => {
      // Paragraph options on the first run (a bullet on a later run would
      // start a new paragraph); finishXml drops the extra paragraph
      // properties pptxgenjs writes for the later runs.
      if (i === 0 && item.first) part.options = { ...part.options, ...item.first };
      if (i === parts.length - 1 && index < items.length - 1) part.options = { ...part.options, breakLine: true };
    });
    out.push(...parts);
  });
  return out;
}

function background(slide: Slide, color: string): void {
  slide.background = { color };
}

function footer(ctx: Ctx, slide: Slide, dark = ctx.theme.dark): void {
  const { theme } = ctx;
  const color = dark ? theme.colors.muted : theme.colors.muted;
  const label = ctx.deck.footer ?? ctx.deck.title;
  if (label) {
    slide.addText(label, { x: M, y: 6.98, w: 8, h: 0.3, fontSize: 10, color, fontFace: theme.fonts.bodyLatin, lang: lang(label), margin: 0 });
  }
  slide.slideNumber = { x: W - M - 0.8, y: 6.98, w: 0.8, h: 0.3, fontSize: 10, color, fontFace: theme.fonts.bodyLatin, align: 'right' } as PptxGenJSModule.SlideNumberProps;
}

function titleBlock(ctx: Ctx, slide: Slide, title: string | undefined, subtitle?: string, width = CONTENT_W, x = M): number {
  const { theme } = ctx;
  if (!title) return BODY_Y - 0.4;
  const size = fitFontSize([{ text: title }], width, 0.95, 30, 20, 1.1, 0);
  slide.addText(runs(title, { fontFace: theme.fonts.headLatin, fontSize: size, bold: true, color: theme.colors.text }, theme), {
    x, y: TITLE_Y, w: width, h: 0.95, valign: 'bottom', margin: 0, fit: 'shrink',
  });
  slide.addShape('rect', { x, y: TITLE_Y + 1.05, w: 0.55, h: 0.06, fill: { color: theme.colors.accent }, line: { type: 'none' } });
  if (subtitle) {
    slide.addText(subtitle, { x, y: TITLE_Y + 1.18, w: width, h: 0.4, fontSize: 15, color: theme.colors.muted, fontFace: theme.fonts.bodyLatin, margin: 0, lang: lang(subtitle) });
    return BODY_Y + 0.35;
  }
  return BODY_Y;
}

function bulletParagraphs(ctx: Ctx, list: Bullet[], size: number, color = ctx.theme.colors.text): TextRun[] {
  const { theme } = ctx;
  const items: Array<{ text: string; options: PptxGenJSModule.TextPropsOptions; first?: PptxGenJSModule.TextPropsOptions }> = [];
  for (const bullet of list) {
    const main = typeof bullet === 'string' ? bullet : bullet.text;
    items.push({
      text: main,
      options: { fontFace: theme.fonts.bodyLatin, fontSize: size, color },
      first: { bullet: { characterCode: '25CF', indent: Math.round(size * 1.1) }, paraSpaceAfter: Math.round(size * 0.55), lineSpacingMultiple: 1.12 },
    });
    if (typeof bullet !== 'string') {
      for (const sub of bullet.sub ?? []) {
        items.push({
          text: sub,
          options: { fontFace: theme.fonts.bodyLatin, fontSize: Math.round(size * 0.82), color: theme.colors.muted },
          first: { bullet: { characterCode: '2013', indent: Math.round(size * 0.9) }, indentLevel: 1, paraSpaceAfter: Math.round(size * 0.35), lineSpacingMultiple: 1.1 },
        });
      }
    }
  }
  return paragraphs(items, theme);
}

function bulletFitInput(list: Bullet[]): Array<{ text: string; indentIn?: number; scale?: number }> {
  const out: Array<{ text: string; indentIn?: number; scale?: number }> = [];
  for (const bullet of list) {
    out.push({ text: typeof bullet === 'string' ? bullet : bullet.text, indentIn: 0.45 });
    if (typeof bullet !== 'string') for (const sub of bullet.sub ?? []) out.push({ text: sub, indentIn: 0.9, scale: 0.82 });
  }
  return out;
}

/** Bullets (and an optional lead paragraph) in a box. */
function bulletBox(ctx: Ctx, slide: Slide, box: { x: number; y: number; w: number; h: number }, list: Bullet[] | undefined, lead?: string, maxPt = 24): void {
  const { theme } = ctx;
  let y = box.y;
  let h = box.h;
  if (lead) {
    const leadSize = fitFontSize([{ text: lead }], box.w, Math.min(1.6, h * 0.4), Math.min(20, maxPt), 13, 1.25, 0);
    const leadH = Math.min(h * 0.45, (Math.ceil(textWidthEm(plainText(lead)) / (box.w / (leadSize / 72))) * leadSize * 1.3) / 72 + 0.15);
    slide.addText(runs(lead, { fontFace: theme.fonts.bodyLatin, fontSize: leadSize, color: list?.length ? theme.colors.muted : theme.colors.text }, theme), {
      x: box.x, y, w: box.w, h: leadH, valign: 'top', margin: 0, lineSpacingMultiple: 1.2, fit: 'shrink',
    });
    y += leadH + 0.15;
    h -= leadH + 0.15;
  }
  if (!list?.length) return;
  const size = fitFontSize(bulletFitInput(list), box.w, h, maxPt, 12, 1.15, 0.55);
  slide.addText(bulletParagraphs(ctx, list, size), { x: box.x, y, w: box.w, h, valign: 'top', margin: 0, fit: 'shrink' });
}

// ── Layouts ─────────────────────────────────────────────────────────────

function coverSlide(ctx: Ctx, spec: SlideSpec, index: number): void {
  const { pptx, theme, deck } = ctx;
  const slide = pptx.addSlide();
  const c = theme.colors;
  background(slide, c.coverBg);
  const colored = c.coverBg !== c.bg || theme.dark;
  // Decoration: a large soft ring at the right edge, a short accent rule.
  if (colored) {
    slide.addShape('ellipse', { x: W - 4.6, y: -1.6, w: 7.2, h: 7.2, fill: { color: c.coverText, transparency: 94 }, line: { type: 'none' } });
    slide.addShape('ellipse', { x: W - 2.9, y: 3.9, w: 4.2, h: 4.2, fill: { color: c.coverBg, transparency: 100 }, line: { color: c.accent2, width: 2.5 } });
  } else {
    slide.addShape('rect', { x: 0, y: 0, w: 0.28, h: H, fill: { color: c.accent }, line: { type: 'none' } });
    slide.addShape('ellipse', { x: W - 3.8, y: 4.4, w: 5.2, h: 5.2, fill: { color: tint(c.accent, 0.86) }, line: { type: 'none' } });
  }
  const title = spec.title ?? deck.title ?? '';
  const subtitle = spec.subtitle ?? (index === 0 ? deck.subtitle : undefined);
  const titleSize = fitFontSize([{ text: title }], 9.6, 2.2, 48, 28, 1.08, 0);
  slide.addShape('rect', { x: 1.0, y: 2.05, w: 0.9, h: 0.08, fill: { color: colored ? c.accent2 : c.accent }, line: { type: 'none' } });
  slide.addText(runs(title, { fontFace: theme.fonts.headLatin, fontSize: titleSize, bold: true, color: c.coverText }, theme), {
    x: 1.0, y: 2.3, w: 9.8, h: 2.3, valign: 'top', margin: 0, lineSpacingMultiple: 1.05, fit: 'shrink',
  });
  if (subtitle) {
    slide.addText(runs(subtitle, { fontFace: theme.fonts.bodyLatin, fontSize: 20, color: c.coverMuted }, theme), { x: 1.0, y: 4.65, w: 9.8, h: 0.9, valign: 'top', margin: 0, fit: 'shrink' });
  }
  const byline = [index === 0 ? deck.author : undefined, index === 0 ? deck.date : undefined].filter(Boolean).join('  ·  ');
  if (byline) slide.addText(byline, { x: 1.0, y: 6.35, w: 9, h: 0.4, fontSize: 13, color: c.coverMuted, fontFace: theme.fonts.bodyLatin, margin: 0, lang: lang(byline) });
  if (spec.notes) slide.addNotes(spec.notes);
}

function sectionSlide(ctx: Ctx, spec: SlideSpec): void {
  const { pptx, theme } = ctx;
  const c = theme.colors;
  const slide = pptx.addSlide();
  background(slide, c.sectionBg);
  ctx.sectionCount += 1;
  const number = spec.number ?? String(ctx.sectionCount).padStart(2, '0');
  const onColor = c.sectionBg !== c.bg && c.sectionText === 'FFFFFF';
  slide.addText(number, { x: 1.0, y: 1.7, w: 4, h: 1.4, fontSize: 72, bold: true, color: onColor ? c.sectionText : c.accent, fontFace: theme.fonts.headLatin, margin: 0, transparency: onColor ? 30 : 0 } as PptxGenJSModule.TextPropsOptions);
  const size = fitFontSize([{ text: spec.title ?? '' }], 10.5, 1.6, 40, 26, 1.1, 0);
  slide.addText(runs(spec.title ?? '', { fontFace: theme.fonts.headLatin, fontSize: size, bold: true, color: c.sectionText }, theme), { x: 1.0, y: 3.2, w: 10.5, h: 1.6, valign: 'top', margin: 0, fit: 'shrink' });
  if (spec.subtitle) slide.addText(runs(spec.subtitle, { fontFace: theme.fonts.bodyLatin, fontSize: 18, color: onColor ? c.sectionText : c.muted }, theme), { x: 1.0, y: 4.85, w: 10.5, h: 0.8, valign: 'top', margin: 0, fit: 'shrink' });
  slide.addShape('rect', { x: 1.0, y: 6.4, w: W - 2.0, h: 0.02, fill: { color: onColor ? c.sectionText : c.line, transparency: onColor ? 60 : 0 }, line: { type: 'none' } });
  if (spec.notes) slide.addNotes(spec.notes);
}

function contentSlide(ctx: Ctx, spec: SlideSpec): { slide: Slide; top: number } {
  const slide = ctx.pptx.addSlide();
  background(slide, ctx.theme.colors.bg);
  const top = titleBlock(ctx, slide, spec.title, spec.subtitle);
  footer(ctx, slide);
  if (spec.notes) slide.addNotes(spec.notes);
  return { slide, top };
}

function bulletsSlide(ctx: Ctx, spec: SlideSpec): void {
  const { slide, top } = contentSlide(ctx, spec);
  bulletBox(ctx, slide, { x: M, y: top, w: CONTENT_W, h: BODY_BOTTOM - top }, spec.bullets, spec.text, 26);
}

function columnPanel(ctx: Ctx, slide: Slide, column: SlideColumn | undefined, box: { x: number; y: number; w: number; h: number }, accent: string): void {
  const { theme } = ctx;
  slide.addShape('roundRect', { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: theme.colors.surface }, line: { type: 'none' }, rectRadius: 0.12 } as PptxGenJSModule.ShapeProps);
  slide.addShape('rect', { x: box.x, y: box.y + 0.35, w: 0.07, h: 0.5, fill: { color: accent }, line: { type: 'none' } });
  if (!column) return;
  const pad = 0.35;
  let y = box.y + 0.3;
  if (column.heading) {
    const size = fitFontSize([{ text: column.heading }], box.w - 2 * pad, 0.6, 22, 15, 1.1, 0);
    slide.addText(runs(column.heading, { fontFace: theme.fonts.headLatin, fontSize: size, bold: true, color: theme.colors.text }, theme), { x: box.x + pad, y, w: box.w - 2 * pad, h: 0.6, valign: 'middle', margin: 0, fit: 'shrink' });
    y += 0.8;
  }
  bulletBox(ctx, slide, { x: box.x + pad, y, w: box.w - 2 * pad, h: box.y + box.h - y - 0.25 }, column.bullets, column.text, 20);
}

function twoColumnSlide(ctx: Ctx, spec: SlideSpec): void {
  const { slide, top } = contentSlide(ctx, spec);
  const gap = 0.4;
  const w = (CONTENT_W - gap) / 2;
  const h = BODY_BOTTOM - top;
  columnPanel(ctx, slide, spec.left, { x: M, y: top, w, h }, ctx.theme.colors.accent);
  columnPanel(ctx, slide, spec.right, { x: M + w + gap, y: top, w, h }, ctx.theme.colors.accent2);
}

function addCoverImage(slide: Slide, image: LoadedImage, box: { x: number; y: number; w: number; h: number }): void {
  slide.addImage({
    data: `data:image/${image.type === 'jpg' ? 'jpeg' : image.type};base64,${image.data.toString('base64')}`,
    x: box.x,
    y: box.y,
    w: image.width / 100,
    h: image.height / 100,
    sizing: { type: 'cover', w: box.w, h: box.h },
  });
}

function placeholder(ctx: Ctx, slide: Slide, box: { x: number; y: number; w: number; h: number }, label: string): void {
  const { theme } = ctx;
  slide.addShape('rect', { x: box.x, y: box.y, w: box.w, h: box.h, fill: { color: theme.colors.surface }, line: { color: theme.colors.line, width: 1, dashType: 'dash' } });
  slide.addText(label, { x: box.x, y: box.y + box.h / 2 - 0.3, w: box.w, h: 0.6, align: 'center', fontSize: 14, color: theme.colors.muted, fontFace: theme.fonts.bodyLatin, lang: lang(label) });
}

async function imageTextSlide(ctx: Ctx, spec: SlideSpec, number: number): Promise<void> {
  const { pptx, theme } = ctx;
  const slide = pptx.addSlide();
  background(slide, theme.colors.bg);
  if (spec.notes) slide.addNotes(spec.notes);
  const imageW = 5.9;
  const right = spec.imageSide === 'right';
  const imageBox = { x: right ? W - imageW : 0, y: 0, w: imageW, h: H };
  const loaded = spec.image ? await loadImage(spec.image, ctx.cwd) : { error: 'no image' };
  if ('error' in loaded) {
    ctx.warnings.push(`slide ${number}: ${loaded.error}; a placeholder was used`);
    placeholder(ctx, slide, imageBox, hasCjk(spec.title ?? '') ? '图片' : 'Image');
  } else {
    addCoverImage(slide, loaded, imageBox);
  }
  const textX = right ? M : imageW + 0.65;
  const textW = W - imageW - 0.65 - M;
  const top = titleBlock(ctx, slide, spec.title, spec.subtitle, textW, textX);
  const captionH = spec.caption ? 0.5 : 0;
  bulletBox(ctx, slide, { x: textX, y: top, w: textW, h: BODY_BOTTOM - top - captionH }, spec.bullets, spec.text, 22);
  if (spec.caption) slide.addText(spec.caption, { x: textX, y: BODY_BOTTOM - 0.4, w: textW, h: 0.4, fontSize: 11, color: theme.colors.muted, fontFace: theme.fonts.bodyLatin, margin: 0, italic: true, lang: lang(spec.caption) });
  const label = ctx.deck.footer ?? ctx.deck.title;
  if (label) slide.addText(label, { x: textX, y: 6.98, w: textW - 1, h: 0.3, fontSize: 10, color: theme.colors.muted, fontFace: theme.fonts.bodyLatin, margin: 0, lang: lang(label) });
  slide.slideNumber = { x: right ? textX + textW - 0.8 : W - M - 0.8, y: 6.98, w: 0.8, h: 0.3, fontSize: 10, color: theme.colors.muted, fontFace: theme.fonts.bodyLatin, align: 'right' } as PptxGenJSModule.SlideNumberProps;
}

const CHART_TYPE: Record<ChartSpec['type'], PptxGenJSModule.CHART_NAME> = {
  bar: 'bar',
  column: 'bar',
  line: 'line',
  pie: 'pie',
  doughnut: 'doughnut',
  area: 'area',
};

function chartOptions(ctx: Ctx, chart: ChartSpec, box: { x: number; y: number; w: number; h: number }): PptxGenJSModule.IChartOpts {
  const { theme } = ctx;
  const c = theme.colors;
  const round = chart.type === 'pie' || chart.type === 'doughnut';
  const font = theme.fonts.bodyLatin;
  const base: PptxGenJSModule.IChartOpts = {
    ...box,
    chartColors: c.chart.slice(0, round ? Math.max(chart.categories.length, 1) : chart.series.length).length ? (round ? Array.from({ length: chart.categories.length }, (_, i) => c.chart[i % c.chart.length]!) : c.chart) : c.chart,
    showLegend: round || chart.series.length > 1,
    legendPos: round ? 'r' : 'b',
    legendFontFace: font,
    legendFontSize: 14,
    legendColor: c.muted,
    showTitle: false,
    dataLabelFontFace: font,
    dataLabelFontSize: 13,
    dataLabelColor: round ? c.onAccent : c.text,
  };
  if (round) {
    return {
      ...base,
      showPercent: chart.showValues !== false,
      showValue: false,
      dataLabelPosition: 'ctr',
      holeSize: chart.type === 'doughnut' ? 58 : undefined,
    } as PptxGenJSModule.IChartOpts;
  }
  const opts: PptxGenJSModule.IChartOpts = {
    ...base,
    catAxisLabelColor: c.muted,
    catAxisLabelFontFace: font,
    catAxisLabelFontSize: 12,
    catAxisLineShow: true,
    catAxisLineColor: c.line,
    valAxisLabelColor: c.muted,
    valAxisLabelFontFace: font,
    valAxisLabelFontSize: 11,
    valAxisLineShow: false,
    valGridLine: { color: c.line, style: 'solid', size: 0.75 },
    catGridLine: { style: 'none' },
    showValue: chart.showValues === true,
    dataLabelPosition: chart.type === 'line' || chart.type === 'area' ? 't' : 'outEnd',
  } as PptxGenJSModule.IChartOpts;
  if (chart.unit) {
    Object.assign(opts, { showValAxisTitle: true, valAxisTitle: chart.unit, valAxisTitleColor: c.muted, valAxisTitleFontSize: 11, valAxisTitleFontFace: font });
  }
  if (chart.type === 'bar' || chart.type === 'column') {
    Object.assign(opts, { barDir: chart.type === 'bar' ? 'bar' : 'col', barGapWidthPct: 70, barGrouping: chart.stacked ? 'stacked' : 'clustered' });
  }
  if (chart.type === 'line') Object.assign(opts, { lineSize: 2.5, lineDataSymbol: 'circle', lineDataSymbolSize: 7 });
  if (chart.type === 'area' && chart.stacked) Object.assign(opts, { barGrouping: 'stacked' });
  return opts;
}

function chartSlide(ctx: Ctx, spec: SlideSpec): void {
  const { slide, top } = contentSlide(ctx, spec);
  const chart = spec.chart!;
  const captionH = spec.caption ? 0.7 : 0;
  const box = { x: M, y: top, w: CONTENT_W, h: BODY_BOTTOM - top - captionH };
  const data = chart.series.map((s) => ({ name: s.name, labels: chart.categories, values: s.values }));
  slide.addChart(CHART_TYPE[chart.type], data, chartOptions(ctx, chart, box));
  if (spec.caption) {
    slide.addText(runs(spec.caption, { fontFace: ctx.theme.fonts.bodyLatin, fontSize: 14, color: ctx.theme.colors.muted }, ctx.theme), { x: M, y: BODY_BOTTOM - captionH + 0.1, w: CONTENT_W, h: captionH - 0.1, valign: 'top', margin: 0, fit: 'shrink' });
  }
}

const MAX_TABLE_ROWS = 18;

function columnWidths(table: TableSpec, total: number): number[] {
  const columns = Math.max(table.header?.length ?? 0, ...table.rows.map((r) => r.length), 1);
  let weights: number[];
  if (table.columnWidths?.length) {
    weights = Array.from({ length: columns }, (_, i) => table.columnWidths![i] ?? 1);
  } else {
    weights = Array.from({ length: columns }, (_, i) => {
      const cells = [table.header?.[i] ?? '', ...table.rows.map((r) => String(r[i] ?? ''))];
      return 2 + Math.min(14, Math.max(2, ...cells.map((cell) => textWidthEm(cell))));
    });
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => (w / sum) * total);
}

function tableSlide(ctx: Ctx, spec: SlideSpec, number: number): void {
  const { slide, top } = contentSlide(ctx, spec);
  const { theme } = ctx;
  const c = theme.colors;
  const table = spec.table!;
  let rows = table.rows;
  if (rows.length > MAX_TABLE_ROWS) {
    ctx.warnings.push(`slide ${number}: the table has ${rows.length} rows; the first ${MAX_TABLE_ROWS} are shown. Split it across slides or put the full data in a spreadsheet.`);
    rows = rows.slice(0, MAX_TABLE_ROWS);
  }
  const count = rows.length + (table.header ? 1 : 0);
  const fontSize = count <= 6 ? 16 : count <= 9 ? 14 : count <= 13 ? 12 : 10;
  const numeric = (value: string | number) => typeof value === 'number' || /^[-+]?[\d,.]+%?$|^[¥$€£][\d,.]+$/.test(String(value).trim());
  const cell = (value: string | number, options: PptxGenJSModule.TableCellProps): PptxGenJSModule.TableCell => ({ text: formatCellNumber(value), options: { ...options, lang: lang(String(value)) } as PptxGenJSModule.TableCellProps });
  const body: PptxGenJSModule.TableRow[] = [];
  if (table.header) {
    body.push(table.header.map((h) => cell(h, { bold: true, color: c.onAccent, fill: { color: c.accent }, fontFace: theme.fonts.headLatin, fontSize, valign: 'middle' })));
  }
  rows.forEach((row, r) => {
    const columns = Math.max(table.header?.length ?? 0, row.length);
    body.push(Array.from({ length: columns }, (_, i) => {
      const value = row[i] ?? '';
      return cell(value, {
        color: c.text,
        fill: { color: r % 2 === 1 ? c.surface : c.bg },
        fontFace: theme.fonts.bodyLatin,
        fontSize,
        align: numeric(value) && i > 0 ? 'right' : 'left',
        valign: 'middle',
      });
    }));
  });
  const captionH = spec.caption ? 0.5 : 0;
  const maxH = BODY_BOTTOM - top - captionH;
  const rowH = Math.min(0.55, maxH / Math.max(count, 1));
  slide.addTable(body, {
    x: M,
    y: top,
    w: CONTENT_W,
    colW: columnWidths(table, CONTENT_W),
    rowH,
    border: { type: 'solid', color: c.line, pt: 0.75 },
    margin: [0.04, 0.12, 0.04, 0.12],
  } as PptxGenJSModule.TableProps);
  if (spec.caption) slide.addText(spec.caption, { x: M, y: Math.min(BODY_BOTTOM - 0.4, top + rowH * count + 0.15), w: CONTENT_W, h: 0.4, fontSize: 12, color: c.muted, fontFace: theme.fonts.bodyLatin, margin: 0, lang: lang(spec.caption) });
}

function quoteSlide(ctx: Ctx, spec: SlideSpec): void {
  const { pptx, theme } = ctx;
  const c = theme.colors;
  const slide = pptx.addSlide();
  background(slide, theme.dark ? c.bg : c.surface);
  if (spec.notes) slide.addNotes(spec.notes);
  slide.addText('“', { x: 1.0, y: 0.7, w: 2, h: 1.8, fontSize: 140, bold: true, color: c.accent, fontFace: 'Georgia', margin: 0 });
  const quote = spec.quote ?? '';
  const size = fitFontSize([{ text: quote }], 10.6, 3.2, 34, 18, 1.3, 0);
  slide.addText(runs(quote, { fontFace: theme.fonts.headLatin, fontSize: size, color: c.text }, theme), { x: 1.35, y: 2.3, w: 10.6, h: 3.2, valign: 'top', margin: 0, lineSpacingMultiple: 1.25, fit: 'shrink' });
  if (spec.author) {
    slide.addShape('rect', { x: 1.35, y: 5.85, w: 0.5, h: 0.04, fill: { color: c.accent }, line: { type: 'none' } });
    slide.addText(spec.author, { x: 2.0, y: 5.62, w: 9, h: 0.5, fontSize: 16, color: c.muted, fontFace: theme.fonts.bodyLatin, margin: 0, lang: lang(spec.author) });
  }
  footer(ctx, slide);
}

function statsSlide(ctx: Ctx, spec: SlideSpec): void {
  const { slide, top } = contentSlide(ctx, spec);
  const { theme } = ctx;
  const c = theme.colors;
  const stats = spec.stats ?? [];
  const gap = 0.35;
  const w = (CONTENT_W - gap * (stats.length - 1)) / Math.max(stats.length, 1);
  const h = Math.min(3.6, BODY_BOTTOM - top);
  const y = top + Math.max(0, (BODY_BOTTOM - top - h) / 2 - 0.2);
  stats.forEach((stat, i) => {
    const x = M + i * (w + gap);
    const color = i % 2 === 0 ? c.accent : c.accent2;
    slide.addShape('roundRect', { x, y, w, h, fill: { color: c.surface }, line: { type: 'none' }, rectRadius: 0.12 } as PptxGenJSModule.ShapeProps);
    slide.addShape('rect', { x: x + 0.35, y: y + 0.4, w: 0.5, h: 0.06, fill: { color }, line: { type: 'none' } });
    const valueSize = fitFontSize([{ text: stat.value }], w - 0.7, 1.2, 54, 26, 1.0, 0);
    slide.addText(stat.value, { x: x + 0.35, y: y + 0.6, w: w - 0.7, h: 1.25, fontSize: valueSize, bold: true, color, fontFace: theme.fonts.headLatin, margin: 0, valign: 'middle', lang: lang(stat.value) });
    slide.addText(runs(stat.label, { fontFace: theme.fonts.bodyLatin, fontSize: 17, bold: true, color: c.text }, theme), { x: x + 0.35, y: y + 1.95, w: w - 0.7, h: 0.6, margin: 0, valign: 'top', fit: 'shrink' });
    if (stat.detail) slide.addText(runs(stat.detail, { fontFace: theme.fonts.bodyLatin, fontSize: 13, color: c.muted }, theme), { x: x + 0.35, y: y + 2.55, w: w - 0.7, h: h - 2.75, margin: 0, valign: 'top', fit: 'shrink' });
  });
}

// ── Assembly ────────────────────────────────────────────────────────────

/** Sets the East Asian face of runs, the theme fonts and the bullet color in the written file. */
async function finishXml(buffer: Buffer, theme: OfficeTheme): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const latinToEa = new Map<string, string>([
    [theme.fonts.headLatin, theme.fonts.headEa],
    [theme.fonts.bodyLatin, theme.fonts.bodyEa],
  ]);
  const files = Object.keys(zip.files).filter((name) => /^ppt\/(slides\/slide\d+|charts\/chart\d+|notesSlides\/notesSlide\d+|slideLayouts\/slideLayout\d+|slideMasters\/slideMaster\d+)\.xml$/.test(name));
  for (const name of files) {
    let xml = await zip.file(name)!.async('string');
    xml = xml.replace(/<a:ea typeface="([^"]*)"/g, (whole, face: string) => {
      const ea = latinToEa.get(face) ?? (face === 'Georgia' ? 'Noto Serif CJK SC' : face === 'Courier New' ? theme.fonts.bodyEa : undefined);
      return ea ? `<a:ea typeface="${ea}"` : whole;
    });
    // pptxgenjs writes paragraph properties before every run of a
    // paragraph; only the first is valid (and the one meant).
    xml = xml.replace(/<a:p>([\s\S]*?)<\/a:p>/g, (_whole, inner: string) => {
      let seen = false;
      const kept = inner.replace(/<a:pPr\b[^>]*?(?:\/>|>[\s\S]*?<\/a:pPr>)/g, (pPr) => {
        if (seen) return '';
        seen = true;
        return pPr;
      });
      return `<a:p>${kept}</a:p>`;
    });
    xml = xml.replace(/<a:buSzPct val="100000"\/><a:buChar/g, `<a:buClr><a:srgbClr val="${theme.colors.accent}"/></a:buClr><a:buSzPct val="90000"/><a:buChar`);
    zip.file(name, xml);
  }
  const themeFile = Object.keys(zip.files).find((name) => /^ppt\/theme\/theme1\.xml$/.test(name));
  if (themeFile) {
    let xml = await zip.file(themeFile)!.async('string');
    xml = xml
      .replace(/(<a:majorFont>\s*<a:latin typeface=")[^"]*(")/, `$1${theme.fonts.headLatin}$2`)
      .replace(/(<a:minorFont>\s*<a:latin typeface=")[^"]*(")/, `$1${theme.fonts.bodyLatin}$2`)
      .replace(/(<a:majorFont>[\s\S]*?<a:ea typeface=")[^"]*(")/, `$1${theme.fonts.headEa}$2`)
      .replace(/(<a:minorFont>[\s\S]*?<a:ea typeface=")[^"]*(")/, `$1${theme.fonts.bodyEa}$2`);
    zip.file(themeFile, xml);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

export async function buildPresentation(deck: DeckSpec, cwd: string): Promise<BuiltDeck> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  const theme = resolveTheme(deck.theme);
  if (deck.title) pptx.title = deck.title;
  if (deck.author) pptx.author = deck.author;
  pptx.theme = { headFontFace: theme.fonts.headLatin, bodyFontFace: theme.fonts.bodyLatin };
  const ctx: Ctx = { pptx, theme, deck, cwd, warnings: [], sectionCount: 0 };
  for (const [index, spec] of deck.slides.entries()) {
    const number = index + 1;
    switch (spec.layout) {
      case 'title':
        coverSlide(ctx, spec, index);
        break;
      case 'section':
        sectionSlide(ctx, spec);
        break;
      case 'bullets':
        bulletsSlide(ctx, spec);
        break;
      case 'two-column':
        twoColumnSlide(ctx, spec);
        break;
      case 'image-text':
        await imageTextSlide(ctx, spec, number);
        break;
      case 'chart':
        chartSlide(ctx, spec);
        break;
      case 'table':
        tableSlide(ctx, spec, number);
        break;
      case 'quote':
        quoteSlide(ctx, spec);
        break;
      case 'stats':
        statsSlide(ctx, spec);
        break;
    }
  }
  const raw = (await pptx.write({ outputType: 'nodebuffer', compression: true })) as Buffer;
  return { buffer: await finishXml(raw, theme), slideCount: deck.slides.length, warnings: ctx.warnings };
}

/** One line per slide: "3. 市场规模 (chart)". */
export function deckOutline(deck: DeckSpec): string[] {
  return deck.slides.map((slide, i) => `${i + 1}. ${plainText(slide.title ?? slide.quote ?? '').slice(0, 60) || '(untitled)'} (${slide.layout})`);
}
