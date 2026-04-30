import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentAction } from '../core/types.js';
import { synthesizeEdgeTts } from '../core/edgeTts.js';
import { ProviderStore } from '../providers/store.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

const execFileAsync = promisify(execFile);

type SynthesizeSpeechAction = Extract<AgentAction, { type: 'synthesize_speech' }>;

export async function executeSynthesizeSpeech(
  action: SynthesizeSpeechAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const setup = (await new ProviderStore(context.cwd).load()).setup;
  const tts = setup?.voice.tts;
  const provider = tts?.provider ?? 'edge';
  if (provider !== 'edge') {
    return {
      action,
      ok: false,
      output: `Configured TTS provider "${provider}" is not implemented in this runtime yet. Use Microsoft Edge TTS for the free built-in path.`,
    };
  }

  const result = await synthesizeEdgeTts({
    cwd: context.cwd,
    text: action.text,
    voice: action.voice ?? tts?.voice,
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
    ].join('\n'),
    data: result,
  };
}
