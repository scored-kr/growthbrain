// Actual Chromium UI + real native framing, broker, encrypted vault. Chrome runtime is simulated.
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {randomUUID,randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';
import {VaultSession} from '../dist/vault.js';
import {startBroker} from '../dist/broker.js';
import {proposal,approve} from './helpers.mjs';
const root=await mkdtemp(join(tmpdir(),'gb-app-ui-')),vault=await VaultSession.open(root,randomUUID(),randomBytes(24).toString('base64url'),true),broker=await startBroker(vault,root);
const project=await vault.mutate(e=>e.addProject('첫 프로젝트')),other=await vault.mutate(e=>e.addProject('다른 프로젝트'));
const first=await vault.mutate(e=>approve(e,proposal({type:'project',projectId:project.id},'tone','기존 어조')));
await vault.mutate(e=>approve(e,proposal({type:'project',projectId:other.id},'other','OTHER_PROJECT_SECRET')));
const candidate=await vault.mutate(e=>e.propose(proposal({type:'project',projectId:project.id},'tone','<img src=x onerror="window.injected=true"> 새 어조')));
const host=spawn(process.execPath,[resolve('dist/native-host.js'),'chrome-extension://'+'a'.repeat(32)+'/'],{env:{...process.env,GROWTH_BRAIN_EXTENSION_ID:'a'.repeat(32),GROWTH_BRAIN_SOCKET:broker.path},stdio:['pipe','pipe','pipe']});
let buffer=Buffer.alloc(0),nativeError='';const pending=new Map();host.stderr.on('data',b=>nativeError+=b);
host.stdout.on('data',b=>{buffer=Buffer.concat([buffer,b]);while(buffer.length>=4){const n=buffer.readUInt32LE();if(buffer.length<n+4)break;const r=JSON.parse(buffer.subarray(4,n+4));buffer=buffer.subarray(n+4);pending.get(r.id)?.(r);pending.delete(r.id)}});
const native=(method,params)=>new Promise(resolve=>{const id=randomUUID(),b=Buffer.from(JSON.stringify({id,method,params})),header=Buffer.alloc(4);header.writeUInt32LE(b.length);pending.set(id,resolve);host.stdin.write(Buffer.concat([header,b]))});
const browser=await chromium.launch({executablePath:process.env.GROWTH_BRAIN_TEST_CHROMIUM??(existsSync('/usr/lib/chromium/chromium')?'/usr/lib/chromium/chromium':undefined),headless:true,args:['--no-sandbox']});
const output='/tmp/growthbrain-app-ui';await mkdir(output,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('nativeCall',async m=>{const r=await native(m.method,m.params);return r.error?{ok:false,error:r.error}:{ok:true,result:r.result}});
 await page.route('https://growthbrain.test/**',async route=>{const name=new URL(route.request().url()).pathname.slice(1);if(!['app.html','app.css','app.js'].includes(name))return route.fulfill({status:404,body:''});return route.fulfill({contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html',body:await readFile(resolve('extension',name),'utf8')})});
 await page.addInitScript(({id})=>{window.fixture={saved:{managementProject:id},hold:false};window.chrome={storage:{local:{get:async()=>fixture.saved,set:async v=>Object.assign(fixture.saved,v)}},runtime:{sendMessage:async m=>{const r=await window.nativeCall(m);if(fixture.hold&&m.method==='list_memories'){fixture.hold=false;await new Promise(resolve=>fixture.release=resolve)}return r}}}}, {id:project.id});
 await page.goto('https://growthbrain.test/app.html');await page.getByText('로컬 금고 연결됨.',{exact:true}).waitFor();assert.match(await page.locator('.metrics').textContent(),/확정 기억1.*검토 후보1/);
 await page.getByRole('link',{name:'검토 대기',exact:true}).click();await page.getByRole('button',{name:'검토하기',exact:true}).click();
 await page.getByRole('button',{name:'선택적 로컬 충돌 분석',exact:true}).click();await page.getByText('로컬 분석이 꺼져 있습니다.',{exact:false}).waitFor();
 assert.equal(await page.locator('img').count(),0);assert.equal(await page.evaluate(()=>window.injected),undefined);
 await page.getByRole('button',{name:'승인',exact:true}).click();await page.getByText('교체 여부를 먼저 확인하세요.',{exact:true}).waitFor();assert.equal(vault.read(e=>e.snapshot().memories.find(m=>m.id===candidate.id).status),'candidate');
 await page.getByLabel('위 기존 기억을 이 후보로 교체하는 데 동의합니다.').check();await page.getByRole('button',{name:'승인',exact:true}).click();await page.getByText('아직 표시할 항목이 없습니다.',{exact:true}).waitFor();assert.equal(vault.read(e=>e.snapshot().memories.find(m=>m.id===first).status),'superseded');
 await page.getByRole('link',{name:'확정 기억',exact:true}).click();await page.getByRole('button',{name:'관리하기',exact:true}).click();await page.getByRole('button',{name:'중요 기억으로 고정',exact:true}).click();await page.locator('.card.pinned').waitFor();
 await page.getByRole('button',{name:'새 기억 제안',exact:true}).click();await page.getByLabel('모든 프로젝트에서 사용할 공통 선호도로 제안합니다.').check();await page.getByLabel('항목 이름').fill('language');await page.getByLabel('기억할 내용').fill('한국어');await page.getByLabel('제안 사유').fill('명시적인 공통 선호');await page.getByRole('button',{name:'검토 후보로 저장',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog').open);
 await page.getByRole('link',{name:'검토 대기',exact:true}).click();await page.getByRole('button',{name:'검토하기',exact:true}).click();await page.getByLabel('수정할 내용').fill('한국어로 간결하게');await page.getByLabel('수정 사유').fill('표현 보완');await page.getByRole('button',{name:'새 후보로 저장',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog').open);const last=vault.read(e=>e.snapshot().memories.at(-1));assert.equal(last.status,'candidate');assert.equal(last.scope.type,'global');
 await page.getByRole('button',{name:'검토하기',exact:true}).click();await page.getByRole('button',{name:'승인',exact:true}).click();await page.getByText('아직 표시할 항목이 없습니다.',{exact:true}).waitFor();
 await page.getByRole('link',{name:'맥락 인계',exact:true}).click();await page.getByRole('button',{name:'새 인계 제안',exact:true}).click();await page.getByLabel('현재 목표',{exact:true}).fill('캠페인 이어가기');await page.getByLabel('완료 주장 (선택)',{exact:true}).fill('초안 작성');await page.getByLabel('완료 주장의 근거').fill('사용자 문서 r2 확인');await page.getByLabel('차단 사유').fill('가격 결정 대기');await page.getByLabel('다음 작업').fill('FAQ 작성');await page.getByRole('button',{name:'검토 후보로 저장',exact:true}).click();await page.getByRole('button',{name:'내용과 근거 보기',exact:true}).click();await page.getByRole('button',{name:'인계 승인',exact:true}).click();await page.getByText('검토와 교체 여부를 확인하세요.',{exact:true}).waitFor();await page.getByLabel('완료 주장과 근거, 다음 작업을 직접 검토했습니다.').check();await page.getByRole('button',{name:'인계 승인',exact:true}).click();await page.getByText('승인됨',{exact:true}).waitFor();
 await page.getByRole('link',{name:'전달 맥락 확인',exact:true}).click();await page.getByLabel('이번 요청에서 바꿀 항목').fill('tone');await page.getByLabel('이번 요청의 값').fill('이번에는 짧게');await page.getByRole('button',{name:'전달할 맥락 확인',exact:true}).click();await page.getByText('tone: 이번에는 짧게 (이번 요청)',{exact:true}).waitFor();assert.match(await page.locator('#content').textContent(),/한국어로 간결하게.*캠페인 이어가기/s);assert.ok(!(await page.locator('#content').textContent()).includes('OTHER_PROJECT_SECRET'));
 for(const width of [1280,320]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(output,`context-${width}.png`),fullPage:true})}
 // Delayed old-project response cannot put old records into the new selection.
 await page.evaluate(()=>fixture.hold=true);await page.getByRole('link',{name:'확정 기억',exact:true}).click();await page.waitForFunction(()=>typeof fixture.release==='function');await page.selectOption('#project',other.id);await page.getByText('OTHER_PROJECT_SECRET',{exact:true}).first().waitFor();await page.evaluate(()=>fixture.release());assert.ok(!(await page.locator('#content').textContent()).includes('새 어조'));
 await page.selectOption('#project',project.id);await page.locator('.card.pinned').waitFor();await page.locator('.card.pinned').getByRole('button',{name:'관리하기'}).click();await page.getByLabel('사용 중지 사유',{exact:true}).fill('더 이상 사용하지 않음');await page.getByLabel('이 기억의 사용을 중지합니다.',{exact:false}).check();await page.getByRole('button',{name:'사용 중지',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('dialog').open);assert.equal(vault.read(e=>e.snapshot().memories.find(m=>m.id===candidate.id).status),'retired');
 await page.keyboard.press('Control+k');assert.equal(await page.locator('#project').evaluate(n=>n===document.activeElement),true);
 await page.getByRole('link',{name:'AI 연결 안내',exact:true}).click();await page.getByText('ChatGPT와 Claude에서 직접 읽기',{exact:true}).waitFor();await page.screenshot({path:join(output,'connections-320.png'),fullPage:true});
 await vault.close();await page.getByRole('button',{name:'새로고침',exact:true}).click();await page.getByText('금고가 잠겨 있습니다.',{exact:false}).waitFor();assert.equal(await page.locator('#content').textContent(),'');assert.ok(!(await page.locator('body').textContent()).includes('한국어로 간결하게'));
 assert.deepEqual(errors,[]);assert.equal(nativeError,'');console.log(JSON.stringify({kind:'actual Chromium + native framing + broker + synthetic encrypted vault',widths:[1280,320],reviewReplacement:true,correctionPending:true,pins:true,handoffLocalReview:true,contextPreview:true,projectRaceIsolation:true,lockClearsData:true,installedExtensionVerified:false,screenshots:output}));
}finally{await browser.close();host.stdin.end();host.kill();await broker.close();await vault.close();await rm(root,{recursive:true,force:true})}
