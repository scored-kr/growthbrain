import { scryptAsync } from '@noble/hashes/scrypt';
import { z } from 'zod';

// Wire formats from the recovery branch's account-keys.ts and account-envelope.ts.
const passwordProtocol = 'growth-brain/account-password/v1';
const envelopeProtocol = 'growth-brain/account-vault/v1';
const maxPlaintext = 12 * 1024 * 1024;
const utf8 = new TextEncoder();
const maxSequence = 2147483647;
const sequenceSchema = z.int().min(1).max(maxSequence);
const parentSchema = z.uuid().nullable();
const wrappedSchema = z.strictObject({
  iv: z.string().length(16), tag: z.string().length(24), ciphertext: z.string().length(44),
});
const envelopeSchema = z.strictObject({
  version: z.literal(1), vaultId: z.uuid(), sequence: sequenceSchema, parentRevision: parentSchema,
  wrapped: wrappedSchema,
  body: wrappedSchema.extend({ ciphertext: z.string().min(4).max(4 * maxPlaintext / 3) }),
});
export type Envelope = z.infer<typeof envelopeSchema>;
type Box = Envelope['wrapped'];
type Bytes = Uint8Array<ArrayBuffer>;
type SnapshotKeys = { vaultId: string; wrapped: Box; bodyKey: CryptoKey };
type Revision = Pick<Envelope, 'sequence' | 'parentRevision'>;

function base64(input: Bytes): string {
  const chunks: string[] = [];
  for (let i = 0; i < input.length; i += 32768) {
    chunks.push(String.fromCharCode(...input.subarray(i, i + 32768)));
  }
  return btoa(chunks.join(''));
}

function decode(input: string): Bytes {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (base64(bytes) !== input) throw Error('INVALID_ENVELOPE');
  return bytes;
}

async function hkdf(key: CryptoKey, salt: Bytes, purpose: string): Promise<Bytes> {
  const algorithm = { name: 'HKDF', hash: 'SHA-256', salt, info: utf8.encode(purpose) };
  return new Uint8Array(await crypto.subtle.deriveBits(algorithm, key, 256));
}

function aesKey(bytes: Bytes) {
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function deriveAccountKeys(email: string, password: string, issuer: string) {
  const canonical = email.trim().normalize('NFC').toLowerCase();
  if (canonical.length > 254 || !/^[^\s@\p{C}]+@[^\s@\p{C}]+\.[^\s@\p{C}]+$/u.test(canonical)) throw Error('INVALID_EMAIL');
  if (!password || password.length > 1024 || /[\uD800-\uDFFF]/u.test(password)) throw Error('INVALID_ACCOUNT_PASSWORD');
  const url = new URL(issuer);
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('INVALID_ACCOUNT_ISSUER');

  const salt = new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(JSON.stringify([passwordProtocol, url.origin, canonical]))));
  const input = utf8.encode(password);
  let root: Uint8Array | undefined;
  let login: Bytes | undefined;
  let wrapping: Bytes | undefined;
  try {
    root = await scryptAsync(input, salt, { N: 131072, r: 8, p: 1, dkLen: 32, maxmem: 160 * 1024 * 1024 });
    const rootKey = await crypto.subtle.importKey('raw', root as Bytes, 'HKDF', false, ['deriveBits']);
    login = await hkdf(rootKey, salt, passwordProtocol + '/provider-login');
    wrapping = await hkdf(rootKey, salt, passwordProtocol + '/vault-wrapping');
    const authPassword = 'Gb1!' + base64(login).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    return { email: canonical, authPassword, wrappingKey: await aesKey(wrapping) };
  } finally {
    input.fill(0); root?.fill(0); login?.fill(0); wrapping?.fill(0);
  }
}

function binding(accountId: string, vaultId: string) {
  if (!z.uuid().safeParse(accountId).success || !z.uuid().safeParse(vaultId).success ||
      accountId.toLowerCase() === vaultId.toLowerCase()) throw Error('ACCOUNT_VAULT_MISMATCH');
  return JSON.stringify([envelopeProtocol, accountId, vaultId]);
}

function associatedData(accountId: string, content: Revision & { vaultId: string; wrapped: Box }) {
  const { vaultId, sequence, parentRevision, wrapped } = content;
  return JSON.stringify([binding(accountId, vaultId), 'snapshot', sequence, parentRevision,
    wrapped.iv, wrapped.tag, wrapped.ciphertext]);
}

async function encrypt(key: CryptoKey, bytes: Bytes, label: string): Promise<Box> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(label) }, key, bytes));
  return { iv: base64(iv), tag: base64(result.subarray(-16)), ciphertext: base64(result.subarray(0, -16)) };
}

async function decrypt(key: CryptoKey, box: Box, label: string): Promise<Bytes> {
  const iv = decode(box.iv), tag = decode(box.tag), ciphertext = decode(box.ciphertext);
  if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length || ciphertext.length > maxPlaintext) throw Error('INVALID_ENVELOPE');
  const input = new Uint8Array(ciphertext.length + tag.length);
  input.set(ciphertext); input.set(tag, ciphertext.length);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: utf8.encode(label) }, key, input));
}

async function snapshotKeys(secret: Bytes, vaultId: string, wrapped: Box): Promise<SnapshotKeys> {
  if (secret.length !== 32) throw Error('INVALID_ACCOUNT_KEY');
  const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bytes = await hkdf(material, utf8.encode(vaultId), envelopeProtocol + '/remote-snapshot');
  try { return { vaultId, wrapped, bodyKey: await aesKey(bytes) }; }
  finally { bytes.fill(0); }
}

export async function createSnapshotKeys(accountId: string, wrappingKey: CryptoKey): Promise<SnapshotKeys> {
  const vaultId = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wrapped = await encrypt(wrappingKey, secret, binding(accountId, vaultId) + '/key');
    return await snapshotKeys(secret, vaultId, wrapped);
  } finally { secret.fill(0); }
}

export async function unlockSnapshotKeys(accountId: string, wrappingKey: CryptoKey, payload: unknown): Promise<SnapshotKeys> {
  const { vaultId, wrapped } = envelopeSchema.parse(payload);
  const secret = await decrypt(wrappingKey, wrapped, binding(accountId, vaultId) + '/key');
  try { return await snapshotKeys(secret, vaultId, wrapped); }
  finally { secret.fill(0); }
}

// The caller projects and validates its portable application state. Only the
// cryptographic envelope is shared across application-state versions.
function checkStateOwner(state: unknown, vaultId: string): asserts state is { ownerId: string } {
  if (!state || typeof state !== 'object' || !('ownerId' in state) || state.ownerId !== vaultId) {
    throw Error('ACCOUNT_VAULT_MISMATCH');
  }
}

export async function sealSnapshot<T extends { ownerId: string }>(accountId: string, keys: SnapshotKeys, revision: Revision, state: T): Promise<Envelope> {
  checkStateOwner(state, keys.vaultId);
  const metadata = {
    sequence: sequenceSchema.parse(revision.sequence), parentRevision: parentSchema.parse(revision.parentRevision),
    vaultId: keys.vaultId, wrapped: wrappedSchema.parse(keys.wrapped),
  };
  const plaintext = utf8.encode(JSON.stringify(state));
  try {
    if (plaintext.length > maxPlaintext) throw Error('VAULT_SIZE_LIMIT');
    return { version: 1, ...metadata, body: await encrypt(keys.bodyKey, plaintext, associatedData(accountId, metadata)) };
  } finally { plaintext.fill(0); }
}

export async function openSnapshot<T>(accountId: string, keys: SnapshotKeys, payload: unknown, parse: (state: unknown) => T): Promise<T> {
  const env = envelopeSchema.parse(payload);
  if (env.vaultId !== keys.vaultId || env.wrapped.iv !== keys.wrapped.iv ||
      env.wrapped.tag !== keys.wrapped.tag || env.wrapped.ciphertext !== keys.wrapped.ciphertext) throw Error('ACCOUNT_VAULT_MISMATCH');
  const plaintext = await decrypt(keys.bodyKey, env.body, associatedData(accountId, env));
  try {
    const state: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    checkStateOwner(state, keys.vaultId);
    return parse(state);
  } finally { plaintext.fill(0); }
}
