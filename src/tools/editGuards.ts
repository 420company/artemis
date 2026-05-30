/**
 * 编辑安全守卫——集中给所有写/改文件的工具用，避免在每个工具里重复。
 *
 * 三层（都很省 token：检查跑在本地，不经过模型）：
 *  1. 构建产物警告：改 dist/*.min.js 等会被 rebuild 覆盖时提醒去改 src。
 *  2. 改前盲改/stale 检测：改一个本轮没读过、或读后已变的文件时提醒（只在有风险时才出声）。
 *  3. 改后语法校验：.json/.js/.ts/.py 改完即检查语法，坏了当场报。
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

// 本轮读过的文件 → 内容哈希。readFile 写入，编辑工具读取。
const readHashes = new Map<string, string>();

/** read_file 成功后调用，记下「agent 见过的内容」。 */
export function noteFileRead(absolute: string, content: string): void {
  readHashes.set(absolute, sha1(content));
}

// ── 1. 构建产物警告 ────────────────────────────────────────────────────────
export function artifactWarning(absolute: string): string | null {
  const p = absolute.replace(/\\/g, '/');
  if (/\.min\.(js|css|mjs|cjs)$/i.test(p)) {
    return '⚠️ 这是压缩产物（*.min.*）：手改易错且会被重建覆盖——请改源文件。';
  }
  if (/\/(dist|build|out)\/.+\.(js|cjs|mjs|d\.ts)$/i.test(p)) {
    return '⚠️ 这是构建产物（dist/build/out 下的编译文件）：下次 build 会覆盖你的改动——要持久请改对应的 src/ 源文件。';
  }
  return null;
}

// ── 2. 改前盲改 / stale 检测（省 token：只在有风险时返回一句） ──────────────
/** 在写入【之前】调用。preContent = 编辑所基于的磁盘旧内容；新建文件传 null。 */
export function preEditWarning(absolute: string, preContent: string | null): string | null {
  if (preContent === null) return null; // 新建文件，无所谓
  const recorded = readHashes.get(absolute);
  if (recorded === undefined) {
    return '⚠️ 改前未读：本轮没读过这个文件就在改它，请确认内容确实是你以为的样子（建议先 read_file）。';
  }
  if (recorded !== sha1(preContent)) {
    return '⚠️ 内容已变（stale）：文件自你上次读取后被改过，本次改动可能基于旧内容（建议先重新 read_file）。';
  }
  return null;
}

// ── 3. 改后语法校验 ────────────────────────────────────────────────────────
async function checkJsFile(file: string): Promise<string | null> {
  try {
    await execFileAsync(process.execPath, ['--check', file], { timeout: 8000 });
    return null;
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return String(err.stderr || err.message || e).split('\n').slice(0, 5).join('\n').trim();
  }
}

async function checkTsContent(content: string): Promise<string | null> {
  // esbuild 是传递依赖：能 import 就用它做纯语法解析（不做类型检查），不能就优雅跳过。
  let transform: ((c: string, o: unknown) => Promise<unknown>) | null = null;
  try {
    const mod = (await import('esbuild')) as { transform?: (c: string, o: unknown) => Promise<unknown> };
    transform = mod.transform ?? null;
  } catch {
    return null;
  }
  if (!transform) return null;
  try {
    await transform(content, { loader: 'ts' });
    return null;
  } catch (e) {
    const err = e as { message?: string };
    return String(err.message || e).split('\n').slice(0, 5).join('\n').trim();
  }
}

async function checkPyFile(file: string): Promise<string | null> {
  try {
    await execFileAsync('python3', ['-m', 'py_compile', file], { timeout: 8000 });
    return null;
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: string };
    if (err.code === 'ENOENT') return null; // 没装 python，跳过
    return String(err.stderr || err.message || e).split('\n').slice(0, 6).join('\n').trim();
  }
}

/** 在写入【之后】调用。返回语法错误描述，没问题返回 null。 */
export async function postEditSyntax(absolute: string, content: string): Promise<string | null> {
  const ext = path.extname(absolute).toLowerCase();
  if (ext === '.json') {
    try { JSON.parse(content); return null; }
    catch (e) { return `JSON 解析失败: ${(e as Error).message}`; }
  }
  if (ext === '.js' || ext === '.cjs' || ext === '.mjs') return checkJsFile(absolute);
  if (['.ts', '.tsx', '.jsx', '.mts', '.cts'].includes(ext)) return checkTsContent(content);
  if (ext === '.py') return checkPyFile(absolute);
  return null;
}

// ── 汇总：编辑工具调一次，得到要追加到 output 末尾的字符串 ──────────────────
/**
 * @param preContent 编辑所基于的磁盘旧内容（新建文件传 null）——用于 stale/盲改检测
 * @param newContent 写入后的新内容——用于语法校验
 */
export async function runEditGuards(
  absolute: string,
  preContent: string | null,
  newContent: string,
): Promise<string> {
  const parts: string[] = [];
  const art = artifactWarning(absolute);
  if (art) parts.push(art);
  const pre = preEditWarning(absolute, preContent);
  if (pre) parts.push(pre);
  const syntax = await postEditSyntax(absolute, newContent);
  if (syntax) {
    parts.push(`🛑 语法/解析错误——你刚才的改动让 ${path.basename(absolute)} 无法解析：\n${syntax}\n请立刻修正这处编辑。`);
  }
  // 写入后把新内容登记为「已知」，后续对同一文件的编辑不会再被误判 stale。
  noteFileRead(absolute, newContent);
  return parts.length ? '\n\n' + parts.join('\n') : '';
}
