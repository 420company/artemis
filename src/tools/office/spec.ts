/**
 * tools/office/spec.ts — the structured specs the office tools take.
 *
 * A model writes a deck, a document or a workbook as JSON; these functions
 * check it, accept the usual variations (layout aliases, a bare string for a
 * bullet, `rows` given as objects), and return a normalized spec the
 * builders can trust. Problems a model can fix are returned as messages, so
 * the tool answers with what to change instead of a stack trace.
 *
 * Edits are JSON-Pointer operations (RFC 6901, zero-based array indexes) on
 * the stored spec: "把第3页标题改成…" is
 * `{ op: 'set', path: '/slides/2/title', value: '…' }`.
 */

import { THEME_IDS } from './themes.js';

// ── Shared ──────────────────────────────────────────────────────────────

/** A bullet: a line, or a line with second-level lines under it. */
export type Bullet = string | { text: string; sub?: string[] };

export type ChartType = 'bar' | 'column' | 'line' | 'pie' | 'doughnut' | 'area';

export interface ChartSpec {
  type: ChartType;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  /** Shown after values and on the value axis, e.g. "%", "万元". */
  unit?: string;
  showValues?: boolean;
  stacked?: boolean;
}

export interface TableSpec {
  header?: string[];
  rows: Array<Array<string | number>>;
  /** Relative column widths (any positive numbers). */
  columnWidths?: number[];
}

// ── Presentation ────────────────────────────────────────────────────────

export const SLIDE_LAYOUTS = ['title', 'section', 'bullets', 'two-column', 'image-text', 'chart', 'table', 'quote', 'stats'] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export interface SlideColumn {
  heading?: string;
  bullets?: Bullet[];
  text?: string;
}

export interface SlideSpec {
  layout: SlideLayout;
  title?: string;
  subtitle?: string;
  /** bullets */
  bullets?: Bullet[];
  /** Free text under or instead of bullets. */
  text?: string;
  /** two-column */
  left?: SlideColumn;
  right?: SlideColumn;
  /** image-text */
  image?: string;
  imageSide?: 'left' | 'right';
  caption?: string;
  /** chart */
  chart?: ChartSpec;
  /** table */
  table?: TableSpec;
  /** quote */
  quote?: string;
  author?: string;
  /** stats */
  stats?: Array<{ value: string; label: string; detail?: string }>;
  /** section: the number shown ("01"); defaults to the section's order. */
  number?: string;
  /** Speaker notes. */
  notes?: string;
}

export interface DeckSpec {
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  theme?: string;
  /** Small text at the bottom-left of content slides. */
  footer?: string;
  slides: SlideSpec[];
}

// ── Document ────────────────────────────────────────────────────────────

export const DOC_BLOCK_TYPES = ['heading', 'paragraph', 'bullets', 'table', 'image', 'quote', 'callout', 'pageBreak', 'toc', 'divider'] as const;
export type DocBlockType = (typeof DOC_BLOCK_TYPES)[number];

export interface DocBlock {
  type: DocBlockType;
  text?: string;
  level?: 1 | 2 | 3;
  items?: Bullet[];
  ordered?: boolean;
  table?: TableSpec;
  path?: string;
  caption?: string;
  /** image: share of the text width, 0.2 – 1. */
  width?: number;
  author?: string;
  title?: string;
}

export interface DocSpec {
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  theme?: string;
  /** A table of contents after the title block. */
  toc?: boolean;
  /** Page numbers in the footer (default on). */
  pageNumbers?: boolean;
  /** Text in the page header. */
  header?: string;
  /** Page size: A4 (default) or Letter. */
  pageSize?: 'A4' | 'Letter';
  blocks: DocBlock[];
}

// ── Spreadsheet ─────────────────────────────────────────────────────────

export interface CellObject {
  value?: string | number | boolean | null;
  /** "=SUM(B2:B9)" or "SUM(B2:B9)". */
  formula?: string;
  /** Number format: a name (number, integer, decimal, percent, currency, date, text) or an Excel format code. */
  format?: string;
  bold?: boolean;
  italic?: boolean;
  /** Text color, RRGGBB. */
  color?: string;
  /** Background, RRGGBB. */
  fill?: string;
  align?: 'left' | 'center' | 'right';
}

export type CellInput = string | number | boolean | null | CellObject;

export interface SheetColumn {
  header: string;
  /** Width in characters. */
  width?: number;
  format?: string;
  align?: 'left' | 'center' | 'right';
}

export interface SheetChart {
  type: ChartType;
  title?: string;
  /** A1 range with the category labels, e.g. "A2:A13". */
  categories: string;
  series: Array<{ name?: string; values: string }>;
  /** Top-left cell of the chart, e.g. "H2" (default: right of the data). */
  position?: string;
  /** Size in columns × rows (default 8 × 16). */
  width?: number;
  height?: number;
}

export interface SheetSpec {
  name: string;
  /** A title row above the table (merged across the columns). */
  title?: string;
  columns?: SheetColumn[];
  rows: CellInput[][];
  /** "A2" or { rows, columns } kept in view while scrolling. Default: the header row. */
  freeze?: string | { rows?: number; columns?: number };
  autoFilter?: boolean;
  /** Striped rows (default on when there are columns). */
  zebra?: boolean;
  merges?: string[];
  charts?: SheetChart[];
}

export interface WorkbookSpec {
  title?: string;
  theme?: string;
  sheets: SheetSpec[];
}

// ── Normalization ───────────────────────────────────────────────────────

export class SpecError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('\n'));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value.trim() ? value : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};
const MAX_TEXT = 20_000;
const clip = (value: string | undefined) => (value && value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value);
const text = (value: unknown) => clip(str(value));

function optional<T extends object>(entries: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out as T;
}

const LAYOUT_ALIASES: Record<string, SlideLayout> = {
  title: 'title',
  cover: 'title',
  opening: 'title',
  closing: 'title',
  end: 'title',
  thanks: 'title',
  section: 'section',
  divider: 'section',
  chapter: 'section',
  bullets: 'bullets',
  bullet: 'bullets',
  list: 'bullets',
  content: 'bullets',
  text: 'bullets',
  agenda: 'bullets',
  twocolumn: 'two-column',
  twocolumns: 'two-column',
  columns: 'two-column',
  comparison: 'two-column',
  compare: 'two-column',
  imagetext: 'image-text',
  textimage: 'image-text',
  image: 'image-text',
  picture: 'image-text',
  photo: 'image-text',
  chart: 'chart',
  graph: 'chart',
  table: 'table',
  quote: 'quote',
  quotation: 'quote',
  stats: 'stats',
  stat: 'stats',
  kpi: 'stats',
  kpis: 'stats',
  metrics: 'stats',
  numbers: 'stats',
};

export function normalizeLayout(raw: unknown): SlideLayout | undefined {
  if (typeof raw !== 'string') return undefined;
  const key = raw.trim().toLowerCase().replace(/[\s_+&-]+/g, '');
  return LAYOUT_ALIASES[key];
}

function bullets(raw: unknown, where: string, problems: string[]): Bullet[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    // A block of lines: "- a\n- b" or plain lines.
    const lines = raw.split('\n').map((line) => line.replace(/^\s*(?:[-*•·]|\d+[.)、])\s*/, '').trim()).filter(Boolean);
    return lines.length ? lines.map(clip) as string[] : undefined;
  }
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be a list of strings`);
    return undefined;
  }
  const out: Bullet[] = [];
  for (const item of raw.slice(0, 40)) {
    const line = text(item);
    if (line) {
      out.push(line);
      continue;
    }
    if (isRecord(item)) {
      const main = text(item.text ?? item.title ?? item.label);
      if (!main) continue;
      const subRaw = item.sub ?? item.children ?? item.items ?? item.bullets;
      const sub = Array.isArray(subRaw) ? subRaw.map((s) => text(isRecord(s) ? s.text : s)).filter((s): s is string => Boolean(s)).slice(0, 20) : [];
      out.push(sub.length ? { text: main, sub } : main);
    }
  }
  return out;
}

const CHART_TYPES: Record<string, ChartType> = {
  bar: 'bar',
  hbar: 'bar',
  horizontalbar: 'bar',
  column: 'column',
  col: 'column',
  vbar: 'column',
  line: 'line',
  trend: 'line',
  pie: 'pie',
  doughnut: 'doughnut',
  donut: 'doughnut',
  ring: 'doughnut',
  area: 'area',
};

export function normalizeChartType(raw: unknown): ChartType | undefined {
  if (typeof raw !== 'string') return undefined;
  return CHART_TYPES[raw.trim().toLowerCase().replace(/[\s_-]+/g, '')];
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,，\s%]/g, '');
    if (cleaned && /^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(cleaned)) return Number(cleaned);
  }
  return undefined;
}

function chart(raw: unknown, where: string, problems: string[]): ChartSpec | undefined {
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object with type, categories and series`);
    return undefined;
  }
  const type = normalizeChartType(raw.type) ?? 'column';
  const categories = Array.isArray(raw.categories ?? raw.labels) ? ((raw.categories ?? raw.labels) as unknown[]).map((c) => str(c) ?? '').slice(0, 60) : [];
  const seriesRaw = Array.isArray(raw.series) ? raw.series : Array.isArray(raw.values) || Array.isArray(raw.data) ? [{ name: str(raw.name) ?? '', values: raw.values ?? raw.data }] : [];
  const series: ChartSpec['series'] = [];
  for (const [index, s] of seriesRaw.slice(0, 8).entries()) {
    if (!isRecord(s)) continue;
    const values = Array.isArray(s.values ?? s.data) ? ((s.values ?? s.data) as unknown[]).map((v) => num(v) ?? 0) : [];
    if (values.length === 0) continue;
    series.push({ name: str(s.name ?? s.label) ?? `Series ${index + 1}`, values });
  }
  if (series.length === 0) problems.push(`${where}.series needs at least one series with numeric values`);
  const length = Math.max(categories.length, ...series.map((s) => s.values.length));
  while (categories.length < length) categories.push(String(categories.length + 1));
  for (const s of series) while (s.values.length < categories.length) s.values.push(0);
  return optional<ChartSpec>({
    type,
    categories,
    series,
    unit: str(raw.unit),
    showValues: typeof raw.showValues === 'boolean' ? raw.showValues : undefined,
    stacked: raw.stacked === true ? true : undefined,
  });
}

function table(raw: unknown, where: string, problems: string[]): TableSpec | undefined {
  if (!isRecord(raw)) {
    if (Array.isArray(raw)) return table({ rows: raw }, where, problems);
    problems.push(`${where} must be an object with header and rows`);
    return undefined;
  }
  let header = Array.isArray(raw.header ?? raw.headers ?? raw.columns) ? ((raw.header ?? raw.headers ?? raw.columns) as unknown[]).map((h) => str(isRecord(h) ? h.header ?? h.name : h) ?? '').slice(0, 30) : undefined;
  const rowsRaw = Array.isArray(raw.rows) ? raw.rows : [];
  const rows: TableSpec['rows'] = [];
  for (const row of rowsRaw.slice(0, 400)) {
    if (Array.isArray(row)) rows.push(row.slice(0, 30).map((c) => (typeof c === 'number' && Number.isFinite(c) ? c : str(c) ?? '')));
    else if (isRecord(row)) {
      // Rows as objects: the keys become the header the first time.
      if (!header) header = Object.keys(row).slice(0, 30);
      rows.push(header.map((key) => {
        const value = row[key];
        return typeof value === 'number' && Number.isFinite(value) ? value : str(value) ?? '';
      }));
    }
  }
  if (rows.length === 0 && !header?.length) problems.push(`${where}.rows needs at least one row`);
  const widths = Array.isArray(raw.columnWidths) ? (raw.columnWidths as unknown[]).map((w) => num(w) ?? 1).map((w) => (w > 0 ? w : 1)) : undefined;
  return optional<TableSpec>({ header, rows, columnWidths: widths });
}

function column(raw: unknown, where: string, problems: string[]): SlideColumn | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' || Array.isArray(raw)) return { bullets: bullets(raw, where, problems) ?? [] };
  if (!isRecord(raw)) return undefined;
  return optional<SlideColumn>({ heading: text(raw.heading ?? raw.title), bullets: bullets(raw.bullets ?? raw.items ?? raw.points, `${where}.bullets`, problems), text: text(raw.text ?? raw.body) });
}

export function normalizeSlide(raw: unknown, index: number, problems: string[]): SlideSpec | undefined {
  const where = `slides[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  let layout = normalizeLayout(raw.layout ?? raw.type);
  // No layout named: infer it from what the slide carries.
  if (!layout) {
    if (raw.layout !== undefined || raw.type !== undefined) {
      problems.push(`${where}.layout "${String(raw.layout ?? raw.type)}" is unknown; use one of ${SLIDE_LAYOUTS.join(', ')}`);
      return undefined;
    }
    layout = raw.chart ? 'chart' : raw.table ? 'table' : raw.quote ? 'quote' : raw.image ? 'image-text' : raw.stats ? 'stats' : raw.left || raw.right ? 'two-column' : raw.bullets || raw.points || raw.text ? 'bullets' : 'title';
  }
  const slide: SlideSpec = optional<SlideSpec>({
    layout,
    title: text(raw.title ?? raw.heading),
    subtitle: text(raw.subtitle),
    notes: text(raw.notes ?? raw.speakerNotes ?? raw.speaker_notes),
  });
  switch (layout) {
    case 'title':
    case 'section':
      if (layout === 'section') slide.number = str(raw.number);
      if (!slide.title) problems.push(`${where}: a ${layout} slide needs a title`);
      break;
    case 'bullets':
      slide.bullets = bullets(raw.bullets ?? raw.points ?? raw.items, `${where}.bullets`, problems);
      slide.text = text(raw.text ?? raw.body);
      if (!slide.bullets?.length && !slide.text) problems.push(`${where}: a bullets slide needs bullets or text`);
      break;
    case 'two-column':
      slide.left = column(raw.left, `${where}.left`, problems);
      slide.right = column(raw.right, `${where}.right`, problems);
      if (!slide.left && !slide.right) problems.push(`${where}: a two-column slide needs left and right`);
      break;
    case 'image-text':
      slide.image = str(raw.image ?? raw.imagePath ?? raw.path);
      slide.imageSide = raw.imageSide === 'right' ? 'right' : raw.imageSide === 'left' ? 'left' : undefined;
      slide.bullets = bullets(raw.bullets ?? raw.points, `${where}.bullets`, problems);
      slide.text = text(raw.text ?? raw.body);
      slide.caption = text(raw.caption);
      if (!slide.image) problems.push(`${where}: an image-text slide needs image (a file path, e.g. one generate_image returned)`);
      break;
    case 'chart':
      slide.chart = chart(raw.chart, `${where}.chart`, problems);
      slide.caption = text(raw.caption ?? raw.text);
      break;
    case 'table':
      slide.table = table(raw.table ?? (raw.rows ? { header: raw.header, rows: raw.rows } : undefined), `${where}.table`, problems);
      slide.caption = text(raw.caption);
      break;
    case 'quote':
      slide.quote = text(raw.quote ?? raw.text);
      slide.author = text(raw.author ?? raw.by ?? raw.source);
      if (!slide.quote) problems.push(`${where}: a quote slide needs quote`);
      break;
    case 'stats': {
      const list = Array.isArray(raw.stats ?? raw.items) ? ((raw.stats ?? raw.items) as unknown[]) : [];
      slide.stats = list
        .filter(isRecord)
        .map((s) => optional<{ value: string; label: string; detail?: string }>({ value: str(s.value ?? s.number) ?? '', label: text(s.label ?? s.title) ?? '', detail: text(s.detail ?? s.note) }))
        .filter((s) => s.value || s.label)
        .slice(0, 4);
      if (!slide.stats.length) problems.push(`${where}: a stats slide needs stats: [{ value, label }]`);
      break;
    }
  }
  return slide;
}

export function normalizeDeckSpec(raw: unknown): DeckSpec {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new SpecError(['spec must be an object with slides']);
  const slidesRaw = Array.isArray(raw.slides) ? raw.slides : [];
  if (slidesRaw.length === 0) problems.push('spec.slides needs at least one slide');
  if (slidesRaw.length > 120) problems.push('spec.slides: at most 120 slides');
  const slides = slidesRaw.slice(0, 120).map((slide, index) => normalizeSlide(slide, index, problems)).filter((s): s is SlideSpec => Boolean(s));
  if (problems.length) throw new SpecError(problems);
  return optional<DeckSpec>({
    title: text(raw.title),
    subtitle: text(raw.subtitle),
    author: text(raw.author),
    date: text(raw.date),
    theme: themeName(raw.theme),
    footer: text(raw.footer),
    slides,
  });
}

function themeName(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

const BLOCK_ALIASES: Record<string, DocBlockType> = {
  heading: 'heading',
  h: 'heading',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  title: 'heading',
  paragraph: 'paragraph',
  p: 'paragraph',
  text: 'paragraph',
  bullets: 'bullets',
  list: 'bullets',
  ul: 'bullets',
  ol: 'bullets',
  numbered: 'bullets',
  table: 'table',
  image: 'image',
  img: 'image',
  figure: 'image',
  quote: 'quote',
  blockquote: 'quote',
  callout: 'callout',
  note: 'callout',
  tip: 'callout',
  pagebreak: 'pageBreak',
  break: 'pageBreak',
  toc: 'toc',
  contents: 'toc',
  divider: 'divider',
  hr: 'divider',
  rule: 'divider',
};

export function normalizeBlock(raw: unknown, index: number, problems: string[]): DocBlock | undefined {
  const where = `blocks[${index}]`;
  if (typeof raw === 'string') return raw.trim() ? { type: 'paragraph', text: clip(raw) } : undefined;
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  const typeKey = String(raw.type ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  const type = BLOCK_ALIASES[typeKey];
  if (!type) {
    problems.push(`${where}.type "${String(raw.type)}" is unknown; use one of ${DOC_BLOCK_TYPES.join(', ')}`);
    return undefined;
  }
  const block: DocBlock = { type };
  switch (type) {
    case 'heading': {
      block.text = text(raw.text ?? raw.title);
      const levelFromType = /^h([123])$/.exec(typeKey)?.[1];
      const level = num(raw.level) ?? (levelFromType ? Number(levelFromType) : 1);
      block.level = (Math.min(3, Math.max(1, Math.round(level))) as 1 | 2 | 3);
      if (!block.text) problems.push(`${where}: a heading needs text`);
      break;
    }
    case 'paragraph':
    case 'quote':
    case 'callout':
      block.text = text(raw.text ?? raw.content ?? raw.body);
      if (type === 'quote') block.author = text(raw.author ?? raw.source);
      if (type === 'callout') block.title = text(raw.title);
      if (!block.text) problems.push(`${where}: a ${type} needs text`);
      break;
    case 'bullets':
      block.items = bullets(raw.items ?? raw.bullets ?? raw.text, `${where}.items`, problems) ?? [];
      block.ordered = raw.ordered === true || typeKey === 'ol' || typeKey === 'numbered';
      if (!block.items.length) problems.push(`${where}: a list needs items`);
      break;
    case 'table':
      block.table = table(raw.table ?? raw, `${where}.table`, problems);
      block.caption = text(raw.caption);
      break;
    case 'image':
      block.path = str(raw.path ?? raw.image ?? raw.src);
      block.caption = text(raw.caption);
      if (num(raw.width) !== undefined) block.width = Math.min(1, Math.max(0.2, num(raw.width)! > 1 ? num(raw.width)! / 100 : num(raw.width)!));
      if (!block.path) problems.push(`${where}: an image needs path`);
      break;
    default:
      break;
  }
  return block;
}

export function normalizeDocSpec(raw: unknown): DocSpec {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new SpecError(['spec must be an object with blocks (or pass markdown)']);
  const blocksRaw = Array.isArray(raw.blocks) ? raw.blocks : [];
  if (blocksRaw.length === 0) problems.push('spec.blocks needs at least one block');
  if (blocksRaw.length > 2000) problems.push('spec.blocks: at most 2000 blocks');
  const blocks = blocksRaw.slice(0, 2000).map((block, index) => normalizeBlock(block, index, problems)).filter((b): b is DocBlock => Boolean(b));
  if (problems.length) throw new SpecError(problems);
  return optional<DocSpec>({
    title: text(raw.title),
    subtitle: text(raw.subtitle),
    author: text(raw.author),
    date: text(raw.date),
    theme: themeName(raw.theme),
    toc: raw.toc === true ? true : undefined,
    pageNumbers: raw.pageNumbers === false ? false : undefined,
    header: text(raw.header),
    pageSize: raw.pageSize === 'Letter' ? 'Letter' : undefined,
    blocks,
  });
}

const CELL_RE = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/;
export const RANGE_RE = /^(?:(?:'[^']+'|[^!]+)!)?\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?$/i;

function cell(raw: unknown): CellInput {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.length === 0 ? null : clip(raw) ?? null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (isRecord(raw)) {
    const value = raw.value;
    return optional<CellObject>({
      value: typeof value === 'number' || typeof value === 'boolean' || value === null ? value : str(value),
      formula: str(raw.formula),
      format: str(raw.format ?? raw.numFmt ?? raw.numberFormat),
      bold: raw.bold === true ? true : undefined,
      italic: raw.italic === true ? true : undefined,
      color: hexColor(raw.color),
      fill: hexColor(raw.fill ?? raw.background),
      align: raw.align === 'left' || raw.align === 'center' || raw.align === 'right' ? raw.align : undefined,
    });
  }
  return str(raw) ?? null;
}

function hexColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const hex = raw.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return hex.toUpperCase();
  if (/^[0-9a-f]{3}$/i.test(hex)) return hex.split('').map((c) => c + c).join('').toUpperCase();
  return undefined;
}

const SHEET_NAME_BAD = /[\\/?*[\]:]/g;

export function normalizeSheet(raw: unknown, index: number, problems: string[], used: Set<string>): SheetSpec | undefined {
  const where = `sheets[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  let name = (str(raw.name ?? raw.title) ?? `Sheet${index + 1}`).replace(SHEET_NAME_BAD, ' ').trim().slice(0, 31) || `Sheet${index + 1}`;
  while (used.has(name.toLowerCase())) name = `${name.slice(0, 28)} ${index + 1}`;
  used.add(name.toLowerCase());
  let columns: SheetColumn[] | undefined;
  const columnsRaw = raw.columns ?? raw.header ?? raw.headers;
  if (Array.isArray(columnsRaw)) {
    columns = columnsRaw.slice(0, 200).map((c) => {
      if (isRecord(c)) {
        return optional<SheetColumn>({
          header: str(c.header ?? c.name ?? c.title) ?? '',
          width: num(c.width),
          format: str(c.format ?? c.numFmt),
          align: c.align === 'left' || c.align === 'center' || c.align === 'right' ? c.align : undefined,
        });
      }
      return { header: str(c) ?? '' };
    });
  }
  const rowsRaw = Array.isArray(raw.rows ?? raw.data) ? ((raw.rows ?? raw.data) as unknown[]) : [];
  const rows: CellInput[][] = [];
  for (const row of rowsRaw.slice(0, 50_000)) {
    if (Array.isArray(row)) rows.push(row.slice(0, 200).map(cell));
    else if (isRecord(row)) {
      if (!columns) columns = Object.keys(row).slice(0, 200).map((key) => ({ header: key }));
      rows.push(columns.map((c) => cell(row[c.header])));
    }
  }
  if (rows.length === 0 && !columns?.length) problems.push(`${where}: a sheet needs rows (and usually columns)`);
  let freeze: SheetSpec['freeze'];
  if (typeof raw.freeze === 'string' && CELL_RE.test(raw.freeze.trim().toUpperCase())) freeze = raw.freeze.trim().toUpperCase();
  else if (isRecord(raw.freeze)) freeze = optional({ rows: num(raw.freeze.rows), columns: num(raw.freeze.columns ?? raw.freeze.cols) });
  const charts: SheetChart[] = [];
  if (Array.isArray(raw.charts)) {
    for (const [ci, c] of raw.charts.slice(0, 6).entries()) {
      if (!isRecord(c)) continue;
      const cw = `${where}.charts[${ci}]`;
      const categories = str(c.categories ?? c.labels);
      const seriesRaw = Array.isArray(c.series) ? c.series : str(c.values) ? [{ values: c.values, name: c.name }] : [];
      const series = seriesRaw.filter(isRecord).map((s) => optional<{ name?: string; values: string }>({ name: str(s.name), values: str(s.values ?? s.range) ?? '' })).filter((s) => s.values);
      if (!categories || !RANGE_RE.test(categories)) problems.push(`${cw}.categories must be an A1 range such as "A2:A13"`);
      if (series.length === 0 || series.some((s) => !RANGE_RE.test(s.values))) problems.push(`${cw}.series[].values must be A1 ranges such as "B2:B13"`);
      const position = str(c.position ?? c.anchor)?.toUpperCase();
      charts.push(optional<SheetChart>({
        type: normalizeChartType(c.type) ?? 'column',
        title: text(c.title),
        categories: categories ?? '',
        series,
        position: position && CELL_RE.test(position) ? position : undefined,
        width: num(c.width),
        height: num(c.height),
      }));
    }
  }
  const merges = Array.isArray(raw.merges) ? (raw.merges as unknown[]).map((m) => str(m)?.toUpperCase()).filter((m): m is string => Boolean(m && /^[A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/.test(m))) : undefined;
  return optional<SheetSpec>({
    name,
    title: text(raw.title !== undefined && raw.name !== undefined ? raw.title : undefined),
    columns,
    rows,
    freeze,
    autoFilter: raw.autoFilter === true || raw.filter === true ? true : undefined,
    zebra: raw.zebra === false ? false : undefined,
    merges: merges?.length ? merges : undefined,
    charts: charts.length ? charts : undefined,
  });
}

export function normalizeWorkbookSpec(raw: unknown): WorkbookSpec {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new SpecError(['spec must be an object with sheets']);
  // A single sheet given at the top level.
  const sheetsRaw = Array.isArray(raw.sheets) ? raw.sheets : raw.rows || raw.columns ? [raw] : [];
  if (sheetsRaw.length === 0) problems.push('spec.sheets needs at least one sheet');
  if (sheetsRaw.length > 50) problems.push('spec.sheets: at most 50 sheets');
  const used = new Set<string>();
  const sheets = sheetsRaw.slice(0, 50).map((sheet, index) => normalizeSheet(sheet, index, problems, used)).filter((s): s is SheetSpec => Boolean(s));
  if (problems.length) throw new SpecError(problems);
  return optional<WorkbookSpec>({ title: text(raw.title), theme: themeName(raw.theme), sheets });
}

// ── Edits ───────────────────────────────────────────────────────────────

export interface SpecEdit {
  op: 'set' | 'insert' | 'remove' | 'merge';
  path: string;
  value?: unknown;
}

/** "/slides/2/title", "slides/2/title", "slides.2.title" and "slides[2].title" → ["slides", "2", "title"]. */
export function parsePointer(path: string): string[] {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') return [];
  if (trimmed.startsWith('/')) return trimmed.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  return trimmed.replace(/\[(\d+|-)\]/g, '.$1').split(/[./]/).filter(Boolean);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Applies edits to a deep copy of `spec`; throws SpecError naming the edit that does not fit. */
export function applySpecEdits<T>(spec: T, edits: unknown): T {
  if (!Array.isArray(edits)) throw new SpecError(['edits must be a list of { op, path, value }']);
  const copy = JSON.parse(JSON.stringify(spec)) as T;
  edits.forEach((raw, index) => {
    const where = `edits[${index}]`;
    if (!isRecord(raw) || typeof raw.path !== 'string') throw new SpecError([`${where} must be { op, path, value }`]);
    const op = (typeof raw.op === 'string' ? raw.op : 'set').toLowerCase();
    if (!['set', 'replace', 'add', 'insert', 'remove', 'delete', 'merge'].includes(op)) throw new SpecError([`${where}.op must be set, insert, remove or merge`]);
    const parts = parsePointer(raw.path);
    if (parts.length === 0) throw new SpecError([`${where}.path must name a field, e.g. /slides/2/title`]);
    if (parts.some((part) => FORBIDDEN_KEYS.has(part))) throw new SpecError([`${where}.path is not allowed`]);
    let parent: unknown = copy;
    for (const part of parts.slice(0, -1)) {
      const next = Array.isArray(parent) ? parent[Number(part)] : isRecord(parent) ? parent[part] : undefined;
      if (next === undefined || next === null || typeof next !== 'object') {
        // Missing objects on the way are created for set/merge.
        if ((op === 'set' || op === 'replace' || op === 'merge' || op === 'add') && isRecord(parent) && !Array.isArray(parent)) {
          (parent as Record<string, unknown>)[part] = {};
          parent = (parent as Record<string, unknown>)[part];
          continue;
        }
        throw new SpecError([`${where}.path "${raw.path}": "${part}" does not exist`]);
      }
      parent = next;
    }
    const key = parts[parts.length - 1]!;
    if (Array.isArray(parent)) {
      const at = key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(at) || at < 0) throw new SpecError([`${where}.path "${raw.path}": "${key}" is not an index`]);
      if (op === 'insert' || op === 'add') {
        if (at > parent.length) throw new SpecError([`${where}: index ${at} is past the end (length ${parent.length})`]);
        parent.splice(at, 0, raw.value);
      } else if (op === 'remove' || op === 'delete') {
        if (at >= parent.length) throw new SpecError([`${where}: index ${at} does not exist (length ${parent.length})`]);
        parent.splice(at, 1);
      } else if (op === 'merge') {
        if (!isRecord(parent[at]) || !isRecord(raw.value)) throw new SpecError([`${where}: merge needs an object at the path and an object value`]);
        parent[at] = { ...(parent[at] as Record<string, unknown>), ...raw.value };
      } else {
        if (at > parent.length) throw new SpecError([`${where}: index ${at} does not exist (length ${parent.length})`]);
        parent[at] = raw.value;
      }
      return;
    }
    if (!isRecord(parent)) throw new SpecError([`${where}.path "${raw.path}" does not lead to an object`]);
    if (op === 'remove' || op === 'delete') delete parent[key];
    else if (op === 'merge') {
      const current = parent[key];
      if (!isRecord(current) || !isRecord(raw.value)) throw new SpecError([`${where}: merge needs an object at the path and an object value`]);
      parent[key] = { ...current, ...raw.value };
    } else parent[key] = raw.value;
  });
  return copy;
}

/** The known theme ids, for tool descriptions. */
export const THEME_LIST = THEME_IDS.join(', ');
