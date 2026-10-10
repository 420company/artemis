/**
 * scripts/evalZh/office.ts — reads .pptx / .docx / .xlsx files for the
 * `office_file` grader: a small synchronous ZIP reader (central directory +
 * raw inflate) and the text, slide count, formulas and charts of a file.
 */

import * as fs from 'node:fs'
import { inflateRawSync } from 'node:zlib'

/** Every entry of a ZIP file, by name. */
export function readZip(file: string): Map<string, Buffer> {
  const data = fs.readFileSync(file)
  const entries = new Map<string, Buffer>()
  // End of central directory: the last 0x06054b50 signature.
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = data.readUInt16LE(eocd + 10)
  let offset = data.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory')
    const method = data.readUInt16LE(offset + 10)
    const compressed = data.readUInt32LE(offset + 20)
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    const local = data.readUInt32LE(offset + 42)
    const name = data.toString('utf8', offset + 46, offset + 46 + nameLength)
    const localName = data.readUInt16LE(local + 26)
    const localExtra = data.readUInt16LE(local + 28)
    const start = local + 30 + localName + localExtra
    const raw = data.subarray(start, start + compressed)
    entries.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d))).replace(/&amp;/g, '&')

function texts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g')
  return [...xml.matchAll(re)].map((m) => decode(m[1]!))
}

export interface OfficeSummary {
  kind: 'pptx' | 'docx' | 'xlsx'
  /** Slides (pptx), sheets (xlsx) or 1 (docx). */
  parts: number
  /** Text of each slide / sheet / the document. */
  partTexts: string[]
  formulas: number
  charts: number
  /** Numbers in cells (values and cached formula results), xlsx only. */
  numbers: number[]
  /** Text outside the slides/sheets: chart titles, labels and values. */
  chartText: string
}

export function summarizeOffice(file: string): OfficeSummary {
  const zip = readZip(file)
  const text = (name: string) => zip.get(name)?.toString('utf8') ?? ''
  const chartParts = [...zip.keys()].filter((name) => /(?:^|\/)charts\/chart\d+\.xml$/.test(name))
  const charts = chartParts.length
  const chartText = chartParts.map((name) => [...texts(text(name), 'c:v'), ...texts(text(name), 'a:t')].join(' ')).join('\n')
  if (zip.has('ppt/presentation.xml')) {
    const slides = [...zip.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]))
    return { kind: 'pptx', parts: slides.length, partTexts: slides.map((s) => texts(text(s), 'a:t').join(' ')), formulas: 0, charts, numbers: [], chartText }
  }
  if (zip.has('word/document.xml')) {
    return { kind: 'docx', parts: 1, partTexts: [texts(text('word/document.xml'), 'w:t').join('')], formulas: 0, charts, numbers: [], chartText }
  }
  if (zip.has('xl/workbook.xml')) {
    const shared = [...text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1]!, 't').join(''))
    const sheets = [...zip.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
    let formulas = 0
    const numbers: number[] = []
    const partTexts = sheets.map((sheet) => {
      const xml = text(sheet)
      const out: string[] = []
      for (const cell of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? ''
        const body = cell[2] ?? ''
        if (/<f[\s>]/.test(body)) formulas++
        const value = /<v>([^<]*)<\/v>/.exec(body)?.[1]
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
        if (type === 's' && value !== undefined) out.push(shared[Number(value)] ?? '')
        else if (type === 'inlineStr') out.push(texts(body, 't').join(''))
        else if (value !== undefined) {
          out.push(decode(value))
          if (type === undefined || type === 'n') numbers.push(Number(value))
        }
      }
      return out.join(' ')
    })
    return { kind: 'xlsx', parts: sheets.length, partTexts, formulas, charts, numbers, chartText }
  }
  throw new Error('not a pptx, docx or xlsx file')
}
