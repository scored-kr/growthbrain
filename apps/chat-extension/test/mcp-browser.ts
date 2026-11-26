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
  let focusChat = (page: Page) => page.bringToFront();
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
    ({popup, focusChat} = await installSimulatedRuntime(context));
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

  // General conversations use the actual capture/storage/popup/relay path, without
  // any manuscript numbering or automatic selection phrase. A user decision and
  // one separately reviewed assistant reference can be shared; other raw turns stay local.
  const genericQuery = '지난번 정한 조건대로 다음 작업을 진행해줘';
  const evidence: {source: 'chatgpt' | 'claude'; target: 'chatgpt' | 'claude'; title: string;
    projectId: string; decision: string; reference?: string; privateMarkers: string[]; savedCount: number}[] = [];
  const modes = [
    {source:'chatgpt', target:'claude', title:'정원 소식', decision:'정원 소식은 한국어로 작성하고 발행 채널은 뉴스레터로 유지해 주세요.'},
    {source:'claude', target:'chatgpt', title:'전시 소식', decision:'전시 소식은 간단한 표로 정리하고 독자는 지역 주민으로 설정해 주세요.'},
  ] as const;
  await popup.locator('#lock').click();
  await waitFor(async () => !(await post<{locked:boolean}>({type:'permissions'})).locked);

  const checkSaved = async (source: Page, count: number) => {
    await focusChat(source);
    await popup.locator('#check-capture').click();
    await popup.locator('#capture-result[data-status]').waitFor();
    const result = popup.locator('#capture-result');
    assert.match(await result.innerText(), new RegExp(`이 대화에 ${count}건 저장`));
    assert.equal(await popup.locator('#journal-list [data-role]').count(), count);
  };
  const encryptedJournal = async (markers: string[]) => popup.evaluate(async markers => {
    function read<T>(request: IDBRequest<T>): Promise<T> {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    const db = await read(indexedDB.open('growth-brain-local'));
    try {
      const store = db.transaction('records').objectStore('records');
      const [keys, key, sealed] = await Promise.all([
        read(store.getAllKeys()), read(store.get('key')), read(store.get('snapshot')),
      ]);
      const settings = JSON.stringify(await chrome.storage.local.get(null)) +
        JSON.stringify(await chrome.storage.session.get(null));
      const ciphertext = sealed?.bytes instanceof ArrayBuffer ? new TextDecoder().decode(sealed.bytes) : '';
      return {
        keys: keys.sort(), sealedKeys: Object.keys(sealed ?? {}).sort(),
        cipher: key?.algorithm?.name, keyExtractable: key?.extractable,
        ivBytes: sealed?.iv?.byteLength, ciphertextBytes: sealed?.bytes?.byteLength,
        rawInCiphertext: markers.some(marker => ciphertext.includes(marker)),
        rawInSettings: markers.some(marker => settings.includes(marker)),
      };
    } finally { db.close(); }
  }, markers);
  const excluded = (response: unknown, markers: string[]) => {
    const serialized = JSON.stringify(response);
    for (const marker of markers) assert.ok(!serialized.includes(marker), 'Unapproved/raw or other-project content escaped');
  };

  for (const mode of modes) {
    let source = await context.newPage();
    await source.goto(mode.source === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new');
    const privateMarkers = ['미승인사용자-' + randomUUID(), '미승인답변-' + randomUUID()];
    const rawUser = privateMarkers[0] + '에 관한 질문입니다. 아직 방향을 정하지 않았으니 검토할 쟁점만 알려 주세요.';
    const rawAssistant = privateMarkers[1] + '은 검토용 참고 내용이며 사용자가 승인한 결정이 아닙니다.';
    const reference = mode.source === 'chatgpt'
      ? '발행 전에 계절별 꽃 소식을 모으고 지역 행사 일정을 확인하면 도움이 됩니다.' : undefined;
    const savedCount = reference ? 4 : 3;
    await submit(source, rawUser);
    await reply(source, rawAssistant);
    await submit(source, mode.decision);
    if (reference) await reply(source, reference);
    await checkSaved(source, savedCount);
    const projectsBefore = await post<{projects:{projectId:string;title:string}[]}>({type:'projects'});
    assert.ok(!projectsBefore.projects.some(project => project.title === mode.title), 'Capture alone must not approve a project');

    const snapshot = await encryptedJournal([...privateMarkers, mode.decision, ...(reference ? [reference] : [])]);
    assert.deepEqual(snapshot.keys, ['key','snapshot']);
    assert.deepEqual(snapshot.sealedKeys, ['bytes','iv']);
    assert.equal(snapshot.cipher, 'AES-GCM');
    assert.equal(snapshot.keyExtractable, false);
    assert.equal(snapshot.ivBytes, 12);
    assert.ok(snapshot.ciphertextBytes > 0);
    assert.equal(snapshot.rawInCiphertext, false);
    assert.equal(snapshot.rawInSettings, false);

    const beforeReview = relay.reads();
    await popup.locator('#journal-list [data-role="assistant"]').filter({hasText:privateMarkers[1]})
      .getByRole('button', {name:'메시지 검토', exact:true}).click();
    await popup.locator('#review-text').filter({hasText:rawAssistant}).waitFor();
    assert.equal(await popup.locator('#review-text').innerText(), rawAssistant);
    assert.deepEqual(relay.reads(), beforeReview, 'Local transcript review is not an MCP read receipt');

    // New page instances read the retained encrypted snapshot. The reopened source
    // fixture has no messages, so a successful preview cannot rely on DOM replay.
    const sourceUrl = source.url(), popupUrl = popup.url();
    await source.close();
    await popup.close();
    source = await context.newPage();
    await source.goto(sourceUrl);
    popup = installed ? await openInstalledPopup(context) : await context.newPage();
    if (!installed) await popup.goto(popupUrl);
    assert.equal(await source.locator('#messages').innerText(), '');
    await checkSaved(source, savedCount);
    await popup.locator('#journal-list [data-role="user"]').filter({hasText:privateMarkers[0]})
      .getByRole('button', {name:'메시지 검토', exact:true}).click();
    await popup.locator('#review-text').filter({hasText:rawUser}).waitFor();
    assert.equal(await popup.locator('#review-text').innerText(), rawUser);

    const unapprovedClient = await connectTestClient(relay, mode.target, randomUUID());
    try {
      const response = await unapprovedClient.callTool({name:'get_context', arguments:{query:genericQuery}});
      assert.equal(response.isError, true);
      assert.equal(response.structuredContent, undefined);
      excluded(response, [...privateMarkers, mode.decision, ...(reference ? [reference] : [])]);
    } finally { await unapprovedClient.close(); }

    await popup.locator('#journal-list [data-role="user"]').filter({hasText:mode.decision})
      .getByRole('button', {name:'메시지 검토', exact:true}).click();
    await popup.locator('#review-text').filter({hasText:mode.decision}).waitFor();
    assert.equal(await popup.locator('#review-text').innerText(), mode.decision);
    await popup.locator('#approval-project').selectOption('new');
    await popup.locator('#new-project-name').fill(mode.title);
    await popup.locator('#approve-message').click();
    await popup.locator('#approval-result[data-status="approved"]').waitFor();
    const projectId = await approvedProject(mode.title);

    const fresh = await context.newPage();
    await fresh.goto(mode.target === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/new');
    await submit(fresh, genericQuery);
    assert.deepEqual(await sentTurns(fresh), [genericQuery]);
    const readsBeforeCall = relay.reads();
    const client = await connectTestClient(relay, mode.target, projectId);
    try {
      const response = await client.callTool({name:'get_context', arguments:{query:genericQuery}});
      assert.ok(!response.isError);
      assert.deepEqual(response.structuredContent, {
        context:{status:'resume', projectId, decisions:[mode.decision]},
      });
      excluded(response, [...privateMarkers, ...(reference ? [reference] : [])]);
      assert.deepEqual(await sentTurns(fresh), [genericQuery], 'The extension must not append stored dialogue to a host question');
      await waitFor(async () => relay.reads().length === readsBeforeCall.length + 1);
      assert.deepEqual(relay.reads().at(-1)?.service, mode.target);
      if (reference) {
        // Merely previewing either assistant answer above did not disclose it. Only
        // this explicit action adds the selected answer as a reference, never a decision.
        await checkSaved(source, savedCount);
        await popup.locator('#journal-list [data-role="assistant"]').filter({hasText:reference})
          .getByRole('button', {name:'메시지 검토', exact:true}).click();
        await popup.locator('#review-text').filter({hasText:reference}).waitFor();
        assert.equal(await popup.locator('#review-text').innerText(), reference);
        await popup.locator('#approval-project').selectOption(projectId);
        const previewOnly = await client.callTool({name:'get_context', arguments:{query:genericQuery}});
        assert.deepEqual(previewOnly.structuredContent, {context:{status:'resume', projectId, decisions:[mode.decision]}});
        excluded(previewOnly, [...privateMarkers, reference]);
        await popup.getByRole('button', {name:'참고자료로 승인', exact:true}).click();
        await popup.locator('#approval-result[data-status="approved"]').waitFor();
        const withReference = await client.callTool({name:'get_context', arguments:{query:genericQuery}});
        assert.ok(!withReference.isError);
        assert.deepEqual(withReference.structuredContent, {
          context:{status:'resume', projectId, decisions:[mode.decision], references:[reference]},
        });
        excluded(withReference, privateMarkers);
        assert.deepEqual(await sentTurns(fresh), [genericQuery]);
        await waitFor(async () => relay.reads().length === readsBeforeCall.length + 3);
      }
    } finally { await client.close(); await fresh.close(); await source.close(); }
    evidence.push({...mode, projectId, ...(reference && {reference}), privateMarkers, savedCount});
  }

  const allRaw = evidence.flatMap(item => item.privateMarkers);
  const unauthenticated = await fetch(relay.url, {method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_context',arguments:{query:genericQuery}}})});
  assert.equal(unauthenticated.status, 401);
  excluded(await unauthenticated.text(), [...allRaw, ...evidence.flatMap(item => [item.decision, ...(item.reference ? [item.reference] : [])])]);
  for (const [index, item] of evidence.entries()) {
    const other = evidence[1-index];
    const client = await connectTestClient(relay, item.target, item.projectId);
    try {
      const scoped = await client.callTool({name:'get_context', arguments:{query:genericQuery}});
      assert.deepEqual(scoped.structuredContent, {context:{status:'resume', projectId:item.projectId, decisions:[item.decision],
        ...(item.reference && {references:[item.reference]})}});
      excluded(scoped, [...allRaw, other.decision, ...(other.reference ? [other.reference] : [])]);
      const receipts = relay.reads();
      for (const args of [{query:other.title + '에서 ' + genericQuery}, {query:genericQuery, projectId:other.projectId}]) {
        const denied = await client.callTool({name:'get_context', arguments:args});
        assert.equal(denied.isError, true);
        assert.equal(denied.structuredContent, undefined);
        excluded(denied, [...allRaw, item.decision, other.decision,
          ...(item.reference ? [item.reference] : []), ...(other.reference ? [other.reference] : [])]);
      }
      assert.deepEqual(relay.reads(), receipts, 'Denied scope changes must not create successful read receipts');
    } finally { await client.close(); }
  }
  console.log(JSON.stringify({
    suite:'generic-dialogue-cross-service',
    browser:installed ? 'installed unpacked MV3 with Chrome APIs' : 'Chromium with simulated Chrome messaging',
    transport:'official MCP SDK with local HTTP/OAuth relay and device WebSocket',
    source:'synthetic local web fixtures; no live model',
    encryptedIndexedDb:true, nonextractableDeviceKey:true, rawSettingsExcluded:true,
    reopened:'source and popup pages in the same temporary profile; no source DOM replay',
    popupExplicitApproval:true, assistantReferenceOnlyAfterExplicitApproval:true,
    unapprovedRawExcluded:true, unauthenticatedDenied:true, otherProjectExcluded:true,
    results:evidence.map(({source,target,savedCount,decision,reference}) => ({source,target,savedCount,query:genericQuery,
      decisions:[decision], ...(reference && {references:[reference]})})),
  }));
} finally {
  try { await context.close(); } finally { await relay.close(); }
}
