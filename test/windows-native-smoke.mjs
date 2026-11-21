import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Supply exactly the origin Chrome derives from the packaged extension key.
// Exercise the binary (including its shipped runtime lookup) and native framing.
export async function checkPackagedNative(app, profile, unlocked) {
  const extension = JSON.parse(await readFile(join(app, 'extension', 'manifest.json'), 'utf8'));
  const key = Buffer.from(extension.key, 'base64');
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  const id = [...digest].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
  const origin = 'chrome-extension://' + id + '/';
  const native = spawn(join(app, 'NativeHost.exe'), [origin, '--parent-window=0'], {
    cwd: app, env: { ...process.env, LOCALAPPDATA: profile }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  const done = once(native, 'close');
  const timer = setTimeout(() => native.kill(), 15000);
  const chunks = [];
  native.stdout.on('data', chunk => chunks.push(chunk));
  native.stdin.on('error', () => { /* Launcher exit code and frame are checked below. */ });
  try {
    const message = Buffer.from(JSON.stringify({ id: 'check', method: 'check_vault', params: {} }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(message.length);
    native.stdin.end(Buffer.concat([header, message]));
    const [code] = await done;
    assert.equal(code, 0, 'Native host launcher failed');
    const frame = Buffer.concat(chunks);
    assert.ok(frame.length >= 4, 'Missing native response');
    assert.equal(frame.readUInt32LE(0), frame.length - 4);
    assert.deepEqual(JSON.parse(frame.subarray(4)), unlocked
      ? { id: 'check', result: { unlocked: true } }
      : { id: 'check', error: 'VAULT_LOCKED' });
  } finally { clearTimeout(timer); }
}
