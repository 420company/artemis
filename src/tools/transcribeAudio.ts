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
  splitSpeechWav,
  type AudioPiece,
} from '../core/audioChunks.js';
import {
  audioContentType,
  PLATFORM_SPEECH_MAX_BYTES,
  PlatformSpeechError,
  platformSpeechFallsBack,
  resolvePlatformSpeech,
  transcribeWithPlatform,
  type PlatformSpeechConfig,
} from '../core/platformSpeech.js';
import { ProviderStore } from '../providers/store.js';
import { getMediaOutputRoot } from '../utils/mediaOutputRoot.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

type TranscribeAudioAction = Extract<AgentAction, { type: 'transcribe_audio' }>;

/** Longer transcripts are saved to a file and shown in part. */
const INLINE_TRANSCRIPT_CHARS = 20_000;
/** Four hours: beyond that, ask for a part of the file. */
const MAX_PLATFORM_SECONDS = 4 * 3600;

export type PlatformFileTranscription = {
  text: string;
  pieces: { startSeconds: number; durationSeconds: number; text: string }[];
  durationSeconds: number;
};

/**
 * Transcribes a local audio or video file through platform speech
 * recognition: converted to 16 kHz mono WAV, split into pieces of at most
 * five minutes at pauses, each piece sent in turn (one retry each for a
 * passing failure). Without ffmpeg, a small file in a format the platform
 * reads is sent as it is.
 */
export async function transcribeFileWithPlatform(
  inputPath: string,
  config: PlatformSpeechConfig,
  options: { language?: string; signal?: AbortSignal; fetchImpl?: typeof fetch; ffmpeg?: string; retryDelayMs?: number } = {},
): Promise<PlatformFileTranscription> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'artemis-stt-'));
  try {
    let pieces: AudioPiece[];
    let durationSeconds = 0;
    let direct: { audio: Buffer; type: string } | undefined;
    try {
      const wav = path.join(tmp, 'audio.wav');
      await convertToSpeechWav(inputPath, wav, { ffmpeg: options.ffmpeg, signal: options.signal });
      const split = await splitSpeechWav(wav, tmp);
      pieces = split.pieces;
      durationSeconds = split.durationSeconds;
    } catch (error) {
      if (error instanceof NoAudioError) throw new PlatformSpeechError('invalid_audio', error.message);
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
      pieces = [{ path: inputPath, startSeconds: 0, durationSeconds: 0 }];
    }
    if (durationSeconds > MAX_PLATFORM_SECONDS) {
      throw new PlatformSpeechError(
        'too_large',
        `the recording is ${formatTimestamp(durationSeconds)} long; transcribe at most ${MAX_PLATFORM_SECONDS / 3600} hours at a time (cut it with ffmpeg first)`,
      );
    }

    const results: PlatformFileTranscription['pieces'] = [];
    for (const [index, piece] of pieces.entries()) {
      const audio = direct?.audio ?? (await readFile(piece.path));
      const type = direct?.type ?? 'audio/wav';
      let result;
      try {
        result = await transcribeOnce(audio, type, config, options);
      } catch (error) {
        if (results.length > 0 && error instanceof PlatformSpeechError) {
          const partial = joinPieces(results);
          throw new PlatformSpeechError(
            error.code,
            `${error.message}. Part ${index + 1} of ${pieces.length} failed; the parts before it (up to ${formatTimestamp(piece.startSeconds)}) were transcribed:\n${partial}`,
          );
        }
        throw error;
      }
      if (!durationSeconds && result.durationSeconds) durationSeconds = result.durationSeconds;
      results.push({ startSeconds: piece.startSeconds, durationSeconds: piece.durationSeconds || result.durationSeconds, text: result.text });
    }
    return { text: joinPieces(results), pieces: results, durationSeconds };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** One piece; a passing failure (busy, network, upstream) is tried once more. */
async function transcribeOnce(
  audio: Buffer,
  type: string,
  config: PlatformSpeechConfig,
  options: { language?: string; signal?: AbortSignal; fetchImpl?: typeof fetch; retryDelayMs?: number },
) {
  const call = () => transcribeWithPlatform(audio, type, config, { language: options.language, signal: options.signal, fetchImpl: options.fetchImpl });
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof PlatformSpeechError) || !['rate_limited', 'unreachable', 'failed'].includes(error.code) || options.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 2_000));
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
  const platform = wantsLocal ? undefined : await resolvePlatformSpeech();
  let platformFailure: PlatformSpeechError | undefined;
  if (platform) {
    try {
      const result = await transcribeFileWithPlatform(inputPath, platform, { language: action.language ?? (stt?.language || undefined) });
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
