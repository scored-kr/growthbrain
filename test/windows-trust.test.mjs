import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {readFile, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {privateDirectory, writePrivateJSON} from '../dist/secure-files.js';
import {readTrusted, writeTrusted, forgetTrusted} from '../dist/trusted-account.js';

test('current-user Windows DPAPI protects the trusted credential, rejects damage and forgets it', {
  skip: process.platform !== 'win32',
}, async t => {
  const dir = join(homedir(), 'Growth Brain trust ' + randomUUID());
  await privateDirectory(dir, true);
  t.after(() => rm(dir, {recursive: true, force: true}));
  const file = join(dir, 'trusted-session.v1.json');
  const account = {userId:randomUUID(), refreshToken:randomUUID(), wrappingKey:randomBytes(32)};
  assert.equal(await readTrusted(dir), null);
  await writeTrusted(dir, account);
  assert.deepEqual(await readTrusted(dir), account);
  const protectedFile = await readFile(file, 'utf8');
  const envelope = JSON.parse(protectedFile);
  const bytes = Buffer.from(envelope.blob, 'base64');
  for (const secret of [account.userId, account.refreshToken, account.wrappingKey.toString('base64')]) {
    assert.ok(!protectedFile.includes(secret) && !bytes.includes(Buffer.from(secret)));
  }
  bytes[bytes.length - 1] ^= 0xff;
  await writePrivateJSON(file, {...envelope, blob: bytes.toString('base64')});
  await assert.rejects(readTrusted(dir), /WINDOWS_TRUST_UNAVAILABLE/);
  await forgetTrusted(dir);
  assert.equal(await readTrusted(dir), null);
  await writePrivateJSON(file, {unrelated:true}, true);
  await assert.rejects(writeTrusted(dir, account), /TRUSTED_SESSION_INVALID/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {unrelated:true});
});
