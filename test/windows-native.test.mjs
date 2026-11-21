import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { authenticatedClient, authenticatedServer } from '../dist/windows-native.js';
import { startBroker, callBroker } from '../dist/broker.js';

test('native bridge authenticates both endpoints before dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gb-psk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = process.platform === 'win32' ? '\\\\.\\pipe\\gb-test-' + randomBytes(12).toString('hex') : join(directory, 'socket');
  const key = randomBytes(32);
  let dispatched = 0;
  const server = authenticatedServer(key, socket => {
    socket.once('data', () => { dispatched++; socket.end('ok'); });
  });
  server.listen(path); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const rejected = authenticatedClient(path, randomBytes(32));
  rejected.once('secureConnect', () => assert.fail('wrong key authenticated'));
  await once(rejected, 'error');
  assert.equal(dispatched, 0);

  const client = authenticatedClient(path, key);
  await once(client, 'secureConnect');
  assert.equal(client.getCipher().name, 'PSK-AES256-GCM-SHA384');
  client.write('query');
  const [response] = await once(client, 'data');
  assert.equal(response.toString(), 'ok');
  await once(client, 'close');
  assert.equal(dispatched, 1);
});

test('Windows capture bundle has exactly one origin derived from its fixed public key', async () => {
  const native = new URL('../windows/native/', import.meta.url);
  const key = await readFile(new URL('extension-public-key.txt', native), 'utf8');
  const digits = createHash('sha256').update(Buffer.from(key.trim(), 'base64')).digest('hex').slice(0, 32);
  const id = [...digits].map(d => String.fromCharCode(97 + Number.parseInt(d, 16))).join('');
  const manifest = JSON.parse(await readFile(new URL('com.growthbrain.local.json', native)));
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://' + id + '/']);
  assert.equal(manifest.name, 'com.growthbrain.local');
  assert.equal(manifest.path, 'NativeHost.exe');
});

test('Windows broker uses protected rendezvous and disconnects on lock', { skip: process.platform !== 'win32' }, async t => {
  // The vault storage layer provisions the ACL on the new leaf directory.
  const directory = join(process.env.LOCALAPPDATA, 'GrowthBrainNativeTest-' + randomBytes(12).toString('hex'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const broker = await startBroker({ assertUnlocked() {} }, directory);
  try {
    assert.deepEqual(await callBroker(broker.path, 'check_vault', {}), { unlocked: true });
  } finally { await broker.close(); }
  await assert.rejects(callBroker(broker.path, 'check_vault', {}), /VAULT_LOCKED/);
});
