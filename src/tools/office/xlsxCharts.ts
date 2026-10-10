/**
 * tools/office/xlsxCharts.ts — native Excel charts for generated workbooks.
 *
 * The workbook library writes cells and styles but no charts, so charts are
 * added to the finished file: a chart part (DrawingML) per chart whose
 * series point at the sheet's cells (they update when the numbers change),
 * with cached values so viewers that do not calculate still draw them, a
 * drawing part per sheet that places the charts, and the relationships and
 * content types that tie them in.
 */

import JSZip from 'jszip';
import type { ChartType } from './spec.js';

export interface PlacedChart {
  type: ChartType;
  title?: string;
  /** Quoted sheet-qualified absolute ranges, e.g. 'Sales'!$A$2:$A$13. */
  categoriesRef: string;
  categories: string[];
  series: Array<{ name: string; ref: string; values: Array<number | null> }>;
  colors: string[];
  textColor: string;
  gridColor: string;
  font: string;
  /** Zero-based anchor cell and size in cells. */
  col: number;
  row: number;
  width: number;
  height: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 'Sheet 1'!$A$2:$A$9 from a sheet name and an A1 range. */
export function absoluteRef(sheet: string, range: string): string {
  const abs = range.replace(/\$/g, '').replace(/([A-Z]+)(\d+)/gi, (_, c: string, r: string) => `$${c.toUpperCase()}$${r}`);
  return `'${sheet.replace(/'/g, "''")}'!${abs}`;
}

function textProps(size: number, color: string, font: string, bold = false): string {
  return `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size * 100}" b="${bold ? 1 : 0}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${esc(font)}"/><a:ea typeface="Noto Sans CJK SC"/></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;
}

function strCache(values: string[]): string {
  return `<c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
}

function numCache(values: Array<number | null>): string {
  return `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache>`;
}

function seriesXml(chart: PlacedChart, index: number): string {
  const s = chart.series[index]!;
  const color = chart.colors[index % chart.colors.length]!;
  const round = chart.type === 'pie' || chart.type === 'doughnut';
  const line = chart.type === 'line';
  const fill = line
    ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>`
    : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`;
  const points = round
    ? chart.categories.map((_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${chart.colors[i % chart.colors.length]}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join('')
    : '';
  const labels = round
    ? `<c:dLbls>${textProps(10, 'FFFFFF', chart.font, true)}<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="1"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>`
    : '';
  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>${round ? `<c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr>` : fill}${points}${labels}<c:cat><c:strRef><c:f>${esc(chart.categoriesRef)}</c:f>${strCache(chart.categories)}</c:strRef></c:cat><c:val><c:numRef><c:f>${esc(s.ref)}</c:f>${numCache(s.values)}</c:numRef></c:val>${line ? '<c:smooth val="0"/>' : ''}</c:ser>`;
}

function axes(chart: PlacedChart, horizontal: boolean): string {
  const tp = textProps(10, chart.textColor, chart.font);
  const grid = `<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${chart.gridColor}"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>`;
  const lineNone = '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>';
  const axisLine = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${chart.gridColor}"/></a:solidFill></a:ln></c:spPr>`;
  return `<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${axisLine}${tp}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`
    + `<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/>${grid}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${lineNone}${tp}<c:crossAx val="5001"/><c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`;
}

export function chartXml(chart: PlacedChart): string {
  const series = chart.series.map((_, i) => seriesXml(chart, i)).join('');
  let plot: string;
  switch (chart.type) {
    case 'pie':
      plot = `<c:pieChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case 'doughnut':
      plot = `<c:doughnutChart><c:varyColors val="1"/>${series}<c:firstSliceAng val="0"/><c:holeSize val="58"/></c:doughnutChart>`;
      break;
    case 'line':
      plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="5001"/><c:axId val="5002"/></c:lineChart>${axes(chart, false)}`;
      break;
    case 'area':
      plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:axId val="5001"/><c:axId val="5002"/></c:areaChart>${axes(chart, false)}`;
      break;
    default: {
      const horizontal = chart.type === 'bar';
      plot = `<c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="70"/><c:overlap val="-10"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>${axes(chart, horizontal)}`;
    }
  }
  const round = chart.type === 'pie' || chart.type === 'doughnut';
  const legend = round || chart.series.length > 1
    ? `<c:legend><c:legendPos val="${round ? 'r' : 'b'}"/><c:overlay val="0"/>${textProps(10, chart.textColor, chart.font)}</c:legend>`
    : '';
  const title = chart.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"><a:solidFill><a:srgbClr val="${chart.textColor}"/></a:solidFill><a:latin typeface="${esc(chart.font)}"/><a:ea typeface="Noto Sans CJK SC"/></a:defRPr></a:pPr><a:r><a:rPr lang="${/[㐀-鿿]/.test(chart.title) ? 'zh-CN' : 'en-US'}" sz="1300" b="1"><a:solidFill><a:srgbClr val="${chart.textColor}"/></a:solidFill><a:latin typeface="${esc(chart.font)}"/><a:ea typeface="Noto Sans CJK SC"/></a:rPr><a:t>${esc(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>`;
}

function drawingXml(charts: Array<{ chart: PlacedChart; rid: string; id: number }>): string {
  const anchors = charts.map(({ chart, rid, id }) => `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${chart.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${chart.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${chart.col + chart.width}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${chart.row + chart.height}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id + 1}" name="Chart ${id}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}</xdr:wsDr>`;
}

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_DRAWING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing';
const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';

function nextRid(rels: string): string {
  const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  return `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
}

/**
 * Adds charts to a written workbook. `bySheet` maps a 1-based sheet
 * position (the order sheets were added) to its charts.
 */
export async function addChartsToWorkbook(buffer: Buffer, bySheet: Map<number, PlacedChart[]>): Promise<Buffer> {
  if (bySheet.size === 0) return buffer;
  const zip = await JSZip.loadAsync(buffer);
  const workbookRels = await zip.file('xl/_rels/workbook.xml.rels')!.async('string');
  const workbook = await zip.file('xl/workbook.xml')!.async('string');
  // Sheet position → worksheet part, through the workbook's relationships.
  const sheetRids = [...workbook.matchAll(/<sheet\b[^>]*r:id="([^"]+)"/g)].map((m) => m[1]!);
  const targetOf = (rid: string) => new RegExp(`<Relationship[^>]*Id="${rid}"[^>]*Target="([^"]+)"`).exec(workbookRels)?.[1] ?? new RegExp(`<Relationship[^>]*Target="([^"]+)"[^>]*Id="${rid}"`).exec(workbookRels)?.[1];
  let types = await zip.file('[Content_Types].xml')!.async('string');
  let chartNo = Object.keys(zip.files).filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n)).length;
  let drawingNo = Object.keys(zip.files).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n)).length;
  let shapeId = 1;
  for (const [position, charts] of bySheet) {
    const rid = sheetRids[position - 1];
    const target = rid ? targetOf(rid) : undefined;
    if (!target || charts.length === 0) continue;
    const sheetPath = `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`;
    const sheetFile = zip.file(sheetPath);
    if (!sheetFile) continue;
    drawingNo += 1;
    const drawingPath = `xl/drawings/drawing${drawingNo}.xml`;
    const placed: Array<{ chart: PlacedChart; rid: string; id: number }> = [];
    let drawingRels = '';
    charts.forEach((chart, i) => {
      chartNo += 1;
      zip.file(`xl/charts/chart${chartNo}.xml`, chartXml(chart));
      types = types.replace('</Types>', `<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
      drawingRels += `<Relationship Id="rId${i + 1}" Type="${REL_CHART}" Target="../charts/chart${chartNo}.xml"/>`;
      placed.push({ chart, rid: `rId${i + 1}`, id: shapeId++ });
    });
    zip.file(drawingPath, drawingXml(placed));
    zip.file(`xl/drawings/_rels/drawing${drawingNo}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${drawingRels}</Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);

    const relsPath = sheetPath.replace(/worksheets\/([^/]+)$/, 'worksheets/_rels/$1.rels');
    let rels = zip.file(relsPath) ? await zip.file(relsPath)!.async('string') : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}"></Relationships>`;
    const drawingRid = nextRid(rels);
    rels = rels.replace('</Relationships>', `<Relationship Id="${drawingRid}" Type="${REL_DRAWING}" Target="../drawings/drawing${drawingNo}.xml"/></Relationships>`);
    zip.file(relsPath, rels);

    let sheet = await sheetFile.async('string');
    if (!/xmlns:r=/.test(sheet.slice(0, 600))) sheet = sheet.replace(/<worksheet\b/, '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    const drawingTag = `<drawing r:id="${drawingRid}"/>`;
    const before = /<(?:legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/.exec(sheet);
    sheet = before ? `${sheet.slice(0, before.index)}${drawingTag}${sheet.slice(before.index)}` : sheet.replace('</worksheet>', `${drawingTag}</worksheet>`);
    zip.file(sheetPath, sheet);
  }
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
