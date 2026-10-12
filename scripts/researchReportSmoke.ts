#!/usr/bin/env tsx
/**
 * scripts/researchReportSmoke.ts — cited research reports
 * (research/researchReport.ts).
 *
 * Covers: citation markers become links to their sources (lists of numbers,
 * unknown numbers, code and existing links left alone), the writer's own
 * sources section replaced by the real list, chart blocks normalized or
 * dropped, the title taken from the report, file names (Chinese kept,
 * collisions numbered), the HTML twin (citations, tables, charts as SVG,
 * nothing unescaped, only http(s) links), and the PDF step (printed when a
 * printer works, skipped when none does or it is turned off).
 *
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/researchReportSmoke.ts
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildResearchReport,
  linkCitations,
  markdownToHtml,
  normalizeCharts,
  parseChart,
  reportLocale,
  slugify,
  writeResearchReport,
  type ReportSource,
} from '../src/research/researchReport.js'

let passed = 0
let failed = 0

function assert(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \x1b[32m✔\x1b[0m ${label}`)
    passed += 1
  } else {
    console.log(`  \x1b[31m✘\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`)
    failed += 1
  }
}

const sources: ReportSource[] = [
  { index: 1, url: 'https://example.org/a', title: 'Battery outlook 2026' },
  { index: 2, url: 'https://www.example.com/b?x=1', title: 'Market [data] "Q3"' },
  { index: 3, url: 'javascript:alert(1)', title: 'bad' },
]

console.log('\ncitations')
{
  const linked = linkCitations('Sales grew [1]. Prices fell [1, 2]. See [9] and `code [2]` and [2023](https://x.org).', sources)
  assert('a marker becomes a link to its source', linked.includes('[[1]](https://example.org/a "Battery outlook 2026")'), linked)
  assert('a list of numbers becomes one link each', linked.includes('[[1]](https://example.org/a "Battery outlook 2026")[[2]](https://www.example.com/b?x=1'), linked)
  assert('unknown numbers, inline code and existing links stay as written', linked.includes('See [9]') && linked.includes('`code [2]`') && linked.includes('[2023](https://x.org)'), linked)
  const fenced = linkCitations('```\nvalue [1]\n```\nafter [1]', sources)
  assert('code blocks are never rewritten', fenced.startsWith('```\nvalue [1]\n```') && fenced.endsWith('after [[1]](https://example.org/a "Battery outlook 2026")'), fenced)
  const paren = buildResearchReport({ question: 'q', body: 'See [1].', sources: [{ index: 1, url: 'https://en.wikipedia.org/wiki/Mercury_(planet)', title: 'Mercury (planet)' }] })
  assert('a source URL with parentheses keeps working as a link (citation, list and page)',
    paren.markdown.includes('[[1]](https://en.wikipedia.org/wiki/Mercury_%28planet%29 "Mercury (planet)")') &&
      paren.markdown.includes('1. [Mercury (planet)](https://en.wikipedia.org/wiki/Mercury_%28planet%29)') &&
      paren.html.includes('href="https://en.wikipedia.org/wiki/Mercury_%28planet%29"') && !paren.html.includes('planet%29)'),
    paren.markdown)
  const unsafe = linkCitations('x [3]', sources)
  assert('a source with an unsafe URL is not linked', unsafe === 'x [3]', unsafe)
}

console.log('\ncharts')
{
  assert('a bar chart parses; bad entries are dropped', JSON.stringify(parseChart('{"type":"bar","title":"Sales","unit":"万辆","data":[{"label":"A","value":3},{"label":"","value":2},{"label":"B","value":"4.5"}]}')) ===
    JSON.stringify({ type: 'bar', title: 'Sales', unit: '万辆', data: [{ label: 'A', value: 3 }, { label: 'B', value: 4.5 }] }))
  assert('other chart types and broken JSON are refused', parseChart('{"type":"pie","data":[{"label":"a","value":1}]}') === undefined && parseChart('{nope') === undefined && parseChart('{"data":[]}') === undefined)
  const body = 'Intro\n\n```chart\n{"data":[{"label":"A","value":1}]}\n```\n\n```chart\nnot json\n```\nEnd'
  const normalized = normalizeCharts(body)
  assert('chart blocks are normalized and broken ones dropped', normalized.charts === 1 && normalized.body.includes('```chart\n{"type":"bar","data":[{"label":"A","value":1}]}\n```') && !normalized.body.includes('not json'), normalized.body)
}

console.log('\nreport')
{
  const report = buildResearchReport({
    question: '新能源汽车电池的成本趋势如何？',
    body: [
      '# 电池成本趋势',
      '',
      '成本持续下降 [1]，价格战加剧 [2]。',
      '',
      '| 年份 | 价格 |',
      '|---|---|',
      '| 2024 | 100 |',
      '',
      '```chart',
      '{"type":"bar","title":"价格","data":[{"label":"2024","value":100},{"label":"2025","value":80}]}',
      '```',
      '',
      '## 来源',
      '[1] something the writer made up',
    ].join('\n'),
    sources,
    generatedAt: new Date('2026-10-10T08:00:00Z'),
  })
  assert('the title comes from the report', report.title === '电池成本趋势')
  assert('the report is Chinese for a Chinese question', reportLocale('新能源汽车电池的成本趋势如何？') === 'zh-CN' && reportLocale('How do battery costs trend?') === 'en')
  assert('the writer\'s own sources section is replaced by the real list',
    !report.markdown.includes('made up') && report.markdown.includes('## 来源\n\n1. [Battery outlook 2026](https://example.org/a) — example.org') &&
      report.markdown.includes('2. [Market \\[data\\] "Q3"](https://www.example.com/b?x=1) — example.com'),
    report.markdown)
  assert('unsafe sources are left out of the list and the count', !report.markdown.includes('javascript:') && report.markdown.includes('2 个来源') && report.sources.length === 2)
  assert('the header says what was asked and when', report.markdown.includes('> 研究问题：新能源汽车电池的成本趋势如何？') && report.markdown.includes('生成于 2026-10-10'))
  assert('one chart counted', report.charts === 1)
  const html = report.html
  assert('HTML: citations are superscript links to the source', /<a href="https:\/\/example\.org\/a" title="Battery outlook 2026" class="cite" target="_blank" rel="noopener noreferrer">1<\/a>/.test(html), html.slice(0, 2000))
  assert('HTML: the table and the chart are drawn', html.includes('<table>') && html.includes('<th>年份</th>') && html.includes('<svg viewBox=') && html.includes('<figcaption>价格</figcaption>'))
  assert('HTML: a self-contained page with print styles', html.startsWith('<!doctype html>') && html.includes('@media print') && html.includes('<html lang="zh-CN">') && !/<script/i.test(html))
  const evil = markdownToHtml('<img src=x onerror=alert(1)> [click](javascript:alert(1)) **bold**')
  assert('HTML: text is escaped and only http(s) links are kept', evil.includes('&lt;img src=x onerror=alert(1)&gt;') && !evil.includes('href="javascript') && evil.includes('<strong>bold</strong>'), evil)

  const outside = buildResearchReport({ question: 'q', body: 'Answer.\n\n## Sources\n- https://x.org', sources: [] })
  assert('an outside service\'s own sources list is kept when there is no list of ours', outside.markdown.includes('## Sources\n- https://x.org') && !outside.markdown.includes('no usable sources'), outside.markdown)
}

console.log('\nfiles')
{
  assert('file names keep Chinese and drop punctuation', slugify('电池成本：2026 趋势！') === '电池成本-2026-趋势' && slugify('???') === 'report' && [...slugify('x'.repeat(100))].length === 40)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'artemis-report-'))
  try {
    const input = { question: 'How do battery costs trend?', body: '# Battery costs\n\nDown [1].', sources, generatedAt: new Date('2026-10-10T08:00:00Z') }
    let printed = ''
    const first = await writeResearchReport(cwd, input, {
      printPdf: async (htmlPath, pdfPath) => {
        printed = htmlPath
        fs.writeFileSync(pdfPath, '%PDF-1.4 test')
        return true
      },
    })
    assert('the report, its page and its PDF land in reports/', first.markdownPath === 'reports/2026-10-10-battery-costs.md' && first.htmlPath === 'reports/2026-10-10-battery-costs.html' && first.pdfPath === 'reports/2026-10-10-battery-costs.pdf' && fs.existsSync(path.join(cwd, first.markdownPath)) && printed.endsWith('.html'), JSON.stringify(first))
    const second = await writeResearchReport(cwd, input, { printPdf: async () => false })
    assert('a second report of the same name is numbered; no PDF when printing fails', second.markdownPath === 'reports/2026-10-10-battery-costs-2.md' && second.pdfPath === undefined, JSON.stringify(second))
    const saved = process.env.ARTEMIS_REPORT_PDF
    process.env.ARTEMIS_REPORT_PDF = '0'
    try {
      const third = await writeResearchReport(cwd, input)
      assert('ARTEMIS_REPORT_PDF=0 skips the PDF', third.pdfPath === undefined && third.markdownPath.endsWith('-3.md'))
    } finally {
      if (saved === undefined) delete process.env.ARTEMIS_REPORT_PDF
      else process.env.ARTEMIS_REPORT_PDF = saved
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
