import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import type {BrowserContext, Page} from 'playwright';

type Permissions = {locked:boolean; grants:Record<'chatgpt'|'claude',{capture:boolean;share:boolean}>};
type Audit = {
  calls:{request:Record<string,unknown>;response?:unknown}[];
  prompts:number;permissionRequests:number;holdSummary:boolean;released:number;
  releaseSummary?:()=>void;
};
type AuditedWindow = Window & {autoStatusAudit:Audit};

// Observe genuine popup requests and delay one response for a lifecycle race.
// All other messages continue through the actual bundle/runtime unchanged.
function auditPopup() {
  const audit: Audit = {calls:[],prompts:0,permissionRequests:0,holdSummary:false,released:0};
  (window as AuditedWindow).autoStatusAudit = audit;
  const wrap = (runtime: typeof chrome.runtime) => {
    const send = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = (async (request:Record<string,unknown>) => {
      const call:{request:Record<string,unknown>;response?:unknown} = {request};
      audit.calls.push(call);
      const response = await send(request);
      call.response = response;
      if (request.type === 'summarizeActiveCapture' && audit.holdSummary) {
        audit.holdSummary = false;
        await new Promise<void>(resolve => {audit.releaseSummary=resolve;});
        delete audit.releaseSummary;
        audit.released++;
      }
      return response;
    }) as typeof runtime.sendMessage;
  };
  if (chrome.runtime?.sendMessage) wrap(chrome.runtime);
  else {
    // The simulated Chrome API is installed by a separate init script; observe
    // its assignment regardless of the browser's init-script execution order.
    let runtime:typeof chrome.runtime;
    Object.defineProperty(chrome,'runtime',{configurable:true,get:()=>runtime,set:value=>{runtime=value;wrap(value);}});
  }
  window.confirm = () => {audit.prompts++;return false;};
  window.prompt = () => {audit.prompts++;return null;};
  window.alert = () => {audit.prompts++;};
  if (chrome.permissions?.request) {
    chrome.permissions.request = (() => {audit.permissionRequests++;return Promise.resolve(false);}) as typeof chrome.permissions.request;
  }
}

async function waitUntil(check:()=>Promise<boolean>, message:string) {
  const deadline=Date.now()+10000;
  while (Date.now()<deadline) {if (await check()) return;await pause(50);}
  throw Error(message);
}

export async function checkAutomaticCaptureStatus(context:BrowserContext,popup:Page,focusChat:(page:Page)=>Promise<void>) {
  const post = <T>(message:object) => popup.evaluate(message=>chrome.runtime.sendMessage(message),message) as Promise<T>;
  const original = await post<Permissions>({type:'permissions'});
  const configure = async (service:'chatgpt'|'claude',field:'capture'|'share',value:boolean) => {
    await popup.locator('#'+service+'-'+field).setChecked(value);
    await waitUntil(async()=>(await post<Permissions>({type:'permissions'})).grants[service][field]===value,'Grant setup did not finish');
  };
  if (original.locked) {
    await popup.locator('#lock').click();
    await waitUntil(async()=>!(await post<Permissions>({type:'permissions'})).locked,'Unlock setup did not finish');
  }
  await configure('chatgpt','capture',true);
  await configure('chatgpt','share',false);
  const source = await context.newPage(), other = await context.newPage();
  const userText='비공개원문-'+randomUUID()+' 정원 소식을 한국어로 정리해 주세요.';
  const assistantText='비공개답변-'+randomUUID()+' 아직 승인하지 않은 참고 답변입니다.';
  const projectTitle='비공개프로젝트-'+randomUUID().slice(0,8);
  async function send(page:Page,text:string) {await page.getByRole('textbox').fill(text);await page.getByRole('textbox').press('Enter');}
  async function snapshot(conversationId:string) {
    return popup.evaluate(async conversationId=>{
      const read=<T>(request:IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{
        request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      });
      const db=await read(indexedDB.open('growth-brain-local'));
      try {
        const store=db.transaction('records').objectStore('records');
        const [key,sealed]=await Promise.all([read(store.get('key')),read(store.get('snapshot'))]);
        if (!key||!sealed) return {count:0,digest:''};
        const bytes=await crypto.subtle.decrypt({name:'AES-GCM',iv:sealed.iv},key,sealed.bytes);
        const state=JSON.parse(new TextDecoder().decode(bytes));
        const count=(state.journal?.retained??[]).filter((row:{service:string;conversationId:string})=>row.service==='chatgpt'&&row.conversationId===conversationId).length;
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',sealed.bytes))).join(',');
        return {count,digest};
      } finally {db.close();}
    },conversationId);
  }
  const countShown=async(count:number)=>{
    await popup.locator('#capture-summary[data-status="summary"]').waitFor();
    await waitUntil(async()=>new RegExp(`이 대화에 ${count}건 저장`).test(await popup.locator('#capture-summary').innerText()),'Automatic stored count was not '+count);
  };
  const privateAbsent=async()=>{
    const body=await popup.locator('body').textContent();
    for(const text of [userText,assistantText,projectTitle]) assert.ok(!body?.includes(text),'Popup opening must not render private transcript/project text');
    assert.equal(await popup.locator('#journal-list').textContent(),'');
    assert.equal(await popup.locator('#review-text').textContent(),'');
    assert.equal(await popup.locator('#projects').textContent(),'');
  };
  try {
    await source.goto('https://chatgpt.com/');
    await send(source,userText);
    await source.evaluate(text=>(window as unknown as {fixtureReply(text:string):void}).fixtureReply(text),assistantText);
    const conversationId=new URL(source.url()).pathname.split('/').at(-1)!;
    await waitUntil(async()=>(await snapshot(conversationId)).count===2,'Background capture did not persist both turns');

    // Seed a private project through the supported review UI. The later popup
    // reopen must show only metadata even when private approved projects exist.
    await focusChat(source);
    await popup.locator('#check-capture').click();
    const row=popup.locator('#journal-list [data-role="user"]').filter({hasText:userText});
    await row.getByRole('button',{name:'메시지 검토',exact:true}).click();
    await popup.locator('#review-text').filter({hasText:userText}).waitFor();
    await popup.locator('#approval-project').selectOption('new');
    await popup.locator('#new-project-name').fill(projectTitle);
    await popup.locator('#approve-message').click();
    await popup.locator('#approval-result[data-status="approved"]').waitFor();

    // No provider message markers remain. Counts must come from the committed
    // encrypted journal and must not be reset to zero by the empty source DOM.
    await source.locator('#messages').evaluate(node=>node.replaceChildren());
    const before=await snapshot(conversationId),permissions=await post<Permissions>({type:'permissions'});
    await popup.addInitScript(auditPopup);
    await focusChat(source);
    await popup.reload();
    await countShown(2);
    await privateAbsent();
    assert.deepEqual(await post<Permissions>({type:'permissions'}),permissions);
    assert.deepEqual(await snapshot(conversationId),before,'Opening the popup must not write or recover memories');
    const initial=await popup.evaluate(()=>{
      const a=(window as AuditedWindow).autoStatusAudit;
      return {calls:a.calls,prompts:a.prompts,permissionRequests:a.permissionRequests};
    });
    assert.equal(initial.prompts,0);assert.equal(initial.permissionRequests,0);
    assert.ok(initial.calls.some(call=>call.request.type==='summarizeActiveCapture'));
    assert.ok(!initial.calls.some(call=>['checkActiveCapture','reviewJournalTurn','projects','setGrant','enableActiveCapture','decidePreference'].includes(String(call.request.type))));
    const response=initial.calls.findLast(call=>call.request.type==='summarizeActiveCapture')!.response as Record<string,unknown>;
    assert.equal(response.status,'summary');assert.equal(response.savedCount,2);
    const metadataKeys=['status','service','savedCount','trimmedCount','identityLimitReached','observed','readable','health'];
    assert.ok(Object.keys(response).every(key=>metadataKeys.includes(key)),'Summary response must contain metadata only');
    assert.ok(Object.values(response).every(value=>['string','number','boolean'].includes(typeof value)));
    for(const text of [userText,assistantText,projectTitle,conversationId]) assert.ok(!JSON.stringify(response).includes(text));

    await popup.locator('#check-capture').click();
    await popup.locator('#journal-list [data-role="user"]').filter({hasText:userText}).getByRole('button',{name:'메시지 검토',exact:true}).click();
    await popup.locator('#review-text').filter({hasText:userText}).waitFor();
    const explicitPreview=await popup.locator('#capture-result').textContent();
    const readCount=await popup.evaluate(()=>(window as AuditedWindow).autoStatusAudit.calls.filter(call=>call.request.type==='summarizeActiveCapture').length);
    await source.evaluate(()=>history.replaceState(null,'',location.pathname+'#same-conversation'));
    await waitUntil(async()=>(await popup.evaluate(()=>(window as AuditedWindow).autoStatusAudit.calls.filter(call=>call.request.type==='summarizeActiveCapture').length))>readCount,'Same-conversation URL event did not refresh summary');
    await countShown(2);
    assert.equal(await popup.locator('#review-text').innerText(),userText,'Automatic same-scope refresh must preserve explicit review');
    assert.equal(await popup.locator('#capture-result').textContent(),explicitPreview);

    await configure('chatgpt','capture',false);
    await popup.locator('#capture-summary[data-status="capture-off"]').waitFor();
    const stopped=await post<Permissions>({type:'permissions'});
    await popup.reload();
    await popup.locator('#capture-summary[data-status="capture-off"]').waitFor();
    await privateAbsent();
    const action=popup.getByRole('button',{name:'ChatGPT 대화 수집 켜기',exact:true});
    assert.equal(await action.isVisible(),true);
    assert.deepEqual(await post<Permissions>({type:'permissions'}),stopped);
    assert.ok(!await popup.evaluate(()=>(window as AuditedWindow).autoStatusAudit.calls.some(call=>['setGrant','enableActiveCapture'].includes(String(call.request.type)))));
    await action.click();
    await countShown(2);
    const enabled=await post<Permissions>({type:'permissions'});
    assert.deepEqual(enabled.grants,{...stopped.grants,chatgpt:{...stopped.grants.chatgpt,capture:true}});
    assert.equal(enabled.grants.chatgpt.share,false,'Capture CTA must not enable AI sharing');

    await other.goto('https://chatgpt.com/');
    await send(other,'다른대화-'+randomUUID()+' 이 메시지는 별도로 보관합니다.');
    const otherId=new URL(other.url()).pathname.split('/').at(-1)!;
    await waitUntil(async()=>(await snapshot(otherId)).count===1,'Other conversation did not persist');
    await focusChat(source);await countShown(2);
    await popup.evaluate(()=>{(window as AuditedWindow).autoStatusAudit.holdSummary=true;});
    await source.evaluate(()=>history.replaceState(null,'',location.pathname+'#delayed-summary'));
    await popup.waitForFunction(()=>typeof(window as AuditedWindow).autoStatusAudit.releaseSummary==='function');
    await focusChat(other);await countShown(1);await privateAbsent();
    await popup.evaluate(()=>(window as AuditedWindow).autoStatusAudit.releaseSummary!());
    await popup.waitForFunction(()=>(window as AuditedWindow).autoStatusAudit.released===1);
    await popup.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve())));
    await countShown(1);

    await other.evaluate(id=>{document.querySelector('#messages')!.replaceChildren();history.pushState(null,'','/c/'+id);},randomUUID());
    await countShown(0);await privateAbsent();
    await other.goto('https://chatgpt.com/');
    await popup.locator('#capture-summary[data-status="new-chat"]').waitFor();
    assert.ok(!(await popup.locator('#capture-summary').innerText()).includes('건 저장'));
    const audit=await popup.evaluate(()=>({prompts:(window as AuditedWindow).autoStatusAudit.prompts,permissionRequests:(window as AuditedWindow).autoStatusAudit.permissionRequests}));
    assert.deepEqual(audit,{prompts:0,permissionRequests:0});
    console.log(JSON.stringify({suite:'automatic-capture-status',storedCountWithoutPreview:true,metadataOnlyResponse:true,
      noPopupWriteOrGrantPrompt:true,unrecognizedSourceKeepsStoredCount:true,explicitPreviewRetained:true,
      captureOnlyCta:true,tabAndSpaIsolation:true,lateSummaryIgnored:true}));
  } finally {
    for(const service of ['chatgpt','claude'] as const) for(const field of ['capture','share'] as const)
      await configure(service,field,original.grants[service][field]);
    if(original.locked) await popup.locator('#lock').click();
    await source.close();await other.close();
  }
}
