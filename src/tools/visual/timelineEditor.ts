import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { resolveArtemisHomeDir } from '../../utils/fs.js';
import { getMediaOutputRoot } from '../../utils/mediaOutputRoot.js';
import type { SagaSegmentInput } from './sagaRenderer/types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TimelineSegment = {
  index: number;
  title: string;
  duration: number;
  originalDuration: number;
  videoPath: string;
  prompt: string;
  trimmed: boolean;
  trimStart?: number;
  trimEnd?: number;
  pendingPrompt?: string;
};

export type TimelineSubtitle = {
  id: string;
  segmentIndex: number;
  text: string;
  start: number;
  end: number;
};

export type TimelineBgm = {
  audioPath: string;
  volumeDb: number;
  fadeInSec: number;
  fadeOutSec: number;
  startSec: number;
};

export type TimelineProject = {
  version: 1;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  ratio: string;
  fps: number;
  width: number;
  height: number;
  segments: TimelineSegment[];
  subtitles: TimelineSubtitle[];
  bgm?: TimelineBgm;
  sourceSagaProjectId?: string;
  lastRender?: { outputPath: string; duration: number; renderedAt: string };
};

type Args = Record<string, unknown>;
type Result = Record<string, unknown>;
type LoadResult =
  | { ok: true; project: TimelineProject; dir: string }
  | { ok: false; error: string };
type VideoInfo = { width: number; height: number; fps: number };

const FFMPEG_MISSING = '未找到 ffmpeg，请先安装 ffmpeg 并确保其在 PATH 中';
const FFPROBE_MISSING = '未找到 ffprobe，无法校验媒体文件，请先安装 ffmpeg（含 ffprobe）并确保其在 PATH 中';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INVALID_ID_MSG = 'projectId 无效（仅允许字母数字 . _ -，最长128）';
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/** 视频输入扩展名白名单（replace_segment / import_saga / render 复检）。 */
const VIDEO_INPUT_EXTS: ReadonlySet<string> = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi']);
/** 音频输入扩展名白名单（set_bgm / render 复检）。 */
const AUDIO_INPUT_EXTS: ReadonlySet<string> = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac']);
/** 渲染输出扩展名白名单。 */
const OUTPUT_EXTS: ReadonlySet<string> = new Set(['.mp4', '.mov', '.m4v']);
/** 仅用于 import_saga 扫描目录时的粗筛，最终仍走 validateVideoFile。 */
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
/** 输出文件名：不能以 . 或 - 开头，只允许字母/数字/空格及 . _ ( ) -。 */
const OUTPUT_NAME_RE = /^[\p{L}\p{N}_][\p{L}\p{N} ._()-]{0,199}$/u;

const MAX_PROMPT_LEN = 4000;
const MAX_TITLE_LEN = 200;
const MAX_IMPORT_SEGMENTS = 500;
const MAX_SEGMENT_INDEX = 1_000_000;
const MAX_WALK_FILES = 5000;
const MAX_RENDER_DIM = 7680;

const LOCK_FILE_NAME = 'timeline.json.lock';
const LOCK_STALE_MS = 60_000;
const LOCK_RETRY_MS = 250;
const LOCK_TIMEOUT_MS = 30_000;
/** 锁文件内容无法解析时的宽限期：wx 创建与写入内容之间存在短暂空文件窗口，避免误判。 */
const LOCK_PARSE_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

class TimelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimelineError';
  }
}

function fail(action: string, error: string, extra: Result = {}): Result {
  return { action, ok: false, error, ...extra };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function int(v: unknown): number | undefined {
  const n = num(v);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmt(n: number): string {
  return String(round3(n));
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function tail(s: string, max: number): string {
  return s.length > max ? `…${s.slice(s.length - max)}` : s;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, ' ');
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    if (stderr) return redactPaths(tail(stderr, 600));
    if (typeof e.message === 'string') return redactPaths(tail(e.message, 600));
  }
  return redactPaths(String(err));
}

/** L1: 把错误文本中的绝对路径替换为 basename，避免泄露服务器目录结构。 */
function redactPaths(s: string): string {
  return s.replace(/(^|[\s"'=:(])(\/(?:[^\s"'()[\]]+\/)*[^\s"'()[\]]+|[A-Za-z]:\\(?:[^\s"'()[\]]+\\)*[^\s"'()[\]]+)/g,
    (_m, pre, p) => `${pre}${path.basename(p)}`);
}

function errCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveUserPath(p: string, cwd: string): string {
  let s = p.trim();
  if (s.includes('\0')) throw new Error('路径不能包含空字节');
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  const resolved = path.isAbsolute(s) ? path.normalize(s) : path.resolve(cwd, s);
  if (/^[\\]{2}/.test(resolved)) throw new Error('不支持 UNC 网络路径');
  if (resolved.includes('\0')) throw new Error('路径不能包含空字节');
  return resolved;
}

function validId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v) && !v.includes('..');
}

function extOf(p: string): string {
  return path.extname(p).toLowerCase();
}

function hasAllowedExt(p: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(extOf(p));
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

/** 任意类型（含悬空符号链接）都算存在，用于覆盖保护。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function realpathOrNull(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/** 递归列文件；不跟随符号链接（Dirent 对符号链接 isFile/isDirectory 均为 false），并限制总文件数。 */
async function walk(dir: string, depth: number, budget: { left: number }): Promise<string[]> {
  const out: string[] = [];
  if (budget.left <= 0) return out;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (budget.left <= 0) break;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && !e.name.startsWith('.')) out.push(...(await walk(p, depth - 1, budget)));
    } else if (e.isFile()) {
      out.push(p);
      budget.left--;
    }
  }
  return out;
}

function gcd(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b < 0) return 1;
  return b === 0 ? a : gcd(b, a % b);
}

function ratioOf(w: number, h: number): string {
  const g = gcd(w, h) || 1;
  return `${w / g}:${h / g}`;
}

function even(n: number): number {
  const r = Math.max(2, Math.round(n));
  return r - (r % 2);
}

// ---------------------------------------------------------------------------
// Process helpers (ffmpeg / ffprobe)
// ---------------------------------------------------------------------------

async function run(
  bin: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileAsync(bin, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  });
  return { stdout: String(r.stdout), stderr: String(r.stderr) };
}

/** 只缓存"存在"的结果；不存在时下次重新探测（安装 ffmpeg 后无需重启进程）。 */
const binCache = new Set<string>();
/** 二进制绝对路径缓存（防 Windows 下 cwd 同名 exe 劫持）。 */
const binPathCache = new Map<string, string>();

async function resolveBinPath(bin: string): Promise<string | null> {
  const cached = binPathCache.get(bin);
  if (cached) return cached;
  try {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(probe, [bin], { timeout: 15_000, windowsHide: true });
    const first = String(stdout).split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (first && path.isAbsolute(first)) {
      binPathCache.set(bin, first);
      return first;
    }
  } catch {
    // fall through
  }
  return null;
}

async function hasBinary(bin: string): Promise<boolean> {
  if (binCache.has(bin)) return true;
  const abs = await resolveBinPath(bin);
  if (!abs) return false;
  try {
    await run(abs, ['-version'], { timeoutMs: 15_000 });
    binCache.add(bin);
    return true;
  } catch {
    return false;
  }
}

/** 取已解析的绝对路径；未解析成功时回退裸名（hasBinary 会先拦截不可用情况）。 */
function binPath(bin: string): string {
  return binPathCache.get(bin) ?? bin;
}

async function probeDuration(file: string): Promise<number | null> {
  if (!(await hasBinary('ffprobe'))) return null;
  try {
    const { stdout } = await run(binPath('ffprobe'),
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        '-protocol_whitelist', 'file',
        '-i', file,
      ],
      { timeoutMs: 60_000 },
    );
    const n = Number.parseFloat(stdout.trim());
    return Number.isFinite(n) && n > 0 ? round3(n) : null;
  } catch {
    return null;
  }
}

async function probeHasAudio(file: string): Promise<boolean | null> {
  if (!(await hasBinary('ffprobe'))) return null;
  try {
    const { stdout } = await run(binPath('ffprobe'),
      [
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream=index',
        '-of', 'csv=p=0',
        '-protocol_whitelist', 'file',
        '-i', file,
      ],
      { timeoutMs: 60_000 },
    );
    return stdout.trim().length > 0;
  } catch {
    return null;
  }
}

function parseRate(r: string | undefined): number | undefined {
  if (!r) return undefined;
  const parts = r.split('/');
  const n = Number(parts[0]);
  const d = parts.length > 1 ? Number(parts[1]) : 1;
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return undefined;
  const v = n / d;
  return v > 0 && v <= 240 ? round3(v) : undefined;
}

async function probeVideoInfo(file: string): Promise<VideoInfo | null> {
  if (!(await hasBinary('ffprobe'))) return null;
  try {
    const { stdout } = await run(binPath('ffprobe'),
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate',
        '-of', 'json',
        '-protocol_whitelist', 'file',
        '-i', file,
      ],
      { timeoutMs: 60_000 },
    );
    const data = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string }>;
    };
    const s = data.streams?.[0];
    if (!s || !s.width || !s.height) return null;
    const fps = parseRate(s.avg_frame_rate) ?? parseRate(s.r_frame_rate) ?? 30;
    return { width: s.width, height: s.height, fps };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input validation (type whitelist + magic bytes)
// ---------------------------------------------------------------------------

/**
 * 读文件前 12 字节判断是否为已知视频容器：
 * - MP4/MOV/M4V：bytes[4..7] == "ftyp"
 * - MKV/WEBM：bytes[0..3] == 1A 45 DF A3
 * - AVI：bytes[0..3] == "RIFF" 且 bytes[8..11] == "AVI "
 * 以 O_NONBLOCK 打开并对句柄 fstat，防止被替换成 FIFO/设备文件导致阻塞。
 */
async function checkVideoMagic(filePath: string): Promise<boolean> {
  let fh: FileHandle | undefined;
  try {
    fh = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    const st = await fh.stat();
    if (!st.isFile()) return false;
    const buf = Buffer.alloc(12);
    const { bytesRead } = await fh.read(buf, 0, 12, 0);
    if (bytesRead < 12) return false;
    if (buf.toString('latin1', 4, 8) === 'ftyp') return true;
    if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return true;
    if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'AVI ') return true;
    return false;
  } catch {
    return false;
  } finally {
    if (fh) await fh.close().catch(() => undefined);
  }
}

/** 扩展名白名单 + 普通文件 + 魔数校验。返回错误信息或 null。 */
async function validateVideoFile(p: string, label: string): Promise<string | null> {
  if (!hasAllowedExt(p, VIDEO_INPUT_EXTS)) {
    return `${label}扩展名不在白名单内（允许: ${[...VIDEO_INPUT_EXTS].join(' ')}）: ${p}`;
  }
  if (!(await fileExists(p))) return `${label}不存在或不是普通文件: ${p}`;
  if (!(await checkVideoMagic(p))) {
    return `${label}的文件头不是已知视频容器格式（MP4/MOV/M4V/MKV/WEBM/AVI），拒绝处理: ${p}`;
  }
  return null;
}

async function validateAudioFile(
  p: string,
): Promise<{ ok: true; duration: number } | { ok: false; error: string }> {
  if (!hasAllowedExt(p, AUDIO_INPUT_EXTS)) {
    return { ok: false, error: `音频扩展名不在白名单内（允许: ${[...AUDIO_INPUT_EXTS].join(' ')}）: ${p}` };
  }
  if (!(await fileExists(p))) return { ok: false, error: `音频文件不存在或不是普通文件: ${p}` };
  if (!(await hasBinary('ffprobe'))) return { ok: false, error: FFPROBE_MISSING };
  const hasAudio = await probeHasAudio(p);
  if (hasAudio !== true) return { ok: false, error: `ffprobe 未能从文件中探测到音频流，拒绝使用: ${p}` };
  const duration = await probeDuration(p);
  if (duration === null || duration <= 0) return { ok: false, error: `ffprobe 无法读取音频时长，拒绝使用: ${p}` };
  return { ok: true, duration };
}

// ---------------------------------------------------------------------------
// Project storage
// ---------------------------------------------------------------------------

async function projectsRoot(): Promise<string> {
  const home = String(await Promise.resolve(resolveArtemisHomeDir() ?? '')).trim();
  if (!home) throw new Error('无法确定 artemis 主目录（resolveArtemisHomeDir 返回空）');
  return path.join(home, 'timeline-projects');
}

async function projectDir(projectId: string): Promise<string> {
  const dir = path.join(await projectsRoot(), projectId);
  // 规范化符号链接/大小写别名；目录不存在时保持原路径（调用方会创建）
  return (await realpathOrNull(dir)) ?? dir;
}

// 注意：loadProject 本身不加锁。saveProject 以 "写临时文件 + rename" 原子替换，
// 因此无锁读取总能读到某个完整版本（只读场景安全）；读-改-写必须走 withTimelineLock。
async function loadProject(projectIdRaw: unknown): Promise<LoadResult> {
  if (!validId(projectIdRaw)) {
    return { ok: false, error: INVALID_ID_MSG };
  }
  const dir = await projectDir(projectIdRaw);
  const file = path.join(dir, 'timeline.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return { ok: false, error: `时间线项目不存在: ${projectIdRaw}（可先用 import_saga 创建）` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `timeline.json 解析失败: ${file}` };
  }
  const p = parsed as Partial<TimelineProject> | null;
  if (!p || typeof p !== 'object' || p.version !== 1 || !Array.isArray(p.segments)) {
    return { ok: false, error: `timeline.json 格式不支持: ${file}` };
  }
  for (const item of p.segments as unknown[]) {
    const s = item as Partial<TimelineSegment> | null;
    if (
      !s ||
      typeof s !== 'object' ||
      !Number.isInteger(s.index) ||
      typeof s.videoPath !== 'string' ||
      typeof s.duration !== 'number' ||
      !Number.isFinite(s.duration) ||
      s.duration < 0
    ) {
      return { ok: false, error: `timeline.json 片段数据损坏: ${file}` };
    }
  }
  const project = p as TimelineProject;
  if (project.projectId !== projectIdRaw) {
    return { ok: false, error: `timeline.json 内 projectId 与目录名不一致: ${file}` };
  }
  if (p.segments.length > 200) {
    return { ok: false, error: `timeline.json 片段数超限（>200）: ${file}` };
  }
  if (!Array.isArray(project.subtitles)) project.subtitles = [];
  if (project.subtitles.length > 2000) {
    return { ok: false, error: `timeline.json 字幕数超限（>2000）: ${file}` };
  }
  if (project.bgm && (typeof project.bgm.volumeDb !== 'number' || !Number.isFinite(project.bgm.volumeDb) ||
      project.bgm.volumeDb < -60 || project.bgm.volumeDb > 20)) {
    return { ok: false, error: `timeline.json BGM 数据损坏: ${file}` };
  }
  for (const item of project.subtitles as unknown[]) {
    const s = item as Partial<TimelineSubtitle> | null;
    if (
      !s ||
      typeof s !== 'object' ||
      typeof s.id !== 'string' ||
      typeof s.text !== 'string' ||
      typeof s.start !== 'number' ||
      typeof s.end !== 'number' ||
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.end)
    ) {
      return { ok: false, error: `timeline.json 字幕数据损坏: ${file}` };
    }
  }
  return { ok: true, project, dir };
}

async function saveProject(dir: string, project: TimelineProject): Promise<void> {
  project.updatedAt = new Date().toISOString();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'timeline.json');
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(project, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cross-process lock for timeline.json
// ---------------------------------------------------------------------------

type LockInfo = { token: string; pid: number; hostname: string; createdAt: string };
type HeldLock = { lockFile: string; token: string };

function parseLock(raw: string): LockInfo | null {
  try {
    const v = JSON.parse(raw) as Partial<LockInfo> | null;
    if (
      v &&
      typeof v === 'object' &&
      typeof v.token === 'string' &&
      typeof v.pid === 'number' &&
      typeof v.hostname === 'string' &&
      typeof v.createdAt === 'string'
    ) {
      return v as LockInfo;
    }
  } catch {
    // fallthrough
  }
  return null;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但无权发信号，仍视为存活；其余（ESRCH）视为不存在。
    return errCode(err) === 'EPERM';
  }
}

function isStaleLock(info: LockInfo): boolean {
  const created = Date.parse(info.createdAt);
  if (!Number.isFinite(created) || Math.abs(Date.now() - created) > LOCK_STALE_MS) return true;
  if (info.hostname === os.hostname() && info.pid !== process.pid && !pidAlive(info.pid)) return true;
  return false;
}

/**
 * 仅在锁文件 token 与 expectedToken 一致时删除（expectedToken 为 null 表示"预期内容不可解析"）。
 * 先原子 rename 到唯一的墓碑名再核对内容，避免"读后删"之间锁被别人换掉而误删；
 * 若发现拿到的是别人的新锁，用 link 尽力原样放回。
 */
async function removeLockIfToken(lockFile: string, expectedToken: string | null): Promise<boolean> {
  const grave = `${lockFile}.${randomUUID()}.del`;
  try {
    await fs.rename(lockFile, grave);
  } catch {
    return false;
  }
  let info: LockInfo | null = null;
  try {
    info = parseLock(await fs.readFile(grave, 'utf8'));
  } catch {
    info = null;
  }
  const match = expectedToken === null ? info === null : info?.token === expectedToken;
  if (!match) {
    await fs.link(grave, lockFile).catch(() => undefined);
  }
  await fs.rm(grave, { force: true }).catch(() => undefined);
  return match;
}

async function acquireLock(dir: string): Promise<HeldLock> {
  const lockFile = path.join(dir, LOCK_FILE_NAME);
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && Date.now() > deadline) {
      throw new TimelineError(
        `获取时间线锁超时（${LOCK_TIMEOUT_MS / 1000}s），可能有其他进程正在修改该项目，请稍后重试: ${lockFile}`,
      );
    }
    // 每次尝试都重新生成 createdAt，避免长时间等待后拿到的锁"出生即过期"。
    const content = JSON.stringify({
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    });
    try {
      await fs.writeFile(lockFile, content, { encoding: 'utf8', flag: 'wx' });
      return { lockFile, token };
    } catch (err) {
      if (errCode(err) !== 'EEXIST') throw err;
    }

    let raw: string;
    let mtimeMs: number;
    try {
      raw = await fs.readFile(lockFile, 'utf8');
      mtimeMs = (await fs.stat(lockFile)).mtimeMs;
    } catch (err) {
      if (errCode(err) !== 'ENOENT') await sleep(LOCK_RETRY_MS);
      continue; // ENOENT：锁刚被释放，立即重试
    }

    const info = parseLock(raw);
    const stale = info ? isStaleLock(info) : Date.now() - mtimeMs > LOCK_PARSE_GRACE_MS;
    if (stale) {
      const removed = await removeLockIfToken(lockFile, info ? info.token : null);
      if (!removed) await sleep(LOCK_RETRY_MS);
      continue;
    }
    await sleep(LOCK_RETRY_MS);
  }
}

async function releaseLock(lock: HeldLock): Promise<void> {
  await removeLockIfToken(lock.lockFile, lock.token).catch(() => undefined);
}

/** 对目录加锁执行 fn。目录必须已存在。锁内只做短操作（不跑 ffmpeg），避免超过 60s 被判过期。 */
async function withDirLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(dir);
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}

/** 加锁 → 重新读取 timeline.json → 执行 fn → 释放锁。加载失败抛 TimelineError。 */
async function withTimelineLock<T>(
  projectId: string,
  fn: (ctx: { project: TimelineProject; dir: string }) => Promise<T>,
): Promise<T> {
  if (!validId(projectId)) throw new TimelineError(INVALID_ID_MSG);
  const dir = await projectDir(projectId);
  if (!(await isDirectory(dir))) {
    throw new TimelineError(`时间线项目不存在: ${projectId}（可先用 import_saga 创建）`);
  }
  return withDirLock(dir, async () => {
    const loaded = await loadProject(projectId);
    if (!loaded.ok) throw new TimelineError(loaded.error);
    return fn({ project: loaded.project, dir: loaded.dir });
  });
}

// ---------------------------------------------------------------------------
// Timeline helpers
// ---------------------------------------------------------------------------

function sortedSegments(project: TimelineProject): TimelineSegment[] {
  return [...project.segments].sort((x, y) => x.index - y.index);
}

function totalDuration(project: TimelineProject): number {
  return round3(project.segments.reduce((sum, s) => sum + (Number.isFinite(s.duration) ? s.duration : 0), 0));
}

function segmentOffsets(project: TimelineProject): Map<number, { startAt: number; endAt: number }> {
  const map = new Map<number, { startAt: number; endAt: number }>();
  let cursor = 0;
  for (const s of sortedSegments(project)) {
    const startAt = round3(cursor);
    cursor += s.duration;
    map.set(s.index, { startAt, endAt: round3(cursor) });
  }
  return map;
}

function findSegment(project: TimelineProject, idxRaw: unknown): TimelineSegment | string {
  const idx = int(idxRaw);
  if (idx === undefined) return 'segmentIndex 必须是整数';
  const seg = project.segments.find((s) => s.index === idx);
  if (!seg) {
    const available = sortedSegments(project).map((s) => s.index).join(', ');
    return `segmentIndex ${idx} 不存在（可用: ${available || '无'}）`;
  }
  return seg;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

// list_segments 只读：不加锁。saveProject 以 rename 原子替换 timeline.json，
// 无锁读取最多读到稍旧但完整的版本，不会读到半写文件。
async function listSegments(a: Args): Promise<Result> {
  const loaded = await loadProject(a.projectId);
  if (!loaded.ok) return fail('list_segments', loaded.error);
  const { project } = loaded;
  const offsets = segmentOffsets(project);
  const segments = [];
  for (const s of sortedSegments(project)) {
    const off = offsets.get(s.index);
    segments.push({
      index: s.index,
      title: s.title,
      duration: s.duration,
      startAt: off?.startAt ?? 0,
      endAt: off?.endAt ?? s.duration,
      videoPath: s.videoPath,
      exists: await fileExists(s.videoPath),
      trimmed: s.trimmed,
      ...(s.trimmed ? { trimStart: s.trimStart, trimEnd: s.trimEnd, originalDuration: s.originalDuration } : {}),
      ...(s.pendingPrompt ? { pendingPrompt: s.pendingPrompt } : {}),
    });
  }
  return {
    action: 'list_segments',
    ok: true,
    projectId: project.projectId,
    ratio: project.ratio,
    resolution: `${project.width}x${project.height}`,
    fps: project.fps,
    segmentCount: segments.length,
    totalDuration: totalDuration(project),
    segments,
    subtitles: [...project.subtitles].sort((x, y) => x.start - y.start),
    bgm: project.bgm ?? null,
    lastRender: project.lastRender ?? null,
    sourceSagaProjectId: project.sourceSagaProjectId ?? null,
  };
}

async function replaceSegment(a: Args, cwd: string): Promise<Result> {
  const act = 'replace_segment';
  const pid = a.projectId;
  if (!validId(pid)) return fail(act, INVALID_ID_MSG);
  // 无锁预检：尽早报告项目/片段不存在，避免白跑探测。真正修改在锁内重新读取后进行。
  const snap = await loadProject(pid);
  if (!snap.ok) return fail(act, snap.error);
  const snapSeg = findSegment(snap.project, a.segmentIndex);
  if (typeof snapSeg === 'string') return fail(act, snapSeg);

  if (isNonEmptyString(a.newVideoPath)) {
    const newPath = resolveUserPath(a.newVideoPath, cwd);
    const bad = await validateVideoFile(newPath, '视频文件');
    if (bad) return fail(act, bad);
    if (!(await hasBinary('ffprobe'))) return fail(act, FFPROBE_MISSING);
    const info = await probeVideoInfo(newPath);
    if (!info) return fail(act, `ffprobe 未能从文件中探测到视频流，拒绝替换: ${newPath}`);
    // 探测在锁外完成（可能较慢），锁内只做内存修改与落盘。
    const probed = await probeDuration(newPath);

    return withTimelineLock<Result>(pid, async ({ project, dir }) => {
      const seg = findSegment(project, a.segmentIndex);
      if (typeof seg === 'string') return fail(act, seg);
      const warnings: string[] = [];
      const oldPath = seg.videoPath;
      const oldDuration = seg.duration;
      if (probed === null) warnings.push('ffprobe 未能读取时长，沿用原时长');
      seg.videoPath = newPath;
      seg.duration = probed ?? oldDuration;
      seg.originalDuration = seg.duration;
      seg.trimmed = false;
      delete seg.trimStart;
      delete seg.trimEnd;
      if (seg.pendingPrompt) {
        seg.prompt = seg.pendingPrompt;
        delete seg.pendingPrompt;
      }
      const total = totalDuration(project);
      // M6: 片段时长变化后，自动平移该片段起点之后的字幕
      const segStart = segmentOffsets(project).get(seg.index)?.startAt ?? 0;
      const delta = round3(seg.duration - oldDuration);
      let shifted = 0;
      if (Math.abs(delta) > 0.05) {
        for (const sub of project.subtitles) {
          if (sub.start >= segStart) {
            sub.start = round3(Math.max(0, sub.start + delta));
            sub.end = round3(Math.max(sub.start + 0.1, sub.end + delta));
            shifted++;
          }
        }
        project.subtitles.sort((x, y) => x.start - y.start);
      }
      if (shifted > 0) warnings.push(`片段时长变化 ${fmt(delta)}s，已自动平移其后的 ${shifted} 条字幕`);
      const outOfRange = project.subtitles.filter((s) => s.end > total + 0.05).length;
      if (outOfRange > 0) warnings.push(`${outOfRange} 条字幕超出新总时长，渲染时将被截断`);
      await saveProject(dir, project);
      return {
        action: act,
        ok: true,
        projectId: project.projectId,
        segmentIndex: seg.index,
        oldVideoPath: oldPath,
        videoPath: seg.videoPath,
        oldDuration,
        duration: seg.duration,
        totalDuration: total,
        ...(warnings.length ? { warnings } : {}),
      };
    });
  }

  if (isNonEmptyString(a.newPrompt)) {
    const prompt = a.newPrompt.trim();
    if (prompt.length > MAX_PROMPT_LEN) return fail(act, `newPrompt 过长（>${MAX_PROMPT_LEN} 字符）`);
    return withTimelineLock<Result>(pid, async ({ project, dir }) => {
      const seg = findSegment(project, a.segmentIndex);
      if (typeof seg === 'string') return fail(act, seg);
      seg.pendingPrompt = prompt;
      await saveProject(dir, project);
      return {
        action: act,
        ok: true,
        projectId: project.projectId,
        segmentIndex: seg.index,
        needsGeneration: true,
        prompt,
        previousPrompt: seg.prompt,
        suggestedDuration: seg.duration,
        ratio: project.ratio,
        nextStep: `先用 generate_video 按该 prompt 生成约 ${fmt(seg.duration)}s、${project.ratio} 的视频，再调用 edit_timeline replace_segment 传入 newVideoPath`,
      };
    });
  }

  return fail(act, '需要提供 newVideoPath 或 newPrompt');
}

async function trimSegment(a: Args): Promise<Result> {
  const act = 'trim_segment';
  const pid = a.projectId;
  if (!validId(pid)) return fail(act, INVALID_ID_MSG);
  // 无锁读取快照：ffmpeg 裁剪可能耗时数分钟，不能持锁执行（锁 60s 即视为过期）。
  // 提交时在锁内重新读取，并校验片段未被并发修改（乐观并发控制）。
  const snap = await loadProject(pid);
  if (!snap.ok) return fail(act, snap.error);
  const seg = findSegment(snap.project, a.segmentIndex);
  if (typeof seg === 'string') return fail(act, seg);

  const start = num(a.start);
  const end = num(a.end);
  if (start === undefined || end === undefined) return fail(act, 'start 和 end 必须是数字（秒，相对片段开头）');
  if (start < 0) return fail(act, 'start 不能小于 0');
  if (end <= start) return fail(act, 'end 必须大于 start');
  if (end > seg.duration + 0.05) return fail(act, `end 超出片段时长 ${fmt(seg.duration)}s`);
  const clampedEnd = Math.min(end, seg.duration);
  const len = round3(clampedEnd - start);
  if (len < 0.1) return fail(act, '裁剪后时长过短（<0.1s）');

  if (!(await hasBinary('ffmpeg'))) return fail(act, FFMPEG_MISSING);
  const srcPath = seg.videoPath;
  if (!(await fileExists(srcPath))) return fail(act, `片段视频文件不存在: ${srcPath}`);
  const bad = await validateVideoFile(srcPath, '片段视频文件');
  if (bad) return fail(act, bad);
  const srcDuration = seg.duration;
  const srcTrimStart = seg.trimStart ?? 0;
  const segIndex = seg.index;

  const segDir = path.join(snap.dir, 'segments');
  await fs.mkdir(segDir, { recursive: true });
  const out = path.join(segDir, `seg-${segIndex}-trimmed-${timestamp()}-${randomUUID().slice(0, 8)}.mp4`);
  const removeOut = (): Promise<void> => fs.rm(out, { force: true }).catch(() => undefined);
  const base = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-protocol_whitelist', 'file',
    '-ss', fmt(start), '-i', srcPath,
    '-t', fmt(len),
  ];

  let method: 'copy' | 'reencode' = 'copy';
  let copyOk = false;
  try {
    await run(binPath('ffmpeg'), [...base, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', out]);
    const d = await probeDuration(out);
    // Stream copy cuts on keyframes; re-encode if the result drifts noticeably.
    copyOk = (await fileSize(out)) > 0 && d !== null && Math.abs(d - len) <= Math.max(0.5, len * 0.05);
  } catch {
    copyOk = false;
  }

  if (!copyOk) {
    method = 'reencode';
    try {
      await run(binPath('ffmpeg'), [
        ...base,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        out,
      ]);
    } catch (err) {
      await removeOut();
      return fail(act, `ffmpeg 裁剪失败: ${errorText(err)}`);
    }
  }

  const probed = await probeDuration(out);

  try {
    return await withTimelineLock<Result>(pid, async ({ project, dir }) => {
      const cur = findSegment(project, segIndex);
      if (typeof cur === 'string') {
        await removeOut();
        return fail(act, cur);
      }
      if (cur.videoPath !== srcPath || cur.duration !== srcDuration || (cur.trimStart ?? 0) !== srcTrimStart) {
        await removeOut();
        return fail(act, '片段在裁剪期间已被其他操作修改，已放弃本次裁剪，请重新执行');
      }
      const prevPath = cur.videoPath;
      // M8: 若被替换的旧文件在项目 segments/ 目录内，删除以防磁盘膨胀
      try {
        const segDir = path.join(dir, 'segments') + path.sep;
        if (prevPath.startsWith(segDir)) await fs.rm(prevPath, { force: true }).catch(() => undefined);
      } catch { /* best effort */ }
      cur.trimStart = round3(srcTrimStart + start);
      cur.trimEnd = round3(srcTrimStart + clampedEnd);
      cur.videoPath = out;
      cur.duration = probed ?? len;
      cur.trimmed = true;

      const warnings: string[] = [];
      const total = totalDuration(project);
      const segStart = segmentOffsets(project).get(cur.index)?.startAt ?? 0;
      // M6: 片段时长变化后，自动平移该片段起点之后的字幕，保持相对位置
      const delta = round3(cur.duration - srcDuration);
      let shifted = 0;
      if (Math.abs(delta) > 0.001) {
        for (const sub of project.subtitles) {
          if (sub.start >= segStart) {
            sub.start = round3(Math.max(0, sub.start + delta));
            sub.end = round3(Math.max(sub.start + 0.1, sub.end + delta));
            shifted++;
          }
        }
        project.subtitles.sort((x, y) => x.start - y.start);
      }
      if (shifted > 0) warnings.push(`片段时长变化 ${fmt(delta)}s，已自动平移其后的 ${shifted} 条字幕`);
      if (method === 'reencode') warnings.push('流复制不精确或失败，已重新编码');

      await saveProject(dir, project);
      return {
        action: act,
        ok: true,
        projectId: project.projectId,
        segmentIndex: cur.index,
        method,
        previousVideoPath: prevPath,
        videoPath: out,
        duration: cur.duration,
        trimStart: cur.trimStart,
        trimEnd: cur.trimEnd,
        totalDuration: total,
        ...(warnings.length ? { warnings } : {}),
      };
    });
  } catch (err) {
    await removeOut();
    throw err;
  }
}

async function addSubtitle(a: Args): Promise<Result> {
  const act = 'add_subtitle';
  const pid = a.projectId;
  if (!validId(pid)) return fail(act, INVALID_ID_MSG);
  // 全部为内存操作，整体在锁内完成。
  return withTimelineLock<Result>(pid, async ({ project, dir }) => {
    if (!isNonEmptyString(a.text)) return fail(act, 'text 不能为空');
    const text = a.text.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim();
    if (text.length > 500) return fail(act, '字幕文本过长（>500 字符）');

    const start = num(a.start);
    const end = num(a.end);
    if (start === undefined || end === undefined) return fail(act, 'start 和 end 必须是数字（秒，成片绝对时间）');
    const total = totalDuration(project);
    if (start < 0) return fail(act, 'start 不能小于 0');
    if (end <= start) return fail(act, 'end 必须大于 start');
    if (end > total + 0.05) return fail(act, `end 超出总时长 ${fmt(total)}s`);

    const offsets = segmentOffsets(project);
    let segmentIndex: number;
    if (a.segmentIndex !== undefined && a.segmentIndex !== null) {
      const seg = findSegment(project, a.segmentIndex);
      if (typeof seg === 'string') return fail(act, seg);
      segmentIndex = seg.index;
    } else {
      let found: number | undefined;
      for (const [idx, off] of offsets) {
        if (start >= off.startAt && start < off.endAt) {
          found = idx;
          break;
        }
      }
      segmentIndex = found ?? sortedSegments(project).at(-1)?.index ?? 0;
    }

    const subtitle: TimelineSubtitle = {
      id: `sub-${randomUUID().slice(0, 8)}`,
      segmentIndex,
      text,
      start: round3(start),
      end: round3(Math.min(end, total)),
    };
    project.subtitles.push(subtitle);
    project.subtitles.sort((x, y) => x.start - y.start);

    const overlaps = project.subtitles.filter(
      (s) => s.id !== subtitle.id && s.start < subtitle.end && s.end > subtitle.start,
    ).length;

    await saveProject(dir, project);
    return {
      action: act,
      ok: true,
      projectId: project.projectId,
      subtitle,
      subtitleCount: project.subtitles.length,
      ...(overlaps > 0 ? { warnings: [`与 ${overlaps} 条已有字幕时间重叠`] } : {}),
    };
  });
}

async function removeSubtitle(a: Args): Promise<Result> {
  const act = 'remove_subtitle';
  const pid = a.projectId;
  if (!validId(pid)) return fail(act, INVALID_ID_MSG);
  return withTimelineLock<Result>(pid, async ({ project, dir }) => {
    if (!isNonEmptyString(a.subtitleId)) return fail(act, 'subtitleId 不能为空');
    const id = a.subtitleId.trim();
    const idx = project.subtitles.findIndex((s) => s.id === id);
    if (idx < 0) return fail(act, `字幕不存在: ${id}`);
    const [removed] = project.subtitles.splice(idx, 1);
    await saveProject(dir, project);
    return { action: act, ok: true, projectId: project.projectId, removed, subtitleCount: project.subtitles.length };
  });
}

async function setBgm(a: Args, cwd: string): Promise<Result> {
  const act = 'set_bgm';
  const pid = a.projectId;
  if (!validId(pid)) return fail(act, INVALID_ID_MSG);
  const snap = await loadProject(pid);
  if (!snap.ok) return fail(act, snap.error);

  if (a.removeBgm === true) {
    return withTimelineLock<Result>(pid, async ({ project, dir }) => {
      const had = Boolean(project.bgm);
      delete project.bgm;
      await saveProject(dir, project);
      return { action: act, ok: true, projectId: project.projectId, removed: had, bgm: null };
    });
  }

  if (!isNonEmptyString(a.audioPath)) return fail(act, 'audioPath 不能为空');
  const audioPath = resolveUserPath(a.audioPath, cwd);
  // 类型白名单 + ffprobe 探测在锁外完成。
  const audio = await validateAudioFile(audioPath);
  if (!audio.ok) return fail(act, audio.error);
  const audioDuration = audio.duration;

  return withTimelineLock<Result>(pid, async ({ project, dir }) => {
    const volumeDb = num(a.volumeDb) ?? project.bgm?.volumeDb ?? -12;
    const fadeInSec = num(a.fadeInSec) ?? project.bgm?.fadeInSec ?? 1;
    const fadeOutSec = num(a.fadeOutSec) ?? project.bgm?.fadeOutSec ?? 2;
    const startSec = num(a.startSec) ?? 0;
    if (volumeDb < -60 || volumeDb > 20) return fail(act, 'volumeDb 需在 -60 到 20 之间');
    if (fadeInSec < 0 || fadeOutSec < 0) return fail(act, 'fadeInSec/fadeOutSec 不能为负');
    const total = totalDuration(project);
    if (startSec < 0) return fail(act, 'startSec 不能为负');
    if (total > 0 && startSec >= total) return fail(act, `startSec 超出总时长 ${fmt(total)}s`);

    project.bgm = {
      audioPath,
      volumeDb: round3(volumeDb),
      fadeInSec: round3(fadeInSec),
      fadeOutSec: round3(fadeOutSec),
      startSec: round3(startSec),
    };
    await saveProject(dir, project);
    return {
      action: act,
      ok: true,
      projectId: project.projectId,
      bgm: project.bgm,
      audioDuration,
      totalDuration: total,
      note: 'BGM 将在 render 时混音（不足时循环）',
    };
  });
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

function buildSrt(subs: TimelineSubtitle[]): string {
  return subs
    .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`)
    .join('\n');
}

/** 烧录字幕前转义 libass 样式覆盖块 `{...}`，防样式注入。软字幕（mov_text）不受影响。 */
function escapeLibass(text: string): string {
  return text.replace(/\{/g, '\\{').replace(/\}/g, '\\}');
}

function escapeConcatPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

async function normalizeSegment(input: string, output: string, target: VideoInfo): Promise<void> {
  const { width: w, height: h, fps } = target;
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p`;
  const hasAudio = await probeHasAudio(input);
  const tries = hasAudio === null ? [true, false] : [hasAudio];
  let lastErr: unknown = new Error('normalize failed');
  for (const withAudio of tries) {
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', input];
    if (!withAudio) {
      args.push('-protocol_whitelist', 'file', '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    }
    args.push('-map', '0:v:0', '-map', withAudio ? '0:a:0' : '1:a:0', '-vf', vf);
    if (withAudio) args.push('-af', 'aresample=48000,apad');
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-shortest', '-movflags', '+faststart', output,
    );
    try {
      await run(binPath('ffmpeg'), args);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function finalPass(p: {
  input: string;
  output: string;
  workDir: string;
  duration: number;
  srtName: string | null;
  bgm: TimelineBgm | null;
  burn: boolean;
  legacyAmix: boolean;
}): Promise<void> {
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-i', p.input];
  let nextInput = 1;
  let bgmIdx = -1;
  let subIdx = -1;
  if (p.bgm) {
    args.push('-protocol_whitelist', 'file', '-stream_loop', '-1', '-i', p.bgm.audioPath);
    bgmIdx = nextInput++;
  }
  if (p.srtName && !p.burn) {
    args.push('-protocol_whitelist', 'file', '-i', p.srtName);
    subIdx = nextInput++;
  }

  const filters: string[] = [];
  let vMap = '0:v:0';
  let aMap = '0:a:0';
  if (p.srtName && p.burn) {
    filters.push(`[0:v]subtitles=${p.srtName}[vout]`);
    vMap = '[vout]';
  }
  if (p.bgm) {
    const startSec = Math.min(p.bgm.startSec, Math.max(0, p.duration - 0.1));
    const len = Math.max(0.1, p.duration - startSec);
    const fi = Math.min(p.bgm.fadeInSec, len);
    const fo = Math.min(p.bgm.fadeOutSec, len);
    const chain = [
      `atrim=0:${fmt(len)}`,
      'asetpts=PTS-STARTPTS',
      'aformat=sample_rates=48000:channel_layouts=stereo',
      `volume=${fmt(p.bgm.volumeDb)}dB`,
    ];
    if (fi > 0) chain.push(`afade=t=in:st=0:d=${fmt(fi)}`);
    if (fo > 0) chain.push(`afade=t=out:st=${fmt(Math.max(0, len - fo))}:d=${fmt(fo)}`);
    if (startSec > 0) {
      const ms = Math.round(startSec * 1000);
      chain.push(`adelay=${ms}|${ms}`);
    }
    filters.push(`[${bgmIdx}:a]${chain.join(',')}[bgm]`);
    const mix = p.legacyAmix
      ? 'amix=inputs=2:duration=first:dropout_transition=0,volume=2'
      : 'amix=inputs=2:duration=first:dropout_transition=0:normalize=0';
    filters.push(`[0:a][bgm]${mix}[aout]`);
    aMap = '[aout]';
  }

  if (filters.length) args.push('-filter_complex', filters.join(';'));
  args.push('-map', vMap, '-map', aMap);
  if (subIdx >= 0) args.push('-map', `${subIdx}:s:0`, '-c:s', 'mov_text');
  if (p.srtName && p.burn) {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p');
  } else {
    args.push('-c:v', 'copy');
  }
  if (p.bgm) args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  else args.push('-c:a', 'copy');
  args.push('-movflags', '+faststart', p.output);
  await run(binPath('ffmpeg'), args, { cwd: p.workDir });
}

/** rename；跨文件系统（EXDEV）时退化为"拷到目标同目录临时名 → rename"。 */
async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
    return;
  } catch (err) {
    if (errCode(err) !== 'EXDEV') throw err;
  }
  const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.${randomUUID()}.tmp`);
  try {
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await fs.rm(src, { force: true }).catch(() => undefined);
}

/**
 * 把 workDir 中渲染好的临时文件放到最终位置。
 * overwrite=false：优先用 link 实现原子"不存在才创建"（EEXIST 即拒绝）；不支持硬链接时退化为检查后 rename。
 * overwrite=true：rename 原子替换。
 */
async function placeOutput(tmp: string, finalPath: string, overwrite: boolean): Promise<void> {
  if (overwrite) {
    await moveFile(tmp, finalPath);
    return;
  }
  try {
    await fs.link(tmp, finalPath);
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    return;
  } catch (err) {
    if (errCode(err) === 'EEXIST') {
      throw new TimelineError(`输出文件已存在: ${finalPath}（传 overwrite: true 覆盖）`);
    }
  }
  if (await pathExists(finalPath)) {
    throw new TimelineError(`输出文件已存在: ${finalPath}（传 overwrite: true 覆盖）`);
  }
  await moveFile(tmp, finalPath);
}

async function render(a: Args): Promise<Result> {
  const act = 'render';
  const pid = a.projectId;
  if (!validId(pid)) return fail(act, INVALID_ID_MSG);
  // 渲染可能持续数十分钟，不能持锁（锁 60s 视为过期）。这里无锁读取一致快照
  //（saveProject 原子 rename 保证读到完整版本），收尾时再加锁、重新加载、只回写 lastRender。
  const loaded = await loadProject(pid);
  if (!loaded.ok) return fail(act, loaded.error);
  const { project, dir } = loaded;
  const snapshotUpdatedAt = project.updatedAt;

  if (!(await hasBinary('ffmpeg'))) return fail(act, FFMPEG_MISSING);
  const segs = sortedSegments(project);
  if (segs.length === 0) return fail(act, '项目没有任何片段');
  for (const s of segs) {
    // 纵深防御：对旧版本写入的 timeline.json 也复检类型白名单与魔数。
    const bad = await validateVideoFile(s.videoPath, `片段 ${s.index} 视频`);
    if (bad) return fail(act, bad);
  }

  const warnings: string[] = [];
  const subtitleMode = a.subtitleMode === 'soft' ? 'soft' : 'burn';
  const overwrite = a.overwrite === true;
  const ts = timestamp();

  // ---- 输出路径：强制位于 <projectDir>/outputs/，只取用户传入值的 basename ----
  const outputsDir = path.join(dir, 'outputs');
  let fileName = `${pid}-final-${ts}.mp4`;
  if (isNonEmptyString(a.outputPath)) {
    const raw = a.outputPath.trim();
    // win32.basename 同时按 / 与 \ 切分并去掉盘符，彻底丢弃目录部分。
    const base = path.win32.basename(raw);
    if (!OUTPUT_NAME_RE.test(base)) {
      return fail(
        act,
        `outputPath 文件名不合法: ${tail(base || raw, 80)}（仅允许字母、数字、空格及 . _ ( ) -，不能以 . 或 - 开头，最长200）`,
      );
    }
    if (base !== raw) warnings.push(`输出已限制在项目 outputs 目录内，已忽略 outputPath 中的目录部分（文件名: ${base}）`);
    fileName = base;
  }
  let ext = extOf(fileName);
  if (!ext) {
    fileName += '.mp4';
    ext = '.mp4';
  } else if (!OUTPUT_EXTS.has(ext)) {
    return fail(act, `不支持的输出扩展名 ${ext}（仅允许 .mp4 / .mov / .m4v）`);
  }
  const outputPath = path.join(outputsDir, fileName);

  await fs.mkdir(outputsDir, { recursive: true });
  let outputsStat;
  try {
    outputsStat = await fs.lstat(outputsDir);
  } catch (err) {
    return fail(act, `无法访问输出目录: ${errorText(err)}`);
  }
  if (!outputsStat.isDirectory()) {
    return fail(act, `输出目录不是普通目录（可能是符号链接），拒绝写入: ${outputsDir}`);
  }
  if (!overwrite && (await pathExists(outputPath))) {
    return fail(act, `输出文件已存在: ${outputPath}（传 overwrite: true 覆盖）`);
  }
  const sourcePaths = new Set<string>(segs.map((s) => path.resolve(s.videoPath)));
  if (project.bgm) sourcePaths.add(path.resolve(project.bgm.audioPath));
  if (sourcePaths.has(path.resolve(outputPath))) {
    return fail(act, `输出路径与项目素材文件相同，拒绝覆盖: ${outputPath}`);
  }

  const width = num(project.width);
  const height = num(project.height);
  const fps = num(project.fps);
  const target: VideoInfo = {
    width: even(Math.min(width !== undefined && width > 0 ? width : 1920, MAX_RENDER_DIM)),
    height: even(Math.min(height !== undefined && height > 0 ? height : 1080, MAX_RENDER_DIM)),
    fps: fps !== undefined && fps > 0 && fps <= 240 ? fps : 30,
  };
  const workDir = path.join(dir, `.render-${ts}-${randomUUID().slice(0, 8)}`);
  await fs.mkdir(workDir, { recursive: true });
  // 先渲染到 workDir 内的临时文件（扩展名与目标一致以选择正确 muxer），成功后再原子移动。
  const tmpOut = path.join(workDir, `final${ext}`);

  try {
    const normalized: string[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg) continue;
      const out = path.join(workDir, `norm-${pad(i, 3)}.mp4`);
      try {
        await normalizeSegment(seg.videoPath, out, target);
      } catch (err) {
        return fail(act, `片段 ${seg.index} 预处理失败: ${errorText(err)}`);
      }
      normalized.push(out);
    }

    const listFile = path.join(workDir, 'concat.txt');
    await fs.writeFile(listFile, `${normalized.map((p) => `file '${escapeConcatPath(p)}'`).join('\n')}\n`, 'utf8');
    const concatOut = path.join(workDir, 'concat.mp4');
    try {
      await run(binPath('ffmpeg'), [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-protocol_whitelist', 'file,concat',
        '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c', 'copy', '-movflags', '+faststart', concatOut,
      ]);
    } catch (err) {
      return fail(act, `拼接失败: ${errorText(err)}`);
    }
    const concatDuration = (await probeDuration(concatOut)) ?? totalDuration(project);

    const subs = project.subtitles
      .filter((s) => s.start < concatDuration)
      .map((s) => ({ ...s, end: Math.min(s.end, concatDuration) }))
      .sort((x, y) => x.start - y.start);
    if (subs.length < project.subtitles.length) {
      warnings.push(`${project.subtitles.length - subs.length} 条字幕超出成片时长，已忽略`);
    }

    let bgm: TimelineBgm | null = project.bgm ?? null;
    if (bgm && (!hasAllowedExt(bgm.audioPath, AUDIO_INPUT_EXTS) || !(await fileExists(bgm.audioPath)))) {
      warnings.push(`BGM 文件不存在或类型不受支持，已跳过: ${bgm.audioPath}`);
      bgm = null;
    }

    let subtitleResult: 'none' | 'burned' | 'soft' = 'none';
    if (subs.length === 0 && !bgm) {
      await fs.copyFile(concatOut, tmpOut);
    } else {
      let srtName: string | null = null;
      if (subs.length > 0) {
        srtName = 'subtitles.srt';
        await fs.writeFile(path.join(workDir, srtName), buildSrt(subs), 'utf8');
        // 烧录用转义版（防 libass 样式注入）；软字幕走 mov_text 不受影响
        const escaped = subs.map((x) => ({ ...x, text: escapeLibass(x.text) }));
        await fs.writeFile(path.join(workDir, 'subtitles_burn.srt'), buildSrt(escaped), 'utf8');
      }
      const burnModes = srtName ? (subtitleMode === 'soft' ? [false] : [true, false]) : [false];
      const amixModes = bgm ? [false, true] : [false];
      const errors: string[] = [];
      let done = false;
      for (const burn of burnModes) {
        for (const legacyAmix of amixModes) {
          try {
            await finalPass({ input: concatOut, output: tmpOut, workDir, duration: concatDuration, srtName: burn ? 'subtitles_burn.srt' : srtName, bgm, burn, legacyAmix });
            done = true;
            if (srtName) {
              subtitleResult = burn ? 'burned' : 'soft';
              if (!burn && subtitleMode === 'burn') warnings.push('字幕烧录失败（可能缺少 libass），已改为内封软字幕');
            }
            break;
          } catch (err) {
            errors.push(errorText(err));
          }
        }
        if (done) break;
      }
      if (!done) return fail(act, `合成失败（${errors.length} 种组合均失败）: ${errors.join(' ｜ ') || '未知错误'}`);
    }

    const duration = (await probeDuration(tmpOut)) ?? concatDuration;
    try {
      await placeOutput(tmpOut, outputPath, overwrite);
    } catch (err) {
      return fail(act, err instanceof TimelineError ? err.message : `写入输出文件失败: ${errorText(err)}`);
    }

    // 收尾回写：加锁并重新加载最新 timeline.json，只 patch lastRender，不用渲染开始时的旧对象覆盖。
    const lastRender = { outputPath, duration, renderedAt: new Date().toISOString() };
    let changedDuringRender = false;
    try {
      await withTimelineLock(pid, async ({ project: fresh, dir: freshDir }) => {
        changedDuringRender = fresh.updatedAt !== snapshotUpdatedAt;
        fresh.lastRender = lastRender;
        await saveProject(freshDir, fresh);
      });
    } catch (err) {
      warnings.push(`成片已生成，但回写 lastRender 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (changedDuringRender) warnings.push('渲染期间项目已被修改，本次成片基于渲染开始时的版本');

    return {
      action: act,
      ok: true,
      projectId: project.projectId,
      outputPath,
      duration,
      segmentCount: segs.length,
      resolution: `${target.width}x${target.height}`,
      subtitles: subtitleResult,
      subtitleCount: subs.length,
      bgm: bgm ? bgm.audioPath : null,
      ...(warnings.length ? { warnings } : {}),
    };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// import_saga
// ---------------------------------------------------------------------------

type ImportEntry = { index: number; title: string; videoPath: string; prompt: string; duration?: number };

function findSegmentsArray(value: unknown, depth: number): Array<Partial<SagaSegmentInput>> | null {
  if (!value || typeof value !== 'object' || depth < 0) return null;
  const obj = value as Record<string, unknown>;
  const segs = obj.segments;
  if (Array.isArray(segs) && segs.some((s) => s && typeof s === 'object' && (isNonEmptyString((s as Record<string, unknown>).outputPath) || isNonEmptyString((s as Record<string, unknown>).mediaPath)))) {
    return segs.filter((s) => s && typeof s === 'object') as Array<Partial<SagaSegmentInput>>;
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findSegmentsArray(v, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 解析 Saga 清单。清单中的路径同样视为不可信：解析符号链接后必须位于媒体输出根目录或 Saga 目录内。
 */
async function readSagaManifest(
  sagaDir: string,
  jsonFiles: string[],
  roots: string[],
): Promise<{ entries: ImportEntry[]; rejected: number }> {
  let rejected = 0;
  for (const file of jsonFiles.slice(0, 20)) {
    if ((await fileSize(file)) > 5 * 1024 * 1024) continue;
    let data: unknown;
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    const segs = findSegmentsArray(data, 3);
    if (!segs) continue;
    const entries: ImportEntry[] = [];
    rejected = 0;
    const limit = Math.min(segs.length, MAX_IMPORT_SEGMENTS);
    for (let i = 0; i < limit; i++) {
      const s = segs[i];
      if (!s) continue;
      const candidates = [s.outputPath, s.mediaPath].filter(isNonEmptyString);
      let videoPath: string | undefined;
      for (const c of candidates) {
        const resolved = path.isAbsolute(c) ? path.normalize(c) : path.resolve(sagaDir, c);
        if (!VIDEO_EXT_RE.test(resolved)) continue;
        const real = await realpathOrNull(resolved);
        if (!real) continue;
        if (!roots.some((r) => isInside(real, r))) {
          rejected++;
          continue;
        }
        if (await fileExists(real)) {
          videoPath = real;
          break;
        }
      }
      if (!videoPath) continue;
      const rawPrompt = [s.prompt, s.visualPrompt, s.textOnlyPrompt].find(isNonEmptyString) ?? '';
      entries.push({
        index:
          typeof s.index === 'number' && Number.isInteger(s.index) && s.index >= 0 && s.index <= MAX_SEGMENT_INDEX
            ? s.index
            : i + 1,
        title: isNonEmptyString(s.title) ? clip(stripControl(s.title.trim()), MAX_TITLE_LEN) : `Segment ${i + 1}`,
        videoPath,
        prompt: clip(String(rawPrompt), MAX_PROMPT_LEN),
        duration: typeof s.duration === 'number' && Number.isFinite(s.duration) && s.duration > 0 ? s.duration : undefined,
      });
    }
    if (entries.length > 0) return { entries, rejected };
  }
  return { entries: [], rejected };
}

function entriesFromFilenames(videos: string[]): ImportEntry[] {
  const re = /(?:^|[^a-z])(?:seg|segment|clip|part|shot)[-_ ]?(\d{1,4})(?!\d)/i;
  const byIndex = new Map<number, string>();
  for (const v of videos) {
    const name = path.basename(v);
    if (/final|merged|concat/i.test(name)) continue;
    const m = re.exec(name);
    if (!m || m[1] === undefined) continue;
    const idx = Number(m[1]);
    const prev = byIndex.get(idx);
    if (!prev || path.basename(prev).length > name.length) byIndex.set(idx, v);
  }
  return [...byIndex.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([index, videoPath]) => ({ index, title: `Segment ${index}`, videoPath, prompt: '' }));
}

async function pickFinalVideo(videos: string[]): Promise<string | undefined> {
  const preferred = videos.filter((v) => /final|merged|full|concat|output/i.test(path.basename(v)));
  const pool = preferred.length ? preferred : videos;
  let best: string | undefined;
  let bestSize = -1;
  for (const v of pool) {
    const size = await fileSize(v);
    if (size > bestSize) {
      best = v;
      bestSize = size;
    }
  }
  return best;
}

async function importSaga(a: Args): Promise<Result> {
  const act = 'import_saga';
  const projectId = a.projectId;
  const sagaProjectId = a.sagaProjectId;
  if (!validId(projectId)) return fail(act, INVALID_ID_MSG);
  if (!validId(sagaProjectId)) return fail(act, 'sagaProjectId 无效');
  const overwrite = a.overwrite === true;

  const mediaRoot = String(await Promise.resolve(getMediaOutputRoot()));
  const sagaDir = path.join(mediaRoot, 'long-video', sagaProjectId);
  if (!(await isDirectory(sagaDir))) return fail(act, `未找到 Saga 输出目录: ${sagaDir}`);

  const dir = await projectDir(projectId);
  const timelineFile = path.join(dir, 'timeline.json');
  // 快速预检（避免白扫目录）；最终判定在锁内重做，消除 TOCTOU。
  if (!overwrite && (await pathExists(timelineFile))) {
    return fail(act, `时间线项目已存在: ${projectId}（传 overwrite: true 覆盖）`);
  }

  const roots: string[] = [];
  for (const r of [mediaRoot, sagaDir]) {
    const real = await realpathOrNull(r);
    if (real && !roots.includes(real)) roots.push(real);
  }

  const files = await walk(sagaDir, 3, { left: MAX_WALK_FILES });
  const videos = files.filter((f) => VIDEO_EXT_RE.test(f)).sort();
  if (videos.length === 0) return fail(act, `Saga 目录中没有视频文件: ${sagaDir}`);
  const jsonFiles = files.filter((f) => /\.json$/i.test(f)).sort();

  const warnings: string[] = [];
  if (files.length >= MAX_WALK_FILES) warnings.push(`Saga 目录文件过多，仅扫描了前 ${MAX_WALK_FILES} 个文件`);

  let source: 'manifest' | 'filenames' | 'final' = 'manifest';
  const manifest = await readSagaManifest(sagaDir, jsonFiles, roots);
  let entries = manifest.entries;
  if (manifest.rejected > 0) warnings.push(`清单中有 ${manifest.rejected} 个路径指向 Saga/媒体目录之外，已拒绝`);
  if (entries.length === 0) {
    source = 'filenames';
    entries = entriesFromFilenames(videos);
  }
  if (entries.length === 0) {
    source = 'final';
    const finalVideo = await pickFinalVideo(videos);
    if (finalVideo) {
      entries = [{ index: 1, title: 'Full video', videoPath: finalVideo, prompt: '' }];
    }
  }
  if (entries.length === 0) {
    return fail(act, '未在 Saga 项目中找到可导入的视频片段', warnings.length ? { warnings } : {});
  }
  if (entries.length > MAX_IMPORT_SEGMENTS) {
    warnings.push(`片段数超过上限 ${MAX_IMPORT_SEGMENTS}，超出部分已忽略`);
  }

  const nowIso = new Date().toISOString();
  const importedSegments: TimelineSegment[] = [];
  const seenIndex = new Set<number>();
  for (let i = 0; i < entries.length && importedSegments.length < MAX_IMPORT_SEGMENTS; i++) {
    const e = entries[i];
    if (!e) continue;
    if (seenIndex.has(e.index)) {
      warnings.push(`片段序号 ${e.index} 重复，已忽略: ${e.videoPath}`);
      continue;
    }
    const bad = await validateVideoFile(e.videoPath, '视频文件');
    if (bad) {
      warnings.push(`已跳过: ${bad}`);
      continue;
    }
    const probed = await probeDuration(e.videoPath);
    const duration = probed ?? e.duration ?? 0;
    if (!(duration > 0)) {
      warnings.push(`无法确定时长，已跳过: ${e.videoPath}`);
      continue;
    }
    seenIndex.add(e.index);
    importedSegments.push({
      index: e.index,
      title: e.title || `Segment ${i + 1}`,
      duration: round3(duration),
      originalDuration: round3(duration),
      videoPath: e.videoPath,
      prompt: e.prompt || '',
      trimmed: false,
    });
  }
  const first = importedSegments[0];
  if (!first) {
    return fail(act, '导入的片段均无有效视频文件', warnings.length ? { warnings } : {});
  }

  // Probe first video for dimensions as project defaults
  const firstInfo = await probeVideoInfo(first.videoPath);
  const project: TimelineProject = {
    version: 1,
    projectId,
    createdAt: nowIso,
    updatedAt: nowIso,
    ratio: firstInfo ? ratioOf(firstInfo.width, firstInfo.height) : '16:9',
    fps: firstInfo?.fps ?? 30,
    width: firstInfo?.width ?? 1920,
    height: firstInfo?.height ?? 1080,
    segments: importedSegments,
    subtitles: [],
    sourceSagaProjectId: sagaProjectId,
  };

  await fs.mkdir(dir, { recursive: true });
  return withDirLock<Result>(dir, async () => {
    if (!overwrite && (await pathExists(timelineFile))) {
      return fail(act, `时间线项目已存在: ${projectId}（传 overwrite: true 覆盖）`);
    }
    await saveProject(dir, project);
    return {
      action: act,
      ok: true,
      projectId,
      segments: importedSegments.length,
      totalDuration: round3(importedSegments.reduce((s, x) => s + x.duration, 0)),
      source,
      ...(warnings.length ? { warnings } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function executeEditTimeline(action: any, context: { cwd: string }): Promise<any> {
  const a: Args =
    action !== null && typeof action === 'object' && !Array.isArray(action) ? (action as Args) : {};
  const rawAct: unknown = a.action;
  const act = typeof rawAct === 'string' ? rawAct : '';
  const cwd = isNonEmptyString(context?.cwd) ? context.cwd : process.cwd();
  let result: Result;
  try {
    switch (act) {
      case 'list_segments': result = await listSegments(a); break;
      case 'replace_segment': result = await replaceSegment(a, cwd); break;
      case 'trim_segment': result = await trimSegment(a); break;
      case 'add_subtitle': result = await addSubtitle(a); break;
      case 'remove_subtitle': result = await removeSubtitle(a); break;
      case 'set_bgm': result = await setBgm(a, cwd); break;
      case 'render': result = await render(a); break;
      case 'import_saga': result = await importSaga(a); break;
      default:
        result = fail(tail(act, 64), `未知 action: ${act ? tail(act, 64) : '（未提供或不是字符串）'}`);
    }
  } catch (err) {
    result = fail(tail(act, 64), err instanceof TimelineError ? err.message : `执行失败: ${errorText(err)}`);
  }
  return result;
}
