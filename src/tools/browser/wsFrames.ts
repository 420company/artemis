/**
 * A minimal server side of RFC 6455 WebSockets, for the live browser host.
 *
 * The host only speaks CDP (JSON text messages) to two kinds of local
 * clients: Playwright in the engine and the platform server. Both are
 * well-behaved Node clients, so this covers exactly what they send: masked
 * text frames, fragmentation, ping/pong and close. No extensions are
 * negotiated (permessage-deflate offers are ignored), which the protocol
 * allows. Kept dependency-free on purpose: the engine does not otherwise
 * ship a WebSocket server.
 */
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Largest message accepted from a client (full-page screenshots travel the other way). */
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024 * 1024;

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + ACCEPT_GUID).digest('base64');
}

/** The 101 response for a valid upgrade request, or undefined when the key is missing or malformed. */
export function handshakeResponse(headers: Record<string, string | string[] | undefined>): string | undefined {
  const key = headers['sec-websocket-key'];
  const version = headers['sec-websocket-version'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key.trim())) return undefined;
  if (version !== undefined && version !== '13') return undefined;
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key.trim())}`,
    '',
    '',
  ].join('\r\n');
}

/** One unmasked server frame. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, payload]);
}

export interface FrameHandlers {
  onText: (text: string) => void;
  onClose: () => void;
}

/**
 * Incremental decoder for client frames. Returns frames to send back
 * (pong, close) through `reply`. Throws on protocol violations; the caller
 * then drops the connection.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentBytes = 0;
  private fragmentOpcode = 0;

  constructor(
    private readonly handlers: FrameHandlers,
    private readonly reply: (frame: Buffer) => void,
    private readonly maxMessageBytes = MAX_CLIENT_MESSAGE_BYTES,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    for (;;) {
      const frame = this.next();
      if (!frame) return;
      this.handle(frame.fin, frame.opcode, frame.payload);
    }
  }

  private next(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
    const buf = this.buffer;
    if (buf.length < 2) return undefined;
    const fin = (buf[0]! & 0x80) !== 0;
    if ((buf[0]! & 0x70) !== 0) throw new Error('reserved bits set (no extensions were negotiated)');
    const opcode = buf[0]! & 0x0f;
    const masked = (buf[1]! & 0x80) !== 0;
    if (!masked) throw new Error('client frames must be masked');
    let length = buf[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return undefined;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return undefined;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(this.maxMessageBytes)) throw new Error('frame too large');
      length = Number(big);
      offset = 10;
    }
    if (length > this.maxMessageBytes) throw new Error('frame too large');
    if (buf.length < offset + 4 + length) return undefined;
    const mask = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + length));
    for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i & 3]!;
    this.buffer = buf.subarray(offset + 4 + length);
    return { fin, opcode, payload };
  }

  private handle(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode >= 0x8) {
      // Control frames are never fragmented and may arrive between fragments.
      if (!fin || payload.length > 125) throw new Error('invalid control frame');
      if (opcode === 0x8) {
        this.reply(encodeFrame(0x8, payload.subarray(0, 2)));
        this.handlers.onClose();
      } else if (opcode === 0x9) {
        this.reply(encodeFrame(0xa, payload));
      }
      return;
    }
    if (opcode === 0x0) {
      if (!this.fragmentOpcode) throw new Error('continuation without a first frame');
    } else {
      if (this.fragmentOpcode) throw new Error('new message before the last one ended');
      this.fragmentOpcode = opcode;
    }
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) throw new Error('message too large');
    this.fragments.push(payload);
    if (!fin) return;
    const message = Buffer.concat(this.fragments);
    const kind = this.fragmentOpcode;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = 0;
    // CDP is JSON text; a binary message is decoded the same way.
    if (kind === 0x1 || kind === 0x2) this.handlers.onText(message.toString('utf8'));
  }
}

/** Wires a raw upgraded socket to text-message callbacks. */
export function attachWebSocket(
  socket: Duplex,
  onText: (text: string) => void,
  onClose: () => void,
): { send: (text: string) => void; close: () => void } {
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  const write = (frame: Buffer) => {
    if (!closed && socket.writable) socket.write(frame);
  };
  const decoder = new FrameDecoder({ onText, onClose: () => { finish(); socket.end(); } }, write);
  socket.on('data', (chunk: Buffer) => {
    try {
      decoder.push(chunk);
    } catch {
      finish();
      socket.destroy();
    }
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return {
    send: (text) => write(encodeFrame(0x1, Buffer.from(text, 'utf8'))),
    close: () => {
      write(encodeFrame(0x8, Buffer.from([0x03, 0xe8])));
      finish();
      socket.end();
    },
  };
}
