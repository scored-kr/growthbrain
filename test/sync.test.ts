import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, hkdfSync, scryptSync } from 'node:crypto';
import { z } from 'zod';
import { deriveAccountKeys, openSnapshot, sealSnapshot, unlockSnapshotKeys } from '../sync/account-envelope.ts';

const issuer = 'https://test-auth.example', email = 'pilot@example.test', password = 'SYNTHETIC account test vector 01';
const account = '018fb5a0-497d-4473-a314-fbcbf328105a';
// Produced by running deriveAccountKeys + createPortableKeys + sealPortable from recovery 0144875.
const legacy = {
  version: 1, vaultId: 'f448259b-28a3-4bff-812e-128e2d1dd279', sequence: 1, parentRevision: null,
  wrapped: { iv: 'FHy4BtVE8I9Dx9Ks', tag: 'W0EQtGdrrZhTE2/nmWqWMw==', ciphertext: '5+khQ9Y9Bf7DuWoeYxJRA7ob3B8O8DOVFEsxnCwg6Xc=' },
  body: {
    iv: '/7CzEbKsl7vsPmIm', tag: '+0mD39/aRfA1e2fVBa6bhA==',
    ciphertext: 'HMETcmFGgda/iwCG+xIf8DJ3/TmXRXnoWV9L2sJ6+k5Yqh8R4yJTn10c8ISagSLQT7HQQDNyRoumIiu13K6GBI4k9BB4qjLlMznwLchio4TMctBuYYilnU2dcM8c+wEG9zisC+ECde8722+KmiDBijXRkhePTV2+Vm3AInsKN20r1eYMWBY+z7ueO9145eW1XP5RrR0emD5F+Q39JGhbptvctKN6MjWTTF0N0xwfdG4BOUXjazrYL8l6CcA4cVuVRfl4gWZ6q8RJsqfbDhutpwYBrIOdj2YsJRo1Q4HSGCjhTrMKtU8HYi4zQx9kB9G4afDJmWIVEWR4dQUzngLjxTC/4efNlPLDIWUKB7QDSYg3PdA1xw9FChUYmkkQHDZf0UiCvpZLUzvtVEcXfW6DIlMnrC+pRROEJXOpHj8v6eZ7vfOkpsH7qNOh7Vu+IY/EnZmLU4tnjwI4C1B+AB465yAreDHRxdlOkMq+Ny4=',
  },
};
const projectState = z.looseObject({ ownerId: z.uuid(), projects: z.array(z.object({ id: z.uuid(), name: z.string() })) });

function nativeOpen(key: Buffer, box: typeof legacy.body, aad: string) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]);
}

test('portable v1 opens the archived implementation’s snapshot and produces a native-readable revision', async () => {
  const login = await deriveAccountKeys('  PILOT@Example.TEST ', password, issuer + '/');
  const hash = createHash('sha256').update(login.authPassword).digest('hex');
  assert.equal(hash, '84a7621d5dd965393923d61669b91a10878ba6eb678c0dfc47ad57dfbcb6d058');
  const keys = await unlockSnapshotKeys(account, login.wrappingKey, legacy);
  const state = await openSnapshot(account, keys, legacy, projectState.parse);
  assert.equal(state.projects[0].name, 'Recovery format 호환 원고');
  const parentRevision = crypto.randomUUID();
  state.projects[0].name = '새 리비전';
  const next = await sealSnapshot(account, keys, {sequence: 2, parentRevision}, state);
  assert.notEqual(next.body.iv, legacy.body.iv);
  const proto = 'growth-brain/account-password/v1';
  const salt = createHash('sha256').update(JSON.stringify([proto, issuer, email])).digest();
  const root = scryptSync(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
  const wrapping = Buffer.from(hkdfSync('sha256', root, salt, proto + '/vault-wrapping', 32));
  const label = JSON.stringify(['growth-brain/account-vault/v1', account, next.vaultId]);
  const wrapped = next.wrapped;
  const secret = nativeOpen(wrapping, wrapped, label + '/key');
  const dataKey = Buffer.from(hkdfSync('sha256', secret, next.vaultId, 'growth-brain/account-vault/v1/remote-snapshot', 32));
  const aad = JSON.stringify([label, 'snapshot', 2, parentRevision, wrapped.iv, wrapped.tag, wrapped.ciphertext]);
  assert.deepEqual(JSON.parse(nativeOpen(dataKey, next.body, aad).toString('utf8')), state);

  await assert.rejects(openSnapshot(account, keys, {...next, parentRevision: null}, projectState.parse));
  await assert.rejects(openSnapshot(account, keys, {...next, sequence: 1}, projectState.parse));
  await assert.rejects(openSnapshot(account, keys, {...next, project: 'plaintext'}, projectState.parse));
  await assert.rejects(unlockSnapshotKeys(crypto.randomUUID(), login.wrappingKey, legacy));
  const providerOnly = await crypto.subtle.importKey('raw', Buffer.from(login.authPassword.slice(4), 'base64url'), 'AES-GCM', false, ['decrypt']);
  await assert.rejects(unlockSnapshotKeys(account, providerOnly, next));
});
