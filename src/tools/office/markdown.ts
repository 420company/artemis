/**
 * tools/office/markdown.ts — Markdown as a document spec.
 *
 * Models write Markdown fluently, so create_document also takes `markdown`
 * and turns it into blocks: # headings (a lone top-level heading becomes the
 * title), paragraphs, - / 1. lists with one nested level, | pipe | tables |,
 * > quotes (> [!NOTE] becomes a callout), ![caption](path) pictures, ---
 * dividers and a [TOC] marker. Inline **bold**, *italic* and `code` stay in
 * the text and are styled by the builder.
 */

import type { Bullet, DocBlock, DocSpec } from './spec.js';

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const IMAGE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}


export function markdownToDocSpec(markdown: string, base: Partial<DocSpec> = {}): DocSpec {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: Bullet[] } | undefined;
  let quote: string[] | undefined;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ').replace(/\s+/g, ' ').trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (list?.items.length) blocks.push({ type: 'bullets', items: list.items, ordered: list.ordered });
    list = undefined;
  };
  const flushQuote = () => {
    if (quote?.length) {
      const first = quote[0] ?? '';
      const callout = /^\[!(note|tip|info|important|warning|caution)\]\s*(.*)$/i.exec(first);
      if (callout) {
        const body = [callout[2] ?? '', ...quote.slice(1)].join(' ').trim();
        blocks.push({ type: 'callout', text: body || callout[1]!, ...(callout[2] && quote.length > 1 ? { title: callout[2], text: quote.slice(1).join(' ') } : {}) });
      } else {
        const text = quote.join(' ').trim();
        const by = /^(.*?)\s*[—–-]{1,2}\s*([^—–-]{1,60})$/.exec(text);
        blocks.push(by && by[1] ? { type: 'quote', text: by[1], author: by[2]!.trim() } : { type: 'quote', text });
      }
    }
    quote = undefined;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushQuote();
      // A blank line between list items keeps the list.
      if (list && !BULLET_RE.test(lines[i + 1] ?? '')) flushList();
      continue;
    }
    if (/^```/.test(trimmed)) {
      flushAll();
      const code: string[] = [];
      for (i += 1; i < lines.length && !/^```/.test(lines[i]!.trim()); i += 1) code.push(lines[i]!);
      blocks.push({ type: 'paragraph', text: code.map((c) => (c.trim() ? `\`${c}\`` : '')).join(' ') });
      continue;
    }
    if (/^\[toc\]$/i.test(trimmed) || /^\[\[_?toc_?\]\]$/i.test(trimmed)) {
      flushAll();
      blocks.push({ type: 'toc' });
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushAll();
      blocks.push({ type: 'divider' });
      continue;
    }
    if (/^\\?(?:pagebreak|\\newpage|<div style="page-break-after: always;?"><\/div>)$/i.test(trimmed)) {
      flushAll();
      blocks.push({ type: 'pageBreak' });
      continue;
    }
    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      flushAll();
      blocks.push({ type: 'heading', level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, text: heading[2]! });
      continue;
    }
    const image = IMAGE_RE.exec(trimmed);
    if (image) {
      flushAll();
      blocks.push({ type: 'image', path: image[2]!, ...(image[1] ? { caption: image[1] } : {}) });
      continue;
    }
    if (trimmed.startsWith('|') && TABLE_SEP_RE.test(lines[i + 1] ?? '')) {
      flushAll();
      const header = splitRow(trimmed);
      const rows: Array<Array<string | number>> = [];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith('|'); i += 1) rows.push(splitRow(lines[i]!));
      i -= 1;
      blocks.push({ type: 'table', table: { header, rows } });
      continue;
    }
    if (trimmed.startsWith('>')) {
      flushParagraph();
      flushList();
      (quote ??= []).push(trimmed.replace(/^>\s?/, ''));
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      flushQuote();
      const ordered = /\d/.test(bullet[2]!);
      const nested = bullet[1]!.replace(/\t/g, '    ').length >= 2;
      if (!list) list = { ordered, items: [] };
      const text = bullet[3]!.trim();
      const last = list.items[list.items.length - 1];
      if (nested && last !== undefined) {
        const parent = typeof last === 'string' ? { text: last, sub: [] as string[] } : { text: last.text, sub: [...(last.sub ?? [])] };
        parent.sub.push(text);
        list.items[list.items.length - 1] = parent;
      } else list.items.push(text);
      continue;
    }
    // A table caption written as "表1：…" or "Table: …" right before a table is kept as a paragraph.
    if (list) flushList();
    flushQuote();
    paragraph.push(trimmed);
  }
  flushAll();

  const spec: DocSpec = { ...base, blocks } as DocSpec;
  // One top-level heading at the start is the document's title.
  const h1s = blocks.filter((b) => b.type === 'heading' && b.level === 1);
  if (!spec.title && blocks[0]?.type === 'heading' && blocks[0].level === 1 && h1s.length === 1) {
    spec.title = blocks[0].text;
    spec.blocks = blocks.slice(1).map((b) => (b.type === 'heading' && b.level && b.level > 1 ? { ...b, level: (b.level - 1) as 1 | 2 | 3 } : b));
  }
  return spec;
}
