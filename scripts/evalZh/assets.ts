/**
 * scripts/evalZh/assets.ts — inputs the eval draws itself: small PNG images
 * with known content (no external or copyrighted assets) and a long
 * synthetic Chinese conversation for the long-context task.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import type { GeneratedAsset, SeedHistory } from './types.js'

// ── PNG ────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

type Rgb = [number, number, number]

class Canvas {
  readonly pixels: Buffer
  constructor(readonly width: number, readonly height: number, background: Rgb) {
    this.pixels = Buffer.alloc(width * height * 3)
    for (let i = 0; i < width * height; i++) this.pixels.set(background, i * 3)
  }

  set(x: number, y: number, color: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    this.pixels.set(color, (y * this.width + x) * 3)
  }

  rect(x0: number, y0: number, w: number, h: number, color: Rgb): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, color)
  }

  circle(cx: number, cy: number, r: number, color: Rgb): void {
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.set(x, y, color)
    }
  }

  /** Upward triangle with its apex at (cx, top). */
  triangle(cx: number, top: number, size: number, color: Rgb): void {
    for (let row = 0; row < size; row++) {
      const half = Math.round((row / size) * (size / 2))
      for (let x = cx - half; x <= cx + half; x++) this.set(x, top + row, color)
    }
  }

  text(x: number, y: number, text: string, scale: number, color: Rgb): void {
    let cursor = x
    for (const ch of text.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT['?']!
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < row.length; gx++) {
          if (row[gx] === '#') this.rect(cursor + gx * scale, y + gy * scale, scale, scale, color)
        }
      })
      cursor += 6 * scale
    }
  }

  png(): Buffer {
    const header = Buffer.alloc(13)
    header.writeUInt32BE(this.width, 0)
    header.writeUInt32BE(this.height, 4)
    header[8] = 8 // bit depth
    header[9] = 2 // RGB
    const stride = this.width * 3
    const raw = Buffer.alloc((stride + 1) * this.height)
    for (let y = 0; y < this.height; y++) {
      raw[y * (stride + 1)] = 0
      this.pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ])
  }
}

/** 5x7 bitmap glyphs (public-domain style pixel font, drawn here). */
const FONT: Record<string, string[]> = {
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['.###.', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
}

/** Red circle, blue square, green triangle, left to right, on white. */
export function drawShapesPng(): Buffer {
  const canvas = new Canvas(480, 200, [255, 255, 255])
  canvas.circle(85, 100, 55, [220, 30, 30])
  canvas.rect(185, 45, 110, 110, [30, 70, 220])
  canvas.triangle(395, 42, 116, [30, 160, 60])
  return canvas.png()
}

export const INVOICE_FACTS = { invoiceNo: 'INV-2026-0917', date: '2026-09-17', total: 128.5 }

/** A plain receipt: invoice number, date and total in large dark letters. */
export function drawInvoicePng(): Buffer {
  const canvas = new Canvas(640, 300, [250, 250, 245])
  canvas.rect(0, 0, 640, 8, [60, 60, 60])
  canvas.text(30, 40, 'INVOICE', 6, [20, 20, 20])
  canvas.text(30, 120, `NO: ${INVOICE_FACTS.invoiceNo}`, 4, [20, 20, 20])
  canvas.text(30, 170, `DATE: ${INVOICE_FACTS.date}`, 4, [20, 20, 20])
  canvas.text(30, 220, 'TOTAL: 128.50', 4, [20, 20, 20])
  return canvas.png()
}

export function writeGeneratedAssets(workspace: string, assets: GeneratedAsset[] = []): void {
  for (const asset of assets) {
    const target = path.join(workspace, asset.path)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, asset.kind === 'shapes-png' ? drawShapesPng() : drawInvoicePng())
  }
}

// ── long synthetic conversation ──────────────────────────────────────────────

const FILLER_TOPICS = [
  ['周末带孩子去哪里玩比较好', '可以考虑科技馆、植物园或者郊野公园，提前看天气，带好水和零食。'],
  ['家里的绿萝叶子发黄怎么办', '多半是浇水太勤或光照不足，见干见湿再浇，放在散射光处，剪掉黄叶。'],
  ['怎么跟房东商量降房租', '先了解周边同户型租金，准备好按时交租的记录，提出续签更长时间换取优惠。'],
  ['晚饭想做个简单的家常菜', '番茄炒蛋、青椒土豆丝、蒜蓉西兰花都很快，二十分钟内能搞定。'],
  ['最近睡眠不太好有什么建议', '固定作息，睡前一小时不看手机，下午少喝咖啡，卧室保持安静和偏暗。'],
  ['想学一点理财入门知识', '先建立应急金，再了解货币基金和指数基金，避免借钱投资和追涨杀跌。'],
  ['公司年会要准备一个节目', '小品或合唱比较容易排练，控制在五分钟以内，提前彩排两次。'],
  ['手机内存总是不够用', '清理聊天记录里的大文件和视频，把照片备份到云端，卸载不用的应用。'],
  ['怎么给父母挑一台血压计', '选上臂式电子血压计，袖带尺寸合适，屏幕字大，有记忆功能更方便。'],
  ['下个月想去成都出差顺便玩一天', '可以去宽窄巷子和人民公园喝茶，晚上吃火锅，注意提前订酒店。'],
  ['孩子写作业总是拖拉', '把任务拆小，定好时间段，完成后及时肯定，减少旁边的干扰。'],
  ['办公室同事之间怎么分工更合理', '按每个人擅长的部分分配，用共享表格记录进度，每周简单同步一次。'],
]

const FILLER_PAD =
  '另外顺便说一下，这几天事情比较多，我想把问题问得详细一点，方便你给出更具体的建议。' +
  '如果有需要注意的地方也请一并提醒我，我会按照你说的一步一步去做，有不清楚的地方再来问你。'

/**
 * A long, realistic-looking chat: the facts first, then filler exchanges on
 * everyday topics. About 450 CJK characters per exchange.
 */
export function buildLongChat(seed: SeedHistory): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: seed.factsMessage },
    { role: 'assistant', content: seed.factsReply },
  ]
  for (let i = 0; i < seed.fillerTurns; i++) {
    const [question, answer] = FILLER_TOPICS[i % FILLER_TOPICS.length]!
    const round = Math.floor(i / FILLER_TOPICS.length) + 1
    messages.push({
      role: 'user',
      content: `第${i + 1}个问题：${question}？${FILLER_PAD}${FILLER_PAD}（第${round}轮补充）`,
    })
    messages.push({
      role: 'assistant',
      content: `关于“${question}”：${answer}${answer}具体来说，${answer}如果情况比较特殊，可以再告诉我细节，我们一起调整方案。${FILLER_PAD}`,
    })
  }
  return messages
}
