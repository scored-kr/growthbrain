// Browser DOM/UI fixture tests with mocked Chrome APIs. Not extension-installation evidence.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
// Fixture UI only: no extension is installed. The extension test retains policy enforcement.
const executablePath=process.env.GROWTH_BRAIN_TEST_CHROMIUM??(existsSync('/usr/lib/chromium/chromium')?'/usr/lib/chromium/chromium':undefined);
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();
 await page.route('https://chatgpt.com/**',r=>r.fulfill({contentType:'text/html',body:'<article data-message-id="u1" data-message-author-role="user">한국어로 답변해주세요</article><article data-message-id="a1" data-message-author-role="assistant"><div class="markdown">알겠습니다</div></article>'}));
 await page.goto('https://chatgpt.com/c/fixture');
 await page.evaluate(()=>{
  window.sent=[];window.listeners=[];
  window.chrome={runtime:{sendMessage:async message=>{window.sent.push(message);return window.locked?{ok:false,error:'VAULT_LOCKED'}:{ok:true}},onMessage:{addListener:fn=>window.listeners.push(fn)}}};
 });
 await page.addScriptTag({path:resolve('extension/adapters.js')});
 let messages=await page.evaluate(()=>GrowthBrainAdapters.collect(document,'chatgpt.com'));
 assert.equal(messages.length,2);assert.deepEqual(messages.map(m=>m.role),['user','assistant']);
 await page.addScriptTag({path:resolve('extension/content.js')});
 await page.waitForFunction(()=>sent.length===2);
 await page.evaluate(()=>document.body.append(document.createElement('div')));await page.waitForTimeout(1200);
 assert.equal(await page.evaluate(()=>sent.length),2);
 await page.evaluate(()=>{listeners.forEach(fn=>fn({type:'GB_STOP'}));document.querySelector('article').textContent='영어로 답변해주세요'});
 await page.waitForTimeout(1200);assert.equal(await page.evaluate(()=>sent.length),2);
 await page.evaluate(()=>listeners.forEach(fn=>fn({type:'GB_START'})));await page.waitForFunction(()=>sent.length>2);
 assert.equal(await page.evaluate(()=>sent[2].message.text),'영어로 답변해주세요');
 await page.evaluate(()=>{window.locked=true;document.querySelector('article').textContent='잠금 뒤 새 요청'});
 await page.waitForFunction(()=>sent.some(m=>m.message.text==='잠금 뒤 새 요청'));
 const lockedCount=await page.evaluate(()=>sent.length);
 await page.evaluate(()=>window.locked=false);
 await page.waitForFunction(count=>sent.length>count,lockedCount);
 assert.equal(await page.evaluate(()=>sent.at(-1).message.text),'잠금 뒤 새 요청');
 await page.setContent('<div data-message-id="c1"><div data-testid="user-message">keep this</div></div><div data-testid="conversation-turn-2"><div class="font-claude-response">answer</div></div><div data-testid="user-message">no stable id</div>');
 // setContent resets the document, not the JS adapter namespace.
 messages=await page.evaluate(()=>GrowthBrainAdapters.collect(document,'claude.ai'));
 assert.equal(messages.length,2);assert.deepEqual(messages.map(m=>m.messageId),['c1','conversation-turn-2']);
 await page.close();

 const popup=await browser.newPage();
 await popup.route('https://growthbrain.test/**',async route=>{
  const name=new URL(route.request().url()).pathname.slice(1)||'popup.html';
  if(!['popup.html','popup.js','popup.css'].includes(name))return route.fulfill({status:404,body:''});
  return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await readFile(resolve('extension',name),'utf8')});
 });
 await popup.addInitScript(()=>{
  const projectId='11111111-1111-4111-8111-111111111111';
  window.fixture={permission:false,calls:[],status:'candidate',enabled:false,value:'<img src=x onerror="window.injected=true">',id:'22222222-2222-4222-8222-222222222222'};
  window.setInterval=callback=>{fixture.poll=callback;return 1};
  window.chrome={permissions:{request:async()=>fixture.permission,contains:async()=>fixture.permission,remove:async input=>{fixture.removedOrigins=input.origins;fixture.permission=false;return true}},runtime:{sendMessage:async message=>{
   fixture.calls.push(message);
   if(fixture.connectionError)return{ok:false,error:fixture.connectionError};
   if(message.type==='CHECK')return{ok:true,result:{open:true}};
   if(message.type==='PROJECTS'&&fixture.deferProjects)await new Promise(resolve=>fixture.releaseProjects=resolve);
   if(message.type==='PROJECTS')return{ok:true,result:{projects:[{id:projectId,name:'Synthetic project'},{id:'44444444-4444-4444-8444-444444444444',name:'Other project'}],local:{}}};
   if(message.type==='MEMORIES'&&fixture.defer&&message.projectId===projectId)await new Promise(resolve=>fixture.release=resolve);
   if(message.type==='MEMORIES'&&message.projectId!==projectId)return{ok:true,result:{memories:[],nextOffset:null}};
   if(message.type==='MEMORIES')return{ok:true,result:{memories:message.status==='all'||message.status===fixture.status?[{id:fixture.id,key:'tone',status:fixture.status,scope:{type:'project',projectId},value:fixture.value,createdAt:'2026-11-06T00:00:00.000Z',source:{reference:'synthetic:source',excerpt:'<script>bad</script>'},reason:'Synthetic feedback',applicability:{taskTypes:['campaign']},correctionOf:fixture.correctionOf,retiredAt:fixture.retiredAt,retirementReason:fixture.retirementReason}]:[],nextOffset:null}};
   if(message.type==='CORRECT'){fixture.correctionOf=fixture.id;fixture.id='33333333-3333-4333-8333-333333333333';fixture.value=message.value;return{ok:true,result:{status:'candidate'}}}
   if(message.type==='RETIRE'){fixture.status='retired';fixture.retiredAt=new Date().toISOString();fixture.retirementReason=message.reason;return{ok:true,result:{status:'retired'}}}
   if(message.type==='REVIEW'){fixture.status='active';return{ok:true,result:{status:'active'}}}
   if(message.type==='ENABLE'){fixture.enabled=true;return{ok:true,result:{enabled:true}}}
   if(message.type==='STOP'){fixture.enabled=false;return{ok:true,result:{enabled:false}}}
   return{ok:false,error:'INVALID_REQUEST'};
  }}};
 });
 await popup.goto('https://growthbrain.test/popup.html');await popup.selectOption('#project','11111111-1111-4111-8111-111111111111');
 await popup.locator('article').waitFor();assert.equal(await popup.locator('article img').count(),0);assert.equal(await popup.evaluate(()=>window.injected),undefined);
 assert.match(await popup.locator('article').textContent(),/적용 업무: 캠페인.*다른 업무·미지정 시 제외/);
 await popup.evaluate(()=>fixture.value='예산: 50만원\n부가세 포함이고 월 단위야.');await popup.click('#refresh');
 await popup.waitForFunction(()=>document.querySelector('article pre')?.textContent===fixture.value);
 assert.equal(await popup.locator('article pre').textContent(),'예산: 50만원\n부가세 포함이고 월 단위야.');
 await popup.click('#enable');await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('허용되지'));
 assert.equal(await popup.evaluate(()=>fixture.calls.some(c=>c.type==='ENABLE')),false);
 await popup.evaluate(()=>fixture.permission=true);await popup.click('#enable');await popup.waitForFunction(()=>fixture.enabled);
 assert.match(await popup.locator('#capture-state').textContent(),/아직 확인된 전송 없음/);
 assert.match(await popup.locator('article').textContent(),/시각: 2026-11-06/);
 await popup.click('#revoke');await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('접근 권한을 해제'));
 assert.deepEqual(await popup.evaluate(()=>fixture.removedOrigins),['https://chatgpt.com/*']);assert.equal(await popup.evaluate(()=>fixture.enabled),false);
 await popup.evaluate(()=>fixture.permission=true);await popup.click('#enable');await popup.waitForFunction(()=>fixture.enabled);
 await popup.getByRole('button',{name:'후보 수정',exact:true}).click();
 await popup.getByLabel('수정할 기억',{exact:true}).fill('Corrected synthetic preference');
 await popup.getByLabel('수정 사유',{exact:true}).fill('The original inference was incorrect');
 await popup.getByRole('button',{name:'수정안 저장',exact:true}).click();
 await popup.waitForFunction(()=>fixture.value==='Corrected synthetic preference');
 assert.equal(await popup.evaluate(()=>fixture.status),'candidate');
 assert.equal(await popup.evaluate(()=>fixture.calls.some(c=>c.type==='REVIEW')),false);
 await popup.getByText('사용자 수정 후보',{exact:false}).waitFor();
 assert.match(await popup.locator('article').textContent(),/적용 업무: 캠페인.*다른 업무·미지정 시 제외/);
 await popup.getByRole('button',{name:'승인',exact:true}).click();await popup.waitForFunction(()=>fixture.status==='active');
 await popup.selectOption('#filter','active');await popup.getByRole('button',{name:'사용 중지',exact:true}).click();
 await popup.getByLabel('사용 중지 사유',{exact:true}).fill('No longer applicable');
 await popup.getByRole('button',{name:'사용 중지 확인',exact:true}).click();
 await popup.waitForFunction(()=>fixture.status==='retired');
 await popup.selectOption('#filter','all');await popup.getByText('사유: No longer applicable',{exact:false}).waitFor();
 await popup.click('#stop');await popup.waitForFunction(()=>!fixture.enabled);
 // A delayed previous-project list must not reappear after project selection changes.
 await popup.evaluate(()=>fixture.defer=true);await popup.click('#refresh');
 await popup.waitForFunction(()=>typeof fixture.release==='function');
 await popup.selectOption('#project','44444444-4444-4444-8444-444444444444');
 await popup.waitForFunction(()=>fixture.calls.at(-1)?.type==='MEMORIES'&&fixture.calls.at(-1).projectId==='44444444-4444-4444-8444-444444444444');
 await popup.evaluate(async()=>{fixture.release();await new Promise(resolve=>setTimeout(resolve,0));});
 assert.equal(await popup.locator('article').count(),0);
 await popup.selectOption('#filter','candidate');await popup.getByText('현재 검토할 새로운 기억 후보가 없습니다.',{exact:false}).waitFor();
 // A native failure clears names/content and invalidates a successful older PROJECTS response.
 await popup.evaluate(()=>{fixture.defer=false;fixture.deferProjects=true});await popup.click('#refresh');await popup.waitForFunction(()=>typeof fixture.releaseProjects==='function');
 await popup.evaluate(()=>{fixture.connectionError='VAULT_LOCKED';fixture.poll()});await popup.getByText('금고가 잠겨 있습니다.',{exact:false}).waitFor();
 await popup.evaluate(()=>fixture.releaseProjects());await popup.waitForTimeout(50);
 assert.equal(await popup.locator('article').count(),0);assert.equal(await popup.getByText('Synthetic project',{exact:true}).count(),0);
 await popup.evaluate(()=>{fixture.connectionError='LOCAL_VAULT_UNAVAILABLE';fixture.deferProjects=false});await popup.click('#reconnect');
 await popup.getByText('로컬 기억 엔진(Native Host)과 연결할 수 없습니다.',{exact:false}).waitFor();
 await popup.evaluate(()=>fixture.permission=true);await popup.click('#revoke');
 await popup.getByText('사이트 접근 권한을 해제했습니다.',{exact:false}).waitFor();assert.equal(await popup.evaluate(()=>fixture.permission),false);
 await popup.evaluate(()=>{fixture.connectionError=undefined});await popup.click('#reconnect');await popup.getByText('로컬 금고 연결됨',{exact:true}).waitFor();
 assert.equal(await popup.locator('#project option').count(),3);
 console.log(JSON.stringify({kind:'real Chromium DOM/UI fixtures with mocked Chrome API',browser:browser.version(),chatgptAdapter:true,claudeAdapter:true,stableIdRequired:true,dedupPauseResume:true,unlockRetryWithoutDomChange:true,permissionDenial:true,permissionRevocation:true,offlineRevocation:true,lockClearsData:true,staleProjectListDiscarded:true,reconnection:true,emptyState:true,sourceTime:true,reviewClick:true,correctionStaysPending:true,retirementClick:true,htmlEscaping:true,wholeQualificationRendered:true,taskApplicabilityRendered:true,staleProjectResponseIgnored:true,installedExtensionVerified:false}));
}finally{await browser.close()}
