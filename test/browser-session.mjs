import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp,mkdir,cp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { VaultSession } from '../dist/vault.js';
import { startBroker } from '../dist/broker.js';

// Honor managed policy. Do not switch browsers or profiles to evade an extension block.
for(const policyFile of ['/etc/chromium/policies/managed/extensions.json','/etc/opt/chrome/policies/managed/extensions.json']){
 const policy=await readFile(policyFile,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return {};throw e});
 if(policy.ExtensionInstallBlocklist?.includes('*'))throw Error('EXTENSION_INSTALL_BLOCKED_BY_MANAGED_POLICY: use an administrator-approved user device for this test');
}

const root=await mkdtemp(join(tmpdir(),'gb-browser-')),profile=join(root,'profile'),ext=join(root,'extension');
const vault=await VaultSession.open(join(root,'vault'),randomUUID(),randomBytes(24).toString('base64url'),true);
const project=await vault.mutate(e=>e.addProject('Synthetic browser campaign'));const broker=await startBroker(vault,join(root,'vault'));
let context,installArgs;
async function until(check){const deadline=Date.now()+15000;while(!await check()){if(Date.now()>deadline)throw Error('Browser condition timed out');await new Promise(r=>setTimeout(r,100))}}
try{
 await cp(resolve('extension'),ext,{recursive:true});await mkdir(profile);
 const manifest=JSON.parse(await readFile(join(ext,'manifest.json'),'utf8'));
 // Pre-grant hosts only in this synthetic fixture. Production keeps optional permissions.
 manifest.host_permissions=manifest.optional_host_permissions;
 await writeFile(join(ext,'manifest.json'),JSON.stringify(manifest));
 context=await chromium.launchPersistentContext(profile,{channel:'chromium',executablePath:'/usr/lib/chromium/chromium',headless:true,ignoreDefaultArgs:['--disable-extensions'],args:['--no-sandbox',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).hostname;
 installArgs=['scripts/native-integration.py','install','--extension-id',id,'--browser','chromium','--manifest-dir',join(profile,'NativeMessagingHosts'),'--launcher',join(root,'native-host'),'--socket',broker.path];
 execFileSync('python3',installArgs,{stdio:'pipe'});
 const popup=await context.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
 await until(async()=> (await popup.locator('#status').textContent()).includes('연결됨'));
 await popup.selectOption('#project',project.id);
 await context.route('https://chatgpt.com/**',route=>route.fulfill({contentType:'text/html',body:'<html><body><article data-message-id="m1" data-message-author-role="user">한국어로 답변해주세요</article></body></html>'}));
 const page=await context.newPage();await page.goto('https://chatgpt.com/c/synthetic');
 assert.equal(vault.read(e=>e.snapshot().captures.length),0);
 await popup.click('#enable');await until(()=>vault.read(e=>e.snapshot().captures.length)===1);
 const candidate=vault.read(e=>e.snapshot().memories[0]);assert.equal(candidate.status,'candidate');
 await page.evaluate(()=>document.body.append(document.createElement('div')));await new Promise(r=>setTimeout(r,1300));
 assert.equal(vault.read(e=>e.snapshot().captures.length),1);
 await popup.click('#refresh');await popup.getByRole('button',{name:'승인',exact:true}).click();await until(()=>vault.read(e=>e.snapshot().memories[0].status)==='active');
 await popup.click('#stop');await until(async()=> (await popup.locator('#status').textContent()).includes('중지 완료'));
 await page.evaluate(()=>{const x=document.createElement('article');x.dataset.messageId='m2';x.dataset.messageAuthorRole='user';x.textContent='영어로 답변해주세요';document.body.append(x)});
 await new Promise(r=>setTimeout(r,1300));assert.equal(vault.read(e=>e.snapshot().captures.length),1);
 await popup.click('#enable');await until(()=>vault.read(e=>e.snapshot().captures.length)===2);
 await popup.click('#refresh');await popup.getByRole('button',{name:'승인',exact:true}).click();
 await until(async()=> (await popup.locator('#status').textContent()).includes('교체할 기존 조건'));
 await popup.getByLabel('교체할 기억').selectOption(candidate.id);await popup.getByRole('button',{name:'승인',exact:true}).click();
 await until(()=>vault.read(e=>e.getContext({projectId:project.id})).conditions[0].value==='English');
 const data=await worker.evaluate(()=>chrome.storage.local.get(null));
 assert.ok(!JSON.stringify(data).includes('Synthetic browser campaign'));assert.ok(!JSON.stringify(data).includes('한국어'));
 const rejected=await worker.evaluate(async()=>{
  const {dispatch}=await import('./background.js');
  try{await dispatch({type:'REVIEW',id:'x',decision:'approve'},{id:chrome.runtime.id,url:'https://chatgpt.com/c/synthetic',tab:{url:'https://chatgpt.com/c/synthetic'}});return false}catch(e){return e.message==='POPUP_REQUIRED'}
 });assert.equal(rejected,true);
 await vault.close();await popup.click('#refresh');await until(async()=> (await popup.locator('#status').textContent()).includes('잠겨'));
 console.log(JSON.stringify({browser:'Chromium 154',actualNativeMessaging:true,fixtureHostsPregranted:true,syntheticSite:true,consentPauseDedupReviewReplacementLocked:'passed',liveAiSitesVerified:false}));
}finally{
 await context?.close();
 if(installArgs){try{execFileSync('python3',[installArgs[0],'remove',...installArgs.slice(2)],{stdio:'pipe'})}catch{}}
 await broker.close();await vault.close();await rm(root,{recursive:true,force:true});
}
