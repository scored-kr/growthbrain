// Isolated Chromium acceptance check. The ciphertext crosses the process boundary.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { build } from 'vite';
import type { Envelope } from '../sync/account-envelope.ts';

const bundle = await build({
  configFile: false, logLevel: 'silent', publicDir: false,
  build: { write: false, lib: { entry: 'test/fixtures/sync-device.ts', name: 'GrowthBrainSync', formats: ['iife'] } },
});
const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
const script = output.find(item => item.type === 'chunk').code;
const accountId = crypto.randomUUID();
const original = 'SYNTHETIC first device input 2026';
const project = '테스트 은하수 ' + crypto.randomUUID().slice(0, 8);
const phrase = '고유 문구 ' + crypto.randomUUID();
const fixture = {
  project, phrase, privateText: '가족 이야기 ' + crypto.randomUUID(), rejected: '탈락한 원고 ' + crypto.randomUUID() + '.',
  suffix: '\r\n' + phrase + '  두 칸도 유지.\r\n\r\n마지막 문단!',
  revisedFirst: '한 잔에 담긴 별빛.',
};
const account = { email: 'pilot@example.test', issuer: 'https://test-auth.example', accountId };
const executablePath = process.env.CHROMIUM_PATH || (existsSync(chromium.executablePath()) ? chromium.executablePath() : '/usr/bin/chromium');

declare global { interface Window { GrowthBrainSync: typeof import('./fixtures/sync-device.ts') } }

async function withDevice<T>(run: (page: import('playwright').Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ executablePath });
  try {
    const page = await browser.newPage();
    await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
    await page.goto('http://localhost/');
    await page.addScriptTag({ content: script });
    return await run(page);
  } finally { await browser.close(); }
}

const serialized = await withDevice(page => page.evaluate(async ({ account, password, fixture }) => {
  const device = window.GrowthBrainSync;
  const memory = device.emptyMemory();
  const send = (service: 'chatgpt' | 'claude', conversationId: string, role: 'user' | 'assistant', text: string) => {
    device.captureTurn(memory, {service, conversationId, role, text, id: crypto.randomUUID()});
  };
  send('chatgpt', 'private', 'user', fixture.privateText);
  send('chatgpt', 'initial', 'user', fixture.project + ' 상세페이지 초안 세 개를 비교해 줘. 2안에 ' + fixture.phrase + ' 넣어 줘.');
  send('chatgpt', 'initial', 'assistant', '1안: ' + fixture.rejected + '\n2안:\n```text\r\n작은 별이 뜬다.' + fixture.suffix + '\r\n```\n3안: 셋째 안.');
  send('chatgpt', 'initial', 'user', '1안은 탈락');
  send('chatgpt', 'initial', 'user', '2안을 채택할게.');
  send('claude', 'edit', 'user', '어제 고른 2안의 첫 문장만 바꿔줘');
  send('claude', 'edit', 'assistant', fixture.revisedFirst);
  send('claude', 'edit', 'user', '좋아, 그 문장으로 확정해 줘.');
  if (JSON.stringify(memory).includes(fixture.privateText)) throw Error('PRIVATE_TEXT_CAPTURED');

  const login = await device.deriveAccountKeys(account.email, password, account.issuer);
  const keys = await device.createSnapshotKeys(account.accountId, login.wrappingKey);
  return JSON.stringify(await device.sealSnapshot(account.accountId, keys, { sequence: 1, parentRevision: null }, { ownerId: keys.vaultId, memory }));
}, { account, password: original, fixture }));

for (const plaintext of [fixture.project, fixture.phrase, fixture.revisedFirst, fixture.rejected, fixture.privateText, original, 'conversations']) {
  assert.ok(!serialized.includes(plaintext));
}

// B receives only the ciphertext and synthetic login inputs. The expected copy remains in the test runner.
const result = await withDevice(page => page.evaluate(async ({ account, password, serialized }) => {
  const device = window.GrowthBrainSync;
  const envelope: Envelope = JSON.parse(serialized);
  const reset = await device.deriveAccountKeys(account.email, password + '-reset', account.issuer);
  let resetRejected = false;
  try { await device.unlockSnapshotKeys(account.accountId, reset.wrappingKey, envelope); }
  catch (error) { if (!(error instanceof DOMException && error.name === 'OperationError')) throw error; resetRejected = true; }
  const login = await device.deriveAccountKeys(account.email, password, account.issuer);
  const keys = await device.unlockSnapshotKeys(account.accountId, login.wrappingKey, envelope);
  const memory = await device.openSnapshot(account.accountId, keys, envelope, state => device.readFixtureMemory(state, keys.vaultId));
  const read = (query: string) => device.lookupContext(memory, {service: 'chatgpt', conversationId: 'fresh-on-B', query});
  return { resetRejected, latest: read('최신안을 보여줘'), rejected: read('탈락한 1안 원문을 다시 보여줘') };
}, { account, serialized, password: original }));

assert.ok(result.resetRejected);
assert.equal(result.latest.status, 'found');
assert.equal(result.latest.title, project);
assert.equal(result.latest.option, 2);
assert.equal(result.latest.version, 2);
assert.equal(result.latest.text, fixture.revisedFirst + fixture.suffix);
assert.equal(result.rejected.status, 'found');
assert.equal(result.rejected.projectId, result.latest.projectId);
assert.equal(result.rejected.option, 1);
assert.equal(result.rejected.version, 1);
assert.equal(result.rejected.text, fixture.rejected);
console.log('Isolated Chromium with a synthetic account: after A exited, B retrieved exact option 2 v2 and rejected option 1 from the encrypted memory. Reset password rejected.');
