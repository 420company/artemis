/**
 * tools/office/xlsx.ts — builds a .xlsx from a WorkbookSpec.
 *
 * Typed cells (numbers stay numbers, ISO dates in a date column become
 * dates), live formulas with cached results, number formats, column widths,
 * a styled header row, striped rows, frozen panes, filters, merged cells and
 * native charts. The workbook asks Excel/LibreOffice for a full
 * recalculation when opened, so the formulas are authoritative.
 *
 * Layout of a sheet: an optional title in row 1, then the header row (from
 * `columns`), then `rows`. `sheetLayouts` reports where each sheet's data
 * ended up, so the tool can tell the model the exact ranges.
 */

import ExcelJS from 'exceljs';
import type { CellInput, CellObject, SheetChart, SheetSpec, WorkbookSpec } from './spec.js';
import { FormulaError, FormulaEvaluator, columnIndex, columnLetters, type Scalar } from './formula.js';
import { absoluteRef, addChartsToWorkbook, type PlacedChart } from './xlsxCharts.js';
import { hasCjk, textWidthEm } from './text.js';
import { resolveTheme, tint, type OfficeTheme } from './themes.js';

export interface SheetLayout {
  name: string;
  headerRow?: number;
  firstDataRow: number;
  lastRow: number;
  columns: number;
  /** "A2:D13": the header and data. */
  range: string;
}

export interface BuiltWorkbook {
  buffer: Buffer;
  sheets: SheetLayout[];
  formulas: number;
  charts: number;
  warnings: string[];
}

interface GridCell {
  value: Scalar;
  formula?: string;
  style?: CellObject;
  format?: string;
}

const NAMED_FORMATS: Record<string, string> = {
  number: '#,##0.00',
  decimal: '#,##0.00',
  integer: '#,##0',
  int: '#,##0',
  thousands: '#,##0',
  percent: '0.0%',
  percentage: '0.0%',
  pct: '0.0%',
  date: 'yyyy-mm-dd',
  datetime: 'yyyy-mm-dd hh:mm',
  time: 'hh:mm',
  text: '@',
  usd: '"$"#,##0.00',
  dollar: '"$"#,##0.00',
  cny: '"¥"#,##0.00',
  rmb: '"¥"#,##0.00',
  yuan: '"¥"#,##0.00',
  eur: '"€"#,##0.00',
  euro: '"€"#,##0.00',
  gbp: '"£"#,##0.00',
  jpy: '"¥"#,##0',
};

export function resolveNumberFormat(format: string | undefined, cjk: boolean): string | undefined {
  if (!format) return undefined;
  const key = format.trim().toLowerCase();
  if (key === 'currency' || key === 'money') return cjk ? '"¥"#,##0.00' : '"$"#,##0.00';
  if (NAMED_FORMATS[key]) return NAMED_FORMATS[key];
  if (/^(?:0|#|@|y|m|d|h|s|"|\[|¥|\$|€|£)/i.test(format.trim()) || /[0#]/.test(format)) return format.trim();
  return undefined;
}

const isDateFormat = (fmt: string | undefined) => Boolean(fmt && /(^|[^"])[ymd]/i.test(fmt.replace(/"[^"]*"/g, '')) && !/[0#]/.test(fmt));
const isNumericFormat = (fmt: string | undefined) => Boolean(fmt && /[0#]/.test(fmt));
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/** Excel serial date for an ISO date string (1900 system). */
function excelSerial(text: string): number | undefined {
  const m = ISO_DATE.exec(text.trim());
  if (!m) return undefined;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (!Number.isFinite(utc)) return undefined;
  return utc / 86_400_000 + 25569;
}

function parseNumberText(text: string): number | undefined {
  const t = text.trim();
  const pct = /^([-+]?[\d,]*\.?\d+)\s*%$/.exec(t);
  if (pct) return Number(pct[1]!.replace(/,/g, '')) / 100;
  const plain = /^[-+]?[¥$€£]?\s*[\d,]*\.?\d+$/.exec(t);
  if (plain) {
    const n = Number(t.replace(/[,¥$€£\s]/g, ''));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toGridCell(input: CellInput, columnFormat: string | undefined, cjk: boolean): GridCell {
  const obj: CellObject = input !== null && typeof input === 'object' ? input : { value: input };
  const format = resolveNumberFormat(obj.format, cjk) ?? columnFormat;
  let formula = obj.formula;
  let value: Scalar = obj.value ?? null;
  if (!formula && typeof value === 'string' && value.startsWith('=') && value.length > 1) {
    formula = value;
    value = null;
  }
  if (formula) formula = formula.trim().replace(/^=/, '');
  if (!formula && typeof value === 'string') {
    if (isDateFormat(format)) value = excelSerial(value) ?? value;
    else if (isNumericFormat(format)) value = parseNumberText(value) ?? value;
  }
  const style = obj === input ? obj : undefined;
  return { value, ...(formula ? { formula } : {}), ...(style ? { style } : {}), ...(format ? { format } : {}) };
}

function displayLength(cell: GridCell): number {
  if (cell.value === null || cell.value === undefined) return 0;
  if (typeof cell.value === 'number') {
    if (isDateFormat(cell.format)) return 10;
    const abs = Math.abs(cell.value);
    const digits = abs >= 1 ? Math.floor(Math.log10(abs)) + 1 : 1;
    const decimals = cell.format?.includes('.') ? (cell.format.split('.')[1]?.match(/0/g)?.length ?? 2) : abs % 1 ? 2 : 0;
    return digits + Math.floor((digits - 1) / 3) + (decimals ? decimals + 1 : 0) + (cell.format?.includes('%') ? 1 : 0) + 1;
  }
  return textWidthEm(String(cell.value)) / 0.55;
}

interface SheetModel {
  spec: SheetSpec;
  grid: Map<string, GridCell>;
  layout: SheetLayout;
}

const key = (c: number, r: number) => `${c},${r}`;

function modelSheet(spec: SheetSpec, cjk: boolean): SheetModel {
  const grid = new Map<string, GridCell>();
  const columnCount = Math.max(spec.columns?.length ?? 0, ...spec.rows.map((r) => r.length), 1);
  let row = 1;
  if (spec.title) row += 1;
  let headerRow: number | undefined;
  if (spec.columns?.length) {
    headerRow = row;
    spec.columns.forEach((column, i) => grid.set(key(i + 1, row), { value: column.header }));
    row += 1;
  }
  const firstDataRow = row;
  for (const cells of spec.rows) {
    cells.forEach((input, i) => {
      const cell = toGridCell(input, resolveNumberFormat(spec.columns?.[i]?.format, cjk), cjk);
      if (cell.value !== null || cell.formula || cell.style) grid.set(key(i + 1, row), cell);
    });
    row += 1;
  }
  const lastRow = Math.max(firstDataRow - 1, row - 1);
  const top = headerRow ?? firstDataRow;
  return {
    spec,
    grid,
    layout: {
      name: spec.name,
      ...(headerRow ? { headerRow } : {}),
      firstDataRow,
      lastRow,
      columns: columnCount,
      range: `A${top}:${columnLetters(columnCount)}${Math.max(top, lastRow)}`,
    },
  };
}

/** Computes every formula's value (cached in the file). */
function evaluateFormulas(models: SheetModel[]): Map<string, Scalar | FormulaError | undefined> {
  const byName = new Map(models.map((m) => [m.spec.name.toLowerCase(), m]));
  const results = new Map<string, Scalar | FormulaError | undefined>();
  const active = new Set<string>();
  const evaluator: FormulaEvaluator = new FormulaEvaluator({
    hasSheet: (sheet) => byName.has(sheet.toLowerCase()),
    cell: (sheet, c, r) => {
      const model = byName.get(sheet.toLowerCase());
      const cell = model?.grid.get(key(c, r));
      if (!cell) return null;
      if (!cell.formula) return cell.value;
      const id = `${model!.spec.name}!${c},${r}`;
      if (results.has(id)) return results.get(id);
      if (active.has(id)) return undefined; // a cycle: no cached value
      active.add(id);
      const value = evaluator.evaluate(cell.formula, model!.spec.name);
      active.delete(id);
      results.set(id, value);
      return value;
    },
  });
  for (const model of models) {
    for (const [k, cell] of model.grid) {
      if (!cell.formula) continue;
      const [c, r] = k.split(',').map(Number) as [number, number];
      const id = `${model.spec.name}!${c},${r}`;
      if (!results.has(id)) {
        active.add(id);
        results.set(id, evaluator.evaluate(cell.formula, model.spec.name));
        active.delete(id);
      }
    }
  }
  return results;
}

function argb(hex: string): { argb: string } {
  return { argb: `FF${hex}` };
}

function parseRange(range: string): { sheet?: string; c1: number; r1: number; c2: number; r2: number } | undefined {
  const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i.exec(range.trim());
  if (!m) return undefined;
  const sheet = m[1]?.replace(/''/g, "'") ?? m[2];
  const c1 = columnIndex(m[3]!);
  const r1 = Number(m[4]);
  return { ...(sheet ? { sheet } : {}), c1, r1, c2: m[5] ? columnIndex(m[5]) : c1, r2: m[6] ? Number(m[6]) : r1 };
}

function placeChart(chart: SheetChart, model: SheetModel, models: SheetModel[], results: Map<string, Scalar | FormulaError | undefined>, theme: OfficeTheme, index: number, warnings: string[]): PlacedChart | undefined {
  const where = `sheet "${model.spec.name}" chart ${index + 1}`;
  const cats = parseRange(chart.categories);
  if (!cats) {
    warnings.push(`${where}: categories range "${chart.categories}" is not valid; chart left out`);
    return undefined;
  }
  const sheetOf = (name?: string) => (name ? models.find((m) => m.spec.name.toLowerCase() === name.toLowerCase()) : model);
  const read = (m: SheetModel, c: number, r: number): Scalar | FormulaError | undefined => {
    const cell = m.grid.get(key(c, r));
    if (!cell) return null;
    return cell.formula ? results.get(`${m.spec.name}!${c},${r}`) : cell.value;
  };
  const cells = (range: NonNullable<ReturnType<typeof parseRange>>) => {
    const m = sheetOf(range.sheet);
    if (!m) return undefined;
    const out: Array<Scalar | FormulaError | undefined> = [];
    for (let r = range.r1; r <= range.r2; r += 1) for (let c = range.c1; c <= range.c2; c += 1) out.push(read(m, c, r));
    return { m, out };
  };
  const catCells = cells(cats);
  if (!catCells) {
    warnings.push(`${where}: sheet in "${chart.categories}" not found; chart left out`);
    return undefined;
  }
  const series: PlacedChart['series'] = [];
  for (const [si, s] of chart.series.entries()) {
    const range = parseRange(s.values);
    const values = range ? cells(range) : undefined;
    if (!range || !values) {
      warnings.push(`${where}: values range "${s.values}" is not valid; series left out`);
      continue;
    }
    let name = s.name;
    if (!name && values.m.layout.headerRow && range.r1 === values.m.layout.headerRow + 1) {
      const header = values.m.grid.get(key(range.c1, values.m.layout.headerRow))?.value;
      if (header !== null && header !== undefined) name = String(header);
    }
    series.push({
      name: name ?? `Series ${si + 1}`,
      ref: absoluteRef(values.m.spec.name, s.values.replace(/^.*!/, '')),
      values: values.out.map((v) => (typeof v === 'number' ? v : null)),
    });
  }
  if (series.length === 0) return undefined;
  const width = Math.min(30, Math.max(4, Math.round(chart.width ?? 8)));
  const height = Math.min(60, Math.max(8, Math.round(chart.height ?? 16)));
  const anchor = chart.position ? parseRange(chart.position) : undefined;
  return {
    type: chart.type,
    ...(chart.title ? { title: chart.title } : {}),
    categoriesRef: absoluteRef(catCells.m.spec.name, chart.categories.replace(/^.*!/, '')),
    categories: catCells.out.map((v) => (v === null || v === undefined || v instanceof FormulaError ? '' : String(v))),
    series,
    colors: theme.colors.chart,
    textColor: '404650',
    gridColor: 'E3E5EA',
    font: theme.fonts.bodyLatin,
    col: anchor ? anchor.c1 - 1 : model.layout.columns + 1,
    row: anchor ? anchor.r1 - 1 : (model.layout.headerRow ?? model.layout.firstDataRow) - 1 + index * (height + 2),
    width,
    height,
  };
}

export async function buildWorkbook(spec: WorkbookSpec): Promise<BuiltWorkbook> {
  const theme = resolveTheme(spec.theme);
  const c = theme.colors;
  const warnings: string[] = [];
  const cjk = hasCjk(JSON.stringify(spec).slice(0, 20_000));
  const models = spec.sheets.map((sheet) => modelSheet(sheet, cjk));
  const results = evaluateFormulas(models);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Artemis';
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  const fontName = theme.fonts.bodyLatin;
  const headerFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: argb(c.accent) };
  const stripeFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: argb(theme.dark ? 'F4F5F7' : tint(c.surface, 0.35)) };
  const thin = { style: 'thin' as const, color: argb(theme.dark ? 'D0D4DC' : c.line) };
  const chartsBySheet = new Map<number, PlacedChart[]>();
  let formulas = 0;

  models.forEach((model, sheetIndex) => {
    const { spec: sheet, grid, layout } = model;
    const ws = workbook.addWorksheet(sheet.name, {
      properties: { defaultRowHeight: 20 },
      // Printing / PDF: landscape, as wide as the page, header row repeated.
      pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } },
    });
    if (layout.headerRow) ws.pageSetup.printTitlesRow = `${layout.headerRow}:${layout.headerRow}`;
    // Column widths: given, or from the content (CJK counts double).
    for (let col = 1; col <= layout.columns; col += 1) {
      const given = sheet.columns?.[col - 1]?.width;
      let width = given;
      if (!width) {
        let longest = 0;
        for (let row = layout.headerRow ?? layout.firstDataRow; row <= Math.min(layout.lastRow, layout.firstDataRow + 300); row += 1) {
          const cell = grid.get(key(col, row));
          if (cell) longest = Math.max(longest, cell.formula ? 12 : displayLength(cell) + (row === layout.headerRow ? 2 : 0));
        }
        width = Math.min(60, Math.max(9, Math.ceil(longest + 2)));
      }
      ws.getColumn(col).width = width;
    }
    if (sheet.title) {
      const title = ws.getCell(1, 1);
      title.value = sheet.title;
      title.font = { name: fontName, size: 15, bold: true, color: argb('1D2129') };
      title.alignment = { vertical: 'middle' };
      ws.getRow(1).height = 30;
      if (layout.columns > 1) ws.mergeCells(1, 1, 1, layout.columns);
    }
    for (const [k, cell] of grid) {
      const [col, row] = k.split(',').map(Number) as [number, number];
      const target = ws.getCell(row, col);
      if (cell.formula) {
        formulas += 1;
        const result = results.get(`${sheet.name}!${col},${row}`);
        const cached = result instanceof FormulaError ? { error: result.code } : result === null ? undefined : result;
        target.value = (cached === undefined ? { formula: cell.formula } : { formula: cell.formula, result: cached }) as ExcelJS.CellValue;
      } else if (cell.value !== null) {
        // Dates are written as serial numbers with a date format: no time zones involved.
        target.value = cell.value;
      }
      const header = row === layout.headerRow;
      const stripe = !header && sheet.zebra !== false && layout.headerRow !== undefined && (row - layout.firstDataRow) % 2 === 1;
      target.font = {
        name: fontName,
        size: 11,
        bold: header || cell.style?.bold === true,
        italic: cell.style?.italic === true,
        color: argb(header ? c.onAccent : cell.style?.color ?? '1D2129'),
      };
      if (header) target.fill = headerFill;
      else if (cell.style?.fill) target.fill = { type: 'pattern', pattern: 'solid', fgColor: argb(cell.style.fill) };
      else if (stripe) target.fill = stripeFill;
      if (cell.format) target.numFmt = cell.format;
      const align = cell.style?.align ?? sheet.columns?.[col - 1]?.align;
      target.alignment = { vertical: 'middle', ...(header ? { horizontal: 'center', wrapText: true } : align ? { horizontal: align } : {}) };
      if (layout.headerRow !== undefined && row >= layout.headerRow) target.border = { bottom: thin };
    }
    // Empty cells inside the table still get the stripe and the rule.
    if (layout.headerRow !== undefined) {
      for (let row = layout.firstDataRow; row <= layout.lastRow; row += 1) {
        for (let col = 1; col <= layout.columns; col += 1) {
          if (grid.has(key(col, row))) continue;
          const target = ws.getCell(row, col);
          target.border = { bottom: thin };
          if (sheet.zebra !== false && (row - layout.firstDataRow) % 2 === 1) target.fill = stripeFill;
        }
      }
      ws.getRow(layout.headerRow).height = 24;
    }
    for (const merge of sheet.merges ?? []) {
      try {
        ws.mergeCells(merge);
      } catch {
        warnings.push(`sheet "${sheet.name}": merge ${merge} overlaps another merge; skipped`);
      }
    }
    // Frozen panes: given, or the rows down to the header.
    let xSplit = 0;
    let ySplit = layout.headerRow ?? 0;
    if (typeof sheet.freeze === 'string') {
      const at = parseRange(sheet.freeze);
      if (at) {
        xSplit = at.c1 - 1;
        ySplit = at.r1 - 1;
      }
    } else if (sheet.freeze) {
      xSplit = Math.max(0, Math.round(sheet.freeze.columns ?? 0));
      ySplit = Math.max(0, Math.round(sheet.freeze.rows ?? ySplit));
    }
    ws.views = xSplit || ySplit ? [{ state: 'frozen', xSplit, ySplit, topLeftCell: `${columnLetters(xSplit + 1)}${ySplit + 1}`, showGridLines: true }] : [{ showGridLines: true }];
    if (sheet.autoFilter && layout.headerRow !== undefined) {
      ws.autoFilter = `A${layout.headerRow}:${columnLetters(layout.columns)}${Math.max(layout.headerRow, layout.lastRow)}`;
    }
    const placed = (sheet.charts ?? []).map((chart, i) => placeChart(chart, model, models, results, theme, i, warnings)).filter((p): p is PlacedChart => Boolean(p));
    if (placed.length) chartsBySheet.set(sheetIndex + 1, placed);
  });

  const written = Buffer.from(await workbook.xlsx.writeBuffer());
  const buffer = await addChartsToWorkbook(written, chartsBySheet);
  return {
    buffer,
    sheets: models.map((m) => m.layout),
    formulas,
    charts: [...chartsBySheet.values()].reduce((n, list) => n + list.length, 0),
    warnings,
  };
}

/** One line per sheet: "Sales: header row 1, data A2:D13, 2 charts". */
export function workbookOutline(spec: WorkbookSpec, layouts: SheetLayout[]): string[] {
  return layouts.map((layout, i) => {
    const sheet = spec.sheets[i]!;
    const data = layout.lastRow >= layout.firstDataRow ? `data rows ${layout.firstDataRow}-${layout.lastRow}` : 'no data rows';
    const columns = sheet.columns?.length ? ` columns ${sheet.columns.map((col, ci) => `${columnLetters(ci + 1)}=${col.header}`).slice(0, 12).join(', ')}` : '';
    return `[${i}] ${layout.name}: ${layout.headerRow ? `header row ${layout.headerRow}, ` : ''}${data} (${layout.range});${columns}${sheet.charts?.length ? `; ${sheet.charts.length} chart(s)` : ''}`;
  });
}
