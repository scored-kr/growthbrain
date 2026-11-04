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
  window.chrome={permissions:{request:async()=>fixture.permission},runtime:{sendMessage:async message=>{
   fixture.calls.push(message);
   if(message.type==='PROJECTS')return{ok:true,result:{projects:[{id:projectId,name:'Synthetic project'},{id:'44444444-4444-4444-8444-444444444444',name:'Other project'}],local:{}}};
   if(message.type==='MEMORIES'&&fixture.defer&&message.projectId===projectId)await new Promise(resolve=>fixture.release=resolve);
   if(message.type==='MEMORIES'&&message.projectId!==projectId)return{ok:true,result:{memories:[],nextOffset:null}};
   if(message.type==='MEMORIES')return{ok:true,result:{memories:message.status==='all'||message.status===fixture.status?[{id:fixture.id,key:'tone',status:fixture.status,scope:{type:'project',projectId},value:fixture.value,source:{reference:'synthetic:source',excerpt:'<script>bad</script>'},reason:'Synthetic feedback',correctionOf:fixture.correctionOf,retiredAt:fixture.retiredAt,retirementReason:fixture.retirementReason}]:[],nextOffset:null}};
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
 await popup.evaluate(()=>fixture.value='예산: 50만원\n부가세 포함이고 월 단위야.');await popup.click('#refresh');
 await popup.waitForFunction(()=>document.querySelector('article pre')?.textContent===fixture.value);
 assert.equal(await popup.locator('article pre').textContent(),'예산: 50만원\n부가세 포함이고 월 단위야.');
 await popup.click('#enable');await popup.waitForFunction(()=>document.querySelector('#status').textContent.includes('허용되지'));
 assert.equal(await popup.evaluate(()=>fixture.calls.some(c=>c.type==='ENABLE')),false);
 await popup.evaluate(()=>fixture.permission=true);await popup.click('#enable');await popup.waitForFunction(()=>fixture.enabled);
 assert.match(await popup.locator('#capture-state').textContent(),/아직 확인된 전송 없음/);
 await popup.getByRole('button',{name:'후보 수정',exact:true}).click();
 await popup.getByLabel('수정할 기억',{exact:true}).fill('Corrected synthetic preference');
 await popup.getByLabel('수정 사유',{exact:true}).fill('The original inference was incorrect');
 await popup.getByRole('button',{name:'수정안 저장',exact:true}).click();
 await popup.waitForFunction(()=>fixture.value==='Corrected synthetic preference');
 assert.equal(await popup.evaluate(()=>fixture.status),'candidate');
 assert.equal(await popup.evaluate(()=>fixture.calls.some(c=>c.type==='REVIEW')),false);
 await popup.getByText('사용자 수정 후보',{exact:false}).waitFor();
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
 console.log(JSON.stringify({kind:'real Chromium DOM/UI fixtures with mocked Chrome API',browser:browser.version(),chatgptAdapter:true,claudeAdapter:true,stableIdRequired:true,dedupPauseResume:true,unlockRetryWithoutDomChange:true,permissionDenial:true,reviewClick:true,correctionStaysPending:true,retirementClick:true,htmlEscaping:true,wholeQualificationRendered:true,staleProjectResponseIgnored:true,installedExtensionVerified:false}));
}finally{await browser.close()}
