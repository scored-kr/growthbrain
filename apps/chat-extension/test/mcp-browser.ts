// Both modes exercise the official SDK and local product relay with fixture web
// pages. --installed loads the built MV3 extension in a disposable Chrome profile.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import type { Page } from 'playwright';
import WebSocket from 'ws';
import { startRelay } from '../server/relay.ts';
import { installSimulatedRuntime } from './fixtures/browser-runtime.ts';
import { connectTestClient } from './fixtures/mcp-client.ts';
import { launchFixtureBrowser, openInstalledPopup } from './fixtures/chromium.ts';

const installed = process.argv.includes('--installed');
const context = await launchFixtureBrowser(installed);
const token = randomBytes(32).toString('base64url');
const relay = await startRelay({ token, httpPort: 0, devicePort: installed ? 43127 : 0 }).catch(async error => {
  await context.close();
  throw error;
});
const editors = (page: Page) => page.getByRole('textbox');
async function submit(page: Page, text: string) {
  await editors(page).fill(text);
  await editors(page).press('Enter');
}
async function reply(page: Page, text: string) {
  await page.evaluate((text) => (window as unknown as { fixtureReply(s: string): void }).fixtureReply(text), text);
}
async function waitFor<T>(run: () => Promise<T | undefined>) {
  const end = Date.now() + 12_000;
  while (Date.now() < end) {
    const value = await run();
    if (value) return value;
    await pause(100);
  }
  throw Error('Timed out waiting for captured project, device or revision');
}
try {
  let popup: Page;
  if (installed) {
    // Use Chrome's genuine extension origin and the worker's loopback WebSocket.
    popup = await openInstalledPopup(context);
  } else {
    // A fixture HTTPS page has a web origin, whereas a real MV3 background has an
    // extension origin. Bridge these test frames to an ephemeral loopback socket.
    await context.routeWebSocket('ws://127.0.0.1:43127/device', async (route) => {
      const device = new WebSocket('ws://127.0.0.1:' + relay.devicePort + '/device');
      const open = once(device, 'open');
      route.onMessage(async (data) => {
        await open;
        if (device.readyState === WebSocket.OPEN) device.send(data);
      });
      device.on('message', (data) => route.send(data.toString()));
      route.onClose(() => device.close());
    });
    ({popup} = await installSimulatedRuntime(context));
  }
  const post = <T>(message: object) => popup.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<T>;
  for (const site of ['chatgpt', 'claude']) {
    for (const grant of ['capture', 'share']) await popup.locator('#' + site + '-' + grant).check();
  }
  const approvedProject = (title: string) =>
    waitFor(async () => {
      const { projects } = await post<{ projects: { projectId: string; title: string }[] }>({ type: 'projects' });
      return projects.find((project) => project.title === title)?.projectId;
    });
  const sentTurns = (page: Page) => page.locator('[data-message-author-role="user"]').allInnerTexts();
  const chat = await context.newPage();
  await chat.goto('https://chatgpt.com/');
  const phrase = '고유 문구 ' + randomUUID() + '입니다.';
  const tail = '\n' + phrase + '\n다음 문장도 그대로 둡니다.';
  const old = '저녁의 잔입니다.' + tail;
  await submit(chat, '유리잔 상세페이지 초안 세 개를 비교해줘. 2안에 “' + phrase + '”를 넣어줘.');
  await reply(chat, '1안: 손에 맞는 잔.\n2안: ' + old + '\n3안: 빛나는 잔.');
  await submit(chat, '2안으로 확정');
  const project = await approvedProject('유리잔');
  await chat.close();
  await popup.locator('#relay summary').click();
  await popup.locator('#token').fill(token);
  await popup.locator('#pair').click();
  await waitFor(async () => {
    try {
      relay.auth.requests();
      return true;
    } catch {
      return undefined;
    }
  });
  const claude = await connectTestClient(relay, 'claude', project);
  const chatgpt = await connectTestClient(relay, 'chatgpt', project);
  try {
    const query = '어제 고른 2안의 첫 문장만 바꿔줘';
    const c = await context.newPage();
    // The host fixture first receives only what the user typed. An independent
    // SDK client performs the subsequent product read; no live model is involved.
    await c.goto('https://claude.ai/new');
    assert.deepEqual(await sentTurns(c), []);
    await submit(c, query);
    await c.waitForURL(/^https:\/\/claude\.ai\/chat\/[a-f0-9-]+$/);
    const originalQuestions = await sentTurns(c);
    assert.deepEqual(originalQuestions, [query]);
    assert.deepEqual(relay.reads(), []);
    const first = await claude.callTool({ name: 'get_context', arguments: { query: originalQuestions[0] } });
    assert.deepEqual(first.structuredContent?.context, {
      status: 'found',
      projectId: project,
      option: 2,
      version: 1,
      text: old,
    });
    assert.deepEqual(await sentTurns(c), [query]);
    assert.equal(relay.reads().at(-1)?.service, 'claude');
    await popup.locator('#claude-share').uncheck();
    assert.equal((await claude.callTool({ name: 'get_context', arguments: { query } })).isError, true);
    await popup.locator('#claude-share').check();
    await reply(c, '아침의 잔입니다.');
    await submit(c, '이 문장으로 확정');
    const latest = '최신안 보여줘';
    const freshChat = await context.newPage();
    await freshChat.goto('https://chatgpt.com/');
    await submit(freshChat, latest);
    await freshChat.waitForURL(/^https:\/\/chatgpt\.com\/c\/[a-f0-9-]+$/);
    assert.deepEqual(await sentTurns(freshChat), [latest]);
    assert.deepEqual(await sentTurns(c), [query, '이 문장으로 확정']);
    await waitFor(async () => {
      const r = await chatgpt.callTool({ name: 'get_context', arguments: { query: latest } });
      const result = r.structuredContent?.context as Record<string, unknown>;
      return result?.version === 2 && result.text === '아침의 잔입니다.' + tail;
    });
    assert.deepEqual(relay.reads().at(-1)?.service, 'chatgpt');
    await popup.locator('#unpair').click();
    const current = () => chatgpt.callTool({ name: 'get_context', arguments: { query: '최신안 보여줘' } });
    await waitFor(async () => (await current()).isError === true);
    await popup.locator('#token').fill(token);
    await popup.locator('#pair').click();
    await waitFor(async () => {
      const result = (await current()).structuredContent?.context as Record<string, unknown> | undefined;
      return result?.version === 2 && result.text === '아침의 잔입니다.' + tail;
    });
    const b = await context.newPage();
    await b.goto('https://chatgpt.com/');
    await submit(b, '면수건 상세페이지 초안 세 개를 비교해줘.');
    const otherMarker = randomUUID();
    const otherCopy = '산뜻한 수건입니다.\n' + otherMarker;
    await reply(b, '1안: 부드러운 물결.\n2안: ' + otherCopy + '\n3안: 소박한 선물.');
    await submit(b, '2안으로 확정');
    const otherProject = await approvedProject('면수건');
    assert.notEqual(otherProject, project);
    await b.close();
    const otherQuery = '면수건 최신안을 보여줘';
    const otherClient = await connectTestClient(relay, 'claude', otherProject);
    try {
      const scopedRead = await otherClient.callTool({ name: 'get_context', arguments: { query: otherQuery } });
      assert.deepEqual(scopedRead.structuredContent?.context, {
        status: 'found', projectId: otherProject, option: 2, version: 1, text: otherCopy,
      });
    } finally {
      await otherClient.close();
    }
    const receipts = relay.reads();
    for (const unresolved of [otherQuery, query]) {
      const denied = await claude.callTool({ name: 'get_context', arguments: { query: unresolved } });
      assert.equal(denied.isError, true, 'A-scoped OAuth grant must reject: ' + unresolved);
      assert.equal(denied.structuredContent, undefined);
      const response = JSON.stringify(denied.content);
      assert.ok(!response.includes(phrase) && !response.includes(otherMarker));
    }
    assert.deepEqual(relay.reads(), receipts);
    await popup.locator('#lock').click();
    assert.equal(
      (await chatgpt.callTool({ name: 'get_context', arguments: { query: '유리잔 최신안을 보여줘' } })).isError,
      true,
    );
    console.log(
      (installed ? '[Unpacked MV3 + native Chrome APIs] ' : '[Simulated Chrome messaging] ') +
      'Passed: fresh Claude and ChatGPT fixture chats sent only the original questions. Official SDK → product relay → Chromium bundle returned v1 with source tab closed and confirmed v2 with exact suffix. Cross-project/ambiguous reads were denied; sharing revocation and lock passed.',
    );
  } finally {
    await Promise.all([chatgpt.close(), claude.close()]);
  }
} finally {
  try { await context.close(); } finally { await relay.close(); }
}
