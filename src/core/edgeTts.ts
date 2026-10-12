import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import tls from 'node:tls';
import { getMediaOutputRoot } from '../utils/mediaOutputRoot.js';

const EDGE_TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_TTS_HOST = 'speech.platform.bing.com';
const EDGE_TTS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_TTS_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const EDGE_CHROMIUM_FULL_VERSION = '143.0.3650.75';
const EDGE_CHROMIUM_MAJOR_VERSION = EDGE_CHROMIUM_FULL_VERSION.split('.', 1)[0];
const SEC_MS_GEC_VERSION = `1-${EDGE_CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH_SECONDS = 11644473600;
/**
 * Text per request, in UTF-8 bytes after XML escaping: the service refuses
 * long SSML, so longer text is spoken in pieces (about 650 Chinese
 * characters or 2000 Latin ones each) and the MP3s are joined.
 */
export const EDGE_TTS_MAX_PIECE_BYTES = 2000;

/**
 * Voices worth offering, by language. The Chinese ones read English words
 * in mixed text well; the multilingual English ones read Chinese too.
 */
export const EDGE_TTS_VOICES: ReadonlyArray<{ id: string; language: string; gender: 'female' | 'male'; style: string }> = [
  { id: 'zh-CN-XiaoxiaoNeural', language: 'zh-CN', gender: 'female', style: 'warm, natural (default for Chinese)' },
  { id: 'zh-CN-XiaoyiNeural', language: 'zh-CN', gender: 'female', style: 'lively' },
  { id: 'zh-CN-YunxiNeural', language: 'zh-CN', gender: 'male', style: 'bright, conversational' },
  { id: 'zh-CN-YunjianNeural', language: 'zh-CN', gender: 'male', style: 'deep, energetic' },
  { id: 'zh-CN-YunyangNeural', language: 'zh-CN', gender: 'male', style: 'news anchor' },
  { id: 'zh-TW-HsiaoChenNeural', language: 'zh-TW', gender: 'female', style: 'Taiwanese Mandarin' },
  { id: 'zh-HK-HiuMaanNeural', language: 'zh-HK', gender: 'female', style: 'Cantonese' },
  { id: 'en-US-AvaMultilingualNeural', language: 'en-US', gender: 'female', style: 'expressive, multilingual' },
  { id: 'en-US-AndrewMultilingualNeural', language: 'en-US', gender: 'male', style: 'warm, multilingual' },
  { id: 'en-US-AriaNeural', language: 'en-US', gender: 'female', style: 'clear (default for English)' },
  { id: 'en-US-GuyNeural', language: 'en-US', gender: 'male', style: 'clear' },
  { id: 'en-GB-SoniaNeural', language: 'en-GB', gender: 'female', style: 'British' },
  { id: 'ja-JP-NanamiNeural', language: 'ja-JP', gender: 'female', style: 'Japanese' },
  { id: 'ko-KR-SunHiNeural', language: 'ko-KR', gender: 'female', style: 'Korean' },
];

/**
 * Microsoft's online read-aloud voices are a consumer service: this client
 * presents itself as the Edge browser to reach it, which its terms do not
 * grant to other software. It is therefore off unless the operator opts in
 * (ARTEMIS_EDGE_TTS=1, or setup.voice.tts.edgeOptIn), accepting that risk;
 * hosted installs speak through the platform's licensed voices instead.
 */
export function edgeTtsOptedIn(setupOptIn: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return setupOptIn === true || /^(?:1|true|yes|on)$/i.test(env.ARTEMIS_EDGE_TTS?.trim() ?? '');
}

/** Most of the letters are Han (Chinese) characters. */
export function isMostlyChinese(text: string): boolean {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return han > 0 && han * 2 >= latin;
}

/**
 * The voice for a text: the one asked for, else the configured one unless it
 * cannot speak the text (an English voice for Chinese text, or the other
 * way round), else a default for the text's language.
 */
/** The language a text is in, as far as its script and letters tell (undefined: no strong sign). */
export function scriptLanguage(text: string): 'zh' | 'ja' | 'ko' | 'latin-other' | 'en' | undefined {
  const count = (re: RegExp) => text.match(re)?.length ?? 0;
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(/\p{Script=Hangul}/gu);
  const han = count(/\p{Script=Han}/gu);
  const latin = count(/[A-Za-z\u00C0-\u024F]/g);
  if (kana > 0 && kana * 4 >= han) return 'ja';
  if (hangul > 0 && hangul * 2 >= latin) return 'ko';
  if (han > 0 && han * 2 >= latin) return 'zh';
  if (latin === 0) return undefined;
  // Accented letters, or words common in other Latin-script languages: a multilingual voice reads them.
  if (/[\u00C0-\u024F]/.test(text) || /\b(?:le|la|les|des|est|und|der|die|das|el|los|que|una|por|il|che|não|uma|het|een)\b/i.test(text)) return 'latin-other';
  return 'en';
}

const SCRIPT_VOICES: Record<'zh' | 'ja' | 'ko' | 'latin-other' | 'en', string> = {
  zh: 'zh-CN-XiaoxiaoNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  'latin-other': 'en-US-AvaMultilingualNeural',
  en: 'en-US-AriaNeural',
};

/**
 * The voice for a text: the one asked for, else the configured one when it
 * can speak the text's language (a multilingual voice speaks any), else one
 * for the text's script: Chinese, Japanese (kana), Korean (hangul), English,
 * or a multilingual voice for other Latin-script languages (French, ...).
 */
export function pickEdgeVoice(text: string, options: { voice?: string; configured?: string; language?: string } = {}): string {
  const asked = options.voice?.trim();
  if (asked && asked !== 'default') return asked;
  const fromTag = options.language?.toLowerCase();
  const language =
    fromTag?.startsWith('zh') ? 'zh' : fromTag?.startsWith('ja') ? 'ja' : fromTag?.startsWith('ko') ? 'ko' : fromTag?.startsWith('en') ? 'en' : fromTag ? 'latin-other' : (scriptLanguage(text) ?? 'en');
  const configured = options.configured?.trim();
  if (configured && configured !== 'default') {
    if (/Multilingual/i.test(configured) && language !== 'ja' && language !== 'ko') return configured;
    const prefix = configured.slice(0, 2).toLowerCase();
    if ((language === 'zh' || language === 'ja' || language === 'ko' || language === 'en') && prefix === language) return configured;
  }
  return SCRIPT_VOICES[language];
}

/**
 * Splits text into pieces of at most `maxBytes` (UTF-8, after XML escaping),
 * at sentence ends where possible, else at commas or spaces, else anywhere.
 */
export function splitSpeechText(text: string, maxBytes = EDGE_TTS_MAX_PIECE_BYTES): string[] {
  const size = (value: string) => Buffer.byteLength(escapeXml(value), 'utf8');
  const clean = text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  if (!clean) return [];
  if (size(clean) <= maxBytes) return [clean];
  const sentences = clean.match(/(?:[^。！？!?；;\n.]|\.(?!\s|$))+(?:[。！？!?；;\n]+|\.+\s*|$)|[。！？!?；;\n.]+/g) ?? [clean];
  const pieces: string[] = [];
  let current = '';
  const push = (part: string) => {
    if (!part.trim()) return;
    if (current && size(current + part) > maxBytes) {
      pieces.push(current.trim());
      current = '';
    }
    if (size(part) <= maxBytes) {
      current += part;
      return;
    }
    // One sentence too long: at commas or spaces, else by characters.
    const words = part.match(/[^，,、：:\s]+[，,、：:\s]*/g) ?? [part];
    for (const word of words) {
      if (current && size(current + word) > maxBytes) {
        pieces.push(current.trim());
        current = '';
      }
      if (size(word) <= maxBytes) {
        current += word;
        continue;
      }
      for (const ch of Array.from(word)) {
        if (current && size(current + ch) > maxBytes) {
          pieces.push(current.trim());
          current = '';
        }
        current += ch;
      }
    }
  };
  for (const sentence of sentences) push(sentence);
  if (current.trim()) pieces.push(current.trim());
  return pieces.filter(Boolean);
}

export type EdgeTtsOptions = {
  /** Tests: a stand-in for the TLS connection to the service. */
  connect?: () => Duplex;
  text: string;
  voice?: string;
  language?: string;
  outputPath?: string;
  cwd?: string;
  rate?: number;
  pitch?: number;
};

export type EdgeTtsResult = {
  outputPath: string;
  bytes: number;
  voice: string;
  language: string;
};

function inferLanguageFromVoice(voice: string, fallback = 'en-US'): string {
  const match = /^([a-z]{2}-[A-Z]{2})-/.exec(voice);
  return match?.[1] ?? fallback;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatProsodyPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value === 1) {
    return '+0%';
  }
  const percent = Math.round((value - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function requestId(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * Seconds the service's clock is ahead of ours. The handshake token is
 * time-based, so a VPS whose clock drifts is refused (403) until this is
 * taken from the refusal's Date header.
 */
let clockSkewSeconds = 0;

function generateSecMsGec(): string {
  const ticks = Math.floor((Date.now() / 1000 + clockSkewSeconds + WIN_EPOCH_SECONDS) / 300) * 300 * 10000000;
  return createHash('sha256').update(`${ticks}${EDGE_TTS_TOKEN}`, 'ascii').digest('hex').toUpperCase();
}

function buildHeaders(headers: Record<string, string>): string {
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n');
}

function buildSpeechConfigMessage(id: string): string {
  const body = JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: 'false',
            wordBoundaryEnabled: 'false',
          },
          outputFormat: EDGE_TTS_OUTPUT_FORMAT,
        },
      },
    },
  });

  return `${buildHeaders({
    Path: 'speech.config',
    'X-RequestId': id,
    'X-Timestamp': new Date().toISOString(),
    'Content-Type': 'application/json',
  })}\r\n\r\n${body}`;
}

function buildSsmlMessage(options: Required<Pick<EdgeTtsOptions, 'text' | 'voice' | 'language'>> & Pick<EdgeTtsOptions, 'rate' | 'pitch'>, id: string): string {
  const ssml = [
    `<speak version="1.0" xml:lang="${escapeXml(options.language)}" xmlns="http://www.w3.org/2001/10/synthesis">`,
    `<voice name="${escapeXml(options.voice)}">`,
    `<prosody rate="${formatProsodyPercent(options.rate)}" pitch="${formatProsodyPercent(options.pitch)}">`,
    escapeXml(options.text),
    '</prosody>',
    '</voice>',
    '</speak>',
  ].join('');

  return `${buildHeaders({
    Path: 'ssml',
    'X-RequestId': id,
    'X-Timestamp': new Date().toISOString(),
    'Content-Type': 'application/ssml+xml',
  })}\r\n\r\n${ssml}`;
}

function extractAudioPayload(frame: Buffer): Buffer | null {
  if (frame.length < 2) {
    return null;
  }
  const headerLength = frame.readUInt16BE(0);
  if (frame.length < 2 + headerLength) {
    return null;
  }
  const headers = frame.subarray(2, 2 + headerLength).toString('utf8');
  if (!/^Path:\s*audio/im.test(headers)) {
    return null;
  }
  const payload = frame.subarray(2 + headerLength);
  return payload.length > 0 ? payload : null;
}

export function resolveOutputPath(options: Pick<EdgeTtsOptions, 'outputPath' | 'cwd'>): string {
  if (options.outputPath) {
    return path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(options.cwd ?? process.cwd(), options.outputPath);
  }
  // Next to the agent's other media, where the owner can open and download it.
  const fileName = `speech-${new Date().toISOString().replace(/[:.]/g, '-')}-${requestId().slice(0, 6)}.mp3`;
  return path.join(getMediaOutputRoot(), 'audio', fileName);
}

function encodeClientFrame(data: string | Buffer, opcode: 1 | 2 | 10): Buffer {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(0x80 | payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    const length = BigInt(payload.length);
    header.push(0x80 | 127);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      header.push(Number((length >> shift) & 0xffn));
    }
  }

  const mask = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ mask[i % 4];
  }

  return Buffer.concat([Buffer.from(header), mask, masked]);
}

type DecodedFrame = {
  opcode: number;
  payload: Buffer;
  frameLength: number;
};

function tryDecodeServerFrame(buffer: Buffer): DecodedFrame | null {
  if (buffer.length < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Edge TTS WebSocket frame is too large.');
    }
    length = Number(bigLength);
    offset += 8;
  }

  let mask: Buffer | undefined;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = payload[i] ^ mask[i % 4];
    }
  }

  return { opcode, payload, frameLength: offset + length };
}

function buildHandshakeRequest(connectionId: string, secWebSocketKey: string): string {
  const query = [
    `TrustedClientToken=${EDGE_TTS_TOKEN}`,
    `ConnectionId=${connectionId}`,
    `Sec-MS-GEC=${generateSecMsGec()}`,
    `Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`,
  ].join('&');

  return [
    `GET ${EDGE_TTS_PATH}?${query} HTTP/1.1`,
    `Host: ${EDGE_TTS_HOST}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Pragma: no-cache',
    'Cache-Control: no-cache',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Key: ${secWebSocketKey}`,
    'Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${EDGE_CHROMIUM_MAJOR_VERSION}.0.0.0`,
    'Accept-Encoding: gzip, deflate, br, zstd',
    'Accept-Language: en-US,en;q=0.9',
    `Cookie: muid=${randomBytes(16).toString('hex').toUpperCase()};`,
    '',
    '',
  ].join('\r\n');
}

/** The handshake was refused; `date` is the service's clock when it said so. */
class EdgeHandshakeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly date?: string,
  ) {
    super(message);
  }
}

/** One request: one piece of text to MP3 bytes. */
function synthesizePiece(text: string, voice: string, language: string, options: Pick<EdgeTtsOptions, 'rate' | 'pitch' | 'connect'>): Promise<Buffer> {
  const id = requestId();
  const connectionId = requestId();
  const chunks: Buffer[] = [];

  return new Promise<Buffer>((resolve, reject) => {
    const socket: Duplex = options.connect?.() ?? tls.connect({
      host: EDGE_TTS_HOST,
      port: 443,
      servername: EDGE_TTS_HOST,
    });
    let settled = false;
    let handshakeComplete = false;
    let buffered = Buffer.alloc(0);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else if (chunks.length === 0) reject(new Error('Edge TTS completed without returning audio.'));
      else resolve(Buffer.concat(chunks));
    };

    const timeout = setTimeout(() => {
      finish(new Error('Edge TTS timed out before synthesis completed.'));
    }, 30000);

    socket.once('secureConnect', () => {
      socket.write(buildHandshakeRequest(connectionId, randomBytes(16).toString('base64')));
    });
    socket.on('error', (error) => finish(error));
    socket.on('close', () => finish(new Error('Edge TTS connection closed before the speech was complete.')));
    socket.on('data', (data) => {
      try {
        buffered = Buffer.concat([buffered, data]);
        if (!handshakeComplete) {
          const headerEnd = buffered.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;

          const responseHeaders = buffered.subarray(0, headerEnd).toString('utf8');
          if (!/^HTTP\/1\.1 101\b/.test(responseHeaders)) {
            const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(responseHeaders)?.[1] ?? 0);
            const date = /^date:\s*(.+)$/im.exec(responseHeaders)?.[1]?.trim();
            finish(new EdgeHandshakeError(`Edge TTS WebSocket handshake failed: ${responseHeaders.split('\r\n')[0]}`, status, date));
            return;
          }

          handshakeComplete = true;
          buffered = buffered.subarray(headerEnd + 4);
          socket.write(encodeClientFrame(buildSpeechConfigMessage(id), 1));
          socket.write(encodeClientFrame(buildSsmlMessage({ text, voice, language, rate: options.rate, pitch: options.pitch }, id), 1));
        }

        for (;;) {
          const frame = tryDecodeServerFrame(buffered);
          if (!frame) break;
          buffered = buffered.subarray(frame.frameLength);

          if (frame.opcode === 8) {
            // Only turn.end means the speech is complete: a close before it is half a reply, never kept.
            finish(new Error('Edge TTS closed before the speech was complete.'));
            return;
          }
          if (frame.opcode === 9) {
            socket.write(encodeClientFrame(frame.payload, 10));
            continue;
          }
          if (frame.opcode === 1) {
            const message = frame.payload.toString('utf8');
            if (/Path:\s*turn\.end/i.test(message)) {
              finish();
              return;
            }
            continue;
          }
          if (frame.opcode === 2) {
            const payload = extractAudioPayload(frame.payload);
            if (payload) chunks.push(payload);
            else if (/Path:\s*turn\.end/i.test(frame.payload.toString('utf8'))) {
              finish();
              return;
            }
          }
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** One piece, once more after a refusal that a clock correction fixes. */
async function synthesizePieceWithClockFix(text: string, voice: string, language: string, options: Pick<EdgeTtsOptions, 'rate' | 'pitch' | 'connect'>): Promise<Buffer> {
  try {
    return await synthesizePiece(text, voice, language, options);
  } catch (error) {
    if (!(error instanceof EdgeHandshakeError) || error.status !== 403 || !error.date) throw error;
    const server = Date.parse(error.date);
    if (!Number.isFinite(server)) throw error;
    clockSkewSeconds = (server - Date.now()) / 1000;
    return synthesizePiece(text, voice, language, options);
  }
}

/** Speech as MP3 bytes, without writing a file; long text is spoken in pieces. */
export async function synthesizeEdgeTtsAudio(options: Omit<EdgeTtsOptions, 'outputPath' | 'cwd'> & { configuredVoice?: string }): Promise<{ audio: Buffer; voice: string; language: string; pieces: number }> {
  const pieces = splitSpeechText(options.text);
  if (pieces.length === 0) {
    throw new Error('TTS text is required.');
  }
  const voice = pickEdgeVoice(options.text, { voice: options.voice, configured: options.configuredVoice, language: options.language });
  const language = options.language || inferLanguageFromVoice(voice);
  const audio: Buffer[] = [];
  for (const piece of pieces) {
    audio.push(await synthesizePieceWithClockFix(piece, voice, language, options));
  }
  return { audio: Buffer.concat(audio), voice, language, pieces: pieces.length };
}

export async function synthesizeEdgeTts(options: EdgeTtsOptions & { configuredVoice?: string }): Promise<EdgeTtsResult> {
  const { audio, voice, language } = await synthesizeEdgeTtsAudio(options);
  const outputPath = resolveOutputPath(options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, audio);
  return { outputPath, bytes: audio.length, voice, language };
}
