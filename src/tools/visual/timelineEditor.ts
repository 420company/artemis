import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
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
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const VIDEO_EXT_RE = /\.(mp4|mov|m4v|mkv|webm)$/i;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

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

function errorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    if (stderr) return tail(stderr, 600);
    if (typeof e.message === 'string') return tail(e.message, 600);
  }
  return String(err);
}

function resolveUserPath(p: string, cwd: string): string {
  let s = p.trim();
  if (s === '~') s = os.homedir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(os.homedir(), s.slice(2));
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(cwd, s);
}

function validId(v: unknown): v is string {
  return typeof v === 'string' && ID_RE.test(v) && !v.includes('..');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile();
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

async function walk(dir: string, depth: number): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0 && !e.name.startsWith('.')) out.push(...(await walk(p, depth - 1)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function gcd(a: number, b: number): number {
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

const binCache = new Map<string, boolean>();

async function hasBinary(bin: string): Promise<boolean> {
  const cached = binCache.get(bin);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    await run(bin, ['-version'], { timeoutMs: 15_000 });
    ok = true;
  } catch {
    ok = false;
  }
  binCache.set(bin, ok);
  return ok;
}

async function probeDuration(file: string): Promise<number | null> {
  if (!(await hasBinary('ffprobe'))) return null;
  try {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
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
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file],
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
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate', '-of', 'json', file],
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
// Project storage
// ---------------------------------------------------------------------------

async function projectsRoot(): Promise<string> {
  const home = String(await Promise.resolve(resolveArtemisHomeDir()));
  return path.join(home, 'timeline-projects');
}

async function projectDir(projectId: string): Promise<string> {
  return path.join(await projectsRoot(), projectId);
}

async function loadProject(projectIdRaw: unknown): Promise<LoadResult> {
  if (!validId(projectIdRaw)) {
    return { ok: false, error: 'projectId 无效（仅允许字母数字 . _ -，最长128）' };
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
  const p = parsed as Partial<TimelineProject>;
  if (!p || p.version !== 1 || !Array.isArray(p.segments)) {
    return { ok: false, error: `timeline.json 格式不支持: ${file}` };
  }
  const project = p as TimelineProject;
  if (!Array.isArray(project.subtitles)) project.subtitles = [];
  return { ok: true, project, dir };
}

async function saveProject(dir: string, project: TimelineProject): Promise<void> {
  project.updatedAt = new Date().toISOString();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'timeline.json');
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

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
  const loaded = await loadProject(a.projectId);
  if (!loaded.ok) return fail(act, loaded.error);
  const { project, dir } = loaded;
  const seg = findSegment(project, a.segmentIndex);
  if (typeof seg === 'string') return fail(act, seg);

  if (isNonEmptyString(a.newVideoPath)) {
    const newPath = resolveUserPath(a.newVideoPath, cwd);
    if (!(await fileExists(newPath))) return fail(act, `视频文件不存在: ${newPath}`);
    const warnings: string[] = [];
    const probed = await probeDuration(newPath);
    const oldPath = seg.videoPath;
    const oldDuration = seg.duration;
    if (probed === null) warnings.push('ffprobe 不可用或探测失败，沿用原时长');
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
    const outOfRange = project.subtitles.filter((s) => s.end > total + 0.05).length;
    if (outOfRange > 0) warnings.push(`${outOfRange} 条字幕超出新总时长，渲染时将被截断`);
    if (Math.abs(seg.duration - oldDuration) > 0.05 && project.subtitles.length > 0) {
      warnings.push('片段时长变化，后续字幕的绝对时间可能需要调整');
    }
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
  }

  if (isNonEmptyString(a.newPrompt)) {
    const prompt = a.newPrompt.trim();
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
  }

  return fail(act, '需要提供 newVideoPath 或 newPrompt');
}

async function trimSegment(a: Args): Promise<Result> {
  const act = 'trim_segment';
  const loaded = await loadProject(a.projectId);
  if (!loaded.ok) return fail(act, loaded.error);
  const { project, dir } = loaded;
  const seg = findSegment(project, a.segmentIndex);
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
  if (!(await fileExists(seg.videoPath))) return fail(act, `片段视频文件不存在: ${seg.videoPath}`);

  const segDir = path.join(dir, 'segments');
  await fs.mkdir(segDir, { recursive: true });
  const out = path.join(segDir, `seg-${seg.index}-trimmed-${timestamp()}.mp4`);
  const base = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', fmt(start), '-i', seg.videoPath, '-t', fmt(len)];

  let method: 'copy' | 'reencode' = 'copy';
  let copyOk = false;
  try {
    await run('ffmpeg', [...base, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-avoid_negative_ts', 'make_zero', out]);
    const d = await probeDuration(out);
    // Stream copy cuts on keyframes; re-encode if the result drifts noticeably.
    copyOk = (await fileSize(out)) > 0 && (d === null || Math.abs(d - len) <= 0.5);
  } catch {
    copyOk = false;
  }

  if (!copyOk) {
    method = 'reencode';
    try {
      await run('ffmpeg', [
        ...base,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        out,
      ]);
    } catch (err) {
      await fs.rm(out, { force: true }).catch(() => undefined);
      return fail(act, `ffmpeg 裁剪失败: ${errorText(err)}`);
    }
  }

  const probed = await probeDuration(out);
  const prevPath = seg.videoPath;
  const baseOffset = seg.trimStart ?? 0;
  seg.trimStart = round3(baseOffset + start);
  seg.trimEnd = round3(baseOffset + clampedEnd);
  seg.videoPath = out;
  seg.duration = probed ?? len;
  seg.trimmed = true;

  const warnings: string[] = [];
  const total = totalDuration(project);
  const segStart = segmentOffsets(project).get(seg.index)?.startAt ?? 0;
  const affected = project.subtitles.filter((s) => s.end > segStart).length;
  if (affected > 0) warnings.push(`${affected} 条字幕位于该片段或之后，绝对时间可能需要调整`);
  if (method === 'reencode') warnings.push('流复制不精确或失败，已重新编码');

  await saveProject(dir, project);
  return {
    action: act,
    ok: true,
    projectId: project.projectId,
    segmentIndex: seg.index,
    method,
    previousVideoPath: prevPath,
    videoPath: out,
    duration: seg.duration,
    trimStart: seg.trimStart,
    trimEnd: seg.trimEnd,
    totalDuration: total,
    ...(warnings.length ? { warnings } : {}),
  };
}

async function addSubtitle(a: Args): Promise<Result> {
  const act = 'add_subtitle';
  const loaded = await loadProject(a.projectId);
  if (!loaded.ok) return fail(act, loaded.error);
  const { project, dir } = loaded;

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
}

async function removeSubtitle(a: Args): Promise<Result> {
  const act = 'remove_subtitle';
  const loaded = await loadProject(a.projectId);
  if (!loaded.ok) return fail(act, loaded.error);
  const { project, dir } = loaded;
  if (!isNonEmptyString(a.subtitleId)) return fail(act, 'subtitleId 不能为空');
  const id = a.subtitleId.trim();
  const idx = project.subtitles.findIndex((s) => s.id === id);
  if (idx < 0) return fail(act, `字幕不存在: ${id}`);
  const [removed] = project.subtitles.splice(idx, 1);
  await saveProject(dir, project);
  return { action: act, ok: true, projectId: project.projectId, removed, subtitleCount: project.subtitles.length };
}

async function setBgm(a: Args, cwd: string): Promise<Result> {
  const act = 'set_bgm';
  const loaded = await loadProject(a.projectId);
  if (!loaded.ok) return fail(act, loaded.error);
  const { project, dir } = loaded;

  if (a.removeBgm === true) {
    const had = Boolean(project.bgm);
    delete project.bgm;
    await saveProject(dir, project);
    return { action: act, ok: true, projectId: project.projectId, removed: had, bgm: null };
  }

  if (!isNonEmptyString(a.audioPath)) return fail(act, 'audioPath 不能为空');
  const audioPath = resolveUserPath(a.audioPath, cwd);
  if (!(await fileExists(audioPath))) return fail(act, `音频文件不存在: ${audioPath}`);

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
  const audioDuration = await probeDuration(audioPath);
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
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
    if (!withAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    args.push('-map', '0:v:0', '-map', withAudio ? '0:a:0' : '1:a:0', '-vf', vf);
    if (withAudio) args.push('-af', 'aresample=48000,apad');
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-shortest', '-movflags', '+faststart', output,
    );
    try {
      await run('ffmpeg', args);
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
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', p.input];
  let nextInput = 1;
  let bgmIdx = -1;
  let subIdx = -1;
  if (p.bgm) {
    args.push('-stream_loop', '-1', '-i', p.bgm.audioPath);
    bgmIdx = nextInput++;
  }
  if (p.srtName && !p.burn) {
    args.push('-i', p.srtName);
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
  await run('ffmpeg', args, { cwd: p.workDir });
}

async function render(a: Args, cwd: string): Promise<Result> {
  const act = 'render';
  const loaded = await loadProject(a.projectId);
  if (!loaded.ok) return fail(act, loaded.error);
  const { project, dir } = loaded;

  if (!(await hasBinary('ffmpeg'))) return fail(act, FFMPEG_MISSING);
  const segs = sortedSegments(project);
  if (segs.length === 0) return fail(act, '项目没有任何片段');
  for (const s of segs) {
    if (!(await fileExists(s.videoPath))) return fail(act, `片段 ${s.index} 视频不存在: ${s.videoPath}`);
  }

  const subtitleMode = a.subtitleMode === 'soft' ? 'soft' : 'burn';
  const ts = timestamp();
  let outputPath = isNonEmptyString(a.outputPath)
    ? resolveUserPath(a.outputPath, cwd)
    : path.join(dir, `${project.projectId}-final-${ts}.mp4`);
  if (!path.extname(outputPath)) outputPath += '.mp4';
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const target: VideoInfo = {
    width: even(project.width || 1920),
    height: even(project.height || 1080),
    fps: project.fps > 0 ? project.fps : 30,
  };
  const warnings: string[] = [];
  const workDir = path.join(dir, `.render-${ts}`);
  await fs.mkdir(workDir, { recursive: true });

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
      await run('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
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
    if (bgm && !(await fileExists(bgm.audioPath))) {
      warnings.push(`BGM 文件不存在，已跳过: ${bgm.audioPath}`);
      bgm = null;
    }

    let subtitleResult: 'none' | 'burned' | 'soft' = 'none';
    if (subs.length === 0 && !bgm) {
      await fs.copyFile(concatOut, outputPath);
    } else {
      let srtName: string | null = null;
      if (subs.length > 0) {
        srtName = 'subtitles.srt';
        await fs.writeFile(path.join(workDir, srtName), buildSrt(subs), 'utf8');
      }
      const burnModes = srtName ? (subtitleMode === 'soft' ? [false] : [true, false]) : [false];
      const amixModes = bgm ? [false, true] : [false];
      const errors: string[] = [];
      let done = false;
      for (const burn of burnModes) {
        for (const legacyAmix of amixModes) {
          try {
            await finalPass({ input: concatOut, output: outputPath, workDir, duration: concatDuration, srtName, bgm, burn, legacyAmix });
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
      if (!done) return fail(act, `合成失败: ${errors.at(-1) ?? '未知错误'}`);
    }

    const duration = (await probeDuration(outputPath)) ?? concatDuration;
    project.lastRender = { outputPath, duration, renderedAt: new Date().toISOString() };
    await saveProject(dir, project);
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

async function readSagaManifest(sagaDir: string, jsonFiles: string[]): Promise<ImportEntry[]> {
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
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!s) continue;
      const candidates = [s.outputPath, s.mediaPath].filter(isNonEmptyString);
      let videoPath: string | undefined;
      for (const c of candidates) {
        const resolved = path.isAbsolute(c) ? c : path.resolve(sagaDir, c);
        if (VIDEO_EXT_RE.test(resolved) && (await fileExists(resolved))) {
          videoPath = resolved;
          break;
        }
      }
      if (!videoPath) continue;
      entries.push({
        index: typeof s.index === 'number' && Number.isInteger(s.index) ? s.index : i + 1,
        title: isNonEmptyString(s.title) ? s.title : `Segment ${i + 1}`,
        videoPath,
        prompt: [s.prompt, s.visualPrompt, s.textOnlyPrompt].find(isNonEmptyString) ?? '',
        duration: typeof s.duration === 'number' && s.duration > 0 ? s.duration : undefined,
      });
    }
    if (entries.length > 0) return entries;
  }
  return [];
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
  if (!validId(a.projectId)) return fail(act, 'projectId 无效（仅允许字母数字 . _ -，最长128）');
  if (!validId(a.sagaProjectId)) return fail(act, 'sagaProjectId 无效');
  const projectId = a.projectId;
  const sagaProjectId = a.sagaProjectId;

  const mediaRoot = String(await Promise.resolve(getMediaOutputRoot()));
  const sagaDir = path.join(mediaRoot, 'long-video', sagaProjectId);
  if (!(await isDirectory(sagaDir))) return fail(act, `未找到 Saga 输出目录: ${sagaDir}`);

  const dir = await projectDir(projectId);
  const timelineFile = path.join(dir, 'timeline.json');
  if ((await fileExists(timelineFile)) && a.overwrite !== true) {
    return fail(act, `时间线项目已存在: ${projectId}（传 overwrite: true 覆盖）`);
  }

  const files = await walk(sagaDir, 3);
  const videos = files.filter((f) => VIDEO_EXT_RE.test(f)).sort();
  if (videos.length === 0) return fail(act, `Saga 目录中没有视频文件: ${sagaDir}`);
  const jsonFiles = files.filter((f) => /\.json$/i.test(f)).sort();

  let source: 'manifest' | 'filenames' | 'final' = 'manifest';
  let entries = await readSagaManifest(sagaDir, jsonFiles);
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
    return fail(act, '未在 Saga 项目中找到可导入的视频片段');
  }

  const nowIso = new Date().toISOString();
  const importedSegments: TimelineSegment[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const videoPath = e.videoPath;
    if (!videoPath || !(await fileExists(videoPath))) continue;
    let duration = e.duration ?? 0;
    if (!duration || duration <= 0) {
      const probed = await probeDuration(videoPath);
      duration = probed ?? 0;
    }
    importedSegments.push({
      index: e.index ?? i + 1,
      title: e.title || `Segment ${i + 1}`,
      duration,
      originalDuration: duration,
      videoPath,
      prompt: e.prompt || '',
      trimmed: false,
    });
  }
  if (importedSegments.length === 0) {
    return fail(act, '导入的片段均无有效视频文件');
  }

  // Probe first video for dimensions as project defaults
  const firstInfo = await probeVideoInfo(importedSegments[0].videoPath);
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
  await saveProject(dir, project);
  return {
    action: act,
    ok: true,
    projectId,
    segments: importedSegments.length,
    totalDuration: round3(importedSegments.reduce((s, x) => s + x.duration, 0)),
    source,
  };
}

export async function executeEditTimeline(action: any, context: { cwd: string }): Promise<any> {
  const a = (action ?? {}) as Args;
  const act = (a as any).action;
  const cwd = context?.cwd || process.cwd();
  let result: Result;
  switch (act) {
    case 'list_segments': result = await listSegments(a); break;
    case 'replace_segment': result = await replaceSegment(a, cwd); break;
    case 'trim_segment': result = await trimSegment(a); break;
    case 'add_subtitle': result = await addSubtitle(a); break;
    case 'remove_subtitle': result = await removeSubtitle(a); break;
    case 'set_bgm': result = await setBgm(a, cwd); break;
    case 'render': result = await render(a, cwd); break;
    case 'import_saga': result = await importSaga(a); break;
    default: result = fail(String(act ?? ''), `未知 action: ${act}`);
  }
  return { action, ...result };
}
