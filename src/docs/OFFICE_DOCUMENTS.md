# Office documents: slides, documents, spreadsheets, PDF

Artemis makes real, editable Office files with three first-class tools:

| Tool | Output | Users see |
|---|---|---|
| `create_presentation` | `.pptx` (16:9) | 制作幻灯片 / Making slides |
| `create_document` | `.docx` (A4 or Letter) | 生成文档 / Writing a document |
| `create_spreadsheet` | `.xlsx` | 生成表格 / Building a spreadsheet |

Each takes a structured JSON `spec` (documents also take `markdown`), writes
the file (default `outputs/<title>.<ext>`, never overwriting another file
unless `path` names it), and saves the spec beside it as a hidden sidecar:
`outputs/deck.pptx` → `outputs/.deck.pptx.json`. `pdf: true` also exports a
PDF next to the file through LibreOffice when it is installed.

Code: `src/tools/officeDocuments.ts` (the executor) and `src/tools/office/`:

| File | Role |
|---|---|
| `spec.ts` | spec types, normalization (layout/block aliases, loose input), JSON-Pointer edits |
| `themes.ts` | six original themes and their fonts |
| `pptx.ts` | deck builder (pptxgenjs) + XML touch-ups (East Asian fonts, bullet colour, one `a:pPr` per paragraph) |
| `docx.ts` | document builder (docx): styles, lists, tables, pictures, contents with page numbers |
| `markdown.ts` | Markdown → document blocks |
| `xlsx.ts`, `xlsxCharts.ts` | workbook builder (exceljs) + native charts added as DrawingML parts |
| `formula.ts` | formula evaluator for cached results |
| `pdf.ts` | LibreOffice export, PDF page text (for contents page numbers) |
| `images.ts` | PNG/JPEG/GIF headers, other formats through ImageMagick |
| `officeHint.ts` | request detection and the per-run playbook |
| `descriptions.ts` | tool descriptions, native function schemas, argument checks |

## Specs

**Presentation** — `{ title, subtitle?, author?, date?, theme?, footer?, slides: [...] }`.
Layouts: `title`, `section`, `bullets`, `two-column`, `image-text`, `chart`,
`table`, `quote`, `stats`. Every slide may carry `notes` (speaker notes).
Charts are native PowerPoint charts (column, bar, line, pie, doughnut,
area); tables are real tables; pictures (`image-text`) are cropped to fill
their half of the slide. Text sizes are fitted to their boxes; inline
`**bold**`, `*italic*`, `` `code` `` are honoured. A missing picture becomes a
placeholder and a warning, never a failed deck.

**Document** — `markdown`, or `{ title, subtitle?, author?, date?, theme?, toc?, header?, pageNumbers?, pageSize?, blocks: [...] }`.
Blocks: `heading` (1–3), `paragraph`, `bullets` (nested, ordered or not),
`table` (header row repeats across pages), `image` (with caption, numbered
图 n / Figure n), `quote`, `callout`, `pageBreak`, `toc`, `divider`. With a
table of contents and LibreOffice available, the document is rendered once
to find each heading's page, and the contents are written with page numbers
(Word refreshes the field anyway); without LibreOffice the entries are
written without numbers.

**Spreadsheet** — `{ title?, theme?, sheets: [{ name, title?, columns, rows, freeze?, autoFilter?, zebra?, merges?, charts? }] }`.
Header in row 1 (row 2 with a sheet title), data below. Cells are typed:
numbers stay numbers (`"1,200"` in a number column becomes 1200), ISO dates
in a date column become dates, `"=SUM(B2:B9)"` is a formula. Formulas get
cached results from `formula.ts` (arithmetic, references across sheets,
SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/MEDIAN/PRODUCT/ROUND*/ABS/IF/IFERROR/
AND/OR/NOT/CONCAT/SUMIF/COUNTIF/AVERAGEIF; anything else is left for
Excel/LibreOffice, which recalculate on open: `fullCalcOnLoad`). Number
formats by name (`number`, `integer`, `percent`, `currency`, `cny`, `usd`,
`eur`, `date`, `datetime`, `text`) or Excel code. Charts reference sheet
ranges, so they follow the data. Printing/PDF: landscape, fit to width,
header row repeated.

**Edits** — `{ path, edits: [{ op: 'set'|'insert'|'remove'|'merge', path: '/slides/2/title', value }] }`
applies JSON-Pointer operations (zero-based) to the saved spec and rebuilds
the file; "把第3页标题改成…" is `/slides/2/title`. The tool's output lists the
outline with the indexes to use. A file the tool did not make (no sidecar)
cannot be edited this way; the tool says so.

## Themes

Six original palettes and font pairings (no third-party templates):
`minimal` 简约, `dark` 深色, `business` 商务 (navy + gold), `vivid` 活力
(violet + coral), `nature` 清新 (green on warm paper), `warm` 雅致 (serif
headings, terracotta). Aliases in Chinese and English resolve (`商务`,
`corporate`, …); unknown names fall back to `minimal`.

Fonts: Latin text names Arial (Liberation Sans on Linux, metric-compatible)
or Georgia for the `warm` headings; East Asian text names **Noto Sans CJK
SC** / **Noto Serif CJK SC**, which the hosted toolbox installs
(`fonts-noto-cjk`). pptxgenjs writes the Latin face into the East Asian slot
too; the builder rewrites `<a:ea>` to the CJK face and sets the theme's
font scheme. Where Noto CJK is missing, Office substitutes its own CJK font.

## Routing

- Intents `slides`, `document`, `spreadsheet` (`artemis execute --intent`,
  also `ppt`, `excel`, `word` …) run the direct workflow with a playbook:
  research first when the topic needs facts (cite sources, never invent
  figures), plan the storyline, make 1–3 pictures with the image tool for
  image slides, write speaker notes, give the file path.
- Without an intent, `detectOfficeRequest` adds the same playbook to plain
  requests ("帮我做一份汇报PPT", "整理成 Excel", "写一份调研报告") but not to
  coding tasks ("写一个生成报告的脚本") or questions ("PPT 是什么").
- The CLI's tool projection offers the office tools (and image generation)
  for office wording; the hosted profile always has them.

## Tests and evals

- `npm run test:office` (`scripts/officeDocsSmoke.ts`, part of `test:all`):
  generates every format, re-opens the ZIP and checks slide count, CJK text
  and fonts, notes, charts, pictures, formulas with cached values, frozen
  panes, filters, edits, error messages, intents, routing, labels, and PDF
  export plus contents page numbers when LibreOffice is installed.
- `evals/zh/tasks/office-*.json` (category `office`) with the `office_file`
  grader (`scripts/evalZh/office.ts` re-opens the files).

## Dependencies and licenses

| Package | Version | License | Use |
|---|---|---|---|
| pptxgenjs | 4.0.1 | MIT | .pptx |
| docx | 9.7.2 | MIT | .docx |
| exceljs | 4.4.0 | MIT | .xlsx |
| jszip (via the above) | 3.x | MIT (dual MIT/GPLv3, used under MIT) | post-processing |

`package.json` overrides pin `image-size` 2.0.4 under pptxgenjs (the
vulnerable 1.x is not used by it at runtime) and `uuid` 11.1.1 under
exceljs, so the new packages add no `npm audit` findings.

Optional system tools: LibreOffice (MPL-2.0) for PDF export, poppler's
`pdftotext` (GPL, run as a separate program) for contents page numbers,
ImageMagick for WebP/BMP pictures. Fonts: Noto Sans/Serif CJK (SIL OFL 1.1),
Liberation (SIL OFL 1.1).
