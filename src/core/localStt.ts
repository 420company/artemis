import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveArtemisHomeDir } from '../utils/fs.js';
import { convertToSpeechWav, FfmpegMissingError, NoAudioError, probeMedia } from './audioChunks.js';

const execFileAsync = promisify(execFile);

export type LocalSttEngine = 'whisper.cpp' | 'openai-whisper';

export type LocalSttOptions = {
  inputPath: string;
  cwd?: string;
  language?: string;
  model?: string;
  modelPath?: string;
  engine?: LocalSttEngine | 'auto';
  command?: string;
};

export type LocalSttResult = {
  text: string;
  engine: LocalSttEngine;
  command: string;
  language?: string;
  model?: string;
  modelPath?: string;
  textPath?: string;
};

type ResolvedExecutable = {
  command: string;
  engine: LocalSttEngine;
};

function resolveInputPath(inputPath: string, cwd = process.cwd()): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function inferEngineFromCommand(command: string): LocalSttEngine {
  const base = path.basename(command).toLowerCase();
  return base === 'whisper' ? 'openai-whisper' : 'whisper.cpp';
}

async function resolveExecutable(options: LocalSttOptions): Promise<ResolvedExecutable> {
  if (options.command) {
    return { command: options.command, engine: options.engine === 'openai-whisper' ? 'openai-whisper' : inferEngineFromCommand(options.command) };
  }

  if (options.engine !== 'openai-whisper') {
    const whisperCpp = await findOnPath('whisper-cli') ?? await findOnPath('main');
    if (whisperCpp) {
      return { command: whisperCpp, engine: 'whisper.cpp' };
    }
  }

  if (options.engine !== 'whisper.cpp') {
    const whisper = await findOnPath('whisper');
    if (whisper) {
      return { command: whisper, engine: 'openai-whisper' };
    }
  }

  throw new Error([
    'No local STT engine found.',
    'Install one free local engine:',
    '- whisper.cpp: build/install whisper-cli and download a ggml model, then set ARTEMIS_WHISPER_MODEL=/path/to/ggml-base.bin',
    '- Python whisper: pipx install openai-whisper or pip install openai-whisper',
  ].join('\n'));
}

async function resolveWhisperCppModel(options: LocalSttOptions): Promise<string> {
  const candidates = [
    options.modelPath,
    process.env.ARTEMIS_WHISPER_MODEL,
    path.join(options.cwd ?? process.cwd(), '.artemis', 'models', `ggml-${options.model ?? 'base'}.bin`),
    path.join(resolveArtemisHomeDir(), 'models', `ggml-${options.model ?? 'base'}.bin`),
    path.join(os.homedir(), 'models', `ggml-${options.model ?? 'base'}.bin`),
  ].filter((value): value is string => Boolean(value?.trim()));

  for (const candidate of candidates) {
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(options.cwd ?? process.cwd(), candidate);
    if (await exists(resolved)) {
      return resolved;
    }
  }

  throw new Error([
    'whisper.cpp requires a local ggml model file.',
    'Set ARTEMIS_WHISPER_MODEL=/absolute/path/to/ggml-base.bin or configure setup.voice.stt.modelPath.',
    'The model is free; common choices are ggml-tiny.bin, ggml-base.bin, ggml-small.bin.',
  ].join('\n'));
}

function normalizeText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Whether a local Whisper engine is installed (the platform's fallback). */
export async function localSttAvailable(options: Pick<LocalSttOptions, 'engine' | 'command'> = {}): Promise<boolean> {
  try {
    await resolveExecutable({ inputPath: '', ...options });
    return true;
  } catch {
    return false;
  }
}

async function transcribeWithWhisperCpp(command: string, inputPath: string, options: LocalSttOptions, work: string): Promise<LocalSttResult> {
  const modelPath = await resolveWhisperCppModel(options);
  const outBase = path.join(work, 'transcript');
  const args = ['-m', modelPath, '-f', inputPath, '-otxt', '-of', outBase];
  if (options.language?.trim()) {
    args.push('-l', options.language.trim());
  }

  const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 20 });
  const fileText = await readFile(`${outBase}.txt`, 'utf8').catch(() => '');
  const text = normalizeText(fileText || stdout || stderr);
  if (!text) {
    throw new Error('Local STT completed but returned no transcript.');
  }

  return {
    text,
    engine: 'whisper.cpp',
    command,
    language: options.language,
    model: options.model ?? 'base',
    modelPath,
  };
}

async function transcribeWithOpenAiWhisper(command: string, inputPath: string, options: LocalSttOptions, work: string): Promise<LocalSttResult> {
  const outputDir = path.join(work, 'out');
  await mkdir(outputDir, { recursive: true });
  const model = options.model ?? 'base';
  const args = [inputPath, '--model', model, '--output_dir', outputDir, '--output_format', 'txt'];
  if (options.language?.trim()) {
    args.push('--language', options.language.trim());
  }

  const { stdout, stderr } = await execFileAsync(command, args, { maxBuffer: 1024 * 1024 * 20 });
  const textPath = path.join(outputDir, `${path.basename(inputPath, path.extname(inputPath))}.txt`);
  const fileText = await readFile(textPath, 'utf8').catch(() => '');
  const text = normalizeText(fileText || stdout || stderr);
  if (!text) {
    throw new Error('Local STT completed but returned no transcript.');
  }

  return {
    text,
    engine: 'openai-whisper',
    command,
    language: options.language,
    model,
  };
}

export async function transcribeLocalAudio(options: LocalSttOptions): Promise<LocalSttResult> {
  const inputPath = resolveInputPath(options.inputPath, options.cwd);
  if (!(await exists(inputPath))) {
    throw new Error(`Audio file not found: ${inputPath}`);
  }

  const executable = await resolveExecutable(options);
  // One temp folder per run, always removed: the converted WAV and the transcript files.
  const work = await mkdtemp(path.join(os.tmpdir(), 'artemis-stt-'));
  try {
    // Whisper reads WAV best (older whisper.cpp builds nothing else): with
    // ffmpeg, the file is probed (playlists and file lists refused) and
    // converted under the same local-files-only flags as the platform path;
    // without it, the file is tried as it is.
    let input = inputPath;
    try {
      const probe = await probeMedia(inputPath);
      if (!probe.hasAudio) throw new NoAudioError('');
      input = path.join(work, 'audio.wav');
      await convertToSpeechWav(inputPath, input);
    } catch (error) {
      if (!(error instanceof FfmpegMissingError)) throw error;
      input = inputPath;
    }
    if (executable.engine === 'openai-whisper') {
      return await transcribeWithOpenAiWhisper(executable.command, input, options, work);
    }
    return await transcribeWithWhisperCpp(executable.command, input, options, work);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}
