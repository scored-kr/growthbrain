import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {randomUUID, randomBytes} from 'node:crypto';
import {readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {VaultSession} from '../dist/vault.js';
import {privateDirectory, readPrivateJSON, writePrivateJSON} from '../dist/secure-files.js';

const windowsTest = process.platform === 'win32' ? test : test.skip;

async function privateFixture(t) {
  const root = join(homedir(), 'Growth Brain 테스트 ' + randomUUID());
  await privateDirectory(root, true);
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

windowsTest('NTFS vault encrypts, keeps older backups and requires its passphrase after recovery', async t => {
  const root = await privateFixture(t);
  const path = join(root, 'vault');
  const owner = randomUUID(), password = randomBytes(24).toString('hex');
  const session = await VaultSession.open(path, owner, password, true);
  t.after(() => session.close());
  const project = await session.mutate(engine => engine.addProject('WIN-PRIVATE-PROJECT'));
  await assert.rejects(VaultSession.open(path, owner, password), /VAULT_ALREADY_OPEN/);
  const original = join(root, 'backup.enc');
  await session.exportBackup(original);
  assert.ok(!(await readFile(original, 'utf8')).includes('WIN-PRIVATE-PROJECT'));
  await assert.rejects(session.exportBackup(original), {code: 'EEXIST'});
  const keyFile = join(root, 'offline', 'key.recovery');
  await session.issueRecovery(password, keyFile);
  const backup = join(root, 'with-recovery.enc');
  await session.exportBackup(backup);
  await session.close();
  const newPassword = randomBytes(24).toString('hex');
  const recoveredPath = join(root, 'restored');
  const recovered = await VaultSession.recover(backup, recoveredPath, owner, keyFile, newPassword);
  assert.ok(recovered.listProjects().some(p => p.id === project.id));
  await recovered.close();
  await assert.rejects(VaultSession.open(recoveredPath, owner, password), /UNLOCK_FAILED/);
  const resumed = await VaultSession.open(recoveredPath, owner, newPassword);
  await resumed.close();
});

windowsTest('broad file or directory permissions and reparse ancestors fail without adopting them', async t => {
  const root = await privateFixture(t);
  const directory = join(root, 'data');
  await privateDirectory(directory, true);
  const file = join(directory, 'owned.json');
  await writePrivateJSON(file, {owned: true}, true);
  const safe = join(root, 'junction');
  await symlink(directory, safe, 'junction');
  await assert.rejects(readPrivateJSON(join(safe, 'owned.json')));
  await assert.rejects(privateDirectory(join(safe, 'nested')));
  const icacls = join(process.env.SystemRoot, 'System32', 'icacls.exe');
  await promisify(execFile)(icacls, [file, '/grant', '*S-1-1-0:(R)']);
  await assert.rejects(readPrivateJSON(file));
  await assert.rejects(writePrivateJSON(file, {replace: true}));
  assert.deepEqual(JSON.parse(await readFile(file)), {owned: true});
  await promisify(execFile)(icacls, [directory, '/grant', '*S-1-1-0:(OI)(CI)(R)']);
  await assert.rejects(privateDirectory(directory));
  await assert.rejects(writePrivateJSON(join(directory, 'new.json'), {unsafe: true}, true));
});

windowsTest('force-closing the vault owner releases the kernel lock and preserves unrelated locks', async t => {
  const root = await privateFixture(t);
  const directory = join(root, 'vault');
  const owner = randomUUID(), password = randomBytes(24).toString('hex');
  const source = `
    import {VaultSession} from ${JSON.stringify(new URL('../dist/vault.js', import.meta.url).href)};
    let data = ''; for await (const chunk of process.stdin) data += chunk;
    const {directory, owner, password} = JSON.parse(data);
    await VaultSession.open(directory, owner, password, true);
    process.stdout.write('ready\\n'); setInterval(() => {}, 120000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {stdio: ['pipe', 'pipe', 'pipe']});
  const exit = once(child, 'exit');
  const lines = createInterface({input: child.stdout});
  t.after(() => { lines.close(); if (child.exitCode === null) child.kill(); });
  child.stdin.end(JSON.stringify({directory, owner, password}));
  const ready = await Promise.race([once(lines, 'line'), exit.then(() => { throw Error('Vault child ended before ready'); })]);
  assert.equal(ready[0], 'ready');
  await assert.rejects(VaultSession.open(directory, owner, password), /VAULT_ALREADY_OPEN/);
  child.kill('SIGKILL');
  await exit;
  const reopened = await VaultSession.open(directory, owner, password);
  await reopened.close();
  await writeFile(join(directory, 'vault.lock'), 'pre-existing', {flag:'wx'});
  await assert.rejects(VaultSession.open(directory, owner, password), /VAULT_ALREADY_OPEN/);
  assert.equal(await readFile(join(directory, 'vault.lock'), 'utf8'), 'pre-existing');
});
