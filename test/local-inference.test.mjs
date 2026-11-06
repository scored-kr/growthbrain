import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalInference} from '../dist/local-inference.js';
import {VaultSession} from '../dist/vault.js';
import {MemoryEngine} from '../dist/engine.js';
import {derive,seal} from '../dist/envelope.js';
import {fixture,proposal,approve} from './helpers.mjs';
async function setup(t,handler){
 const directory=await mkdtemp(join(tmpdir(),'gb-analysis-')),owner=randomUUID(),password=randomBytes(24).toString('base64url'),vault=await VaultSession.open(directory,owner,password,true);
 const project=await vault.mutate(e=>e.addProject('PRIVATE_PROJECT')),other=await vault.mutate(e=>e.addProject('OTHER_PROJECT'));
 const active=await vault.mutate(e=>approve(e,proposal({type:'project',projectId:project.id},'tone','approved value')));
 const candidate=await vault.mutate(e=>e.propose(proposal({type:'project',projectId:project.id},'tone','proposed value')));
 await vault.mutate(e=>approve(e,proposal({type:'project',projectId:other.id},'tone','OTHER_PROJECT_SECRET')));
 const requests=[];const server=createServer(async(req,res)=>{let text='';for await(const b of req)text+=b;requests.push(JSON.parse(text));await handler(req,res,JSON.parse(text),active,candidate.id)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const client=new LocalInference({url:`http://127.0.0.1:${server.address().port}/v1/chat/completions`,model:'synthetic-local'});
 t.after(async()=>{client.close();server.closeAllConnections();await new Promise(r=>server.close(r));await vault.close();await rm(directory,{recursive:true,force:true})});
 return {directory,owner,password,vault,project,other,active,candidate,requests,client};
}
const reply=(res,advice)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(advice)}}]}))};
test('local-only configuration refuses network hosts, credentials, redirects-as-config and arbitrary paths',()=>{
 for(const url of ['https://example.com/v1/chat/completions','http://localhost:11434/v1/chat/completions','http://192.168.1.2:80/v1/chat/completions','http://127.0.0.1:11434/other','http://secret@127.0.0.1:11434/v1/chat/completions','http://127.0.0.1:11434/v1/chat/completions?key=secret'])assert.throws(()=>new LocalInference({url,model:'synthetic'}),/LOCAL_MODEL_URL_REQUIRED/);
 assert.throws(()=>new LocalInference({url:'http://127.0.0.1:11434/v1/chat/completions',model:'synthetic',apiKey:'no'}));
});
test('real loopback inference gates clear candidates, limits scope and returns advice without changing any memory',async t=>{
 const f=await setup(t,(_q,r,_b,active)=>reply(r,{value:'suggested value',reason:'Needs human review',supersedesId:active}));
 const clear=await f.vault.mutate(e=>e.propose(proposal({type:'project',projectId:f.project.id},'language','한국어')));
 assert.equal((await f.client.evaluate(f.vault,f.project.id,clear.id)).outcome,'not_needed');assert.equal(f.requests.length,0);
 const before=f.vault.read(e=>e.snapshot().memories),r=await f.client.evaluate(f.vault,f.project.id,f.candidate.id);
 assert.equal(r.outcome,'advice');assert.equal(r.reviewRequired,true);assert.equal(r.verification,'unverified_local_model');assert.equal(r.advice.supersedesId,f.active);
 assert.equal(f.requests.length,1);assert.ok(!JSON.stringify(f.requests).includes('OTHER_PROJECT_SECRET'));assert.deepEqual(f.vault.read(e=>e.snapshot().memories),before);
 await assert.rejects(f.client.evaluate(f.vault,f.other.id,f.candidate.id),/CANDIDATE_NOT_FOUND/);
 const disk=await readFile(join(f.directory,'vault.json'),'utf8');assert.ok(!disk.includes('inferenceUsage'));assert.ok(!disk.includes('proposed value'));
 const usage=f.vault.read(e=>e.snapshot().inferenceUsage);await f.vault.close();const reopened=await VaultSession.open(f.directory,f.owner,f.password);assert.deepEqual(reopened.read(e=>e.snapshot().inferenceUsage),usage);await reopened.close();
});
test('invalid output, foreign replacement IDs and redirects fall back without changing approval',async t=>{
 let mode=0;const f=await setup(t,(_q,r,_b,active)=>{if(mode===0)reply(r,{value:'advice',reason:'why',supersedesId:randomUUID()});else if(mode===1)reply(r,{value:'advice',reason:'why',supersedesId:active,status:'active'});else{r.writeHead(302,{location:'https://example.com/private'});r.end()}});
 for(mode=0;mode<3;mode++){const r=await f.client.evaluate(f.vault,f.project.id,f.candidate.id);assert.equal(r.outcome,'manual_review');assert.equal(f.vault.read(e=>e.snapshot().memories.find(m=>m.id===f.candidate.id).status),'candidate');}
 assert.equal(f.requests.length,3);
});
test('timeout, stopping and stale candidate races discard model output; no automatic retry',async t=>{
 let release;const f=await setup(t,async(_q,r,_b,active)=>{await new Promise(resolve=>release=resolve);reply(r,{value:'obsolete model suggestion',reason:'why',supersedesId:active})});
 const timeout=await f.client.evaluate(f.vault,f.project.id,f.candidate.id);assert.equal(timeout.reason,'timeout');assert.equal(f.requests.length,1);release();
 const work=f.client.evaluate(f.vault,f.project.id,f.candidate.id);while(f.requests.length<2)await new Promise(r=>setTimeout(r,10));await f.vault.mutate(e=>e.review(f.candidate.id,'reject'));release();assert.equal((await work).reason,'stale_candidate');
 const next=await f.vault.mutate(e=>e.propose(proposal({type:'project',projectId:f.project.id},'tone','next proposal')));const stopping=f.client.evaluate(f.vault,f.project.id,next.id);while(f.requests.length<3)await new Promise(r=>setTimeout(r,10));f.client.close();release();assert.equal((await stopping).reason,'disabled');assert.equal((await f.client.evaluate(f.vault,f.project.id,next.id)).reason,'disabled');
});
test('persisted reservations enforce global/project daily budgets and per-minute calls, including clock rollback',()=>{
 const {engine,project,other}=fixture(),now=Date.parse('2026-11-06T12:00:00Z');
 for(let i=0;i<20;i++)engine.reserveInference(project.id,1,now);
 const before=engine.snapshot();assert.throws(()=>engine.reserveInference(other.id,1,now),/INFERENCE_RATE_LIMIT/);assert.deepEqual(engine.snapshot(),before);
 engine.reserveInference(project.id,49990,now+60000);engine.reserveInference(project.id,49990,now+60000);
 assert.throws(()=>engine.reserveInference(project.id,1,now+60000),/INFERENCE_BUDGET_LIMIT/);
 assert.throws(()=>engine.reserveInference(project.id,1,now-60000),/CLOCK_MOVED_BACKWARD/);
 const restored=new MemoryEngine(engine.snapshot());assert.throws(()=>restored.reserveInference(project.id,1,now+120000),/INFERENCE_BUDGET_LIMIT/);
 restored.reserveInference(project.id,1,now+86400000);assert.equal(restored.snapshot().inferenceUsage.units,1);
});
test('v7 migration preserves source ciphertext before usage accounting',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'gb-analysis-v8-')),owner=randomUUID(),password=randomBytes(24).toString('base64url');t.after(()=>rm(directory,{recursive:true,force:true}));
 const e=MemoryEngine.empty(owner),project=e.addProject('synthetic');const {inferenceUsage,...old}=e.snapshot();old.version=7;
 const salt=randomBytes(16),key=await derive(password,salt),envelope=seal({snapshot:()=>old},key,{version:1,ownerId:owner,salt:salt.toString('base64')});key.fill(0);await writeFile(join(directory,'vault.json'),JSON.stringify(envelope),{mode:0o600});
 const vault=await VaultSession.open(directory,owner,password);try{await vault.mutate(e=>e.reserveInference(project.id,10));const names=(await readdir(directory)).filter(n=>n.startsWith('pre-state-v8-'));assert.equal(names.length,1);assert.deepEqual(JSON.parse(await readFile(join(directory,names[0]),'utf8')),envelope);}finally{await vault.close()}
});
