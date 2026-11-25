import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { chromium, type Page, type BrowserContext } from 'playwright';
import { installSimulatedRuntime } from './fixtures/browser-runtime.ts';

const installed = process.argv.includes('--installed');
const dist = resolve('dist');
const query = '어제 고른 2안의 첫 문장만 바꿔줘';
const token = '달빛-' + randomUUID();
const suffix = '\n지금 정한 문구는 ' + token + '입니다.\n이 문장은 그대로 유지합니다.';
const original = '오늘의 커피를 천천히 만나보세요.' + suffix;
const replacement = '새벽의 향기를 한 모금 느껴보세요.';
const changed = replacement + suffix;
const latest = '최신안을 보여줘';
const fixturePath = new URL('./fixtures/chat.html', import.meta.url);

async function checkedExecutable() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const path of [chromium.executablePath(), '/usr/bin/chromium']) {
    if (await access(path).then(() => true, () => false)) return path;
  }
  throw new Error('Install Playwright Chromium or specify CHROMIUM_PATH.');
}

// Linux administrator policy applies to the installed-extension check. Synthetic
// mode only executes app code inside our own pages; it never installs an extension.
async function assertUnpackedAllowed() {
  for (const dir of ['/etc/chromium/policies/managed', '/etc/opt/chrome/policies/managed']) {
    const files = await readdir(dir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    for (const name of files.filter(name => name.endsWith('.json'))) {
      const policy = JSON.parse(await readFile(join(dir, name), 'utf8'));
      if (policy.ExtensionInstallBlocklist?.includes('*') ||
          policy.ExtensionSettings?.['*']?.installation_mode === 'blocked') {
        throw new Error('Managed policy blocks unpacked extensions here. Run the installed check on a permitted Chrome profile.');
      }
    }
  }
}

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
  const turnId = await sent(source).nth(index).getAttribute('data-message-id');
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

async function exercise(context: BrowserContext, popup: Page) {
  for (const service of ['chatgpt', 'claude']) {
    for (const consent of ['capture', 'share']) {
      const control = popup.locator('#' + service + '-' + consent);
      assert.equal(await control.isChecked(), false);
      await control.check();
    }
  }

  // No manuscript exists. Neither ordinary send path may discard the request.
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

  const chatgpt = await useNewChat(context, 'chatgpt');
  await send(chatgpt, '달빛 커피 상세페이지 초안 세 개를 비교해 줘.');
  await confirmSent(chatgpt,0,'달빛 커피 상세페이지 초안 세 개를 비교해 줘.');
  await reply(chatgpt, '1안\n밝은 아침의 한 잔.\n\n2안\n' + original + '\n\n3안\n오늘 만나는 원두.');
  await send(chatgpt, '2안으로 확정', true);
  await confirmSent(chatgpt,1,'2안으로 확정');

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

if (installed) await assertUnpackedAllowed();
const profile = await mkdtemp(join(tmpdir(),'growth-brain-browser-'));
let context: BrowserContext | undefined;
try {
  const args = installed ? ['--disable-extensions-except=' + dist, '--load-extension=' + dist] : [];
  context = await chromium.launchPersistentContext(profile, {
    channel:'chromium', executablePath:await checkedExecutable(), headless:true, args,
    ...(installed && {ignoreDefaultArgs:['--disable-extensions']}),
    serviceWorkers:installed ? 'allow' : 'block',
  });
  context.setDefaultTimeout(10000);
  // Never contact ChatGPT/Claude or their models. All requests that leave a page
  // are intercepted even in installed mode.
  await context.route(/^https?:\/\//, route => route.abort());
  const html = await readFile(fixturePath,'utf8');
  for (const host of ['chatgpt.com','claude.ai']) {
    await context.route('https://' + host + '/**', route => route.request().isNavigationRequest()
      ? route.fulfill({body:html,contentType:'text/html;charset=utf-8'}) : route.abort());
  }
  let popup: Page;
  if (installed) {
    const isGrowthBrain = (worker: {url():string}) => new URL(worker.url()).pathname === '/background.js';
    const worker = context.serviceWorkers().find(isGrowthBrain) ?? await context.waitForEvent('serviceworker',isGrowthBrain);
    popup = await context.newPage();
    await popup.goto(new URL('popup.html',worker.url()).href);
  } else {
    ({popup} = await installSimulatedRuntime(context));
  }
  await exercise(context,popup);
  console.log(JSON.stringify({chromium:'passed',sites:'local chat fixtures',runtime:installed?'unpacked MV3':'simulated Chrome messaging',modelResponses:'scripted',liveMcp:false}));
} finally {
  await context?.close();
  await rm(profile, {recursive:true,force:true});
}
