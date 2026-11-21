import { hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MemoryEngine } from './engine.js';
import { decryptBox, encryptBox } from './envelope.js';
import { identifier, type State } from './model.js';

const maxPlaintext = 12 * 1024 * 1024;
const iv = z.string().length(16).base64();
const tag = z.string().regex(/^[A-Za-z0-9+/]{22}==$/);
const wrapSchema = z.object({ iv, tag, ciphertext: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) }).strict();
const bodySchema = z.object({ iv, tag, ciphertext: z.string().min(4).max(4 * maxPlaintext / 3).base64() }).strict();
const sequenceSchema = z.number().int().min(1).max(2147483647);
export const portableEnvelopeSchema = z.object({
  version: z.literal(1), vaultId: identifier, sequence: sequenceSchema,
  parentRevision: identifier.nullable(), wrapped: wrapSchema, body: bodySchema,
}).strict();

export type PortableEnvelope = z.infer<typeof portableEnvelopeSchema>;
export type PortableKeys = { vaultId: string; secret: Buffer; wrapped: PortableEnvelope['wrapped'] };
type PortableRecord = { sequence: number; parentRevision: string | null; state: State };

function binding(accountId: string, vaultId: string): string {
  if (!identifier.safeParse(accountId).success || !identifier.safeParse(vaultId).success ||
      accountId.toLowerCase() === vaultId.toLowerCase()) throw Error('ACCOUNT_VAULT_MISMATCH');
  return JSON.stringify(['growth-brain/account-vault/v1', accountId, vaultId]);
}

function aad(accountId: string, metadata: Omit<PortableEnvelope,'body'|'version'>): string {
  const w = metadata.wrapped;
  return JSON.stringify([binding(accountId, metadata.vaultId), 'snapshot', metadata.sequence,
    metadata.parentRevision, w.iv, w.tag, w.ciphertext]);
}

function validKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw Error('INVALID_ACCOUNT_KEY');
}

export function createPortableKeys(accountId: string, wrappingKey: Buffer): PortableKeys {
  validKey(wrappingKey);
  const vaultId = randomUUID();
  const label = binding(accountId, vaultId);
  const secret = randomBytes(32);
  try {
    return { vaultId, secret, wrapped: encryptBox(secret, wrappingKey, label + '/key') };
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

export function unwrapPortableKeys(accountId: string, wrappingKey: Buffer, payload: unknown): PortableKeys {
  validKey(wrappingKey);
  const { vaultId, wrapped } = portableEnvelopeSchema.parse(payload);
  const secret = decryptBox(wrapped, wrappingKey, binding(accountId, vaultId) + '/key');
  return { vaultId, wrapped, secret };
}

function subkey(keys: PortableKeys, purpose: string): Buffer {
  validKey(keys.secret);
  return Buffer.from(hkdfSync('sha256', keys.secret, keys.vaultId, 'growth-brain/account-vault/v1/' + purpose, 32));
}

export function localVaultPassword(keys: PortableKeys): string {
  const local = subkey(keys, 'local-file');
  try { return local.toString('base64url'); } finally { local.fill(0); }
}

/** Device permissions, raw capture archives, and per-device counters stay local.
 * Encrypted account records keep their decision history and cited evidence. */
export function portableState(state: State): State {
  return new MemoryEngine({
    ...state, captureSettings: [], agentBindings: [], captures: [], agentCaptures: [],
    inferenceUsage: {day:'1970-01-01',units:0,minute:0,calls:0,projects:{}},
  }).snapshot();
}

export function sealPortable(keys: PortableKeys, accountId: string, record: PortableRecord): PortableEnvelope {
  if (record.state.ownerId !== keys.vaultId) throw Error('ACCOUNT_VAULT_MISMATCH');
  const metadata = {
    vaultId: keys.vaultId, sequence: sequenceSchema.parse(record.sequence),
    parentRevision: identifier.nullable().parse(record.parentRevision), wrapped: wrapSchema.parse(keys.wrapped),
  };
  const label = aad(accountId, metadata);
  const plaintext = Buffer.from(JSON.stringify(portableState(record.state)));
  const key = subkey(keys, 'remote-snapshot');
  try {
    if (plaintext.length > maxPlaintext) throw Error('VAULT_SIZE_LIMIT');
    return { version:1, ...metadata, body:encryptBox(plaintext, key, label) };
  } finally { key.fill(0); plaintext.fill(0); }
}

export function openPortable(keys: PortableKeys, accountId: string, input: unknown): PortableRecord {
  const envelope = portableEnvelopeSchema.parse(input);
  if (envelope.vaultId !== keys.vaultId ||
      envelope.wrapped.iv !== keys.wrapped.iv || envelope.wrapped.tag !== keys.wrapped.tag ||
      envelope.wrapped.ciphertext !== keys.wrapped.ciphertext) {
    throw Error('ACCOUNT_VAULT_MISMATCH');
  }
  const label = aad(accountId, envelope);
  const key = subkey(keys, 'remote-snapshot');
  let plaintext: Buffer | undefined;
  try {
    plaintext = decryptBox(envelope.body, key, label);
    const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
    const state = new MemoryEngine(parsed).snapshot();
    if (state.captureSettings.length || state.agentBindings.length || state.captures.length || state.agentCaptures.length) {
      throw Error('INVALID_PORTABLE_STATE');
    }
    if (state.ownerId !== keys.vaultId) throw Error('ACCOUNT_VAULT_MISMATCH');
    return {sequence:envelope.sequence, parentRevision:envelope.parentRevision, state};
  } finally { key.fill(0); plaintext?.fill(0); }
}
