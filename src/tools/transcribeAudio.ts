import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentAction } from '../core/types.js';
import { localSttAvailable, transcribeLocalAudio } from '../core/localStt.js';
import {
  convertToSpeechWav,
  FfmpegMissingError,
  formatTimestamp,
  NoAudioError,
  planSpeechWav,
  probeMedia,
  readSpeechPiece,
  UnsafeMediaError,
  type AudioPiece,
} from '../core/audioChunks.js';
import {
  audioContentType,
  PLATFORM_SPEECH_MAX_BYTES,
  PlatformSpeechError,
  platformSpeechFallsBack,
  resolvePlatformSpeech,
  transcribeWithPlatform,
  type PlatformSttConfig,
} from '../core/platformSpeech.js';
import { ProviderStore } from '../providers/store.js';
import { getMediaOutputRoot } from '../utils/mediaOutputRoot.js';
import { resolveDataRootDir } from '../utils/fs.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

type TranscribeAudioAction = Extract<AgentAction, { type: 'transcribe_audio' }>;

/** Longer transcripts are saved to a file and shown in part. */
const INLINE_TRANSCRIPT_CHARS = 20_000;
/**
 * Two hours of audio at a time: transcribed three pieces at once, that fits
 * well inside the hour the runtime allows this tool (TOOL_EXPECTED_MAX_MS),
 * and its WAV (about 230 MB) is the most it ever writes to disk.
 */
export const MAX_PLATFORM_SECONDS = 2 * 3600;
/** Pieces in flight at once. */
const PIECE_CONCURRENCY = 3;

export type PlatformFileTranscription = {
  text: string;
  pieces: { startSeconds: number; durationSeconds: number; text: string }[];
  durationSeconds: number;
};

/** The run was stopped (the owner pressed stop, the run timed out). */
export class TranscriptionStopped extends Error {
  constructor() {
    super('transcription stopped');
    this.name = 'AbortError';
  }
}

/**
 * Transcribes a local audio or video file through platform speech
 * recognition. The file is probed first (playlists and lists of other files
 * are refused, and a recording over MAX_PLATFORM_SECONDS is refused before
 * anything is decoded), converted to one 16 kHz mono WAV in the workspace's
 * own temp folder (`tmpRoot`), and planned into pieces of at most five
 * minutes cut at pauses; each piece is read from that WAV when it is sent,
 * a few at a time, with one retry for a passing failure. `signal` stops
 * ffmpeg and the pieces. Without ffmpeg, a small file in a format the
 * platform reads is sent as it is.
 */
export async function transcribeFileWithPlatform(
  inputPath: string,
  config: PlatformSttConfig,
  options: { language?: string; signal?: AbortSignal; fetchImpl?: typeof fetch; ffmpeg?: string; ffprobe?: string; retryDelayMs?: number; tmpRoot?: string; concurrency?: number; maxSeconds?: number } = {},
): Promise<PlatformFileTranscription> {
  const { signal } = options;
  const cap = options.maxSeconds ?? MAX_PLATFORM_SECONDS;
  const tooLong = (seconds: number) =>
    new PlatformSpeechError(
      'too_large',
      `the recording is ${formatTimestamp(seconds)} long; transcribe at most ${formatTimestamp(cap)} at a time (cut it into parts with ffmpeg first)`,
    );
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  await mkdir(tmpRoot, { recursive: true });
  const tmp = await mkdtemp(path.join(tmpRoot, 'stt-'));
  try {
    let pieces: AudioPiece[] = [];
    let durationSeconds = 0;
    let wav: string | undefined;
    let direct: { audio: Buffer; type: string } | undefined;
    try {
      const probe = await probeMedia(inputPath, { ffprobe: options.ffprobe, signal });
      if (!probe.hasAudio) throw new NoAudioError('');
      if (probe.durationSeconds !== undefined && probe.durationSeconds > cap + 1) throw tooLong(probe.durationSeconds);
      wav = path.join(tmp, 'audio.wav');
      // -t as well: a container that does not say its length is still cut at the cap.
      await convertToSpeechWav(inputPath, wav, { ffmpeg: options.ffmpeg, signal, maxSeconds: cap + 1 });
      const plan = await planSpeechWav(wav);
      pieces = plan.pieces;
      durationSeconds = plan.durationSeconds;
      if (durationSeconds > cap) throw tooLong(durationSeconds);
    } catch (error) {
      if (signal?.aborted || (error as Error).name === 'AbortError') throw new TranscriptionStopped();
      if (error instanceof NoAudioError) throw new PlatformSpeechError('invalid_audio', error.message);
      if (error instanceof UnsafeMediaError) throw new PlatformSpeechError('unsupported_format', error.message);
      if (!(error instanceof FfmpegMissingError)) throw error;
      const type = audioContentType(inputPath);
      const size = (await stat(inputPath)).size;
      if (!type || size > PLATFORM_SPEECH_MAX_BYTES) {
        throw new PlatformSpeechError(
          'unsupported_format',
          'ffmpeg is needed to read this file (video, a long recording or an uncommon format) and is not installed',
        );
      }
      direct = { audio: await readFile(inputPath), type };
      pieces = [{ startSeconds: 0, durationSeconds: 0, byteOffset: 0, byteLength: size, sampleRate: 0 }];
    }

    // A few pieces at a time; the first failure stops the rest.
    const results: (PlatformFileTranscription['pieces'][number] | undefined)[] = new Array(pieces.length);
    const stop = new AbortController();
    const pieceSignal = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    let next = 0;
    const outcome: { failure?: { index: number; error: unknown } } = {};
    const worker = async () => {
      while (!outcome.failure && !pieceSignal.aborted) {
        const index = next++;
        if (index >= pieces.length) return;
        const piece = pieces[index]!;
        try {
          const audio = direct?.audio ?? (await readSpeechPiece(wav!, piece));
          const result = await transcribeOnce(audio, direct?.type ?? 'audio/wav', config, { ...options, signal: pieceSignal });
          results[index] = { startSeconds: piece.startSeconds, durationSeconds: piece.durationSeconds || result.durationSeconds, text: result.text };
          if (!durationSeconds && result.durationSeconds) durationSeconds = result.durationSeconds;
        } catch (error) {
          const earlier = outcome.failure as { index: number } | undefined;
          if (!earlier || index < earlier.index) outcome.failure = { index, error };
          stop.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency ?? PIECE_CONCURRENCY, pieces.length) }, worker));
    if (signal?.aborted) throw new TranscriptionStopped();
    const failed = outcome.failure;
    if (failed) {
      const { index, error } = failed;
      const done = results.slice(0, index).filter((r): r is NonNullable<typeof r> => !!r);
      if (done.length === index && index > 0 && error instanceof PlatformSpeechError) {
        throw new PlatformSpeechError(
          error.code,
          `${error.message}. Part ${index + 1} of ${pieces.length} failed; the parts before it (up to ${formatTimestamp(pieces[index]!.startSeconds)}) were transcribed:\n${joinPieces(done)}`,
        );
      }
      throw error;
    }
    const all = results.filter((r): r is NonNullable<typeof r> => !!r);
    return { text: joinPieces(all), pieces: all, durationSeconds };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One piece; a passing failure (busy, network, upstream) is tried once more. */
async function transcribeOnce(
  audio: Buffer,
  type: string,
  config: PlatformSttConfig,
  options: { language?: string; signal?: AbortSignal; fetchImpl?: typeof fetch; retryDelayMs?: number },
) {
  const call = () => transcribeWithPlatform(audio, type, config, { language: options.language, signal: options.signal, fetchImpl: options.fetchImpl });
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof PlatformSpeechError) || !['rate_limited', 'unreachable', 'failed'].includes(error.code) || options.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 2_000));
    if (options.signal?.aborted) throw error;
    return call();
  }
}

/** Pieces with text; several pieces get a timestamp each. */
function joinPieces(pieces: PlatformFileTranscription['pieces']): string {
  const spoken = pieces.filter((piece) => piece.text.trim());
  if (pieces.length <= 1) return spoken.map((piece) => piece.text.trim()).join('\n');
  return spoken.map((piece) => `[${formatTimestamp(piece.startSeconds)}] ${piece.text.trim()}`).join('\n\n');
}

/** The transcript as a text file next to the agent's other media, for long results. */
async function saveTranscript(inputPath: string, text: string): Promise<string | undefined> {
  try {
    const dir = path.join(getMediaOutputRoot(), 'transcripts');
    await mkdir(dir, { recursive: true });
    const base = path.basename(inputPath, path.extname(inputPath)).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 60) || 'audio';
    const file = path.join(dir, `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    await writeFile(file, `${text}\n`, 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

function resolveInput(inputPath: string, cwd: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

export async function executeTranscribeAudio(
  action: TranscribeAudioAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const setup = (await new ProviderStore(context.cwd).load()).setup;
  const stt = setup?.voice.stt;
  const provider = stt?.provider ?? 'local';
  const inputPath = resolveInput(action.inputPath, context.cwd);
  try {
    if (!(await stat(inputPath)).isFile()) throw new Error('not a file');
  } catch {
    return { action, ok: false, output: `Audio file not found: ${inputPath}` };
  }

  // Asking for a local Whisper model or binary means local Whisper.
  const wantsLocal = Boolean(action.command || action.modelPath || action.model || (action.engine && action.engine !== 'auto'));
  const resolved = wantsLocal ? undefined : await resolvePlatformSpeech();
  const platform = resolved?.sttModel ? { ...resolved, sttModel: resolved.sttModel } : undefined;
  let platformFailure: PlatformSpeechError | undefined;
  if (platform) {
    try {
      const result = await transcribeFileWithPlatform(inputPath, platform, {
        language: action.language ?? (stt?.language || undefined),
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        // The workspace's own temp folder: hours of audio must not fill a small /tmp.
        tmpRoot: path.join(resolveDataRootDir(context.cwd), 'tmp'),
      });
      if (!result.text.trim()) {
        return { action, ok: true, output: 'Transcript: (no speech was recognised in this recording)', data: { engine: 'platform', ...result } };
      }
      const long = result.pieces.length > 1 || result.text.length > INLINE_TRANSCRIPT_CHARS;
      const saved = long ? await saveTranscript(inputPath, result.text) : undefined;
      const shown = result.text.length > INLINE_TRANSCRIPT_CHARS ? `${result.text.slice(0, INLINE_TRANSCRIPT_CHARS)}\n…(cut here; the full transcript is in the file below)` : result.text;
      return {
        action,
        ok: true,
        output: [
          `Transcript (platform speech recognition${result.durationSeconds ? `, ${formatTimestamp(result.durationSeconds)} of audio` : ''}${result.pieces.length > 1 ? `, ${result.pieces.length} parts` : ''}):`,
          shown,
          ...(saved ? ['', `Full transcript saved: ${saved}`] : []),
        ].join('\n'),
        data: { engine: 'platform', text: result.text, durationSeconds: result.durationSeconds, pieces: result.pieces.length, ...(saved ? { textPath: saved } : {}) },
      };
    } catch (error) {
      if (error instanceof TranscriptionStopped || context.abortSignal?.aborted) return { action, ok: false, output: 'Transcription stopped.' };
      const failure = error instanceof PlatformSpeechError ? error : new PlatformSpeechError('failed', error instanceof Error ? error.message : String(error));
      if (!platformSpeechFallsBack(failure) || !(await localSttAvailable({ engine: stt?.engine ?? 'auto', command: stt?.command }))) {
        return { action, ok: false, output: `Transcription failed: ${failure.message}` };
      }
      platformFailure = failure;
    }
  } else if (provider !== 'local') {
    return {
      action,
      ok: false,
      output: `Configured STT provider "${provider}" is not implemented in this runtime yet. Use local Whisper STT for the free no-API path.`,
    };
  }

  try {
    const result = await transcribeLocalAudio({
      cwd: context.cwd,
      inputPath,
      language: action.language ?? stt?.language,
      model: action.model ?? stt?.localModel,
      modelPath: action.modelPath ?? stt?.modelPath,
      engine: action.engine ?? stt?.engine ?? 'auto',
      command: action.command ?? stt?.command,
    });

    return {
      action,
      ok: true,
      output: [
        `Transcript (${result.engine}):`,
        result.text,
        '',
        ...(platformFailure ? [`(Platform speech recognition failed: ${platformFailure.message}; local Whisper was used instead.)`] : []),
        `Command: ${result.command}`,
        result.modelPath ? `Model path: ${result.modelPath}` : `Model: ${result.model ?? 'base'}`,
      ].join('\n'),
      data: result,
    };
  } catch (error) {
    if (platformFailure) {
      return { action, ok: false, output: `Transcription failed: ${platformFailure.message}; local Whisper failed too: ${error instanceof Error ? error.message : String(error)}` };
    }
    throw error;
  }
}
