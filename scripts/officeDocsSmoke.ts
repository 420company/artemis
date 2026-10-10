// Office documents: create_presentation / create_document / create_spreadsheet
// write real .pptx / .docx / .xlsx files. Each format is generated, re-opened
// and checked (ZIP structure, slide count, CJK text and fonts, formulas with
// cached values, charts), edits rebuild from the saved spec, bad specs come
// back as fixable messages, and the intents / routing hint / user-facing
// labels are in place. PDF export runs when LibreOffice is installed.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { executeOfficeDocument, sidecarPath } from '../src/tools/officeDocuments.js';
import { applySpecEdits, normalizeDeckSpec, parsePointer, SpecError } from '../src/tools/office/spec.js';
import { FormulaError, FormulaEvaluator, type Scalar } from '../src/tools/office/formula.js';
import { markdownToDocSpec } from '../src/tools/office/markdown.js';
import { buildOfficeHint, detectOfficeRequest } from '../src/tools/office/officeHint.js';
import { findSoffice, locateHeadings } from '../src/tools/office/pdf.js';
import { imageInfo } from '../src/tools/office/images.js';
import { fitFontSize, parseInline, slugify } from '../src/tools/office/text.js';
import { OFFICE_THEMES, THEME_IDS, resolveTheme } from '../src/tools/office/themes.js';
import { validateOfficeAction } from '../src/tools/office/descriptions.js';
import { normalizeHeadlessIntent, planHeadlessWorkflow } from '../src/services/headlessWorkflow.js';
import { getToolDefinition, validateToolAction } from '../src/tools/registry.js';
import { buildActionParametersSchema } from '../src/core/providerNativeTools.js';
import { getAllowedActionTypesForProfile } from '../src/core/agentProfiles.js';
import { describeToolForUser, describeToolOutputForUser, findInternalNames } from '../src/utils/internalNames.js';
import { SessionStore } from '../src/storage/sessions.js';
import type { AgentAction } from '../src/core/types.js';
import type { ToolExecutionContext } from '../src/tools/types.js';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✔ ${name}`);
}

const workspace = mkdtempSync(path.join(os.tmpdir(), 'artemis-office-smoke-'));
const context: ToolExecutionContext = { cwd: workspace, permissionMode: 'full-access' } as ToolExecutionContext;

/** A small solid PNG. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7a)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(path.join(workspace, 'photo.png'), png(64, 40));

async function zipOf(file: string): Promise<JSZip> {
  return JSZip.loadAsync(readFileSync(file));
}
async function partText(zip: JSZip, name: string): Promise<string> {
  const entry = zip.file(name);
  assert.ok(entry, `missing part ${name}`);
  return entry.async('string');
}
const run = (action: Record<string, unknown>) => executeOfficeDocument(action as Extract<AgentAction, { type: 'create_presentation' }>, context);

const DECK = {
  title: '2026 年第三季度经营汇报',
  subtitle: '增长与计划',
  author: '运营部',
  theme: 'business',
  slides: [
    { layout: 'title', title: '2026 年第三季度经营汇报', subtitle: '增长与计划' },
    { layout: 'bullets', title: '本季度要点', bullets: ['营收同比增长 **38%**', { text: '新客户 1,240 家', sub: ['华东区贡献 46%'] }], notes: '先讲结论。' },
    { layout: 'section', title: '市场与客户' },
    { layout: 'chart', title: '季度营收', chart: { type: 'column', categories: ['Q1', 'Q2', 'Q3'], series: [{ name: '营收', values: [910, 1050, 1260] }] } },
    { layout: 'two-column', title: '优势与挑战', left: { heading: '优势', bullets: ['口碑好'] }, right: { heading: '挑战', bullets: ['获客成本上升'] } },
    { layout: 'image-text', title: '发布会', image: 'photo.png', bullets: ['到场 800 人'] },
    { layout: 'table', title: '区域表现', table: { header: ['区域', '营收'], rows: [['华东', 520], ['华南', 310]] } },
    { layout: 'quote', quote: '最好的产品让人感觉不到它的存在。', author: '客户' },
    { layout: 'stats', title: '关键指标', stats: [{ value: '38%', label: '增长' }, { value: '55', label: 'NPS' }] },
  ],
};

await test('themes: six original themes, aliases resolve, unknown falls back to minimal', () => {
  assert.equal(THEME_IDS.length, 6);
  for (const theme of Object.values(OFFICE_THEMES)) {
    for (const color of [theme.colors.bg, theme.colors.text, theme.colors.accent, ...theme.colors.chart]) assert.match(color, /^[0-9A-F]{6}$/);
    assert.match(theme.fonts.bodyEa, /Noto (Sans|Serif) CJK SC/);
  }
  assert.equal(resolveTheme('商务').id, 'business');
  assert.equal(resolveTheme('DARK').id, 'dark');
  assert.equal(resolveTheme('nope').id, 'minimal');
});

await test('presentation: a real .pptx with every layout, CJK text, East Asian font, notes, chart, picture', async () => {
  const result = await run({ type: 'create_presentation', path: 'decks/汇报.pptx', spec: DECK });
  assert.equal(result.ok, true, result.output);
  const file = path.join(workspace, 'decks', '汇报.pptx');
  assert.ok(existsSync(file));
  assert.match(result.output, /Slides: 9/);
  assert.ok(existsSync(sidecarPath(file)), 'spec saved beside the file');
  const zip = await zipOf(file);
  assert.ok(zip.file('[Content_Types].xml') && zip.file('ppt/presentation.xml'));
  const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  assert.equal(slides.length, 9);
  const first = await partText(zip, 'ppt/slides/slide1.xml');
  assert.match(first, /2026 年第三季度经营汇报/);
  assert.match(first, /<a:ea typeface="Noto Sans CJK SC"/, 'CJK runs name the East Asian font');
  assert.match(first, /lang="zh-CN"/);
  const second = await partText(zip, 'ppt/slides/slide2.xml');
  assert.match(second, /<a:buChar/);
  assert.equal(second.match(/<a:p>(?:(?!<\/a:p>)[\s\S])*?<a:pPr[\s\S]*?<a:pPr/g)?.filter((p) => !p.includes('</a:p>')).length ?? 0, 0, 'one paragraph-properties element per paragraph');
  assert.ok(Object.keys(zip.files).some((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name)), 'native chart');
  assert.ok(Object.keys(zip.files).some((name) => /^ppt\/media\/image/.test(name)), 'embedded picture');
  assert.match(Object.keys(zip.files).filter((name) => name.startsWith('ppt/notesSlides/')).join(','), /notesSlide/);
  const notes = await Promise.all(Object.keys(zip.files).filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name)).map((name) => partText(zip, name)));
  assert.ok(notes.some((xml) => xml.includes('先讲结论')), 'speaker notes');
  const theme = await partText(zip, 'ppt/theme/theme1.xml');
  assert.match(theme, /<a:minorFont>\s*<a:latin typeface="Arial"/);
  assert.match(result.output, /\/slides\/n-1/);
  assert.deepEqual(findInternalNames(result.output.replace(/create_\w+/g, '')).map((h) => h.name), []);
});

await test('presentation: edits change the saved spec and rebuild ("把第3页标题改成…")', async () => {
  const result = await run({ type: 'create_presentation', path: 'decks/汇报.pptx', edits: [
    { op: 'set', path: '/slides/2/title', value: '市场机会' },
    { op: 'insert', path: '/slides/-', value: { layout: 'title', title: '谢谢' } },
    { op: 'remove', path: '/slides/7' },
  ] });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /updated/);
  const zip = await zipOf(path.join(workspace, 'decks', '汇报.pptx'));
  assert.match(await partText(zip, 'ppt/slides/slide3.xml'), /市场机会/);
  assert.match(await partText(zip, 'ppt/slides/slide9.xml'), /谢谢/);
  assert.match(await partText(zip, 'ppt/slides/slide1.xml'), /经营汇报/, 'other slides unchanged');
  const saved = JSON.parse(readFileSync(sidecarPath(path.join(workspace, 'decks', '汇报.pptx')), 'utf8'));
  assert.equal(saved.spec.slides.length, 9);
  assert.equal(saved.spec.slides[2].title, '市场机会');
});

await test('presentation: missing picture becomes a placeholder and a warning, not a failure', async () => {
  const result = await run({ type: 'create_presentation', path: 'decks/missing.pptx', spec: { slides: [{ layout: 'image-text', title: 'x', image: 'nope.png', bullets: ['a'] }] } });
  assert.equal(result.ok, true);
  assert.match(result.output, /Warning: slide 1: image nope\.png: file not found/);
});

await test('presentation: bad specs come back as fixable messages', async () => {
  const unknown = await run({ type: 'create_presentation', spec: { slides: [{ layout: 'hologram', title: 'x' }] } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.output, /layout "hologram" is unknown/);
  const empty = await run({ type: 'create_presentation', spec: { slides: [] } });
  assert.match(empty.output, /at least one slide/);
  const noFile = await run({ type: 'create_presentation', path: 'decks/none.pptx', edits: [{ op: 'set', path: '/title', value: 'x' }] });
  assert.equal(noFile.ok, false);
  assert.match(noFile.output, /does not exist/);
  const badEdit = await run({ type: 'create_presentation', path: 'decks/汇报.pptx', edits: [{ op: 'set', path: '/slides/99/title', value: 'x' }] });
  assert.equal(badEdit.ok, false);
  assert.match(badEdit.output, /does not exist/);
  assert.deepEqual(validateOfficeAction({ type: 'create_presentation' }), ['spec is required (or path + edits).']);
  assert.deepEqual(validateToolAction({ type: 'create_presentation', spec: DECK } as AgentAction), []);
});

await test('presentation: default path is outputs/<title>.pptx and never overwrites', async () => {
  const a = await run({ type: 'create_presentation', spec: { title: '新品发布', slides: [{ layout: 'title', title: '新品发布' }] } });
  const b = await run({ type: 'create_presentation', spec: { title: '新品发布', slides: [{ layout: 'title', title: '新品发布' }] } });
  assert.match(a.output, /outputs\/新品发布\.pptx/);
  assert.match(b.output, /outputs\/新品发布-2\.pptx/);
});

await test('document: markdown → .docx with headings, lists, table, picture, contents, CJK fonts', async () => {
  const markdown = [
    '# 市场调研报告',
    '',
    '[TOC]',
    '',
    '## 一、背景',
    '',
    '本报告基于**公开数据**。',
    '',
    '- 华东占比最高',
    '  - 上海领先',
    '- 华南增长最快',
    '',
    '## 二、规模',
    '',
    '| 年份 | 销量 |',
    '| --- | --- |',
    '| 2024 | 1,280 |',
    '',
    '![示意图](photo.png)',
    '',
    '> [!NOTE] 结论',
    '> 竞争转向智能化。',
  ].join('\n');
  const result = await run({ type: 'create_document', path: 'docs/report', markdown, spec: { author: '研究部', theme: 'warm' } });
  assert.equal(result.ok, true, result.output);
  const file = path.join(workspace, 'docs', 'report.docx');
  const zip = await zipOf(file);
  const doc = await partText(zip, 'word/document.xml');
  assert.match(doc, /市场调研报告/);
  assert.match(doc, /w:val="Heading1"/);
  assert.match(doc, /<w:tbl>/);
  assert.match(doc, /<w:numPr>/);
  assert.match(doc, /instrText[^>]*>TOC \\/, 'table of contents field');
  assert.match(doc, /<wp:inline|<wp:anchor/, 'picture');
  assert.match(doc, /2024/);
  assert.doesNotMatch(doc, /2,024/, 'years are not grouped');
  const styles = await partText(zip, 'word/styles.xml');
  assert.match(styles, /w:eastAsia="Noto (Sans|Serif) CJK SC"/);
  assert.match(result.output, /Headings/);
});

await test('document: spec blocks, edits, unknown block type', async () => {
  const ok = await run({ type: 'create_document', path: 'docs/memo.docx', spec: { title: '会议纪要', blocks: [{ type: 'h2', text: '议题' }, { type: 'p', text: '讨论预算。' }, { type: 'ol', items: ['一', '二'] }, { type: 'quote', text: '少即是多', author: '某人' }, { type: 'divider' }, { type: 'pageBreak' }] } });
  assert.equal(ok.ok, true, ok.output);
  const edited = await run({ type: 'create_document', path: 'docs/memo.docx', edits: [{ op: 'set', path: '/blocks/1/text', value: '讨论第四季度预算。' }] });
  assert.equal(edited.ok, true, edited.output);
  assert.match(await partText(await zipOf(path.join(workspace, 'docs', 'memo.docx')), 'word/document.xml'), /讨论第四季度预算/);
  const bad = await run({ type: 'create_document', spec: { blocks: [{ type: 'video', text: 'x' }] } });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /type "video" is unknown/);
});

await test('spreadsheet: typed cells, formulas with cached values, formats, freeze, filter, chart', async () => {
  const result = await run({ type: 'create_spreadsheet', path: 'sheets/销售.xlsx', spec: {
    theme: 'nature',
    sheets: [
      {
        name: '月度',
        columns: [{ header: '月份' }, { header: '金额', format: 'cny' }, { header: '占比', format: 'percent' }, { header: '日期', format: 'date' }],
        rows: [['一月', 100, '=B2/B5', '2026-01-31'], ['二月', '1,200', '=B3/B5', '2026-02-28'], ['三月', 300, '=B4/B5', '2026-03-31'], [{ value: '合计', bold: true }, '=SUM(B2:B4)', '=SUM(C2:C4)', null]],
        autoFilter: true,
        charts: [{ type: 'column', title: '月度金额', categories: 'A2:A4', series: [{ values: 'B2:B4' }] }],
      },
      { name: 'Summary', columns: ['项', '值'], rows: [['最大', "=MAX('月度'!B2:B4)"], ['平均', '=ROUND(AVERAGE(月度!B2:B4),1)']] },
    ],
  } });
  assert.equal(result.ok, true, result.output);
  assert.match(result.output, /formulas: 7, charts: 1/);
  assert.match(result.output, /header row 1, data rows 2-5/);
  const zip = await zipOf(path.join(workspace, 'sheets', '销售.xlsx'));
  const sheet1 = await partText(zip, 'xl/worksheets/sheet1.xml');
  assert.match(sheet1, /<f>SUM\(B2:B4\)<\/f><v>1600<\/v>/, 'formula with its cached result');
  assert.match(sheet1, /<c r="B3"[^>]*><v>1200<\/v>/, '"1,200" in a number column is a number');
  assert.match(sheet1, /<c r="D2"[^>]*><v>46053<\/v>/, 'ISO date in a date column is a serial date');
  assert.match(sheet1, /state="frozen"/);
  assert.match(sheet1, /<autoFilter ref="A1:D5"/);
  assert.match(sheet1, /<drawing r:id="rId\d+"\/>/);
  const sheet2 = await partText(zip, 'xl/worksheets/sheet2.xml');
  assert.match(sheet2, /<v>1200<\/v>/);
  assert.match(sheet2, /<v>533\.3<\/v>/);
  const types = await partText(zip, '[Content_Types].xml');
  assert.match(types, /\/xl\/charts\/chart1\.xml/);
  assert.match(types, /\/xl\/drawings\/drawing1\.xml/);
  const chart = await partText(zip, 'xl/charts/chart1.xml');
  assert.match(chart, /<c:f>'月度'!\$B\$2:\$B\$4<\/c:f>/);
  assert.match(chart, /<c:v>金额<\/c:v>/, 'series named after its header');
  const workbook = await partText(zip, 'xl/workbook.xml');
  assert.match(workbook, /fullCalcOnLoad="1"/);
  const styles = await partText(zip, 'xl/styles.xml');
  assert.match(styles, /formatCode="&quot;¥&quot;#,##0\.00"/);
  const strings = await partText(zip, 'xl/sharedStrings.xml');
  assert.match(strings, /合计/);
});

await test('spreadsheet: edits by pointer, bad chart range', async () => {
  const edited = await run({ type: 'create_spreadsheet', path: 'sheets/销售.xlsx', edits: [{ op: 'set', path: '/sheets/0/rows/0/1', value: 500 }] });
  assert.equal(edited.ok, true, edited.output);
  assert.match(await partText(await zipOf(path.join(workspace, 'sheets', '销售.xlsx')), 'xl/worksheets/sheet1.xml'), /<f>SUM\(B2:B4\)<\/f><v>2000<\/v>/);
  const bad = await run({ type: 'create_spreadsheet', spec: { sheets: [{ name: 'a', rows: [[1]], charts: [{ type: 'pie', categories: 'nonsense', series: [{ values: 'B1:B2' }] }] }] } });
  assert.equal(bad.ok, false);
  assert.match(bad.output, /A1 range/);
});

await test('formulas: arithmetic, ranges, functions, errors, unsupported → no value', () => {
  const cells: Record<string, Scalar> = { 'S!1,1': 2, 'S!2,1': 3, 'S!1,2': 'x', 'S!2,2': 10 };
  const sheets = { hasSheet: (s: string) => s === 'S', cell: (s: string, c: number, r: number) => cells[`${s}!${c},${r}`] ?? null };
  const f = new FormulaEvaluator(sheets);
  assert.equal(f.evaluate('=A1*B1+B2^2/5', 'S'), 26);
  assert.equal(f.evaluate('SUM(A1:B2)', 'S'), 15);
  assert.equal(f.evaluate('COUNTA(A1:B2)', 'S'), 4);
  assert.equal(f.evaluate('IF(B2>5,"大","小")', 'S'), '大');
  assert.equal(f.evaluate('A1&"-"&A2', 'S'), '2-x');
  assert.equal(f.evaluate('ROUND(10/3,2)', 'S'), 3.33);
  assert.equal(f.evaluate('50%*B2', 'S'), 5);
  assert.equal(f.evaluate('SUMIF(A1:B1,">2")', 'S'), 3);
  assert.ok(f.evaluate('A1/0', 'S') instanceof FormulaError);
  assert.equal(f.evaluate('IFERROR(A1/0,0)', 'S'), 0);
  assert.equal(f.evaluate('VLOOKUP(1,A1:B2,2,0)', 'S'), undefined);
  assert.ok(f.evaluate('Other!A1', 'S') instanceof FormulaError);
});

await test('spec helpers: pointers, edits, aliases, inline emphasis, fitting, slugs, image headers', () => {
  assert.deepEqual(parsePointer('/slides/2/title'), ['slides', '2', 'title']);
  assert.deepEqual(parsePointer('slides[2].title'), ['slides', '2', 'title']);
  assert.throws(() => applySpecEdits({ a: 1 }, [{ op: 'set', path: '/__proto__/x', value: 1 }]), SpecError);
  assert.deepEqual(applySpecEdits({ a: { b: 1 } }, [{ op: 'merge', path: '/a', value: { c: 2 } }]), { a: { b: 1, c: 2 } });
  const deck = normalizeDeckSpec({ slides: [{ layout: 'Two Column', title: 't', left: ['a'], right: 'b' }, { type: 'kpi', title: 'k', stats: [{ value: '1', label: 'x' }] }, { title: 'inferred', bullets: '- a\n- b' }] });
  assert.deepEqual(deck.slides.map((s) => s.layout), ['two-column', 'stats', 'bullets']);
  assert.deepEqual(deck.slides[2]!.bullets, ['a', 'b']);
  assert.deepEqual(parseInline('a **b** *c* `d`'), [{ text: 'a ' }, { text: 'b', bold: true }, { text: ' ' }, { text: 'c', italic: true }, { text: ' ' }, { text: 'd', code: true }]);
  assert.ok(fitFontSize([{ text: '短' }], 10, 5, 24, 12) === 24);
  assert.ok(fitFontSize(Array.from({ length: 30 }, () => ({ text: '很长的一句话'.repeat(10) })), 10, 4, 24, 12) < 24);
  assert.equal(slugify('Q3 汇报 / 最终版', 'x'), 'Q3-汇报-最终版');
  assert.equal(slugify('///', 'fallback'), 'fallback');
  assert.deepEqual(imageInfo(png(64, 40)), { type: 'png', width: 64, height: 40 });
  const md = markdownToDocSpec('# 标题\n\n## 一\n\n正文\n\n1. a\n2. b\n\n---\n');
  assert.equal(md.title, '标题');
  assert.deepEqual(md.blocks.map((b) => b.type), ['heading', 'paragraph', 'bullets', 'divider']);
  assert.equal(md.blocks[0]!.level, 1);
  assert.deepEqual(locateHeadings(['目录 一 二', '一 正文', '正文 二'], ['一', '二'], 1), [2, 3]);
});

await test('routing: office requests are detected, coding and questions are not', () => {
  assert.equal(detectOfficeRequest('帮我做一个关于新能源汽车的PPT'), 'slides');
  assert.equal(detectOfficeRequest('把这些数据整理成Excel表格'), 'spreadsheet');
  assert.equal(detectOfficeRequest('写一份调研报告，要 Word 版'), 'document');
  assert.equal(detectOfficeRequest('make a slide deck about our roadmap'), 'slides');
  assert.equal(detectOfficeRequest('PPT 是什么'), undefined);
  assert.equal(detectOfficeRequest('写一个生成报告的 Python 脚本'), undefined);
  assert.equal(detectOfficeRequest('今天天气怎么样'), undefined);
  for (const kind of ['slides', 'document', 'spreadsheet'] as const) {
    const hint = buildOfficeHint(kind, true);
    assert.match(hint, /create_(presentation|document|spreadsheet)/);
    assert.match(hint, /file path/);
  }
  assert.match(buildOfficeHint('slides', false), /generate_image/);
});

await test('intents: slides / document / spreadsheet run with the office playbook', async () => {
  assert.equal(normalizeHeadlessIntent('ppt'), 'slides');
  assert.equal(normalizeHeadlessIntent('Excel'), 'spreadsheet');
  assert.equal(normalizeHeadlessIntent('document'), 'document');
  const store = new SessionStore(workspace);
  for (const [intent, tool] of [['slides', 'create_presentation'], ['document', 'create_document'], ['spreadsheet', 'create_spreadsheet']] as const) {
    const session = store.createSession({ title: 'office' });
    const plan = await planHeadlessWorkflow({
      session,
      prompt: '季度总结',
      cwd: workspace,
      attachmentCount: 0,
      inCodeRepo: false,
      autoRoute: true,
      intent,
      getClassifier: async () => undefined,
      hasVideoProvider: async () => false,
    });
    assert.equal(plan.kind, 'run');
    if (plan.kind === 'run') {
      assert.equal(plan.workflow, 'direct');
      assert.match(plan.hint, new RegExp(tool));
    }
  }
  const session = store.createSession({ title: 'office' });
  const auto = await planHeadlessWorkflow({ session, prompt: '帮我做一份年终总结PPT，10页左右', cwd: workspace, attachmentCount: 0, inCodeRepo: false, autoRoute: true, getClassifier: async () => undefined, hasVideoProvider: async () => false });
  assert.equal(auto.kind, 'run');
  if (auto.kind === 'run') assert.match(auto.hint, /create_presentation/);
});

await test('registration: tools, schemas, hosted profile, user-facing labels', () => {
  for (const type of ['create_presentation', 'create_document', 'create_spreadsheet'] as const) {
    const def = getToolDefinition(type);
    assert.ok(def?.execute, `${type} registered with an executor`);
    assert.equal(def?.permissionCategory, 'write');
    const schema = buildActionParametersSchema(type) as { properties: Record<string, unknown> };
    assert.ok(schema.properties.spec && schema.properties.edits && schema.properties.path);
    assert.doesNotMatch(JSON.stringify(schema), /"anyOf"|"type":\[/, 'portable schema');
    assert.ok(getAllowedActionTypesForProfile('main').includes(type), `${type} in the hosted profile`);
    for (const locale of ['zh-CN', 'en']) {
      for (const label of [describeToolForUser(type, locale), describeToolOutputForUser(type, locale)]) {
        assert.deepEqual(findInternalNames(label), []);
        assert.notEqual(label, locale === 'en' ? 'Working' : '正在处理');
      }
    }
  }
  assert.equal(describeToolForUser('create_presentation', 'zh-CN'), '制作幻灯片');
  assert.equal(describeToolForUser('create_document', 'zh-CN'), '生成文档');
  assert.equal(describeToolForUser('create_spreadsheet', 'zh-CN'), '生成表格');
  assert.ok(findInternalNames('调用 create_presentation').length > 0, 'the code name is on the denylist');
});

const soffice = await findSoffice();
if (soffice) {
  await test('pdf: export next to the file (LibreOffice installed)', async () => {
    const result = await run({ type: 'create_presentation', path: 'decks/pdf.pptx', spec: { slides: [{ layout: 'title', title: '导出测试' }] }, pdf: true });
    assert.equal(result.ok, true, result.output);
    const pdf = path.join(workspace, 'decks', 'pdf.pdf');
    assert.ok(existsSync(pdf), result.output);
    assert.equal(readFileSync(pdf).subarray(0, 4).toString('latin1'), '%PDF');
    const doc = await run({ type: 'create_document', path: 'docs/toc.docx', markdown: '# 报告\n\n[TOC]\n\n## 第一章\n\n正文。\n\n## 第二章\n\n正文。', pdf: true });
    assert.equal(doc.ok, true, doc.output);
    const xml = await partText(await zipOf(path.join(workspace, 'docs', 'toc.docx')), 'word/document.xml');
    assert.match(xml, /第一章[\s\S]*?<w:t[^>]*>\d+<\/w:t>/, 'contents entries got page numbers');
  });
} else {
  console.log('  - pdf: skipped (LibreOffice not installed)');
}

console.log(`\nofficeDocsSmoke: ${passed} passed`);
