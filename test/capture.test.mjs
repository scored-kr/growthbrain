import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { MemoryEngine } from '../dist/engine.js';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultSession } from '../dist/vault.js';

const input=(projectId,extra={})=>({site:'chatgpt.com',projectId,url:'https://chatgpt.com/c/synthetic?token=discard#fragment',messageId:'turn-1',role:'user',text:'앞으로 한국어로 답변해주세요',...extra});
test('capture requires site consent and matching selected project; pause denies immediately',()=>{
  const {engine,project,other}=fixture();
  assert.throws(()=>engine.capture(input(project.id)),/CAPTURE_NOT_CONSENTED/);
  engine.configureCapture({site:'chatgpt.com',projectId:project.id,enabled:true});
  assert.throws(()=>engine.capture(input(other.id)),/CAPTURE_NOT_CONSENTED/);
  assert.throws(()=>engine.capture(input(project.id,{url:'https://evil.example/c/test'})),/CAPTURE_URL_MISMATCH/);
  assert.throws(()=>engine.capture(input(project.id,{site:'claude.ai',url:'https://claude.ai/chat/test'})),/CAPTURE_NOT_CONSENTED/);
  engine.configureCapture({site:'chatgpt.com',projectId:project.id,enabled:false});
  assert.throws(()=>engine.capture(input(project.id)),/CAPTURE_NOT_CONSENTED/);
});
test('deduplication, revisions, assistant boundary and project-only candidates',()=>{
  const {engine,project}=fixture();engine.configureCapture({site:'chatgpt.com',projectId:project.id,enabled:true});
  const first=engine.capture(input(project.id));assert.equal(first.candidateIds.length,1);
  assert.equal(engine.capture(input(project.id)).duplicate,true);
  const edit=engine.capture(input(project.id,{text:'영어로 답변해주세요'}));assert.equal(edit.duplicate,false);
  assert.equal(engine.snapshot().captures[1].previousId,first.id);
  // An edit back to the original text is a new revision, not an ignored old hash.
  assert.equal(engine.capture(input(project.id)).duplicate,false);
  const assistant=engine.capture(input(project.id,{messageId:'assistant-1',role:'assistant'}));assert.deepEqual(assistant.candidateIds,[]);
  assert.equal(engine.snapshot().captures[0].url,'https://chatgpt.com/c/synthetic');
  assert.ok(engine.snapshot().memories.every(m=>m.status==='candidate'&&m.scope.type==='project'));
  assert.deepEqual(engine.getContext({projectId:project.id}).conditions,[]);
  engine.review(first.candidateIds[0],'approve');
  assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'한국어');
});
test('v1 state migrates explicitly and invalid capture revisions are rejected',()=>{
  const id=randomUUID();const old={version:1,ownerId:id,projects:[],memories:[]};
  const migrated=new MemoryEngine(old).snapshot();assert.equal(migrated.version,5);assert.deepEqual(migrated.captures,[]);
  const {engine,project}=fixture();engine.configureCapture({site:'chatgpt.com',projectId:project.id,enabled:true});engine.capture(input(project.id));
  const state=engine.snapshot();state.captures[0].previousId=state.captures[0].id;
  assert.throws(()=>new MemoryEngine(state),/INVALID_CAPTURE_REVISION/);
});
test('local review cannot resolve another project capture source or approve another project candidate',()=>{
  const {engine,project,other}=fixture();
  engine.configureCapture({site:'chatgpt.com',projectId:other.id,enabled:true});
  const captured=engine.capture(input(other.id));
  const foreign=engine.snapshot().memories[0];
  const own=engine.propose({scope:{type:'project',projectId:project.id},kind:'feedback',key:'source_test',value:'Synthetic',source:{kind:'ai',reference:`capture:${captured.id}`,excerpt:'AI-supplied reference'},reason:'Synthetic scope check'});
  assert.equal(engine.listMemories(project.id,'candidate').memories.find(m=>m.id===own.id).captureSource,undefined);
  assert.throws(()=>engine.reviewScoped(project.id,foreign.id,'approve'),/CANDIDATE_NOT_FOUND/);
});
test('captured raw text, URL, preferences and settings persist only inside ciphertext',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gb-capture-'));const owner=randomUUID(),password=randomBytes(24).toString('base64url');
  let vault=await VaultSession.open(directory,owner,password,true);
  try {
    const project=await vault.mutate(e=>e.addProject('CAPTURE_PRIVATE_PROJECT'));
    await vault.mutate(e=>e.configureCapture({site:'chatgpt.com',projectId:project.id,enabled:true}));
    await vault.mutate(e=>e.capture(input(project.id)));
    const disk=await readFile(join(directory,'vault.json'),'utf8');
    for(const text of ['한국어','CAPTURE_PRIVATE_PROJECT','chatgpt.com','turn-1'])assert.ok(!disk.includes(text));
    await vault.close();vault=await VaultSession.open(directory,owner,password);
    assert.equal(vault.read(e=>e.snapshot().captures.length),1);
    assert.equal((await vault.mutate(e=>e.capture(input(project.id)))).duplicate,true);
  } finally {await vault.close();await rm(directory,{recursive:true,force:true});}
});
