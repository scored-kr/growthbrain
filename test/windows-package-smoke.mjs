// Run on Windows against the exact extracted package. No provider login or public listener.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { callPackagedNative, checkPackagedNative } from './windows-native-smoke.mjs';

if (process.platform !== 'win32' || !process.argv[2]) throw Error('Run on Windows with the extracted app directory');
const app = resolve(process.argv[2]);
const data = await mkdtemp(join(process.env.LOCALAPPDATA, 'GB-package-test-'));
const secret = randomBytes(32).toString('base64url');
const backupFile = join(data, 'Backup', 'Example.enc');
const recoveryFile = join(data, 'Keys', 'Example.recovery');
async function withDevice(action, profile = data) {
  const child = spawn(join(app, 'node.exe'), [join(app, 'dist', 'desktop-controller.js')], {
    cwd: app, env: { ...process.env, LOCALAPPDATA: profile }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const exit = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const timer = setTimeout(() => child.kill(), 60000);
  let id = 0;
  async function send(op, args = {}) {
    child.stdin.write(JSON.stringify({ id: ++id, op, ...args }) + '\n');
    const line = await lines.next();
    assert.equal(line.done, false, 'Controller exited early');
    const reply = JSON.parse(line.value);
    assert.equal(reply.id, id);
    return reply;
  }
  try { await action(send); } finally {
    child.stdin.end();
    const [code] = await exit;
    clearTimeout(timer);
    assert.equal(code, 0, 'Controller shutdown failed');
  }
}
try {
  await withDevice(async send => {
    assert.equal((await send('status')).result.exists, false);
    const opened = await send('create', { password: secret });
    assert.ok(opened.ok, 'Create failed: ' + opened.error);
    assert.equal(opened.result.unlocked, true);
    await checkPackagedNative(app, data, true);
    const project = await send('addProject', { name: 'Synthetic-package-project' });
    assert.ok(project.ok);
    const saved = await send('addPreference', { projectId: project.result.projects[0].id, key: 'tone', value: 'Synthetic-private-preference' });
    assert.ok(saved.ok);
    const projectId = project.result.projects[0].id;
    for (const [method, field] of [['get_context', 'conditions'], ['search_memory', 'matches']]) {
      const { result } = await callPackagedNative(app, data, method, { projectId, query: 'tone' });
      const record = result[field].find(item => item.key === 'tone');
      assert.equal(record.value, 'Synthetic-private-preference');
      for (const privateField of ['source', 'reason', 'supersedesId', 'correctionOf']) {
        assert.equal(Object.hasOwn(record, privateField), false, method + ' exposed ' + privateField);
      }
      assert.ok(!JSON.stringify(result).includes('desktop:explicit-entry'));
    }
    assert.ok((await send('issueRecovery', { file: recoveryFile, password: secret })).ok);
    assert.ok((await send('backup', { file: backupFile })).ok);
    const locked = await send('lock');
    assert.equal(locked.result.unlocked, false);
    await checkPackagedNative(app, data, false);
    assert.deepEqual(locked.result.projects, []);
    assert.equal((await send('addProject', { name: 'Locked' })).ok, false);
  });
  const ciphertext = await readFile(join(data, 'GrowthBrain', 'vault', 'vault.json'), 'utf8');
  for (const forbidden of [secret, 'Synthetic-package-project', 'Synthetic-private-preference']) assert.ok(!ciphertext.includes(forbidden));
  await withDevice(async send => {
    assert.equal((await send('unlock', { password: randomBytes(18).toString('hex') })).ok, false);
    const reopened = await send('unlock', { password: secret });
    assert.ok(reopened.ok, 'Reopen failed: ' + reopened.error);
    assert.equal(reopened.result.projects[0].name, 'Synthetic-package-project');
  });
  const fresh = await mkdtemp(join(data, 'New-profile-'));
  const replacement = randomBytes(32).toString('base64url');
  await withDevice(async send => {
    const recovered = await send('recover', { backupFile, recoveryFile, password: replacement });
    assert.ok(recovered.ok, 'Windows recovery failed: ' + recovered.error);
    assert.equal(recovered.result.unlocked, false);
    const reopened = await send('unlock', { password: replacement });
    assert.ok(reopened.ok);
    assert.equal(reopened.result.projects[0].name, 'Synthetic-package-project');
  }, fresh);
  console.log('Packaged Windows runtime created, locked, reopened and recovered a synthetic vault.');
} finally { await rm(data, { recursive: true, force: true }); }
