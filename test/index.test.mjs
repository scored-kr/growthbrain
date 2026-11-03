import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, proposal, approve } from './helpers.mjs';
import { MemoryEngine } from '../dist/engine.js';
import { VaultSession } from '../dist/vault.js';

test('common root precedes explicit or uniquely configured project; ambiguity never merges projects',()=>{
  const {engine,project,other}=fixture();
  approve(engine,proposal({type:'global'},'language','한국어'));
  approve(engine,proposal({type:'global'},'tone','친근한 말투'));
  approve(engine,proposal({type:'project',projectId:project.id},'tone','전문적인 말투'));
  approve(engine,proposal({type:'project',projectId:other.id},'tone','OTHER_PRIVATE_TONE'));
  let result=engine.getContext({});
  assert.equal(result.routing.reason,'common_only');assert.deepEqual(result.searchedScopes,['global']);
  assert.equal(result.conditions.find(m=>m.key==='tone').origin,'global');
  // Names alone are not consent to routing.
  assert.equal(engine.getContext({query:project.name}).projectId,null);
  engine.configureProjectTriggers(project.id,['오로라','Aurora']);
  result=engine.getContext({query:'오로라의 다음 캠페인'});
  assert.equal(result.projectId,project.id);assert.equal(result.routing.reason,'configured_trigger');
  assert.deepEqual(result.searchedScopes,['global',`project:${project.id}`]);
  assert.deepEqual(result.conditions.map(m=>m.value),['전문적인 말투','한국어']);
  assert.equal(engine.getContext({query:'preaurorapost'}).projectId,null);
  assert.equal(engine.getContext({query:'ＡＵＲＯＲＡ campaign'}).projectId,project.id);
  engine.configureProjectTriggers(other.id,['오로라']);
  result=engine.getContext({query:'오로라'});
  assert.equal(result.routing.reason,'project_selection_required');assert.equal(result.projectId,null);
  assert.deepEqual(new Set(result.routing.candidateProjectIds),new Set([project.id,other.id]));
  assert.ok(!JSON.stringify(result).includes('OTHER_PRIVATE_TONE'));
  assert.deepEqual(engine.search(undefined,'오로라 전문적인').matches,[]);
  result=engine.getContext({projectId:project.id,query:'오로라',requestConditions:{tone:'짧게'}});
  assert.equal(result.routing.reason,'explicit_project');assert.equal(result.conditions[0].value,'짧게');
  engine.configureProjectTriggers(other.id,[]);
  assert.equal(new MemoryEngine(engine.snapshot()).getContext({query:'오로라'}).projectId,project.id);
  assert.throws(()=>engine.configureProjectTriggers(randomUUID(),['잘못된']),/PROJECT_NOT_FOUND/);
  assert.throws(()=>engine.configureProjectTriggers(project.id,[' ']));
});

test('ranked index handles labels, normalization and limited Korean particles without indexing historical evidence',()=>{
  const {engine,project,other}=fixture(),scope={type:'project',projectId:project.id};
  approve(engine,proposal({type:'global'},'language','한국어'));
  approve(engine,proposal(scope,'tone','과장 없는 전문적인 문체'));
  const cta=approve(engine,proposal(scope,'cta','무료 상담',{source:{kind:'user',reference:'synthetic:obsolete_purchase',excerpt:'즉시구매 대신 무료 상담'},reason:'obsolete_purchase 중단'}));
  approve(engine,proposal(scope,'format','Short paragraphs'));
  approve(engine,proposal(scope,'budget','오백만원'));
  approve(engine,proposal({type:'project',projectId:other.id},'secret','외부프로젝트특급비밀'));
  assert.equal(engine.search(project.id,'말투는').matches[0].key,'tone');
  assert.equal(engine.search(project.id,'상담을').matches[0].id,cta);
  assert.equal(engine.search(project.id,'ＰＡＲＡＧＲＡＰＨ').matches[0].key,'format');
  for(const query of ['즉시구매','obsolete_purchase','외부프로젝트특급비밀'])assert.deepEqual(engine.search(project.id,query).matches,[]);
  const found=engine.search(project.id,'무료 상담');
  assert.ok(found.matches[0].score>0);assert.deepEqual(found.matches[0].matchedTerms,['무료','상담']);
  assert.ok(found.matches[0].source.excerpt.includes('즉시구매'));
  // Narrow topic assistance is explicit evidence, not invented semantic confidence.
  assert.equal(engine.search(project.id,'돈을 얼마나 써도 돼').matches[0].key,'budget');
  assert.deepEqual(engine.search(project.id,'돈을 얼마나 써도 돼').matches[0].matchedTopics,['budget']);
});

test('cached indexes invalidate on approval, supersession and retirement; rejected forks cannot poison the parent',()=>{
  const {engine,project}=fixture(),scope={type:'project',projectId:project.id};
  const old=approve(engine,proposal(scope,'cta','이전약속'));
  assert.equal(engine.search(project.id,'이전약속').matches.length,1);
  const pending=engine.propose(proposal(scope,'cta','새로운약속',{supersedesId:old}));
  assert.deepEqual(engine.search(project.id,'새로운약속').matches,[]);
  const fork=engine.fork();fork.review(pending.id,'approve');
  assert.equal(engine.search(project.id,'이전약속').matches.length,1);
  assert.deepEqual(fork.search(project.id,'이전약속').matches,[]);
  engine.review(pending.id,'approve');assert.equal(engine.search(project.id,'새로운약속').matches.length,1);
  const result=engine.getContext({projectId:project.id});result.conditions[0].source.excerpt='mutated';
  const search=engine.search(project.id,'새로운약속');search.matches[0].scope.projectId=randomUUID();
  assert.notEqual(engine.getContext({projectId:project.id}).conditions[0].source.excerpt,'mutated');
  engine.retireMemory(project.id,pending.id,'종료');
  assert.deepEqual(engine.search(project.id,'약속').matches,[]);
  assert.deepEqual(engine.getContext({projectId:project.id}).conditions,[]);
});

test('vault cached queries stay detached, survive rollback/reopen and leave no plaintext index on disk',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'gb-index-')),owner=randomUUID(),password=randomBytes(24).toString('base64url');
  let vault=await VaultSession.open(directory,owner,password,true);
  t.after(async()=>{await vault.close();await rm(directory,{recursive:true,force:true});});
  const project=await vault.mutate(e=>e.addProject('INDEX_PRIVATE_PROJECT'));
  const id=await vault.mutate(e=>{e.configureProjectTriggers(project.id,['INDEX_PRIVATE_TRIGGER']);return approve(e,proposal({type:'project',projectId:project.id},'tone','INDEX_PRIVATE_VALUE'));});
  assert.equal(vault.getContext({query:'INDEX_PRIVATE_TRIGGER'}).projectId,project.id);
  const found=vault.search(project.id,'INDEX_PRIVATE_VALUE');found.matches[0].source.excerpt='changed';
  await assert.rejects(vault.mutate(e=>{e.retireMemory(project.id,id,'rollback');throw Error('abort');}),/abort/);
  assert.equal(vault.search(project.id,'INDEX_PRIVATE_VALUE').matches.length,1);
  assert.notEqual(vault.getContext({projectId:project.id}).conditions[0].source.excerpt,'changed');
  for(const file of await readdir(directory))assert.ok(!(await readFile(join(directory,file),'utf8')).includes('INDEX_PRIVATE'));
  await vault.close();assert.throws(()=>vault.search(project.id,'INDEX_PRIVATE_VALUE'),/VAULT_LOCKED/);
  vault=await VaultSession.open(directory,owner,password);
  assert.equal(vault.getContext({query:'INDEX_PRIVATE_TRIGGER'}).conditions[0].value,'INDEX_PRIVATE_VALUE');
  await vault.mutate(e=>e.retireMemory(project.id,id,'종료'));assert.deepEqual(vault.search(project.id,'INDEX_PRIVATE_VALUE').matches,[]);
});
