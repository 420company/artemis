import type { AgentAction } from '../core/types.js';
import { transcribeLocalAudio } from '../core/localStt.js';
import { ProviderStore } from '../providers/store.js';
import type { ToolExecutionContext, ToolExecutionResult } from './types.js';

type TranscribeAudioAction = Extract<AgentAction, { type: 'transcribe_audio' }>;

export async function executeTranscribeAudio(
  action: TranscribeAudioAction,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const setup = (await new ProviderStore(context.cwd).load()).setup;
  const stt = setup?.voice.stt;
  const provider = stt?.provider ?? 'local';
  if (provider !== 'local') {
    return {
      action,
      ok: false,
      output: `Configured STT provider "${provider}" is not implemented in this runtime yet. Use local Whisper STT for the free no-API path.`,
    };
  }

  const result = await transcribeLocalAudio({
    cwd: context.cwd,
    inputPath: action.inputPath,
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
      `Command: ${result.command}`,
      result.modelPath ? `Model path: ${result.modelPath}` : `Model: ${result.model ?? 'base'}`,
    ].join('\n'),
    data: result,
  };
}
