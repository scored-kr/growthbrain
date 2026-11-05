// Real Chromium file/DOM interactions with mocked extension transport, not installed-extension evidence.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {readFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chatExport} from './fixtures/chatgpt-export.mjs';
import {claudeExport} from './fixtures/claude-export.mjs';
const executablePath=process.env.GROWTH_BRAIN_TEST_CHROMIUM??(existsSync('/usr/lib/chromium/chromium')?'/usr/lib/chromium/chromium':undefined);
const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
const output=process.env.GROWTH_BRAIN_IMPORT_UI_OUTPUT??'/tmp/growthbrain-import-ui';await mkdir(output,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:980,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://growthbrain.test/**',async route=>{
  const name=new URL(route.request().url()).pathname.slice(1);
  if(!['import.html','import-page.js','chat-import.js','popup.css'].includes(name))return route.fulfill({status:404,body:''});
  return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await readFile(resolve('extension',name),'utf8')});
 });
 await page.addInitScript(()=>{
  window.fixture={calls:[],seen:[],locked:false,hold:false,projects:[{id:'11111111-1111-4111-8111-111111111111',name:'첫 프로젝트'},{id:'22222222-2222-4222-8222-222222222222',name:'다른 프로젝트'}]};
  window.chrome={runtime:{sendMessage:async m=>{
   fixture.calls.push(m);
   if(m.type==='IMPORT_PROJECTS')return{ok:true,result:{projects:fixture.projects}};
   if(m.type==='IMPORT_CREATE_PROJECT'){const p={id:'33333333-3333-4333-8333-333333333333',name:m.name};fixture.projects.push(p);return{ok:true,result:p}}
   if(m.type==='IMPORT_CHAT'){
    if(fixture.locked)return{ok:false,error:'VAULT_LOCKED'};
    if(fixture.hold)await new Promise(r=>fixture.release=r);
    let imported=0,duplicates=0;for(const message of m.params.messages){const id=m.params.conversationId+':'+message.id;if(fixture.seen.includes(id))duplicates++;else{imported++;fixture.seen.push(id)}}
    return{ok:true,result:{imported,duplicates,candidateIds:[],reviewRequired:true}};
   }
   return{ok:false,error:'INVALID_REQUEST'};
  }}};
 });
 await page.goto('https://growthbrain.test/import.html');await page.getByText('로컬 금고 연결됨.',{exact:false}).waitFor();
 await page.fill('#new-project-name','새 일반 채팅');await page.click('#create-project');await page.waitForFunction(()=>document.querySelector('#import-project').value.startsWith('33333333'));
 const c=chatExport();c.title='<img src=x onerror="window.injected=true">';
 const file=data=>({name:'conversations.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
 await page.setInputFiles('#export-file',file([c,chatExport('unselected')]));
 await page.waitForFunction(()=>document.querySelector('#conversation').options.length===3);await page.selectOption('#conversation','0');
 assert.equal(await page.locator('#export-file').evaluate(el=>el.files[0]?.name),'conversations.json');
 assert.match(await page.locator('#import-summary').textContent(),/메시지 4개.*3개 제외.*1개 제외/);
 assert.equal(await page.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
 assert.equal(await page.evaluate(()=>fixture.calls.filter(m=>m.type==='IMPORT_CHAT').length),0);
 assert.equal(await page.locator('#start-import').isDisabled(),true);
 await page.locator('#import-preview summary').first().click();
 assert.match(await page.locator('#import-preview').textContent(),/2023-11-14T22:13:20/);
 for(const width of [980,320]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(output,`import-${width}.png`),fullPage:true});
 }
 await page.check('#import-consent');await page.selectOption('#import-project','11111111-1111-4111-8111-111111111111');assert.equal(await page.isChecked('#import-consent'),false);
 await page.check('#import-consent');await page.click('#start-import');await page.getByText('가져오기 완료',{exact:false}).waitFor();
 const sent=await page.evaluate(()=>fixture.calls.find(m=>m.type==='IMPORT_CHAT').params);
 assert.equal(sent.projectId,'11111111-1111-4111-8111-111111111111');assert.equal(sent.messages.length,4);
 for(const marker of ['unselected','ABANDONED_BRANCH','PRIVATE_REASONING','private-attachment'])assert.ok(!JSON.stringify(sent).includes(marker));
 await page.check('#import-consent');await page.click('#start-import');await page.getByText('새 메시지 0개 · 중복 4개',{exact:false}).waitFor();
 await page.evaluate(()=>fixture.locked=true);await page.check('#import-consent');await page.click('#start-import');await page.getByText('금고가 잠겨 있습니다.',{exact:false}).waitFor();
 await page.evaluate(()=>fixture.locked=false);
 // A long import can stop between acknowledged batches. A project change cannot redirect the remaining records.
 const many=chatExport('many');many.mapping={root:{id:'root',parent:null,message:null}};
 for(let i=0;i<25;i++)many.mapping[`m${i}`]={id:`m${i}`,parent:i?`m${i-1}`:'root',message:{id:`m${i}`,author:{role:'user'},content:{content_type:'text',parts:[`synthetic ${i}`]},create_time:null}};
 many.current_node='m24';await page.setInputFiles('#export-file',file([many]));await page.waitForFunction(()=>document.querySelector('#conversation').options.length===2);await page.selectOption('#conversation','0');
 await page.evaluate(()=>fixture.hold=true);await page.check('#import-consent');await page.click('#start-import');await page.waitForFunction(()=>typeof fixture.release==='function');
 assert.equal(await page.locator('#import-project').isDisabled(),true);assert.equal(await page.locator('#export-file').isDisabled(),true);
 await page.click('#stop-import');await page.evaluate(()=>fixture.release());await page.getByText('중단했습니다',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>fixture.calls.filter(m=>m.type==='IMPORT_CHAT'&&m.params.conversationId==='many').length),1);
 await page.evaluate(()=>fixture.hold=false);
 await page.selectOption('#import-provider','claude-export');
 assert.equal(await page.locator('#start-import').isDisabled(),true);assert.equal(await page.locator('#import-preview details').count(),0);
 await page.setInputFiles('#export-file',file([claudeExport()]));await page.waitForFunction(()=>document.querySelector('#conversation').options.length===2);await page.selectOption('#conversation','0');
 await page.getByText('현재 분기 미확인',{exact:false}).waitFor();
 await page.check('#import-consent');assert.equal(await page.locator('#start-import').isDisabled(),true);
 await page.check('#unverified-consent');await page.screenshot({path:join(output,'claude-import-320.png'),fullPage:true});
 await page.click('#start-import');await page.getByText('새 메시지 3개',{exact:false}).waitFor();
 const claudeSent=await page.evaluate(()=>fixture.calls.find(m=>m.type==='IMPORT_CHAT'&&m.params.provider==='claude-export').params);
 assert.equal(claudeSent.allowUnverifiedBranch,true);assert.equal(claudeSent.branchMode,'unverified-flat');assert.equal(claudeSent.branchLeafId,null);
 assert.ok(!JSON.stringify(claudeSent).includes('PRIVATE_CLAUDE'));
 await page.setInputFiles('#export-file',{name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{private malformed')});await page.getByText('선택한 서비스의 지원 대화 JSON',{exact:false}).waitFor();
 assert.equal(await page.locator('#start-import').isDisabled(),true);assert.ok(!(await page.locator('body').textContent()).includes('{private malformed'));
 await page.screenshot({path:join(output,'import-error-320.png'),fullPage:true});
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({kind:'real Chromium file selection/DOM with mocked Chrome transport',providers:['ChatGPT','Claude'],filePreviewConsent:true,chatgptCurrentBranch:true,claudeUnverifiedBranchExplicitConsent:true,projectPinned:true,duplicateResume:true,lockAndMalformedErrors:true,stopBetweenBatches:true,widths:[980,320],installedExtensionVerified:false,screenshots:output}));
}finally{await browser.close()}
