import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAction } from '../core/types.js';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { edgeTtsOptedIn, resolveOutputPath, splitSpeechText, synthesizeEdgeTts } from '../core/edgeTts.js';
import {
  DEFAULT_PLATFORM_VOICE,
  PLATFORM_TTS_MAX_CHARS,
  PLATFORM_VOICES,
  PlatformSpeechError,
  platformSpeechFallsBack,
  resolvePlatformSpeech,
  synthesizeWithPlatform,
} from '../core/platformSpeech.js';
import { ProviderStore } from '../providers/store.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

const execFileAsync = promisify(execFile);

type SynthesizeSpeechAction = Extract<AgentAction, { type: 'synthesize_speech' }>;

/** Where the MP3 lands (the media folder by default) and that it is written. */
async function save(outputPath: string, audio: Buffer): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, audio);
}

/**
 * Speech, in this order: the platform's licensed voices (a hosted VPS,
 * `speech.ttsModel` in the global providers.json), then the free Edge voices
 * only when the operator opted in (edgeTtsOptedIn); otherwise a plain
 * failure that says text to speech is not set up.
 */
export async function executeSynthesizeSpeech(
  action: SynthesizeSpeechAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const setup = (await new ProviderStore(context.cwd).load()).setup;
  const tts = setup?.voice.tts;
  const edge = edgeTtsOptedIn(tts?.edgeOptIn);
  const platform = await resolvePlatformSpeech();
  const ttsModel = platform?.ttsModel;
  let platformFailure: PlatformSpeechError | undefined;

  if (platform && ttsModel) {
    try {
      const pieces = splitSpeechText(action.text, PLATFORM_TTS_MAX_CHARS);
      if (pieces.length === 0) return { action, ok: false, output: 'There is no text to speak.' };
      const audio: Buffer[] = [];
      for (const piece of pieces) {
        audio.push(await synthesizeWithPlatform(piece, { ...platform, ttsModel }, {
          ...(action.voice ? { voice: action.voice } : {}),
          ...(action.rate !== undefined ? { speed: action.rate } : {}),
          ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        }));
      }
      const outputPath = resolveOutputPath({ outputPath: action.outputPath, cwd: context.cwd });
      const bytes = Buffer.concat(audio);
      await save(outputPath, bytes);
      if (action.playAudio === true && process.platform === 'darwin') await execFileAsync('afplay', [outputPath]);
      const voice = (PLATFORM_VOICES as readonly string[]).includes(action.voice ?? '') ? action.voice! : DEFAULT_PLATFORM_VOICE;
      return {
        action,
        ok: true,
        output: [`Speech synthesized: ${outputPath}`, 'Provider: platform voices', `Voice: ${voice}`, `Bytes: ${bytes.length}`].join('\n'),
        data: { outputPath, bytes: bytes.length, voice, provider: 'platform' },
      };
    } catch (error) {
      platformFailure = error instanceof PlatformSpeechError ? error : new PlatformSpeechError('failed', error instanceof Error ? error.message : String(error));
      if (!edge || !platformSpeechFallsBack(platformFailure)) return { action, ok: false, output: `Speech synthesis failed: ${platformFailure.message}` };
    }
  }

  if (!edge) {
    return {
      action,
      ok: false,
      output: [
        'Text to speech is not set up on this host: the platform offers no voice model on this plan, and the free Edge voices are off.',
        'The operator can opt in to the Edge voices with ARTEMIS_EDGE_TTS=1 (or setup.voice.tts.edgeOptIn), accepting that this consumer service is not licensed for use by other software.',
      ].join('\n'),
    };
  }

  const result = await synthesizeEdgeTts({
    cwd: context.cwd,
    text: action.text,
    voice: action.voice,
    // The configured voice unless it cannot speak this text (an English voice for Chinese).
    configuredVoice: tts?.voice,
    language: action.language,
    outputPath: action.outputPath,
    rate: action.rate,
    pitch: action.pitch,
  });

  if (action.playAudio === true && process.platform === 'darwin') {
    await execFileAsync('afplay', [result.outputPath]);
  }

  return {
    action,
    ok: true,
    output: [
      `Speech synthesized: ${result.outputPath}`,
      `Provider: Microsoft Edge TTS`,
      `Voice: ${result.voice}`,
      `Bytes: ${result.bytes}`,
      ...(platformFailure ? [`(Platform voices failed: ${platformFailure.message}; the Edge voices were used instead.)`] : []),
    ].join('\n'),
    data: result,
  };
}
