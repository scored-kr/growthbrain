import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { z } from 'zod';
import { MemoryEngine } from './engine.js';
import { identifier } from './model.js';

const box = z.object({ iv: z.string().base64(), tag: z.string().base64(), ciphertext: z.string().base64() }).strict();
const passwordSlot = box.extend({ salt: z.string().base64() });
export const envelopeSchema = z.discriminatedUnion('version', [
  box.extend({ version: z.literal(1), ownerId: identifier, salt: z.string().base64() }),
  box.extend({ version: z.literal(2), ownerId: identifier, password: passwordSlot, recovery: box.optional() }),
]);
export type Envelope = z.infer<typeof envelopeSchema>;
export type Header = { version: 1; ownerId: string; salt: string } |
  { version: 2; ownerId: string; password: z.infer<typeof passwordSlot>; recovery?: z.infer<typeof box> };
export const recoverySchema = z.object({
  format: z.literal('growth-brain-recovery'), version: z.literal(1), ownerId: identifier,
  key: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export async function derive(password: string, salt: Buffer) {
  if (password.length < 12 || password.length > 1024) throw new Error('PASSPHRASE_LENGTH');
  if (salt.length !== 16) throw new Error('INVALID_ENVELOPE');
  return await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
  });
}
function encrypt(plaintext: Buffer, key: Buffer, aad: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
function decryptBox(data: z.infer<typeof box>, key: Buffer, aad: string) {
  const iv = Buffer.from(data.iv, 'base64'), tag = Buffer.from(data.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('INVALID_ENVELOPE');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(tag);
  let chunk: Buffer | undefined;
  try { chunk = decipher.update(Buffer.from(data.ciphertext, 'base64')); return Buffer.concat([chunk, decipher.final()]); }
  catch { throw new Error('UNLOCK_FAILED'); }
  finally { chunk?.fill(0); }
}
export function headerOf(data: Envelope): Header {
  return data.version === 1 ? { version: 1, ownerId: data.ownerId, salt: data.salt } :
    { version: 2, ownerId: data.ownerId, password: data.password, ...(data.recovery ? { recovery: data.recovery } : {}) };
}
function aad(header: Header) {
  // Canonical field order authenticates every key slot, including removal of recovery.
  const canonicalBox = (value: z.infer<typeof box>) => ({ iv: value.iv, tag: value.tag, ciphertext: value.ciphertext });
  return header.version === 1 ? `growth-brain:1:${header.ownerId}` : JSON.stringify({
    version: 2, ownerId: header.ownerId,
    password: { salt: header.password.salt, ...canonicalBox(header.password) },
    recovery: header.recovery ? canonicalBox(header.recovery) : null,
  });
}
export function seal(engine: MemoryEngine, key: Buffer, header: Header): Envelope {
  const state = engine.snapshot();
  if (state.ownerId !== header.ownerId) throw new Error('OWNER_MISMATCH');
  const plaintext = Buffer.from(JSON.stringify(state));
  try { return { ...header, ...encrypt(plaintext, key, aad(header)) }; }
  finally { plaintext.fill(0); }
}
function openPayload(data: Envelope, ownerId: string, key: Buffer) {
  if (key.length !== 32) { key.fill(0); throw new Error('INVALID_ENVELOPE'); }
  try {
    const plaintext = decryptBox(data, key, aad(headerOf(data)));
    let engine: MemoryEngine;
    try { engine = new MemoryEngine(JSON.parse(plaintext.toString('utf8'))); } finally { plaintext.fill(0); }
    if (engine.snapshot().ownerId !== ownerId) throw new Error('OWNER_MISMATCH');
    return { engine, key, header: headerOf(data) };
  } catch (error) { key.fill(0); throw error; }
}
export async function decrypt(data: Envelope, ownerId: string, password: string) {
  if (data.ownerId !== ownerId) throw new Error('OWNER_MISMATCH');
  if (data.version === 1) return openPayload(data, ownerId, await derive(password, Buffer.from(data.salt, 'base64')));
  const wrappingKey = await derive(password, Buffer.from(data.password.salt, 'base64'));
  try { return openPayload(data, ownerId, decryptBox(data.password, wrappingKey, `growth-brain:2:${ownerId}:password`)); }
  finally { wrappingKey.fill(0); }
}
export function decryptRecovery(data: Envelope, ownerId: string, recovery: z.infer<typeof recoverySchema>) {
  if (data.ownerId !== ownerId || recovery.ownerId !== ownerId) throw new Error('OWNER_MISMATCH');
  if (data.version !== 2 || !data.recovery) throw new Error('RECOVERY_NOT_ENABLED');
  const wrappingKey = Buffer.from(recovery.key, 'base64url');
  try { return openPayload(data, ownerId, decryptBox(data.recovery, wrappingKey, `growth-brain:2:${ownerId}:recovery`)); }
  finally { wrappingKey.fill(0); }
}
export async function newHeader(ownerId: string, password: string, key: Buffer, recoveryKey?: Buffer): Promise<Header> {
  const salt = randomBytes(16), wrappingKey = await derive(password, salt);
  try {
    return { version: 2, ownerId, password: { salt: salt.toString('base64'), ...encrypt(key, wrappingKey, `growth-brain:2:${ownerId}:password`) },
      ...(recoveryKey ? { recovery: encrypt(key, recoveryKey, `growth-brain:2:${ownerId}:recovery`) } : {}) };
  } finally { wrappingKey.fill(0); }
}
