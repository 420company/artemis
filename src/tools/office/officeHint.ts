/**
 * tools/office/officeHint.ts — steering for deck, document and spreadsheet
 * requests.
 *
 * When the user picks 制作幻灯片 / 生成文档 / 生成表格 in the app (intents
 * `slides`, `document`, `spreadsheet`), or a message plainly asks for one
 * ("帮我做个汇报PPT", "整理成 Excel"), the run gets a short playbook: gather
 * the facts first when the topic needs them, make pictures only where they
 * help, then write the file with the office tool and give its path.
 */

export type OfficeIntent = 'slides' | 'document' | 'spreadsheet';

const MAKE = String.raw`(?:做|制作|生成|写|出|弄|整理|准备|搞|设计|帮我做|帮我写|给我做|给我写|来一份|来个|创建|导出|转成|做成|整理成|转换成|输出|make|create|build|write|draft|prepare|generate|put together|turn (?:this|it) into|export)`;

const SLIDES_RE = new RegExp(String.raw`${MAKE}[^。！？\n]{0,24}(?:PPT|ppt|Ppt|pptx|幻灯片|演示文稿|演示稿|汇报(?:材料|稿|PPT)?|路演(?:材料|稿)?|keynote|slides?|(?:slide )?deck|presentation)|(?:PPT|ppt|幻灯片|演示文稿|slides|deck)[^。！？\n]{0,12}(?:怎么做|帮我|给我|做一下|做一份|做个|一份)`, 'i');
const DOCUMENT_RE = new RegExp(String.raw`${MAKE}[^。！？\n]{0,24}(?:Word|word|docx|文档|报告|方案书|策划书|计划书|说明书|白皮书|简历|合同|会议纪要|周报|月报|年报|调研报告|研究报告|(?:word )?document|report|proposal|resume|memo|white ?paper)`, 'i');
const SHEET_RE = new RegExp(String.raw`${MAKE}[^。！？\n]{0,24}(?:Excel|excel|xlsx|表格|电子表格|数据表|统计表|预算表|清单表|工作簿|spreadsheet|workbook|sheet)|(?:Excel|xlsx|电子表格)[^。！？\n]{0,8}(?:格式|文件)`, 'i');
/** Questions about a format, not requests for a file. */
const NOT_A_REQUEST_RE = /(?:怎么用|如何使用|是什么|什么是|区别|教程|how (?:do|to) (?:i )?use|what is)/i;
/** Code that produces reports or reads spreadsheets is a coding task, not a file request. */
const CODE_TASK_RE = /(?:脚本|代码|函数|程序|接口|组件|插件|\b(?:script|code|function|class|module|api|endpoint|parser|generator|library|component|bug|test)s?\b|\.(?:ts|js|py|go|rs|java)\b)/i;

/** What kind of office file a message asks for, if any. */
export function detectOfficeRequest(text: string): OfficeIntent | undefined {
  const t = text.trim();
  if (!t || NOT_A_REQUEST_RE.test(t) || CODE_TASK_RE.test(t)) return undefined;
  if (SLIDES_RE.test(t)) return 'slides';
  if (SHEET_RE.test(t)) return 'spreadsheet';
  if (DOCUMENT_RE.test(t)) return 'document';
  return undefined;
}

const PLAIN = 'When you talk to the user, describe what you do in plain words (「制作幻灯片」「生成文档」「生成表格」); never name tools, workflows, models or providers.';

const RESEARCH_FIRST = 'If the topic needs facts, figures or recent events, look them up first (web search, several sources) and use real numbers with their sources (speaker notes, captions or a final 参考来源 slide/section); never invent statistics.';

export function buildOfficeHint(kind: OfficeIntent, chosenInApp: boolean): string {
  const header = chosenInApp
    ? `[Run context — the user chose "${kind}" in the app; this is not part of their message]`
    : '[Run context — this request asks for an office file; this is not part of the user\'s message]';
  const body: Record<OfficeIntent, string[]> = {
    slides: [
      'Make a real PowerPoint file with create_presentation (not HTML, not Markdown).',
      RESEARCH_FIRST,
      'Plan the storyline first: cover, agenda or key takeaways, sections, one idea per slide, a closing slide; usually 8–15 slides. Mix layouts (bullets, two-column, chart, table, stats, quote, image-text) to fit the content; keep bullets short.',
      'Pictures: for image-text slides, make 1–3 pictures with generate_image (landscape) or use pictures the user gave, then pass their file paths. Skip pictures rather than use unrelated ones.',
      'Write speaker notes for the main slides. Pick a theme that fits the audience (business for reports, vivid for marketing, minimal by default).',
    ],
    document: [
      'Make a real Word file with create_document (Markdown in `markdown` is the easiest way to write it).',
      RESEARCH_FIRST,
      'Structure it with headings (##/###), short paragraphs, lists and tables where they help; add a table of contents ([TOC] or toc: true) for long documents.',
    ],
    spreadsheet: [
      'Make a real Excel file with create_spreadsheet: typed numbers (not text), formulas for totals and ratios, number formats (currency, percent, date), a header row and, when it helps, a chart.',
      'Remember the layout: header in row 1, data from row 2 (row 3 when the sheet has a title).',
    ],
  };
  return [
    header,
    ...body[kind],
    'To change a file you made earlier ("把第3页标题改成…", "加一列"), call the same tool with its path and edits instead of rebuilding it. Add pdf: true when the user wants a PDF.',
    'End with the saved file path in your reply so the file appears for the user. ' + PLAIN,
  ].join('\n');
}
