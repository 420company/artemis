/**
 * tools/serverSetup/keys.ts — SSH and WireGuard key pairs made in-process
 * (no ssh-keygen or wg binary needed on the agent's machine).
 */

import { generateKeyPairSync, randomBytes } from 'node:crypto';

function sshString(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function rawEd25519(): { seed: Buffer; pub: Buffer } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwkPriv = privateKey.export({ format: 'jwk' }) as { d: string };
  const jwkPub = publicKey.export({ format: 'jwk' }) as { x: string };
  return { seed: Buffer.from(jwkPriv.d, 'base64url'), pub: Buffer.from(jwkPub.x, 'base64url') };
}

export interface SshKeyPair {
  /** OpenSSH private key (PEM "OPENSSH PRIVATE KEY", unencrypted). */
  privateKey: string;
  /** authorized_keys line: "ssh-ed25519 AAAA… comment". */
  publicKey: string;
}

/** An Ed25519 key pair in the formats OpenSSH reads. */
export function generateSshKeyPair(comment = 'artemis'): SshKeyPair {
  const { seed, pub } = rawEd25519();
  const keyType = 'ssh-ed25519';
  const publicBlob = Buffer.concat([sshString(keyType), sshString(pub)]);
  const check = randomBytes(4).readUInt32BE(0);
  let privateSection = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ]);
  const pad: number[] = [];
  for (let i = 1; (privateSection.length + pad.length) % 8 !== 0; i++) pad.push(i);
  privateSection = Buffer.concat([privateSection, Buffer.from(pad)]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'binary'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(publicBlob),
    sshString(privateSection),
  ]);
  const b64 = body.toString('base64').replace(/(.{70})/g, '$1\n').replace(/\n$/, '');
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${b64}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `${keyType} ${publicBlob.toString('base64')} ${comment}`,
  };
}

export interface WireGuardKeyPair {
  privateKey: string;
  publicKey: string;
}

/** A WireGuard (Curve25519) key pair, base64 as `wg genkey` / `wg pubkey` print them. */
export function generateWireGuardKeyPair(): WireGuardKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const d = Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url');
  // Clamp as `wg genkey` does (the curve operation clamps anyway).
  d[0]! &= 248;
  d[31]! &= 127;
  d[31]! |= 64;
  const x = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return { privateKey: d.toString('base64'), publicKey: x.toString('base64') };
}
