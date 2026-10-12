/**
 * Audio preparation for speech recognition: any audio or video file becomes
 * 16 kHz mono 16-bit WAV (ffmpeg drops the video), and long recordings are
 * split into pieces a speech service takes in one request.
 *
 * Pieces are cut in the quietest moment near the end of each window (a pause
 * between sentences, not mid-word), at most MAX_PIECE_SECONDS long. The WAV
 * is read in blocks, never whole, so hours of audio need little memory.
 */
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import * as path from 'node:path';

export const SPEECH_SAMPLE_RATE = 16_000;
/** 16-bit mono at 16 kHz. */
export const SPEECH_BYTES_PER_SECOND = SPEECH_SAMPLE_RATE * 2;
/** Five minutes: 9.6 MB of WAV, well inside a 12 MB request. */
export const MAX_PIECE_SECONDS = 300;
/** A cut is placed in the last SEARCH_SECONDS of a full window. */
export const CUT_SEARCH_SECONDS = 45;
/** Loudness is measured over frames this long. */
export const FRAME_SECONDS = 0.1;

/** ffmpeg is not installed (or not on PATH). */
export class FfmpegMissingError extends Error {
  constructor() {
    super('ffmpeg is not installed');
    this.name = 'FfmpegMissingError';
  }
}

/** The file has no audio track (a silent video, an image, not media at all). */
export class NoAudioError extends Error {
  constructor(detail: string) {
    super(`the file has no audio that can be read${detail ? ` (${detail})` : ''}`);
    this.name = 'NoAudioError';
  }
}

/** A demuxer that can read other files or URLs named inside the input: never used on a file the agent was handed. */
export class UnsafeMediaError extends Error {
  constructor(format: string) {
    super(`this file is a ${format} playlist or list of other files, not audio or video; it is not opened`);
    this.name = 'UnsafeMediaError';
  }
}

/** Formats that pull in other files or URLs (playlists, lists, image sequences). */
const UNSAFE_FORMATS = new Set(['hls', 'applehttp', 'concat', 'image2', 'image2pipe', 'ffconcat', 'tee', 'dash', 'webm_dash_manifest']);

/**
 * Hardening for every ffmpeg and ffprobe run on a file the agent was handed:
 * only local files may be opened (no network, no pipes, no subprocesses
 * that a crafted playlist could name).
 */
export const FFMPEG_SAFE_INPUT = ['-protocol_whitelist', 'file'];

/** An input path as ffmpeg must see it: absolute, so it can never read as an option or a protocol. */
function safeInput(inputPath: string): string {
  return path.resolve(inputPath);
}

function run(command: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024, timeout: options.timeoutMs, ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout: String(stdout), stderr: String(stderr) });
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reject(new FfmpegMissingError());
      if (options.signal?.aborted) return reject(Object.assign(new Error('stopped'), { name: 'AbortError' }));
      reject(Object.assign(error, { stderr: String(stderr ?? '') }));
    });
  });
}

export interface MediaProbe {
  /** The demuxer ffprobe picked, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "wav". */
  format: string;
  /** Seconds, when the container says. */
  durationSeconds?: number;
  hasAudio: boolean;
}

/**
 * What a file is, before anything is decoded: its container, length and
 * whether it has sound. Playlists and file lists (hls, concat, image2...) are
 * refused with UnsafeMediaError: they name other files or URLs to open.
 */
export async function probeMedia(inputPath: string, options: { ffprobe?: string; signal?: AbortSignal } = {}): Promise<MediaProbe> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      options.ffprobe ?? 'ffprobe',
      ['-v', 'error', ...FFMPEG_SAFE_INPUT, '-show_entries', 'format=format_name,duration:stream=codec_type', '-of', 'json', '-i', safeInput(inputPath)],
      { timeoutMs: 60_000, ...(options.signal ? { signal: options.signal } : {}) },
    ));
  } catch (error) {
    if (error instanceof FfmpegMissingError || (error as Error).name === 'AbortError') throw error;
    throw new NoAudioError('not a readable audio or video file');
  }
  let data: { format?: { format_name?: unknown; duration?: unknown }; streams?: { codec_type?: unknown }[] } = {};
  try {
    data = JSON.parse(stdout) as typeof data;
  } catch {
    throw new NoAudioError('not a readable audio or video file');
  }
  const format = typeof data.format?.format_name === 'string' ? data.format.format_name : '';
  const unsafe = format.split(',').find((name) => UNSAFE_FORMATS.has(name.trim()));
  if (unsafe) throw new UnsafeMediaError(unsafe);
  const duration = Number(data.format?.duration);
  return {
    format,
    ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
    hasAudio: Array.isArray(data.streams) && data.streams.some((s) => s?.codec_type === 'audio'),
  };
}

/**
 * Converts an audio or video file to 16 kHz mono 16-bit PCM WAV, at most
 * `maxSeconds` of it. Only local files are opened (see FFMPEG_SAFE_INPUT;
 * callers probe first to refuse playlists). Rejects with FfmpegMissingError
 * when ffmpeg is not installed and NoAudioError when the file has no
 * readable audio.
 */
export async function convertToSpeechWav(
  inputPath: string,
  outputPath: string,
  options: { ffmpeg?: string; signal?: AbortSignal; timeoutMs?: number; maxSeconds?: number } = {},
): Promise<void> {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    ...FFMPEG_SAFE_INPUT,
    '-i', safeInput(inputPath),
    '-map', '0:a:0',
    '-vn', '-sn', '-dn',
    ...(options.maxSeconds ? ['-t', String(Math.ceil(options.maxSeconds))] : []),
    '-ac', '1', '-ar', String(SPEECH_SAMPLE_RATE),
    '-c:a', 'pcm_s16le', '-f', 'wav',
    outputPath,
  ];
  try {
    await run(options.ffmpeg ?? 'ffmpeg', args, { timeoutMs: options.timeoutMs ?? 20 * 60_000, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    if (error instanceof FfmpegMissingError || (error as Error).name === 'AbortError') throw error;
    const text = String((error as { stderr?: unknown }).stderr ?? '');
    const tail = text.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ').slice(0, 300);
    if (/matches no streams|does not contain any stream/i.test(text)) throw new NoAudioError('');
    if (/Invalid data found|could not find codec parameters|not on whitelist/i.test(text)) throw new NoAudioError('not a readable audio or video file');
    throw new Error(`ffmpeg could not convert the audio${tail ? `: ${tail}` : ''}`);
  }
}

export interface WavInfo {
  /** Byte offset of the PCM samples. */
  dataOffset: number;
  /** Bytes of PCM samples (clamped to the file). */
  dataBytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/**
 * Reads a RIFF/WAVE header (chunks before `data` are skipped). `fileSize`
 * clamps a data size that says more than the file holds (or the "unknown"
 * size a streaming writer leaves).
 */
export function parseWavHeader(header: Uint8Array, fileSize: number): WavInfo {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const ascii = (at: number) => String.fromCharCode(header[at]!, header[at + 1]!, header[at + 2]!, header[at + 3]!);
  if (header.byteLength < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') throw new Error('not a WAV file');
  let offset = 12;
  let format: Omit<WavInfo, 'dataOffset' | 'dataBytes'> | undefined;
  while (offset + 8 <= header.byteLength) {
    const id = ascii(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 24 <= header.byteLength) {
      format = {
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data before its format');
      const dataOffset = offset + 8;
      const dataBytes = Math.max(0, Math.min(size, fileSize - dataOffset));
      return { ...format, dataOffset, dataBytes };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV header without a data chunk');
}

/** A 44-byte header for mono 16-bit PCM. */
export function wavHeader(dataBytes: number, sampleRate = SPEECH_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Where to cut, in frames: each piece is at most `maxFrames` long, cut at the
 * quietest frame in the last `searchFrames` of its window (the latest one on
 * a tie, so pieces stay long). Returns the start frame of every piece after
 * the first. Pure, for tests.
 */
export function planCuts(levels: ArrayLike<number>, maxFrames: number, searchFrames: number): number[] {
  const total = levels.length;
  const cuts: number[] = [];
  const search = Math.max(1, Math.min(searchFrames, maxFrames - 1));
  let start = 0;
  while (total - start > maxFrames) {
    const end = start + maxFrames;
    let best = end;
    let bestLevel = Number.POSITIVE_INFINITY;
    for (let frame = end; frame >= end - search; frame--) {
      const level = levels[frame] ?? Number.POSITIVE_INFINITY;
      if (level < bestLevel) {
        bestLevel = level;
        best = frame;
      }
    }
    cuts.push(best);
    start = best;
  }
  return cuts;
}

export interface AudioPiece {
  startSeconds: number;
  durationSeconds: number;
  /** The piece's PCM within the WAV file. */
  byteOffset: number;
  byteLength: number;
  sampleRate: number;
}

/**
 * Plans the pieces of a 16 kHz mono 16-bit WAV: at most `maxSeconds` each,
 * cut in pauses. Nothing is written: each piece is read from the one WAV
 * when it is sent (readSpeechPiece), so a long recording takes its own size
 * on disk once, never twice.
 */
export async function planSpeechWav(
  wavPath: string,
  options: { maxSeconds?: number; searchSeconds?: number } = {},
): Promise<{ pieces: AudioPiece[]; durationSeconds: number }> {
  const maxSeconds = options.maxSeconds ?? MAX_PIECE_SECONDS;
  const searchSeconds = options.searchSeconds ?? CUT_SEARCH_SECONDS;
  const file = await open(wavPath, 'r');
  try {
    const { size } = await file.stat();
    const head = Buffer.alloc(Math.min(size, 64 * 1024));
    await file.read(head, 0, head.length, 0);
    const info = parseWavHeader(head, size);
    if (info.channels !== 1 || info.bitsPerSample !== 16) throw new Error('expected mono 16-bit WAV');
    const bytesPerSecond = info.sampleRate * 2;
    const durationSeconds = info.dataBytes / bytesPerSecond;
    const piece = (from: number, to: number): AudioPiece => ({
      startSeconds: from / bytesPerSecond,
      durationSeconds: (to - from) / bytesPerSecond,
      byteOffset: info.dataOffset + from,
      byteLength: to - from,
      sampleRate: info.sampleRate,
    });
    if (durationSeconds <= maxSeconds) return { pieces: info.dataBytes > 0 ? [piece(0, info.dataBytes)] : [], durationSeconds };

    // Loudness per frame (mean absolute sample), read in blocks.
    const frameBytes = Math.max(2, Math.round(info.sampleRate * FRAME_SECONDS) * 2);
    const levels = new Float32Array(Math.ceil(info.dataBytes / frameBytes));
    const block = Buffer.alloc(frameBytes * 512);
    for (let read = 0; read < info.dataBytes; ) {
      const want = Math.min(block.length, info.dataBytes - read);
      const { bytesRead } = await file.read(block, 0, want, info.dataOffset + read);
      if (bytesRead <= 0) break;
      for (let at = 0; at + 1 < bytesRead; at += frameBytes) {
        const end = Math.min(at + frameBytes, bytesRead - 1);
        let sum = 0;
        let count = 0;
        for (let i = at; i < end; i += 2) {
          sum += Math.abs(block.readInt16LE(i));
          count++;
        }
        levels[(read + at) / frameBytes] = count ? sum / count : 0;
      }
      read += bytesRead;
    }

    const frameSeconds = frameBytes / bytesPerSecond;
    const cuts = planCuts(levels, Math.floor(maxSeconds / frameSeconds), Math.round(searchSeconds / frameSeconds));
    const bounds = [0, ...cuts.map((frame) => frame * frameBytes), info.dataBytes];
    const pieces: AudioPiece[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const from = bounds[i]!;
      const to = Math.min(bounds[i + 1]!, info.dataBytes);
      if (to > from) pieces.push(piece(from, to));
    }
    return { pieces, durationSeconds };
  } finally {
    await file.close();
  }
}

/** One planned piece as a WAV file in memory. */
export async function readSpeechPiece(wavPath: string, piece: AudioPiece): Promise<Buffer> {
  const file = await open(wavPath, 'r');
  try {
    const pcm = Buffer.alloc(piece.byteLength);
    const { bytesRead } = await file.read(pcm, 0, pcm.length, piece.byteOffset);
    return Buffer.concat([wavHeader(bytesRead, piece.sampleRate), pcm.subarray(0, bytesRead)]);
  } finally {
    await file.close();
  }
}

/** Seconds as h:mm:ss (or m:ss under an hour). */
export function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}
