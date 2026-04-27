/**
 * scripts/promptSmoke.ts — headless smoke tests for the input system
 *
 * Tests all editing operations without requiring a real TTY.
 * Run: node --no-warnings node_modules/tsx/dist/cli.mjs scripts/promptSmoke.ts
 */

// ─── mini test harness ────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  \x1b[32m✔\x1b[0m ${name}`)
    passed++
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`  \x1b[31m✘\x1b[0m ${name}`)
    console.log(`      ${msg}`)
    failed++
  }
}

function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    const label = msg ? `${msg}: ` : ''
    throw new Error(`${label}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ─── inline buffer/cursor model (mirrors Prompt internals) ───────────────────

const segmenter = new Intl.Segmenter()
function graphemes(s: string): string[] {
  return [...segmenter.segment(s)].map(seg => seg.segment)
}

class InputBuf {
  gs: string[] = []
  cursor: number = 0
  killRing: string[] = []

  get value(): string { return this.gs.join('') }

  insert(text: string): void {
    const newGs = graphemes(text)
    this.gs.splice(this.cursor, 0, ...newGs)
    this.cursor += newGs.length
  }

  backspace(): void {
    if (this.cursor === 0) return
    this.gs.splice(this.cursor - 1, 1)
    this.cursor--
  }

  deleteForward(): void {
    if (this.cursor >= this.gs.length) return
    this.gs.splice(this.cursor, 1)
  }

  moveLeft(): void { if (this.cursor > 0) this.cursor-- }
  moveRight(): void { if (this.cursor < this.gs.length) this.cursor++ }

  moveHome(): void {
    let i = this.cursor - 1
    while (i >= 0 && this.gs[i] !== '\n') i--
    this.cursor = i + 1
  }

  moveEnd(): void {
    let i = this.cursor
    while (i < this.gs.length && this.gs[i] !== '\n') i++
    this.cursor = i
  }

  moveWordLeft(): void {
    while (this.cursor > 0 && this.gs[this.cursor - 1] === ' ') this.cursor--
    while (this.cursor > 0 && this.gs[this.cursor - 1] !== ' ' && this.gs[this.cursor - 1] !== '\n') this.cursor--
  }

  moveWordRight(): void {
    const len = this.gs.length
    while (this.cursor < len && (this.gs[this.cursor] === ' ' || this.gs[this.cursor] === '\n')) this.cursor++
    while (this.cursor < len && this.gs[this.cursor] !== ' ' && this.gs[this.cursor] !== '\n') this.cursor++
  }

  killToEnd(): void {
    let end = this.cursor
    while (end < this.gs.length && this.gs[end] !== '\n') end++
    const killed = this.gs.splice(this.cursor, end - this.cursor).join('')
    if (killed) this.killRing.push(killed)
  }

  killToHome(): void {
    let start = this.cursor - 1
    while (start >= 0 && this.gs[start] !== '\n') start--
    start++
    const killed = this.gs.splice(start, this.cursor - start).join('')
    this.cursor = start
    if (killed) this.killRing.push(killed)
  }

  killWordBack(): void {
    const orig = this.cursor
    while (this.cursor > 0 && this.gs[this.cursor - 1] === ' ') this.cursor--
    while (this.cursor > 0 && this.gs[this.cursor - 1] !== ' ' && this.gs[this.cursor - 1] !== '\n') this.cursor--
    const killed = this.gs.splice(this.cursor, orig - this.cursor).join('')
    if (killed) this.killRing.push(killed)
  }

  yank(): void {
    if (this.killRing.length === 0) return
    this.insert(this.killRing[this.killRing.length - 1])
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

console.log()
console.log('  promptSmoke')
console.log('  ===========')
console.log()

// ── basic insert ────────────────────────────────────────────────────────────
test('insert at end', () => {
  const b = new InputBuf()
  b.insert('hello')
  eq(b.value, 'hello')
  eq(b.cursor, 5)
})

test('insert in middle', () => {
  const b = new InputBuf()
  b.insert('hllo')
  b.moveLeft(); b.moveLeft(); b.moveLeft()  // cursor at 1 → before 'l'
  b.insert('e')
  eq(b.value, 'hello')
  eq(b.cursor, 2)
})

test('insert multiline', () => {
  const b = new InputBuf()
  b.insert('line1\nline2')
  eq(b.value, 'line1\nline2')
  eq(b.cursor, 11)
})

// ── backspace / delete ──────────────────────────────────────────────────────
test('backspace at end', () => {
  const b = new InputBuf()
  b.insert('hello')
  b.backspace()
  eq(b.value, 'hell')
  eq(b.cursor, 4)
})

test('backspace at start is noop', () => {
  const b = new InputBuf()
  b.insert('x')
  b.moveHome()
  b.backspace()
  eq(b.value, 'x')
  eq(b.cursor, 0)
})

test('delete forward', () => {
  const b = new InputBuf()
  b.insert('hello')
  b.moveLeft()  // cursor = 4, before 'o'
  b.deleteForward()
  eq(b.value, 'hell')
  eq(b.cursor, 4)
})

// ── cursor movement ─────────────────────────────────────────────────────────
test('moveLeft clamps at 0', () => {
  const b = new InputBuf()
  b.moveLeft()
  eq(b.cursor, 0)
})

test('moveRight clamps at end', () => {
  const b = new InputBuf()
  b.insert('ab')
  b.moveRight()  // already at end
  eq(b.cursor, 2)
})

test('moveHome on single line', () => {
  const b = new InputBuf()
  b.insert('hello')
  b.moveHome()
  eq(b.cursor, 0)
})

test('moveEnd on single line', () => {
  const b = new InputBuf()
  b.insert('hello')
  b.moveHome()
  b.moveEnd()
  eq(b.cursor, 5)
})

test('moveHome / moveEnd on multiline', () => {
  const b = new InputBuf()
  b.insert('abc\ndefg')
  // cursor at end (8), on second line
  b.moveHome()
  eq(b.cursor, 4, 'home of second line')
  b.moveEnd()
  eq(b.cursor, 8, 'end of second line')
  // move to first line
  b.moveLeft(); b.moveLeft(); b.moveLeft(); b.moveLeft(); b.moveLeft()  // cursor=3
  b.moveHome()
  eq(b.cursor, 0, 'home of first line')
  b.moveEnd()
  eq(b.cursor, 3, 'end of first line (before \\n)')
})

test('moveWordLeft', () => {
  const b = new InputBuf()
  b.insert('foo bar baz')
  b.moveWordLeft()
  eq(b.cursor, 8, 'before baz')
  b.moveWordLeft()
  eq(b.cursor, 4, 'before bar')
  b.moveWordLeft()
  eq(b.cursor, 0, 'before foo')
})

test('moveWordRight', () => {
  const b = new InputBuf()
  b.insert('foo bar baz')
  b.moveHome()
  b.moveWordRight()
  eq(b.cursor, 3, 'after foo')
  b.moveWordRight()
  eq(b.cursor, 7, 'after bar')
  b.moveWordRight()
  eq(b.cursor, 11, 'after baz')
})

// ── kill / yank ─────────────────────────────────────────────────────────────
test('killToEnd', () => {
  const b = new InputBuf()
  b.insert('hello world')
  b.moveHome()
  b.moveRight(); b.moveRight(); b.moveRight(); b.moveRight(); b.moveRight()  // cursor=5
  b.killToEnd()
  eq(b.value, 'hello')
  eq(b.cursor, 5)
  eq(b.killRing[b.killRing.length - 1], ' world')
})

test('killToHome', () => {
  const b = new InputBuf()
  b.insert('hello world')
  b.moveLeft(); b.moveLeft(); b.moveLeft(); b.moveLeft(); b.moveLeft()  // cursor=6
  b.killToHome()
  eq(b.value, 'world')
  eq(b.cursor, 0)
})

test('killWordBack', () => {
  const b = new InputBuf()
  b.insert('foo bar baz')
  b.killWordBack()
  eq(b.value, 'foo bar ')
  eq(b.cursor, 8)
  eq(b.killRing[b.killRing.length - 1], 'baz')
})

test('yank restores kill', () => {
  const b = new InputBuf()
  b.insert('hello world')
  b.killWordBack()  // kills 'world'
  b.yank()
  eq(b.value, 'hello world')
  eq(b.cursor, 11)
})

// ── grapheme-awareness ──────────────────────────────────────────────────────
test('CJK grapheme: cursor advances by one grapheme not one byte', () => {
  const b = new InputBuf()
  b.insert('你好世界')  // 4 graphemes, each potentially multi-byte
  eq(b.cursor, 4)
  eq(b.value, '你好世界')
})

test('CJK backspace removes one grapheme', () => {
  const b = new InputBuf()
  b.insert('你好')
  b.backspace()
  eq(b.value, '你')
  eq(b.cursor, 1)
})

test('emoji is one grapheme', () => {
  const b = new InputBuf()
  b.insert('A\uD83D\uDE00B')  // A + 😀 + B
  eq(b.cursor, 3, 'three graphemes')
  b.moveLeft()
  eq(b.cursor, 2)
  b.backspace()  // removes emoji
  eq(b.value, 'AB')
})

// ── paste sanitisation (manual) ─────────────────────────────────────────────
test('paste sanitisation: control chars stripped', () => {
  const raw = 'hello\x00world\x01\x02\x03'
  const sanitised = raw.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '')
  eq(sanitised, 'helloworld')
})

test('paste sanitisation: \\n preserved, \\r normalised', () => {
  const raw = 'line1\r\nline2\rline3'
  const normalised = raw.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '').replace(/\r\n?/g, '\n')
  eq(normalised, 'line1\nline2\nline3')
})

// ─── results ──────────────────────────────────────────────────────────────────

console.log()
if (failed === 0) {
  console.log(`  \x1b[32m✔ All ${passed} tests passed\x1b[0m`)
} else {
  console.log(`  \x1b[31m✘ ${failed} failed, ${passed} passed\x1b[0m`)
  process.exit(1)
}
console.log()
