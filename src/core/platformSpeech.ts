/**
 * The "platform" backend of transcribe_audio: speech to text through the
 * hosted platform's model gateway (`POST <gateway>/v1/audio/transcriptions`).
 *
 * A hosted VPS has no local Whisper. The gateway runs the platform's speech
 * model and bills the audio to the owner's account; the engine authenticates
 * with the platform key it already uses for the platform's models. The agent
 * server writes where to find them into the global providers.json:
 *
 *   "speech": { "provider": "platform", "enabled": true,
 *               "baseUrl": "https://<gateway>/v1", "apiKey": "ak-…",
 *               "sttModel": "<the tier's speech-to-text model>",
 *               "ttsModel": "<the tier's text-to-speech model>",
 *               "managedBy": "platform" }
 *
 * `enabled: false` turns both off; without `sttModel` there is no platform
 * speech to text, without `ttsModel` no platform text to speech (the tier has
 * no such model). Text to speech goes to `/v1/audio/speech` (licensed
 * voices, billed to the owner) and is synthesize_speech's first choice. Only the global store (~/.artemis or
 * $ARTEMIS_HOME) is read, so a workspace's own providers.json cannot point
 * the platform key at another endpoint.
 *
 * The gateway takes one recording of at most 12 MB per request. Long audio
 * and video files are first turned into 16 kHz mono WAV pieces of at most
 * five minutes (see audioChunks.ts) and transcribed piece by piece.
 */
import { createGlobalProviderStore } from '../providers/store.js';

export interface PlatformSpeechConfig {
  /** The gateway's API root, e.g. https://gw.example/v1. */
  baseUrl: string;
  /** The owner's platform key. */
  apiKey: string;
  /** The tier's speech-to-text model, if it has one. */
  sttModel?: string;
  /** The tier's text-to-speech model, if it has one. */
  ttsModel?: string;
}

/** Platform speech with a speech-to-text model. */
export type PlatformSttConfig = PlatformSpeechConfig & { sttModel: string };

/** The largest recording the gateway takes in one request. */
export const PLATFORM_SPEECH_MAX_BYTES = 12 * 1024 * 1024;

/** One piece: a few minutes of speech within 120 s, the gateway's own retries included. */
export const PLATFORM_SPEECH_TIMEOUT_MS = 120_000;

type SpeechEntry = {
  provider?: unknown;
  enabled?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  sttModel?: unknown;
  ttsModel?: unknown;
};

const isHttpUrl = (value: unknown): value is string => typeof value === 'string' && /^https?:\/\/\S+$/i.test(value.trim());
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/**
 * The platform speech settings from a provider store's data, or undefined
 * when this host has none (or they are turned off). Pure, for tests.
 */
export function platformSpeechFromStore(data: { speech?: unknown }): PlatformSpeechConfig | undefined {
  const entry = data.speech;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const speech = entry as SpeechEntry;
  if (speech.provider !== 'platform' || speech.enabled === false) return undefined;
  if (!isHttpUrl(speech.baseUrl) || !isText(speech.apiKey)) return undefined;
  const sttModel = isText(speech.sttModel) ? speech.sttModel.trim() : undefined;
  const ttsModel = isText(speech.ttsModel) ? speech.ttsModel.trim() : undefined;
  if (!sttModel && !ttsModel) return undefined;
  return { baseUrl: speech.baseUrl.trim(), apiKey: speech.apiKey.trim(), ...(sttModel ? { sttModel } : {}), ...(ttsModel ? { ttsModel } : {}) };
}

/** The platform speech settings of this host, from the global providers.json. */
export async function resolvePlatformSpeech(): Promise<PlatformSpeechConfig | undefined> {
  try {
    const data = await createGlobalProviderStore().load();
    return platformSpeechFromStore(data as { speech?: unknown });
  } catch {
    // An unreadable store means no platform speech, never a crash of the tool.
    return undefined;
  }
}

export type PlatformSpeechErrorCode =
  | 'insufficient_balance'
  | 'rate_limited'
  | 'unavailable'
  | 'unreachable'
  | 'unauthorized'
  | 'too_large'
  | 'unsupported_format'
  | 'invalid_audio'
  | 'failed';

/** A failure the model can relay to the user as is: never a made-up transcript. */
export class PlatformSpeechError extends Error {
  constructor(
    readonly code: PlatformSpeechErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlatformSpeechError';
  }
}

/** Failures where local Whisper (when installed) may still do the job. */
export function platformSpeechFallsBack(error: unknown): boolean {
  return error instanceof PlatformSpeechError && ['unavailable', 'unreachable', 'unauthorized', 'rate_limited', 'failed'].includes(error.code);
}

export interface PlatformTranscription {
  text: string;
  /** Seconds of audio the platform measured (0 when it did not say). */
  durationSeconds: number;
}

/**
 * One recording through the gateway. Rejects with a PlatformSpeechError
 * whose message says plainly what went wrong.
 */
export async function transcribeWithPlatform(
  audio: Uint8Array,
  contentType: string,
  config: PlatformSttConfig,
  options: { language?: string; prompt?: string; signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<PlatformTranscription> {
  if (audio.byteLength === 0) throw new PlatformSpeechError('invalid_audio', 'the recording is empty');
  if (audio.byteLength > PLATFORM_SPEECH_MAX_BYTES) {
    throw new PlatformSpeechError('too_large', 'the recording is larger than platform speech recognition takes in one piece (12 MB)');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? PLATFORM_SPEECH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': contentType,
    'x-model': config.sttModel,
  };
  // A header carries only ASCII: anything but a language tag (zh, en-US) is dropped, never sent.
  const language = languageTag(options.language);
  if (language) headers['x-language'] = language;
  const prompt = options.prompt?.trim();
  if (prompt) headers['x-prompt'] = encodeURIComponent(prompt.slice(0, 1_000));
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers,
      body: new Uint8Array(audio),
      signal,
    });
  } catch (error) {
    throw new PlatformSpeechError(
      'unreachable',
      timeout.aborted ? 'platform speech recognition did not answer in time' : `platform speech recognition is unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let data: { text?: unknown; durationSeconds?: unknown; error?: { code?: unknown; message?: unknown } } | undefined;
  try {
    data = (await response.json()) as typeof data;
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const code = typeof data?.error?.code === 'string' ? data.error.code : '';
    const detail = typeof data?.error?.message === 'string' && data.error.message ? `: ${data.error.message}` : '';
    if (response.status === 402) throw new PlatformSpeechError('insufficient_balance', 'platform speech recognition refused: the account balance is too low (the owner needs to top up)');
    if (response.status === 429) {
      const retry = response.headers.get('retry-after');
      throw new PlatformSpeechError('rate_limited', `platform speech recognition is busy${retry ? `; retry in ${retry} s` : ''}`);
    }
    if (response.status === 401 || response.status === 403) throw new PlatformSpeechError('unauthorized', 'platform speech recognition refused the platform key');
    if (response.status === 413) throw new PlatformSpeechError('too_large', 'the recording is too large for platform speech recognition');
    if (response.status === 415) throw new PlatformSpeechError('unsupported_format', `platform speech recognition cannot read this audio format${detail}`);
    if (response.status === 400) throw new PlatformSpeechError('invalid_audio', `platform speech recognition could not read the recording${detail}`);
    if (response.status === 404 || response.status === 503) {
      throw new PlatformSpeechError('unavailable', `platform speech recognition is not available right now (${code || `HTTP ${response.status}`})`);
    }
    throw new PlatformSpeechError('failed', `platform speech recognition failed (${code || `HTTP ${response.status}`})${detail}`);
  }
  if (typeof data?.text !== 'string') throw new PlatformSpeechError('failed', 'platform speech recognition answered without text');
  const duration = typeof data.durationSeconds === 'number' && Number.isFinite(data.durationSeconds) && data.durationSeconds > 0 ? data.durationSeconds : 0;
  return { text: data.text.trim(), durationSeconds: duration };
}

/** The media type the gateway expects for a file, by its extension. */
export function audioContentType(filePath: string): string | undefined {
  const ext = filePath.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
    case 'oga':
    case 'opus':
      return 'audio/ogg';
    case 'webm':
      return 'audio/webm';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    default:
      return undefined;
  }
}

/** A BCP-47 language tag (zh, en-US, zh-Hans-CN), or undefined for anything else ("中文", "Chinese"). */
export function languageTag(value: string | undefined): string | undefined {
  const tag = value?.trim();
  return tag && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : undefined;
}

/** Voices a platform text-to-speech model takes (the OpenAI names; multilingual). */
export const PLATFORM_VOICES = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'] as const;
export const DEFAULT_PLATFORM_VOICE = 'nova';

/** Text one platform speech request carries. */
export const PLATFORM_TTS_MAX_CHARS = 4_000;

/**
 * Text to MP3 through the platform's licensed voices (`/v1/audio/speech`).
 * `voice` is a PLATFORM_VOICES name (anything else: the default); `speed`
 * 0.25-4. Rejects with a PlatformSpeechError worded for the model.
 */
export async function synthesizeWithPlatform(
  text: string,
  config: PlatformSpeechConfig & { ttsModel: string },
  options: { voice?: string; speed?: number; signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Buffer> {
  const input = text.trim();
  if (!input) throw new PlatformSpeechError('invalid_audio', 'there is no text to speak');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const voice = (PLATFORM_VOICES as readonly string[]).includes(options.voice ?? '') ? options.voice! : DEFAULT_PLATFORM_VOICE;
  let response: Response;
  try {
    response = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/audio/speech`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.ttsModel,
        input,
        voice,
        response_format: 'mp3',
        ...(options.speed !== undefined && Number.isFinite(options.speed) && options.speed !== 1 ? { speed: Math.min(4, Math.max(0.25, options.speed)) } : {}),
      }),
      signal,
    });
  } catch (error) {
    throw new PlatformSpeechError(
      'unreachable',
      timeout.aborted ? 'platform speech synthesis did not answer in time' : `platform speech synthesis is unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => undefined)) as { error?: { code?: unknown } } | undefined;
    const code = typeof data?.error?.code === 'string' ? data.error.code : `HTTP ${response.status}`;
    if (response.status === 402) throw new PlatformSpeechError('insufficient_balance', 'platform speech synthesis refused: the account balance is too low (the owner needs to top up)');
    if (response.status === 429) throw new PlatformSpeechError('rate_limited', 'platform speech synthesis is busy; try again shortly');
    if (response.status === 401 || response.status === 403) throw new PlatformSpeechError('unauthorized', 'platform speech synthesis refused the platform key');
    if (response.status === 404 || response.status === 503) throw new PlatformSpeechError('unavailable', `platform speech synthesis is not available right now (${code})`);
    if (response.status === 400) throw new PlatformSpeechError('invalid_audio', `platform speech synthesis refused the text (${code})`);
    throw new PlatformSpeechError('failed', `platform speech synthesis failed (${code})`);
  }
  const audio = Buffer.from(await response.arrayBuffer());
  if (audio.length === 0) throw new PlatformSpeechError('failed', 'platform speech synthesis answered without audio');
  return audio;
}
