// Run after npm run build. The browser uses fixture web pages and a Chrome API
// shim. The MCP server, SDK, extension bundles, IndexedDB and Web Crypto are real.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, access } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { chromium, type Page } from 'playwright';
import WebSocket from 'ws';
import { startRelay } from '../server/relay.ts';
import { installSimulatedRuntime } from './fixtures/browser-runtime.ts';
import { connectTestClient } from './fixtures/mcp-client.ts';

const token = randomBytes(32).toString('base64url');
const relay = await startRelay({ token, httpPort: 0, devicePort: 0 });
const bundled = chromium.executablePath();
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ??
    (await access(bundled).then(
      () => bundled,
      () => '/usr/bin/chromium',
    )),
});
const context = await browser.newContext({ serviceWorkers: 'block' });
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
  await context.route(/^https?:\/\//, (route) => route.abort());
  const html = await readFile(new URL('./fixtures/chat.html', import.meta.url), 'utf8');
  for (const site of ['chatgpt.com', 'claude.ai']) {
    await context.route('https://' + site + '/**', (route) =>
      route.request().isNavigationRequest()
        ? route.fulfill({ body: html, contentType: 'text/html;charset=utf-8' })
        : route.abort(),
    );
  }
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
  const { popup } = await installSimulatedRuntime(context);
  const post = <T>(message: object) => popup.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<T>;
  for (const site of ['chatgpt', 'claude']) {
    for (const grant of ['capture', 'share']) await popup.locator('#' + site + '-' + grant).check();
  }
  const chat = await context.newPage();
  await chat.goto('https://chatgpt.com/c/demo-one');
  await submit(chat, '유리잔 상세페이지 초안 세 개를 비교해줘');
  const tail = '\n고유 문구 ' + randomUUID() + '입니다.';
  const old = '저녁의 잔입니다.' + tail;
  await reply(chat, '1안: 손에 맞는 잔.\n2안: ' + old + '\n3안: 빛나는 잔.');
  await submit(chat, '2안으로 확정');
  const project = await waitFor(
    async () => (await post<{ projects: { projectId: string }[] }>({ type: 'projects' })).projects?.[0]?.projectId,
  );
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
    await c.goto('https://claude.ai/chat/second');
    await submit(c, query);
    const first = await claude.callTool({ name: 'get_context', arguments: { query } });
    assert.deepEqual(first.structuredContent?.context, {
      status: 'found',
      projectId: project,
      option: 2,
      version: 1,
      text: old,
    });
    await popup.locator('#claude-share').uncheck();
    assert.equal((await claude.callTool({ name: 'get_context', arguments: { query } })).isError, true);
    await popup.locator('#claude-share').check();
    await reply(c, '아침의 잔입니다.');
    await submit(c, '이 문장으로 확정');
    await waitFor(async () => {
      const r = await chatgpt.callTool({ name: 'get_context', arguments: { query: '최신안 보여줘' } });
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
    await popup.locator('#lock').click();
    assert.equal(
      (await chatgpt.callTool({ name: 'get_context', arguments: { query: '최신안 보여줘' } })).isError,
      true,
    );
    console.log(
      'Passed: official SDK → product relay → Chromium extension bundle, fixture messaging, two service grants, v1 → confirmed v2, sharing revocation and lock.',
    );
  } finally {
    await Promise.all([chatgpt.close(), claude.close()]);
  }
} finally {
  await context.close();
  await browser.close();
  await relay.close();
}
