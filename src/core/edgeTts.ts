import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import tls from 'node:tls';

const EDGE_TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_TTS_HOST = 'speech.platform.bing.com';
const EDGE_TTS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_TTS_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const EDGE_CHROMIUM_FULL_VERSION = '143.0.3650.75';
const EDGE_CHROMIUM_MAJOR_VERSION = EDGE_CHROMIUM_FULL_VERSION.split('.', 1)[0];
const SEC_MS_GEC_VERSION = `1-${EDGE_CHROMIUM_FULL_VERSION}`;
const WIN_EPOCH_SECONDS = 11644473600;

export type EdgeTtsOptions = {
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

function normalizeVoice(language = 'en-US', voice = ''): string {
  if (voice && voice !== 'default') {
    return voice;
  }
  if (language.toLowerCase().startsWith('zh')) {
    return 'zh-CN-XiaoxiaoNeural';
  }
  return 'en-US-AriaNeural';
}

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

function generateSecMsGec(): string {
  const ticks = Math.floor((Date.now() / 1000 + WIN_EPOCH_SECONDS) / 300) * 300 * 10000000;
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

function resolveOutputPath(options: EdgeTtsOptions): string {
  if (options.outputPath) {
    return path.isAbsolute(options.outputPath)
      ? options.outputPath
      : path.resolve(options.cwd ?? process.cwd(), options.outputPath);
  }
  const fileName = `edge-tts-${Date.now()}-${requestId().slice(0, 8)}.mp3`;
  return path.resolve(options.cwd ?? process.cwd(), '.artemis', 'tts', fileName);
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

export async function synthesizeEdgeTts(options: EdgeTtsOptions): Promise<EdgeTtsResult> {
  const text = options.text.trim();
  if (!text) {
    throw new Error('TTS text is required.');
  }
  const voice = normalizeVoice(options.language, options.voice);
  const language = options.language || inferLanguageFromVoice(voice);
  const id = requestId();
  const connectionId = requestId();
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect({
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
      else resolve();
    };

    const timeout = setTimeout(() => {
      finish(new Error('Edge TTS timed out before synthesis completed.'));
    }, 30000);

    socket.once('secureConnect', () => {
      socket.write(buildHandshakeRequest(connectionId, randomBytes(16).toString('base64')));
    });
    socket.on('error', (error) => finish(error));
    socket.on('data', (data) => {
      try {
        buffered = Buffer.concat([buffered, data]);
        if (!handshakeComplete) {
          const headerEnd = buffered.indexOf('\r\n\r\n');
          if (headerEnd === -1) return;

          const responseHeaders = buffered.subarray(0, headerEnd).toString('utf8');
          if (!/^HTTP\/1\.1 101\b/.test(responseHeaders)) {
            finish(new Error(`Edge TTS WebSocket handshake failed: ${responseHeaders.split('\r\n')[0]}`));
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
            finish(chunks.length > 0 ? undefined : new Error('Edge TTS closed before returning audio.'));
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

  if (chunks.length === 0) {
    throw new Error('Edge TTS completed without returning audio.');
  }

  const audio = Buffer.concat(chunks);
  const outputPath = resolveOutputPath(options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, audio);
  return { outputPath, bytes: audio.length, voice, language };
}
