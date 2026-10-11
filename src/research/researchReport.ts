/**
 * research/researchReport.ts — a deep-research result as a report the owner
 * can read, keep and share.
 *
 * Every finished research run writes, into the workspace's `reports/`:
 *
 *   <date>-<slug>.md    the report: title, summary, findings with numbered
 *                       citations that link to their sources, optional
 *                       tables and simple charts, limitations, and a
 *                       numbered sources list
 *   <date>-<slug>.html  the same report as one self-contained page (reading
 *                       and print styles, charts drawn as SVG)
 *   <date>-<slug>.pdf   printed from that page with the bundled Chromium,
 *                       when one is installed (skipped otherwise, or with
 *                       ARTEMIS_REPORT_PDF=0)
 *
 * Charts: the writer may add a fenced block of language `chart` holding
 * JSON `{"type":"bar","title":"…","unit":"…","data":[{"label":"…","value":1}]}`.
 * Blocks that do not parse are dropped, so a report never shows broken JSON.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ReportSource = { index: number; url: string; title: string };

export type ReportChart = {
  type: 'bar';
  title?: string;
  unit?: string;
  data: Array<{ label: string; value: number }>;
};

export type ReportLocale = 'zh-CN' | 'en';

export type ResearchReportInput = {
  question: string;
  /** The writer's Markdown: may start with `# Title`, cites sources as [n]. */
  body: string;
  sources: ReportSource[];
  locale?: ReportLocale;
  generatedAt?: Date;
};

export type ResearchReport = {
  title: string;
  markdown: string;
  html: string;
  sources: ReportSource[];
  charts: number;
};

export type WrittenReport = {
  /** Workspace-relative paths (what the reply names). */
  markdownPath: string;
  htmlPath: string;
  pdfPath?: string;
  title: string;
};

const REPORTS_DIR = 'reports';
const MAX_CHART_BARS = 24;
const MAX_TITLE_CHARS = 80;

const words = (locale: ReportLocale | undefined) => locale === 'zh-CN'
  ? { sources: '来源', none: '（没有可用的来源）', question: '研究问题', generated: '生成于', count: (n: number) => `${n} 个来源` }
  : { sources: 'Sources', none: '(no usable sources)', question: 'Question', generated: 'Generated', count: (n: number) => `${n} source${n === 1 ? '' : 's'}` };

/** The report's language: Chinese when the question is mostly Chinese. */
export function reportLocale(question: string): ReportLocale {
  const letters = question.replace(/[\s\d\p{P}\p{S}]/gu, '');
  if (!letters) return 'en';
  const cjk = (letters.match(/[㐀-鿿]/g) ?? []).length;
  return cjk / letters.length >= 0.15 ? 'zh-CN' : 'en';
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/** File-name part from a title: letters and digits (any script), dashes between, at most 40 characters. */
export function slugify(title: string): string {
  const slug = [...title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')]
    .slice(0, 40)
    .join('')
    .replace(/-+$/g, '');
  return slug || 'report';
}

/** A safe http(s) URL, or undefined. */
function safeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Escapes text for a Markdown link title or label. */
function mdLabel(text: string): string {
  return text.replace(/[[\]\\]/g, (c) => `\\${c}`).replace(/\s+/g, ' ').trim();
}

/**
 * Turns citation markers into links to their sources: `[3]` → `[[3]](url)`,
 * `[1, 4]` / `[1][4]` → one link each. Markers inside code, existing links
 * and unknown numbers are left as written.
 */
export function linkCitations(body: string, sources: ReportSource[]): string {
  const byIndex = new Map(sources.map((source) => [source.index, source]));
  const link = (n: number) => {
    const source = byIndex.get(n);
    const url = source ? safeUrl(source.url) : undefined;
    return url ? `[[${n}]](${url} "${mdLabel(source!.title).replace(/"/g, "'")}")` : `[${n}]`;
  };
  const out: string[] = [];
  let fence: string | undefined;
  for (const line of body.split('\n')) {
    const marker = /^\s*(```+|~~~+)/.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker;
      out.push(line);
      continue;
    }
    // Inline code is kept as is; elsewhere `[n]` not followed by `(` or `]` (already a link) becomes one.
    out.push(line.split(/(`+[^`]*?`+)/).map((part, i) => (i % 2 === 1
      ? part
      : part.replace(/\[(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\](?![(\]])/g, (whole, list: string) => {
        const numbers = list.split(/[,，、]/).map((n) => Number(n.trim()));
        return numbers.every((n) => byIndex.has(n)) ? numbers.map(link).join('') : whole;
      }))).join(''));
  }
  return out.join('\n');
}

/** Parses a chart block's JSON; undefined when it is not a usable bar chart. */
export function parseChart(json: string): ReportChart | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.type !== undefined && value.type !== 'bar') return undefined;
  if (!Array.isArray(value.data)) return undefined;
  const data = value.data
    .map((entry) => {
      const item = entry as Record<string, unknown> | null;
      const label = typeof item?.label === 'string' ? oneLine(item.label, 40) : '';
      const number = typeof item?.value === 'number' ? item.value : Number(item?.value);
      return label && Number.isFinite(number) ? { label, value: number } : undefined;
    })
    .filter((entry): entry is { label: string; value: number } => Boolean(entry))
    .slice(0, MAX_CHART_BARS);
  if (data.length === 0) return undefined;
  return {
    type: 'bar',
    ...(typeof value.title === 'string' && value.title.trim() ? { title: oneLine(value.title, 80) } : {}),
    ...(typeof value.unit === 'string' && value.unit.trim() ? { unit: oneLine(value.unit, 16) } : {}),
    data,
  };
}

/** Rewrites chart blocks in their normalized form and drops the ones that do not parse. */
export function normalizeCharts(body: string): { body: string; charts: number } {
  let charts = 0;
  const normalized = body.replace(/^```chart[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm, (_whole, json: string) => {
    const chart = parseChart(json);
    if (!chart) return '';
    charts += 1;
    return `\`\`\`chart\n${JSON.stringify(chart)}\n\`\`\``;
  });
  return { body: normalized, charts };
}

/** Drops a sources section the writer added itself (the list is built from the real sources). */
function withoutSourcesSection(body: string): string {
  return body.replace(/\n#{1,3}\s*(?:sources|references|来源|参考(?:资料|文献)?)\s*\n[\s\S]*$/i, '\n').trimEnd();
}

/** The writer's title (first `# ` line), taken out of the body; else one from the question. */
function splitTitle(body: string, question: string): { title: string; rest: string } {
  const match = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(body);
  if (match && body.slice(0, match.index).trim() === '') {
    return { title: oneLine(match[1]!, MAX_TITLE_CHARS), rest: body.slice(match.index + match[0].length).trim() };
  }
  return { title: oneLine(question, MAX_TITLE_CHARS) || 'Research report', rest: body.trim() };
}

export function buildResearchReport(input: ResearchReportInput): ResearchReport {
  const locale = input.locale ?? reportLocale(input.question);
  const w = words(locale);
  const at = input.generatedAt ?? new Date();
  const { title, rest } = splitTitle(input.body, input.question);
  const sources = input.sources.filter((source) => safeUrl(source.url));
  // Without a source list of our own (an outside research service), the writer's own list stays.
  const ownList = sources.length === 0 && input.sources.length === 0;
  const { body, charts } = normalizeCharts(linkCitations(ownList ? rest : withoutSourcesSection(rest), sources));
  const date = at.toISOString().slice(0, 10);
  const sourceLines = sources.length
    ? sources.map((source) => `${source.index}. [${mdLabel(source.title) || hostOf(source.url)}](${safeUrl(source.url)})${hostOf(source.url) ? ` — ${hostOf(source.url)}` : ''}`)
    : [w.none];
  const markdown = [
    `# ${title}`,
    '',
    `> ${w.question}：${oneLine(input.question, 300)}`,
    ownList ? `> ${w.generated} ${date}` : `> ${w.generated} ${date} · ${w.count(sources.length)}`,
    '',
    body,
    '',
    ...(ownList ? [] : [`## ${w.sources}`, '', ...sourceLines, '']),
  ].join('\n').replace(/\n{3,}/g, '\n\n');
  return { title, markdown, html: renderReportHtml(markdown, { title, lang: locale }), sources, charts };
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Inline Markdown: code, links (http/https only), bold, italic. Everything else is text. */
function inline(text: string): string {
  const out: string[] = [];
  for (const [i, part] of text.split(/(`+[^`]*?`+)/).entries()) {
    if (i % 2 === 1) {
      out.push(`<code>${escapeHtml(part.replace(/^`+|`+$/g, ''))}</code>`);
      continue;
    }
    let html = '';
    let rest = part;
    const linkRe = /\[((?:\\.|\[[^\]]*\]|[^\]\\[])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/;
    for (;;) {
      const m = linkRe.exec(rest);
      if (!m) break;
      html += emphasis(escapeHtml(rest.slice(0, m.index)));
      const label = m[1]!.replace(/\\(.)/g, '$1');
      const url = safeUrl(m[2]!);
      const cite = /^\[\d+\]$/.test(label);
      html += url
        ? `<a href="${escapeHtml(url)}"${m[3] ? ` title="${escapeHtml(m[3])}"` : ''}${cite ? ' class="cite"' : ''} target="_blank" rel="noopener noreferrer">${cite ? escapeHtml(label.slice(1, -1)) : emphasis(escapeHtml(label))}</a>`
        : emphasis(escapeHtml(label));
      rest = rest.slice(m.index + m[0].length);
    }
    out.push(html + emphasis(escapeHtml(rest)));
  }
  return out.join('');
}

function emphasis(html: string): string {
  return html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
}

function tableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** A horizontal bar chart as inline SVG. */
export function chartSvg(chart: ReportChart): string {
  const max = Math.max(...chart.data.map((d) => Math.abs(d.value)), 1);
  const rowH = 28;
  const labelW = 150;
  const barW = 360;
  const height = chart.data.length * rowH + 8;
  const rows = chart.data.map((d, i) => {
    const y = i * rowH + 4;
    const w = Math.max(2, Math.round((Math.abs(d.value) / max) * barW));
    const value = `${Number.isInteger(d.value) ? d.value : d.value.toFixed(2)}${chart.unit ? ` ${chart.unit}` : ''}`;
    return `<text x="${labelW - 8}" y="${y + 17}" text-anchor="end" class="l">${escapeHtml(oneLine(d.label, 22))}</text>` +
      `<rect x="${labelW}" y="${y + 4}" width="${w}" height="18" rx="4" class="b"/>` +
      `<text x="${labelW + w + 6}" y="${y + 17}" class="v">${escapeHtml(value)}</text>`;
  }).join('');
  return `<figure class="chart">${chart.title ? `<figcaption>${escapeHtml(chart.title)}</figcaption>` : ''}` +
    `<svg viewBox="0 0 ${labelW + barW + 90} ${height}" role="img" aria-label="${escapeHtml(chart.title ?? 'chart')}">${rows}</svg></figure>`;
}

/** The report subset of Markdown as HTML: headings, paragraphs, lists, quotes, tables, code and charts. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i += 1;
      const chart = fence[2] === 'chart' ? parseChart(body.join('\n')) : undefined;
      html.push(chart ? chartSvg(chart) : `<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      const head = tableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) rows.push(tableRow(lines[i++]!));
      html.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ''));
      html.push(`<blockquote>${quote.map((q) => `<p>${inline(q)}</p>`).join('')}</blockquote>`);
      continue;
    }
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (ordered || /^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      const itemRe = ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/;
      while (i < lines.length && itemRe.test(lines[i]!)) items.push(lines[i++]!.replace(itemRe, ''));
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^(#{1,6}\s|\s*```|\s*>|\s*[-*+]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i]!)) paragraph.push(lines[i++]!);
    if (paragraph.length === 0) paragraph.push(lines[i++]!);
    html.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
  }
  return html.join('\n');
}

const REPORT_CSS = `
:root{color-scheme:light;--ink:#1d1d1f;--muted:#6e6e73;--line:#e5e5ea;--accent:#3b5bdb;--soft:#f5f5f7}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
main{max-width:760px;margin:0 auto;padding:48px 24px 64px}
h1{font-size:30px;line-height:1.3;margin:0 0 16px}
h2{font-size:21px;margin:36px 0 12px;padding-top:12px;border-top:1px solid var(--line)}
h3{font-size:17px;margin:24px 0 8px}
p,li{margin:0 0 12px}
blockquote{margin:0 0 24px;padding:10px 16px;background:var(--soft);border-radius:10px;color:var(--muted);font-size:14px}
blockquote p{margin:0}
a{color:var(--accent);text-decoration:none}
a.cite{font-size:.72em;vertical-align:super;margin:0 1px;padding:0 4px;border-radius:6px;background:#eef2ff}
a.cite::before{content:"["}a.cite::after{content:"]"}
.table{overflow-x:auto;margin:0 0 16px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--soft)}
pre{background:var(--soft);padding:12px;border-radius:10px;overflow-x:auto;font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
.chart{margin:8px 0 20px}
.chart figcaption{font-weight:600;font-size:14px;margin-bottom:6px}
.chart svg{width:100%;height:auto}
.chart .b{fill:var(--accent)}
.chart .l,.chart .v{font-size:13px;fill:var(--ink)}
.chart .v{fill:var(--muted)}
h2+ol li{font-size:14px;word-break:break-word}
@media print{main{padding:0;max-width:none}a{color:var(--ink)}a.cite{background:none}h2{break-after:avoid}figure,table{break-inside:avoid}}
@page{margin:18mm 16mm}
`;

export function renderReportHtml(markdown: string, meta: { title: string; lang: ReportLocale }): string {
  return [
    '<!doctype html>',
    `<html lang="${meta.lang === 'zh-CN' ? 'zh-CN' : 'en'}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(meta.title)}</title>`,
    `<style>${REPORT_CSS}</style>`,
    '</head>',
    `<body><main>${markdownToHtml(markdown)}</main></body>`,
    '</html>',
    '',
  ].join('\n');
}

// ── files ─────────────────────────────────────────────────────────────────────

/** Prints an HTML file to PDF with a headless Chromium; resolves false when none can be started. */
export type PdfPrinter = (htmlPath: string, pdfPath: string) => Promise<boolean>;

export const chromiumPdfPrinter: PdfPrinter = async (htmlPath, pdfPath) => {
  let browser: import('playwright').Browser | undefined;
  const timeout = new Promise<false>((resolve) => setTimeout(() => resolve(false), 60_000).unref());
  const print = (async () => {
    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const page = await browser.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 30_000 });
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } });
      return true;
    } catch {
      return false;
    }
  })();
  try {
    return await Promise.race([print, timeout]);
  } finally {
    await browser?.close().catch(() => undefined);
  }
};

/** A file name not taken yet: `<base>.md`, else `<base>-2.md`, `<base>-3.md`… (all three extensions free). */
function freeBase(dir: string, base: string): string {
  for (let n = 1; n < 1000; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!['.md', '.html', '.pdf'].some((ext) => existsSync(path.join(dir, `${candidate}${ext}`)))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export async function writeResearchReport(
  cwd: string,
  input: ResearchReportInput,
  options: { printPdf?: PdfPrinter | false } = {},
): Promise<WrittenReport & { report: ResearchReport }> {
  const report = buildResearchReport(input);
  const dir = path.join(cwd, REPORTS_DIR);
  await mkdir(dir, { recursive: true });
  const date = (input.generatedAt ?? new Date()).toISOString().slice(0, 10);
  const base = freeBase(dir, `${date}-${slugify(report.title)}`);
  const markdownPath = path.join(dir, `${base}.md`);
  const htmlPath = path.join(dir, `${base}.html`);
  await writeFile(markdownPath, report.markdown, 'utf8');
  await writeFile(htmlPath, report.html, 'utf8');
  const relative = (file: string) => path.relative(cwd, file).split(path.sep).join('/');
  let pdfPath: string | undefined;
  const printer = options.printPdf === undefined
    ? (process.env.ARTEMIS_REPORT_PDF === '0' ? false : chromiumPdfPrinter)
    : options.printPdf;
  if (printer) {
    const target = path.join(dir, `${base}.pdf`);
    if (await printer(htmlPath, target).catch(() => false)) pdfPath = relative(target);
  }
  return {
    markdownPath: relative(markdownPath),
    htmlPath: relative(htmlPath),
    ...(pdfPath ? { pdfPath } : {}),
    title: report.title,
    report,
  };
}
