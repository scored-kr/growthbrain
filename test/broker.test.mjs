import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnection, createServer } from 'node:net';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker, callBroker, safeError } from '../dist/broker.js';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'gb-protocol-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
function rawRequest(path, input) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = '';
    socket.setTimeout(3000, () => { socket.destroy(); reject(Error('test timeout')); });
    socket.once('connect', () => socket.write(input));
    socket.on('data', chunk => { data += chunk; });
    socket.once('end', () => resolve(JSON.parse(data)));
    socket.on('error', reject);
  });
}
test('broker rejects malformed and oversized frames without dispatch and bounds responses', async t => {
  const path = await directory(t); let reads = 0;
  const broker = await startBroker({ getContext() { reads++; return { payload: 'x'.repeat(270000) }; } }, path);
  t.after(() => broker.close());
  assert.deepEqual(await rawRequest(broker.path, '{"private":"DO_NOT_ECHO",\n'), { error: 'INVALID_REQUEST' });
  assert.deepEqual(await rawRequest(broker.path, 'x'.repeat(65537)+'\n'), { error: 'REQUEST_TOO_LARGE' });
  assert.equal(reads, 0);
  assert.deepEqual(await rawRequest(broker.path, JSON.stringify({ method: 'get_context', params: {} })+'\n'), { error: 'RESPONSE_TOO_LARGE' });
  assert.equal(reads, 1);
  await assert.rejects(callBroker(broker.path, 'get_context', { query: 'x'.repeat(65536) }), /REQUEST_TOO_LARGE/);
  assert.equal(reads, 1);
});
test('broker client rejects incomplete/invalid peer responses and never relays private error text', async t => {
  const path = join(await directory(t), 'peer.sock');
  let response = '';
  const server = createServer(socket => { socket.on('error', () => {}); socket.once('data', () => socket.end(response)); });
  await new Promise(resolve => server.listen(path, resolve)); await chmod(path, 0o600);
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const value of ['{}\n', 'null\n', '{"error":42}\n', '{"result":{},"error":"VAULT_LOCKED"}\n', '{"result":', 'not json\n']) {
    response = value;
    await assert.rejects(callBroker(path, 'get_context', {}), /INVALID_RESPONSE/);
  }
  response = '{"error":"PRIVATE_UNEXPECTED_TEXT"}\n';
  await assert.rejects(callBroker(path, 'get_context', {}), /^Error: REQUEST_FAILED$/);
  response = 'x'.repeat(262145);
  await assert.rejects(callBroker(path, 'get_context', {}), /RESPONSE_TOO_LARGE/);
  response = '';
  await assert.rejects(callBroker(path, 'get_context', {}), /VAULT_LOCKED/);
  for (const code of ['REQUEST_TOO_LARGE','RESPONSE_TOO_LARGE','INVALID_REQUEST','INVALID_RESPONSE']) assert.equal(safeError(Error(code)), code);
  assert.equal(safeError(Error('PRIVATE_UNEXPECTED_TEXT')), 'REQUEST_FAILED');
});
