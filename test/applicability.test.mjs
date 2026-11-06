import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fixture,proposal,approve} from './helpers.mjs';
import {MemoryEngine} from '../dist/engine.js';
import {STATE_VERSION} from '../dist/model.js';
import {VaultSession} from '../dist/vault.js';
import {derive,seal,decrypt} from '../dist/envelope.js';
import {startBroker} from '../dist/broker.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const only=(...taskTypes)=>({applicability:{taskTypes}});
test('approved task conditions filter both recall and search before project override and ranking',()=>{
  const {engine,project,other}=fixture(),scope={type:'project',projectId:project.id};
  const common=approve(engine,proposal({type:'global'},'format','기본 문장형'));
  const campaign=approve(engine,proposal(scope,'format','캠페인 실행안 3개',only('campaign')));
  const translation=approve(engine,proposal({type:'global'},'translation_style','고유명사 원문 보존',only('translation')));
  approve(engine,proposal({type:'project',projectId:other.id},'format','OTHER_PROJECT_MARKER',only('campaign')));
  const candidate=engine.propose(proposal(scope,'draft','PENDING_MARKER',only('campaign')));
  const before=engine.snapshot();
  for(const [taskType,ids] of [[undefined,[common]],['translation',[common,translation]],['campaign',[campaign]],['coding',[common]],['analysis',[common]],['writing',[common]]]) {
    const context=engine.getContext({projectId:project.id,...(taskType?{taskType}:{})});
    assert.deepEqual(new Set(context.conditions.map(m=>m.memoryId)),new Set(ids));
    assert.equal(context.taskType,taskType??null);
    assert.equal(context.taskExcludedCount,taskType===undefined||taskType==='coding'||taskType==='analysis'||taskType==='writing'?2:1);
    const expected=taskType==='campaign'?[campaign]:[common];
    assert.deepEqual(engine.search(project.id,'format',20,{},taskType).matches.map(m=>m.id),expected);
    for(const query of ['PENDING_MARKER','OTHER_PROJECT_MARKER'])assert.deepEqual(engine.search(project.id,query,20,{},taskType).matches,[]);
    if(taskType!=='campaign')assert.deepEqual(engine.search(project.id,'캠페인 실행안',20,{},taskType).matches,[]);
  }
  const override={format:'이번에는 표 하나'};
  assert.equal(engine.getContext({projectId:project.id,taskType:'campaign',requestConditions:override}).conditions[0].origin,'current_request');
  assert.deepEqual(engine.search(project.id,'format',20,override,'campaign').matches,[]);
  assert.deepEqual(engine.snapshot(),before);
  assert.equal(engine.getContext({taskType:'campaign'}).conditions.find(m=>m.key==='format').memoryId,common);
  assert.ok(!JSON.stringify(engine.getContext({projectId:project.id,taskType:'campaign'})).includes(candidate.id));
});

test('task applicability survives correction, replacement and retirement without becoming unconditional',()=>{
  const {engine,project}=fixture(),scope={type:'project',projectId:project.id};
  const old=approve(engine,proposal(scope,'format','old campaign format',only('campaign')));
  const candidate=engine.propose(proposal(scope,'format','pending campaign format',{...only('campaign'),supersedesId:old}));
  const corrected=engine.correctCandidate(project.id,candidate.id,'corrected campaign format','Explicit correction');
  assert.deepEqual(engine.snapshot().memories.at(-1).applicability,{taskTypes:['campaign']});
  assert.equal(engine.getContext({projectId:project.id,taskType:'campaign'}).conditions[0].memoryId,old);
  engine.review(corrected.id,'approve',old);
  assert.deepEqual(engine.getContext({projectId:project.id,taskType:'translation'}).conditions,[]);
  const restored=new MemoryEngine(engine.snapshot());
  assert.equal(restored.getContext({projectId:project.id,taskType:'campaign'}).conditions[0].memoryId,corrected.id);
  const corrupt=engine.snapshot();delete corrupt.memories.at(-1).applicability;
  assert.throws(()=>new MemoryEngine(corrupt),/INVALID_CORRECTION/);
  restored.retireMemory(project.id,corrected.id,'No longer applicable');
  assert.deepEqual(restored.search(project.id,'format',20,{},'campaign').matches,[]);
  assert.deepEqual(restored.getContext({projectId:project.id,taskType:'campaign'}).conditions,[]);
});

test('invalid applicability and legacy records with undeclared new fields fail closed',()=>{
  const {engine,project}=fixture(),scope={type:'project',projectId:project.id};
  const before=engine.snapshot();
  for(const applicability of [null,{}, {taskTypes:[]},{taskTypes:['campaign','campaign']},{taskTypes:['all']},{taskTypes:['campaign'],automatic:true}])assert.throws(()=>engine.propose(proposal(scope,'format','invalid',{applicability})));
  assert.deepEqual(engine.snapshot(),before);
  for(const taskType of ['all','',null,[],{type:'campaign'}]) {
    assert.throws(()=>engine.getContext({projectId:project.id,taskType}));
    assert.throws(()=>engine.search(project.id,'format',20,{},taskType));
  }
  const id=approve(engine,proposal(scope,'format','approved',only('campaign','writing')));
  const legacy=engine.snapshot();legacy.version=4;delete legacy.handoffs;delete legacy.inferenceUsage;
  assert.throws(()=>new MemoryEngine(legacy));
  delete legacy.memories.find(m=>m.id===id).applicability;
  const migrated=new MemoryEngine(legacy);
  assert.equal(migrated.snapshot().version,STATE_VERSION);
  assert.equal(migrated.getContext({projectId:project.id}).conditions[0].memoryId,id);
});

test('v4 ciphertext is preserved before conditional writes and survives encrypted export/restore',async()=>{
  const root=await mkdtemp(join(tmpdir(),'gb-task-migrate-')),directory=join(root,'vault'),owner=randomUUID(),password=randomBytes(24).toString('base64url');
  const old=MemoryEngine.empty(owner),project=old.addProject('PRIVATE_CONDITIONAL_PROJECT');
  const originalState=old.snapshot();originalState.version=4;delete originalState.handoffs;delete originalState.inferenceUsage;
  const salt=randomBytes(16),key=await derive(password,salt),envelope=seal({snapshot:()=>originalState},key,{version:1,ownerId:owner,salt:salt.toString('base64')});key.fill(0);
  const {mkdir}=await import('node:fs/promises');await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'vault.json'),JSON.stringify(envelope),{mode:0o600});
  let vault,reopened;
  try {
    vault=await VaultSession.open(directory,owner,password);
    const backups=(await readdir(directory)).filter(n=>n.startsWith(`pre-state-v${STATE_VERSION}-`));assert.equal(backups.length,1);
    assert.deepEqual(JSON.parse(await readFile(join(directory,backups[0]),'utf8')),envelope);
    await vault.mutate(e=>approve(e,proposal({type:'project',projectId:project.id},'format','PRIVATE_TASK_VALUE',only('campaign'))));
    await vault.exportBackup(join(root,'export.enc'));await vault.close();
    const disk=await readFile(join(directory,'vault.json'),'utf8');
    for(const privateText of ['PRIVATE_TASK_VALUE','PRIVATE_CONDITIONAL_PROJECT','campaign','applicability'])assert.ok(!disk.includes(privateText));
    assert.equal(JSON.parse(disk).version,1);
    const previous=await decrypt(envelope,owner,password);assert.equal(previous.sourceStateVersion,4);previous.key.fill(0);
    reopened=await VaultSession.restore(join(root,'export.enc'),join(root,'restored'),owner,password);
    assert.deepEqual(reopened.getContext({projectId:project.id}).conditions,[]);
    assert.equal(reopened.getContext({projectId:project.id,taskType:'campaign'}).conditions[0].value,'PRIVATE_TASK_VALUE');
    assert.deepEqual(JSON.parse(await readFile(join(directory,backups[0]),'utf8')),envelope);
  } finally {await vault?.close();await reopened?.close();await rm(root,{recursive:true,force:true});}
});

test('real MCP communicates task selection and excludes unrelated task content and sources',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'gb-task-mcp-')),vault=await VaultSession.open(directory,randomUUID(),randomBytes(24).toString('base64url'),true);
  const project=await vault.mutate(e=>e.addProject('Synthetic task project'));
  await vault.mutate(e=>approve(e,proposal({type:'global'},'language','한국어')));
  const broker=await startBroker(vault,directory),client=new Client({name:'task-filter-test',version:'1'});
  t.after(async()=>{await client.close();await vault.close();await broker.close();await rm(directory,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.js')],env:{GROWTH_BRAIN_SOCKET:broker.path},stderr:'ignore'}));
  const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));assert.deepEqual(JSON.parse(r.content[0].text),r.structuredContent);return r.structuredContent;};
  const candidate=await call('propose_memory',proposal({type:'project',projectId:project.id},'format','CAMPAIGN_ONLY_VALUE',{...only('campaign'),source:{kind:'user',reference:'synthetic:CAMPAIGN_ONLY_SOURCE',excerpt:'CAMPAIGN_ONLY_EXCERPT'}}));
  assert.equal(candidate.status,'candidate');
  await vault.mutate(e=>e.review(candidate.id,'approve'));
  for(const taskType of [undefined,'translation','campaign']) {
    const selection={projectId:project.id,...(taskType?{taskType}:{})};
    const ctx=await call('get_context',selection),search=await call('search_memory',{...selection,query:'format'});
    assert.equal(ctx.taskType,taskType??null);assert.equal(search.taskType,taskType??null);
    if(taskType==='campaign') {assert.equal(search.matches[0].id,candidate.id);assert.deepEqual(search.matches[0].applicability,only('campaign').applicability);}
    else {assert.equal(ctx.taskExcludedCount,1);assert.deepEqual(search.matches,[]);for(const marker of ['CAMPAIGN_ONLY',candidate.id])assert.ok(!JSON.stringify([ctx,search]).includes(marker));}
  }
  const invalid=await client.callTool({name:'get_context',arguments:{projectId:project.id,taskType:'anything'}});assert.equal(invalid.isError,true);
});
