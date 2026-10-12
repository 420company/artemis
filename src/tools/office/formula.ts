/**
 * tools/office/formula.ts — computes the values of common spreadsheet
 * formulas, so a generated workbook carries cached results.
 *
 * Excel and LibreOffice recalculate on open anyway (the workbook asks for a
 * full calculation on load); the cached values are for everything that only
 * reads the file: previews, grid viewers, phones, other programs. Supported:
 * + - * / ^ & % and comparisons, cell references and ranges (also on other
 * sheets), and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, MEDIAN, PRODUCT,
 * ROUND/ROUNDUP/ROUNDDOWN, ABS, IF, IFERROR, AND, OR, NOT, CONCAT(ENATE),
 * SUMIF, COUNTIF, AVERAGEIF. Anything else leaves the cell without a
 * cached value (never a wrong one).
 */

export type Scalar = number | string | boolean | null;
type Value = Scalar | FormulaError | Scalar[];

export class FormulaError {
  constructor(readonly code: '#DIV/0!' | '#VALUE!' | '#REF!' | '#NAME?' | '#N/A' | '#NUM!') {}
}

class Unsupported extends Error {}

/** What the evaluator needs to know about the workbook. */
export interface FormulaSheets {
  /** The value of a cell (a formula cell's computed value), or null when empty. */
  cell(sheet: string, column: number, row: number): Scalar | FormulaError | undefined;
  hasSheet(sheet: string): boolean;
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'ref'; sheet?: string; c1: number; r1: number; c2?: number; r2?: number }
  | { t: 'fn'; v: string }
  | { t: 'op'; v: string }
  | { t: '('; } | { t: ')'; } | { t: ','; };

export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function columnLetters(index: number): string {
  let s = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const REF_RE = /^(?:('(?:[^']|'')+'|[A-Za-z_一-鿿][\w.一-鿿]*)!)?\$?([A-Za-z]{1,3})\$?(\d{1,7})(?::\$?([A-Za-z]{1,3})\$?(\d{1,7}))?/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          s += '"';
          j += 2;
        } else if (src[j] === '"') break;
        else s += src[j++];
      }
      tokens.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    const rest = src.slice(i);
    const number = /^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|^\.\d+/.exec(rest);
    if (number && !/^[A-Za-z]/.test(rest)) {
      tokens.push({ t: 'num', v: Number(number[0]) });
      i += number[0].length;
      continue;
    }
    const fn = /^([A-Za-z][A-Za-z0-9.]*)\s*\(/.exec(rest);
    if (fn) {
      tokens.push({ t: 'fn', v: fn[1]!.toUpperCase() });
      tokens.push({ t: '(' });
      i += fn[0].length;
      continue;
    }
    const ref = REF_RE.exec(rest);
    if (ref) {
      const sheet = ref[1] ? ref[1].replace(/^'|'$/g, '').replace(/''/g, "'") : undefined;
      tokens.push({ t: 'ref', ...(sheet ? { sheet } : {}), c1: columnIndex(ref[2]!), r1: Number(ref[3]), ...(ref[4] ? { c2: columnIndex(ref[4]), r2: Number(ref[5]) } : {}) });
      i += ref[0].length;
      continue;
    }
    const bool = /^(TRUE|FALSE)\b/i.exec(rest);
    if (bool) {
      tokens.push({ t: 'bool', v: bool[1]!.toUpperCase() === 'TRUE' });
      i += bool[0].length;
      continue;
    }
    const op = /^(<>|<=|>=|[-+*/^&=<>%])/.exec(rest);
    if (op) {
      tokens.push({ t: 'op', v: op[1]! });
      i += op[1]!.length;
      continue;
    }
    if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ t: ch } as Token);
      i += 1;
      continue;
    }
    if (ch === ';') {
      tokens.push({ t: ',' });
      i += 1;
      continue;
    }
    throw new Unsupported(`unexpected ${ch}`);
  }
  return tokens;
}

type Node =
  | { k: 'lit'; v: Scalar }
  | { k: 'ref'; sheet?: string; c1: number; r1: number; c2?: number; r2?: number }
  | { k: 'un'; op: string; a: Node }
  | { k: 'pct'; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] };

function parse(tokens: Token[]): Node {
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (...ops: string[]) => {
    const t = peek();
    return t?.t === 'op' && ops.includes(t.v);
  };
  const level = (ops: string[], next: () => Node) => (): Node => {
    let left = next();
    while (isOp(...ops)) {
      const op = (tokens[pos++] as { v: string }).v;
      left = { k: 'bin', op, a: left, b: next() };
    }
    return left;
  };
  const primary = (): Node => {
    const t = tokens[pos++];
    if (!t) throw new Unsupported('unexpected end');
    switch (t.t) {
      case 'num':
        return { k: 'lit', v: t.v };
      case 'str':
        return { k: 'lit', v: t.v };
      case 'bool':
        return { k: 'lit', v: t.v };
      case 'ref':
        return { k: 'ref', ...(t.sheet ? { sheet: t.sheet } : {}), c1: t.c1, r1: t.r1, ...(t.c2 ? { c2: t.c2, r2: t.r2 } : {}) };
      case '(': {
        const inner = comparison();
        if (tokens[pos++]?.t !== ')') throw new Unsupported('missing )');
        return inner;
      }
      case 'fn': {
        pos += 1; // "("
        const args: Node[] = [];
        if (peek()?.t !== ')') {
          for (;;) {
            args.push(comparison());
            if (peek()?.t === ',') {
              pos += 1;
              continue;
            }
            break;
          }
        }
        if (tokens[pos++]?.t !== ')') throw new Unsupported('missing )');
        return { k: 'call', fn: t.v, args };
      }
      default:
        throw new Unsupported('unexpected token');
    }
  };
  const postfix = (): Node => {
    let node = primary();
    while (isOp('%')) {
      pos += 1;
      node = { k: 'pct', a: node };
    }
    return node;
  };
  const unary = (): Node => {
    if (isOp('-', '+')) {
      const op = (tokens[pos++] as { v: string }).v;
      return { k: 'un', op, a: unary() };
    }
    return postfix();
  };
  const power = level(['^'], unary);
  const mul = level(['*', '/'], power);
  const add = level(['+', '-'], mul);
  const concat = level(['&'], add);
  const comparison = level(['=', '<>', '<', '>', '<=', '>='], concat);
  const root = comparison();
  if (pos !== tokens.length) throw new Unsupported('trailing input');
  return root;
}

const isErr = (v: unknown): v is FormulaError => v instanceof FormulaError;

function toNumber(v: Scalar | FormulaError): number | FormulaError {
  if (isErr(v)) return v;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : new FormulaError('#VALUE!');
}

function toText(v: Scalar): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

function toBool(v: Scalar | FormulaError): boolean | FormulaError {
  if (isErr(v)) return v;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  return new FormulaError('#VALUE!');
}

function flatten(values: Value[]): Array<Scalar | FormulaError> {
  const out: Array<Scalar | FormulaError> = [];
  for (const v of values) {
    if (Array.isArray(v)) out.push(...v);
    else out.push(v);
  }
  return out;
}

function roundTo(n: number, digits: number, mode: 'round' | 'up' | 'down'): number {
  const f = 10 ** digits;
  const x = Math.abs(n) * f;
  const r = mode === 'round' ? Math.round(x + 1e-9) : mode === 'up' ? Math.ceil(x - 1e-9) : Math.floor(x + 1e-9);
  return (Math.sign(n) * r) / f;
}

function criteria(raw: Scalar | FormulaError): (v: Scalar | FormulaError) => boolean {
  if (isErr(raw)) return () => false;
  const text = toText(raw);
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(text)!;
  const op = m[1] ?? '=';
  const target = m[2]!;
  const num = target !== '' && Number.isFinite(Number(target)) ? Number(target) : undefined;
  return (v) => {
    if (isErr(v)) return false;
    if (num !== undefined && typeof v === 'number') {
      switch (op) {
        case '<': return v < num;
        case '>': return v > num;
        case '<=': return v <= num;
        case '>=': return v >= num;
        case '<>': return v !== num;
        default: return v === num;
      }
    }
    const a = toText(v).toLowerCase();
    const b = target.toLowerCase();
    if (op === '<>') return a !== b;
    if (op === '=') return b.includes('*') ? new RegExp(`^${b.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(a) : a === b;
    return false;
  };
}

export class FormulaEvaluator {
  constructor(private readonly sheets: FormulaSheets) {}

  /** The value of `formula` (with or without "=") on `sheet`, or undefined when not supported. */
  evaluate(formula: string, sheet: string): Scalar | FormulaError | undefined {
    try {
      const node = parse(tokenize(formula.replace(/^=/, '')));
      const value = this.eval(node, sheet);
      if (Array.isArray(value)) return value[0] ?? null;
      return value;
    } catch (error) {
      if (error instanceof Unsupported) return undefined;
      throw error;
    }
  }

  private range(node: Extract<Node, { k: 'ref' }>, sheet: string): Value {
    const target = node.sheet ?? sheet;
    if (!this.sheets.hasSheet(target)) return new FormulaError('#REF!');
    const read = (c: number, r: number) => {
      const v = this.sheets.cell(target, c, r);
      if (v === undefined) throw new Unsupported('unresolved cell');
      return v;
    };
    if (node.c2 === undefined || node.r2 === undefined) return read(node.c1, node.r1) as Value;
    const out: Scalar[] = [];
    const [c1, c2] = [Math.min(node.c1, node.c2), Math.max(node.c1, node.c2)];
    const [r1, r2] = [Math.min(node.r1, node.r2), Math.max(node.r1, node.r2)];
    if ((c2 - c1 + 1) * (r2 - r1 + 1) > 200_000) throw new Unsupported('range too large');
    for (let r = r1; r <= r2; r += 1) for (let c = c1; c <= c2; c += 1) out.push(read(c, r) as Scalar);
    return out;
  }

  private eval(node: Node, sheet: string): Value {
    switch (node.k) {
      case 'lit':
        return node.v;
      case 'ref':
        return this.range(node, sheet);
      case 'un': {
        const v = this.scalar(node.a, sheet);
        const n = toNumber(v);
        return isErr(n) ? n : node.op === '-' ? -n : n;
      }
      case 'pct': {
        const n = toNumber(this.scalar(node.a, sheet));
        return isErr(n) ? n : n / 100;
      }
      case 'bin':
        return this.binary(node.op, this.scalar(node.a, sheet), this.scalar(node.b, sheet));
      case 'call':
        return this.call(node.fn, node.args, sheet);
    }
  }

  private scalar(node: Node, sheet: string): Scalar | FormulaError {
    const v = this.eval(node, sheet);
    if (Array.isArray(v)) {
      if (v.length === 1) return v[0]!;
      throw new Unsupported('array in scalar position');
    }
    return v;
  }

  private binary(op: string, a: Scalar | FormulaError, b: Scalar | FormulaError): Value {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    if (op === '&') return toText(a) + toText(b);
    if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
      const both = typeof a === 'number' && typeof b === 'number';
      const x = both ? a : toText(a).toLowerCase();
      const y = both ? b : toText(b).toLowerCase();
      switch (op) {
        case '=': return x === y;
        case '<>': return x !== y;
        case '<': return x < y;
        case '>': return x > y;
        case '<=': return x <= y;
        default: return x >= y;
      }
    }
    const x = toNumber(a);
    const y = toNumber(b);
    if (isErr(x)) return x;
    if (isErr(y)) return y;
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': return y === 0 ? new FormulaError('#DIV/0!') : x / y;
      case '^': return x ** y;
      default: throw new Unsupported(op);
    }
  }

  private call(fn: string, args: Node[], sheet: string): Value {
    const values = () => args.map((a) => this.eval(a, sheet));
    const numbers = (): number[] | FormulaError => {
      const out: number[] = [];
      for (const v of values()) {
        if (Array.isArray(v)) {
          for (const x of v) {
            if (isErr(x)) return x;
            if (typeof x === 'number') out.push(x);
          }
        } else {
          if (isErr(v)) return v;
          // Direct arguments count even as text numbers / booleans.
          if (v === null) continue;
          const n = toNumber(v);
          if (isErr(n)) return n;
          out.push(n);
        }
      }
      return out;
    };
    const arg = (i: number) => (args[i] ? this.scalar(args[i]!, sheet) : null);
    switch (fn) {
      case 'SUM': {
        const n = numbers();
        return isErr(n) ? n : n.reduce((a, b) => a + b, 0);
      }
      case 'AVERAGE': {
        const n = numbers();
        return isErr(n) ? n : n.length ? n.reduce((a, b) => a + b, 0) / n.length : new FormulaError('#DIV/0!');
      }
      case 'MIN':
      case 'MAX': {
        const n = numbers();
        return isErr(n) ? n : n.length ? (fn === 'MIN' ? Math.min(...n) : Math.max(...n)) : 0;
      }
      case 'MEDIAN': {
        const n = numbers();
        if (isErr(n)) return n;
        if (!n.length) return new FormulaError('#NUM!');
        const s = [...n].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
      }
      case 'PRODUCT': {
        const n = numbers();
        return isErr(n) ? n : n.reduce((a, b) => a * b, 1);
      }
      case 'COUNT':
        return flatten(values()).filter((v) => typeof v === 'number').length;
      case 'COUNTA':
        return flatten(values()).filter((v) => v !== null && v !== '').length;
      case 'ROUND':
      case 'ROUNDUP':
      case 'ROUNDDOWN': {
        const n = toNumber(arg(0));
        const d = toNumber(arg(1));
        if (isErr(n)) return n;
        if (isErr(d)) return d;
        return roundTo(n, Math.trunc(d), fn === 'ROUND' ? 'round' : fn === 'ROUNDUP' ? 'up' : 'down');
      }
      case 'ABS': {
        const n = toNumber(arg(0));
        return isErr(n) ? n : Math.abs(n);
      }
      case 'IF': {
        const c = toBool(arg(0));
        if (isErr(c)) return c;
        return c ? (args[1] ? this.scalar(args[1], sheet) : true) : args[2] ? this.scalar(args[2], sheet) : false;
      }
      case 'IFERROR': {
        const v = arg(0);
        return isErr(v) ? arg(1) : v;
      }
      case 'AND':
      case 'OR': {
        const bools = flatten(values()).filter((v) => v !== null).map(toBool);
        const err = bools.find(isErr);
        if (err) return err;
        return fn === 'AND' ? bools.every(Boolean) : bools.some(Boolean);
      }
      case 'NOT': {
        const b = toBool(arg(0));
        return isErr(b) ? b : !b;
      }
      case 'CONCAT':
      case 'CONCATENATE': {
        const parts = flatten(values());
        const err = parts.find(isErr);
        return err ?? parts.map((p) => toText(p as Scalar)).join('');
      }
      case 'SUMIF':
      case 'COUNTIF':
      case 'AVERAGEIF': {
        const range = this.eval(args[0]!, sheet);
        const test = criteria(arg(1));
        const cells = Array.isArray(range) ? range : [range as Scalar];
        const sumRange = fn !== 'COUNTIF' && args[2] ? this.eval(args[2], sheet) : range;
        const sums = Array.isArray(sumRange) ? sumRange : [sumRange as Scalar];
        let count = 0;
        let total = 0;
        cells.forEach((cell, i) => {
          if (!test(cell)) return;
          count += 1;
          const v = sums[i];
          if (typeof v === 'number') total += v;
        });
        if (fn === 'COUNTIF') return count;
        if (fn === 'SUMIF') return total;
        return count ? total / count : new FormulaError('#DIV/0!');
      }
      default:
        throw new Unsupported(`function ${fn}`);
    }
  }
}
