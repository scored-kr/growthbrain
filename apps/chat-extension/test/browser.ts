import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import type { Page, BrowserContext } from 'playwright';
import { launchFixtureBrowser, openInstalledPopup } from './fixtures/chromium.ts';
import { installSimulatedRuntime } from './fixtures/browser-runtime.ts';

import {checkCaptureRouteIsolation} from './capture-route-fixtures.ts';
import {checkTranscriptAdapters} from './transcript-fixtures.ts';

const installed = process.argv.includes('--installed');
const query = '어제 고른 2안의 첫 문장만 바꿔줘';
const token = '자두우체통-731-' + randomUUID();
const suffix = '\n지금 정한 문구는 ' + token + '입니다.\n이 문장은 그대로 유지합니다.';
const original = '오늘의 텀블러를 만나보세요.' + suffix;
const replacement = '새벽의 향기를 한 모금 느껴보세요.';
const changed = replacement + suffix;
const latest = '최신안을 보여줘';

async function send(page: Page, text: string, byButton = false) {
  const editor = page.getByRole('textbox');
  await editor.fill(text);
  if (byButton) await page.getByRole('button', {name:'Send message'}).click();
  else await editor.press('Enter');
}
function sent(page: Page) {
  return page.locator('[data-message-author-role="user"]');
}
async function confirmSent(page: Page, index: number, text: string) {
  const turn = sent(page).nth(index);
  await turn.waitFor();
  assert.equal(await turn.innerText(), text);
}
async function reply(page: Page, text: string) {
  await page.evaluate((text: string) => {
    (window as unknown as {fixtureReply(text:string):void}).fixtureReply(text);
  }, text);
}
async function useNewChat(context: BrowserContext, service: 'claude' | 'chatgpt') {
  const page = await context.newPage();
  await page.goto(service === 'claude' ? 'https://claude.ai/new' : 'https://chatgpt.com/');
  return page;
}

// The product's closed shadow root protects the preview from host-page script.
// Chromium accessibility exposes controls to the test as it would to assistive
// technology. Native mouse input exercises the same trusted click path as a user.
async function panelButton(page: Page, name: RegExp, clicks = 1) {
  const devtools = await page.context().newCDPSession(page);
  try {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      const {nodes} = await devtools.send('Accessibility.getFullAXTree');
      const button = nodes.find(node => node.role?.value === 'button' && name.test(String(node.name?.value)));
      if (button?.backendDOMNodeId) {
        const backendNodeId = button.backendDOMNodeId;
        if (!clicks) return;
        await devtools.send('DOM.scrollIntoViewIfNeeded',{backendNodeId});
        const {model} = await devtools.send('DOM.getBoxModel',{backendNodeId});
        const [left, top,, ,right,bottom] = model.border;
        await page.mouse.click((left+right)/2,(top+bottom)/2,{clickCount:clicks});
        return;
      }
      await pause(60);
    }
    throw new Error('Missing panel action ' + name);
  } finally { await devtools.detach(); }
}
async function previewText(page: Page, expected: string) {
  const devtools = await page.context().newCDPSession(page);
  try {
    const deadline = performance.now() + 10000;
    while (performance.now() < deadline) {
      const {root} = await devtools.send('DOM.getDocument',{depth:-1,pierce:true});
      const host = root.children?.flatMap(function visit(node): typeof node[] {
        return [node,...(node.children ?? []).flatMap(visit)];
      }).find(node => node.localName === 'growth-brain-notice');
      if (host?.shadowRoots?.[0]) {
        const {object} = await devtools.send('DOM.resolveNode',{backendNodeId:host.shadowRoots[0].backendNodeId});
        if (object.objectId) {
          const {result} = await devtools.send('Runtime.callFunctionOn',{
            objectId:object.objectId,
            functionDeclaration:'function(){ return [...this.querySelectorAll("*")].filter(el => el.children.length === 0).map(el => el.textContent); }',
            returnByValue:true
          });
          await devtools.send('Runtime.releaseObject',{objectId:object.objectId});
          if ((result.value as string[]).includes(expected)) return;
        }
      }
      await pause(60);
    }
    throw new Error('Preview did not contain the precise expected revision');
  } finally { await devtools.detach(); }
}

// Inspect only this synthetic profile after both UI lookups have completed.
// Never use an internal read to prepare a project's contents for a target tab.
async function waitForDecision(popup: Page, source: Page, index: number) {
  const turnId = await sent(source).nth(index).evaluate(node => node.closest('[data-message-id]')?.getAttribute('data-message-id'));
  assert.ok(turnId);
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    const persisted = await popup.evaluate(async turnId => {
      if (!(await indexedDB.databases()).some(item => item.name === 'growth-brain-local')) return false;
      function done<T>(request:IDBRequest<T>): Promise<T> {
        return new Promise((resolve,reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }
      const db = await done(indexedDB.open('growth-brain-local'));
      try {
        const records = db.transaction('records').objectStore('records');
        const [key, record] = await Promise.all([done(records.get('key')),done(records.get('snapshot'))]);
        if (!record || !key) return false;
        if (key.extractable || !(record.bytes instanceof ArrayBuffer)) throw new Error('Expected sealed local state');
        const bytes = await crypto.subtle.decrypt({name:'AES-GCM',iv:record.iv},key,record.bytes);
        const snapshot = JSON.parse(new TextDecoder().decode(bytes));
        return snapshot.projects.some((project:{decisions:{source:{id:string}}[]}) =>
          project.decisions.some(d => d.source.id === turnId));
      } finally { db.close(); }
    },turnId);
    if (persisted) return;
    await pause(50);
  }
  throw new Error('The source selection was not committed to encrypted storage');
}

type FocusChat = (page: Page) => Promise<void>;

async function checkSave(popup: Page, source: Page, focusChat: FocusChat, expected: string) {
  await popup.reload();
  const button = popup.locator('#check-capture');
  await button.waitFor();
  await focusChat(source);
  await button.click();
  const receipt = popup.locator('#capture-result[data-status]');
  await receipt.waitFor();
  assert.equal(await receipt.getAttribute('data-status'), expected, await receipt.innerText());
  if (expected === 'approved') assert.match(await receipt.innerText(), /2안 v1/);
}

async function checkLateReplyCapture(context: BrowserContext, popup: Page, focusChat: FocusChat) {
  const chat = await useNewChat(context, 'chatgpt');
  await send(chat, '별빛 종이컵 상세페이지 초안 3개 써줘.');
  await send(chat, '2안으로 확정');
  await confirmSent(chat, 1, '2안으로 확정');
  await checkSave(popup, chat, focusChat, 'no-options');

  // Virtualized history can insert the assistant's earlier reply after its choice was seen.
  await chat.evaluate(() => {
    const list = document.querySelector('#messages')!;
    const choice = list.lastElementChild!;
    (window as unknown as {fixtureReply(text: string): void}).fixtureReply('1안: 아침 종이컵.\n2안: 별빛 한 잔.\n3안: 오후 종이컵.');
    list.insertBefore(list.lastElementChild!, choice);
    (window as unknown as {fixtureReply(text: string): void}).fixtureReply('확인했습니다.');
    list.lastElementChild!.setAttribute('data-is-streaming', 'true');
  });
  await checkSave(popup, chat, focusChat, 'options');
  await chat.evaluate(() => {
    const list = document.querySelector('#messages')!;
    list.lastElementChild!.setAttribute('data-is-streaming', 'false');
    const unsupported = document.createElement('article');
    unsupported.textContent = '응답 종류가 확인되지 않은 추가 기록';
    list.prepend(unsupported);
  });
  await checkSave(popup, chat, focusChat, 'options');
  await chat.locator('#messages > article').first().evaluate(node => node.remove());
  await checkSave(popup, chat, focusChat, 'approved');
  await checkSave(popup, chat, focusChat, 'approved');
  assert.equal(await sent(chat).count(), 2, 'Checking storage must never send a message to ChatGPT');
}

async function compareReply(popup: Page, chat: Page, focusChat: FocusChat) {
  // Reload the popup for each click so a previous verdict cannot satisfy the next assertion.
  await popup.reload();
  const button = popup.locator('#compare-reply');
  await button.waitFor();
  await focusChat(chat);
  // In installed mode this is Chrome's actual foreground tab. A real action popup
  // leaves it selected. Our standalone popup page must preserve that behavior.
  const activeChatUrl = () => popup.evaluate(async () => (await chrome.tabs.query({active:true, lastFocusedWindow:true}))[0]?.url);
  assert.equal(await activeChatUrl(), chat.url());
  await button.click();
  const result = popup.locator('#compare-result[data-status]');
  await result.waitFor();
  assert.equal(await activeChatUrl(), chat.url(), 'Checking the popup must leave the Claude tab selected');
  assert.ok((await result.innerText()).trim(), 'The result must be readable in the popup');
  return result.getAttribute('data-status');
}

async function checkReplyComparison(context: BrowserContext, popup: Page, focusChat: FocusChat) {
  const full = changed;

  const page = await useNewChat(context, 'claude');
  await send(page, query);
  await confirmSent(page, 0, query);
  await panelButton(page, /2안 조회 미확인/, 0);
  assert.equal(await compareReply(popup, page, focusChat), 'unverified', 'A question alone cannot prove a match');
  await reply(page, full);
  const assistant = page.locator('[data-message-author-role="assistant"]').last();
  const body = assistant.locator('.standard-markdown');
  await assistant.evaluate(node => node.setAttribute('data-is-streaming', 'true'));
  assert.equal(await compareReply(popup, page, focusChat), 'unverified', 'Wait for the streaming response to finish');
  await assistant.evaluate(node => node.removeAttribute('data-is-streaming'));
  assert.equal(await compareReply(popup, page, focusChat), 'unverified', 'A silent partial render can already contain the full expected text');
  await assistant.evaluate(node => node.setAttribute('data-is-streaming', 'false'));
  assert.equal(await compareReply(popup, page, focusChat), 'match');

  await body.evaluate((node, text) => {node.innerText = text;}, replacement);
  assert.notEqual(await compareReply(popup, page, focusChat), 'match', 'A bare replacement sentence omits the protected suffix');
  await body.evaluate((node, text) => {node.innerText = text;}, full.replace(token, '달라진-고유-문구'));
  assert.equal(await compareReply(popup, page, focusChat), 'changed');
  await body.evaluate((node, text) => {node.innerText = text;}, full);
  assert.equal(await compareReply(popup, page, focusChat), 'match');
  assert.equal(await sent(page).count(), 1, 'Checks must not send anything into chat');

  await send(page, '방금 원고와 관련 없는 다음 질문이야.');
  await confirmSent(page, 1, '방금 원고와 관련 없는 다음 질문이야.');
  await reply(page, full);
  assert.equal(await compareReply(popup, page, focusChat), 'unverified', 'An adjacent answer to an unrelated turn is ineligible');

  const revoked = await useNewChat(context, 'claude');
  await send(revoked, query);
  await confirmSent(revoked, 0, query);
  await panelButton(revoked, /2안 조회 미확인/, 0);
  await reply(revoked, full);
  assert.equal(await compareReply(popup, revoked, focusChat), 'match');
  // The fallback attaches a new question and copy. Its receipt must invalidate the earlier answer.
  await panelButton(revoked, /2안 조회 미확인/);
  await panelButton(revoked, /^2안과 함께 다시 보내기$/);
  await sent(revoked).nth(1).waitFor();
  assert.equal(await compareReply(popup, revoked, focusChat), 'unverified');
  await reply(revoked, full);
  assert.equal(await compareReply(popup, revoked, focusChat), 'match');
  await popup.locator('#claude-share').uncheck();
  await popup.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장했습니다'));
  assert.equal(await compareReply(popup, revoked, focusChat), 'unverified');
  await popup.locator('#claude-share').check();
  await popup.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장했습니다'));
}

async function exercise(context: BrowserContext, popup: Page, focusChat: FocusChat) {
  for (const service of ['chatgpt', 'claude']) {
    for (const consent of ['capture', 'share']) {
      const control = popup.locator('#' + service + '-' + consent);
      assert.equal(await control.isChecked(), false);
      await control.check();
    }
  }

  await checkCaptureRouteIsolation(context,popup,focusChat);
  for (const service of ['chatgpt','claude'] as const) {
    const chat = await useNewChat(context,service);
    const editor = chat.getByRole('textbox');
    const task = service === 'claude' ? '오늘 쓸 2안 원고를 이어줘' : '지난번 정한 조건대로 다음 작업을 진행해줘.';
    await send(chat,service === 'claude' ? '/gb ' + task : '/gb',service === 'chatgpt');
    await chat.waitForFunction(() => document.querySelector<HTMLElement>('[role="textbox"]')?.innerText.startsWith('Growth Brain의 get_context'));
    const expanded = await editor.innerText();
    assert.ok(expanded.endsWith('\n\n' + task));
    assert.equal(await sent(chat).count(),0);
    await editor.press('Enter');
    await confirmSent(chat,0,expanded);
    await chat.close();
  }

  const share = popup.locator('#claude-share');
  await share.uncheck();
  await popup.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장했습니다'));
  const captureOnly = await useNewChat(context,'claude');
  await send(captureOnly,'/gb 이어서');
  await captureOnly.locator('growth-brain-notice').waitFor();
  assert.equal(await captureOnly.getByRole('textbox').innerText(),'/gb 이어서');
  assert.equal(await sent(captureOnly).count(),0);
  await send(captureOnly,'/gbx는 일반 문장이야');
  await confirmSent(captureOnly,0,'/gbx는 일반 문장이야');
  await captureOnly.close();
  await share.check();
  await popup.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('저장했습니다'));

  const ambiguousSource = await useNewChat(context, 'chatgpt');
  await send(ambiguousSource, '캠핑 머그 상세페이지 초안 3개를 써줘.');
  await ambiguousSource.evaluate(() => {
    // None of these rendered blocks proves a unique, stable source for a draft.
    const output = '<div data-message-author-role="assistant"><p class="markdown">1안: 하나<br>2안: 허용하지 않은 원고</p></div>';
    document.querySelector('#messages')!.insertAdjacentHTML('beforeend',
      '<article data-message-id="shared">' + output + '<div data-message-author-role="tool">도구 결과</div></article>' +
      '<article data-testid="conversation-turn-4">' + output + '</article>' +
      '<div data-message-id="not-this-turn"><article>' + output + '</article></div>' +
      '<article data-message-id="repeated">' + output + '</article><article data-message-id="repeated">' + output + '</article>');
  });
  await send(ambiguousSource, '2안으로 확정');

  // No identifiable manuscript exists. Neither ordinary send path may discard the request.
  const absent = await useNewChat(context, 'claude');
  const editor = absent.getByRole('textbox');
  await editor.fill(query.slice(0,-1));
  await editor.press('End');
  const ime = await context.newCDPSession(absent);
  const finalSyllable = query.slice(-1);
  await ime.send('Input.imeSetComposition',{text:finalSyllable,selectionStart:1,selectionEnd:1});
  for (const type of ['keyDown','keyUp'] as const) {
    await ime.send('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:229,nativeVirtualKeyCode:229});
  }
  await ime.send('Input.insertText',{text:finalSyllable});
  await ime.detach();
  assert.equal(await editor.innerText(),query);
  assert.equal(await sent(absent).count(),0);
  await editor.press('Enter');
  await panelButton(absent, /다시 불러오기/, 0);
  await absent.getByRole('button', {name:'Send message'}).click();
  await panelButton(absent, /다시 불러오기/);
  assert.equal(await editor.innerText(), query);
  assert.equal(await sent(absent).count(), 0);

  await absent.reload();
  await absent.waitForFunction((expected: string) =>
    document.querySelector<HTMLElement>('[role="textbox"]')!.innerText === expected, query);
  assert.equal(await sent(absent).count(),0);
  await ambiguousSource.close();

  const chatgpt = await useNewChat(context, 'chatgpt');
  await chatgpt.evaluate(() => { document.body.dataset.turnLayout = 'ancestor'; });
  const brief = `휴대용 텀블러 상세페이지 초안을 3개 써줘. 각각 ‘1안:’, ‘2안:’, ‘3안:’으로 시작하고 두 문장씩 써줘. 2안의 두 번째 문장에 ‘${token}’을 그대로 넣어줘.`;
  await send(chatgpt, brief);
  await confirmSent(chatgpt,0,brief);
  await checkSave(popup, chatgpt, focusChat, 'no-options');
  await reply(chatgpt, '1안: 밝은 아침의 한 잔.\n2안: ' + original + '\n3안: 손에 꼭 맞는 텀블러.');
  await checkSave(popup, chatgpt, focusChat, 'options');
  await send(chatgpt, '2안으로 확정', true);
  await confirmSent(chatgpt,1,'2안으로 확정');
  await checkSave(popup, chatgpt, focusChat, 'approved');

  await checkReplyComparison(context, popup, focusChat);
  const stale = await useNewChat(context, 'claude');
  await send(stale, query);
  await confirmSent(stale, 0, query);
  await panelButton(stale, /2안 조회 미확인/, 0);

  const claude = await useNewChat(context, 'claude');
  await send(claude, query);
  await confirmSent(claude,0,query);
  await panelButton(claude,/2안 조회 미확인/);
  await previewText(claude,original);
  assert.equal(await sent(claude).count(),1);
  // Expanding does not modify the composer or send the stored copy.
  assert.equal(await claude.getByRole('textbox').innerText(),'');
  const inProgress = '보내기 전에 확인할 답장';
  await claude.getByRole('textbox').fill(inProgress);
  await panelButton(claude,/^2안과 함께 다시 보내기$/);
  assert.equal(await claude.getByRole('textbox').innerText(),inProgress);
  assert.equal(await sent(claude).count(),1);
  await claude.getByRole('textbox').fill('');
  await panelButton(claude,/^2안과 함께 다시 보내기$/,2);
  const retryTurn = sent(claude).nth(1);
  await retryTurn.waitFor();
  const payload = await retryTurn.innerText();
  assert.equal(payload.split(query).length,2);
  assert.equal(payload.split(original).length,2);
  assert.equal(await sent(claude).count(),2);
  await reply(claude, replacement);
  await send(claude,'그 문장으로 확정',true);
  await confirmSent(claude,2,'그 문장으로 확정');

  const fresh = await useNewChat(context, 'chatgpt');
  await send(fresh,latest,true);
  await confirmSent(fresh,0,latest);
  await panelButton(fresh,/2안 조회 미확인/);
  await previewText(fresh,changed);
  assert.equal(await sent(fresh).count(),1);
  assert.equal(await sent(claude).count(),3);
  // A lookalike send button inside an unrelated dialog must not receive the copy.
  await fresh.evaluate(() => {
    const modal = document.createElement('aside');
    modal.setAttribute('role','dialog');
    modal.innerHTML = '<div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">편집 보내기</button>';
    document.body.append(modal);
    (document.querySelector('form button') as HTMLButtonElement).disabled = true;
  });
  await panelButton(fresh,/^2안과 함께 다시 보내기$/);
  const nativeEditor = fresh.locator('form [contenteditable]');
  await fresh.waitForFunction((changed: string) =>
    document.querySelector<HTMLElement>('form [contenteditable]')!.innerText.endsWith(changed), changed);
  assert.equal(await fresh.locator('[role="dialog"] [contenteditable]').innerText(),'');
  assert.equal(await sent(fresh).count(),1);
  await previewText(fresh,'질문과 원고를 입력창에 준비했어요. 서비스 보내기 버튼을 눌러 주세요.');
  const prepared = await nativeEditor.innerText();
  assert.equal(prepared.split(latest).length,2);
  assert.equal(prepared.split(changed).length,2);
  await fresh.locator('form button').evaluate((button:HTMLButtonElement) => button.disabled = false);
  await fresh.locator('form button').click();
  await confirmSent(fresh,1,prepared);
  await waitForDecision(popup,chatgpt,1);
  await waitForDecision(popup,claude,2);

  // This query resolved ChatGPT option 2 v1. Claude has since confirmed v2.
  await reply(stale, changed);
  assert.equal(await compareReply(popup, stale, focusChat), 'unverified', 'The original lookup revision is stale');

  // Sharing remains useful on a service whose conversation capture is disabled.
  await popup.locator('#claude-capture').uncheck();
  const shareOnly = await useNewChat(context,'claude');
  await send(shareOnly,latest);
  await confirmSent(shareOnly,0,latest);
  await panelButton(shareOnly,/2안 조회 미확인/);
  await previewText(shareOnly,changed);
  // Some hosts may ignore the synthetic send-button click even when it exists
  // and is enabled. Retain the question/manuscript and never dispatch it twice.
  await shareOnly.locator('form button').evaluate(button =>
    button.addEventListener('click', event => {
      if (!event.isTrusted) event.preventDefault();
    }, {capture:true}));
  await panelButton(shareOnly,/^2안과 함께 다시 보내기$/,2);
  await panelButton(shareOnly,/입력창에 원문 복구/,0);
  assert.equal(await sent(shareOnly).count(),1);
  await panelButton(shareOnly,/입력창에 원문 복구/);
  const manual = await shareOnly.getByRole('textbox').innerText();
  assert.equal(manual.split(changed).length,2);
  assert.equal(manual.split(latest).length,2);
  assert.equal(await sent(shareOnly).count(),1);
  await shareOnly.getByRole('button',{name:'Send message'}).click();
  await confirmSent(shareOnly,1,manual);

  // A different conversation reached via the same tab must not inherit the fallback.
  await fresh.goto('https://chatgpt.com/c/another-thread');
  assert.equal(await fresh.locator('growth-brain-notice').count(),0);
}

const context = await launchFixtureBrowser(installed);
try {
  let popup: Page;
  let focusChat: FocusChat = page => page.bringToFront();
  if (installed) {
    popup = await openInstalledPopup(context);
  } else {
    ({popup, focusChat} = await installSimulatedRuntime(context));
  }
  await checkTranscriptAdapters(context);
  await exercise(context,popup,focusChat);
  await checkLateReplyCapture(context,popup,focusChat);
  console.log(JSON.stringify({chromium:'passed',sites:'local chat fixtures',runtime:installed?'unpacked MV3':'simulated Chrome messaging',modelResponses:'scripted',liveMcp:false}));
} finally {
  await context.close();
}
