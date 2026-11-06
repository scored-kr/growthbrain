import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,proposal,approve} from './helpers.mjs';
import {MemoryEngine} from '../dist/engine.js';
import {VaultSession} from '../dist/vault.js';
import {derive,seal,decrypt} from '../dist/envelope.js';
import {contextOutputSchema,searchOutputSchema} from '../dist/mcp-contract.js';
const global={type:'global'};
const tasks=(...taskTypes)=>({applicability:{taskTypes}});

// Simulate legal v8 records: aliases were independent keys, never auto-rewrite data.
export function legacyAliasCollision(engine,original,key,value) {
 const state=engine.snapshot();state.version=8;
 const old=state.memories.find(m=>m.id===original);
 state.memories.push({...structuredClone(old),id:randomUUID(),key,value,source:{...old.source,excerpt:value}});
 return new MemoryEngine(state);
}
test('curated aliases share precedence, explicit corrections and search terms while preserving source keys',()=>{
 const {engine,project}=fixture(),scope={type:'project',projectId:project.id};
 approve(engine,proposal(global,'tone','common friendly'));
 const old=approve(engine,proposal(scope,'response_tone','project formal'));
 const before=engine.snapshot();
 const request=engine.getContext({projectId:project.id,requestConditions:{output_tone:'brief'}});
 assert.deepEqual(request.conditions,[{key:'tone',value:'brief',origin:'current_request'}]);
 assert.deepEqual(engine.search(project.id,'tone',20,{tone:'brief'}).matches,[]);
 assert.deepEqual(engine.snapshot(),before);
 const normal=engine.getContext({projectId:project.id});contextOutputSchema.parse(normal);
 assert.equal(normal.conditions[0].storedKey,'response_tone');assert.equal(normal.conditions[0].memoryId,old);
 const candidate=engine.propose(proposal(scope,'tone','project warm'));
 assert.equal(engine.listMemories(project.id,'candidate').memories[0].conflict.id,old);
 assert.equal(engine.inferenceInput(project.id,candidate.id).conflicts[0].id,old);
 assert.throws(()=>engine.review(candidate.id,'approve'),/EXPLICIT_SUPERSESSION_REQUIRED/);
 engine.review(candidate.id,'approve',old);
 const restored=new MemoryEngine(engine.snapshot());assert.equal(restored.getContext({projectId:project.id}).conditions[0].memoryId,candidate.id);
 assert.deepEqual(restored.search(project.id,'formal').matches,[]);
 const coding=approve(engine,proposal(global,'coding_convention','team style'));
 assert.equal(engine.search(undefined,'code style').matches[0].id,coding);
 const result=engine.search(undefined,'coding convention');searchOutputSchema.parse(result);
 assert.equal(result.matches[0].key,'code_style');assert.equal(result.matches[0].storedKey,'coding_convention');
 approve(engine,proposal(global,'coding.indentation','two spaces'));
 assert.equal(engine.getContext({}).conditions.filter(c=>['code_style','coding.indentation'].includes(c.key)).length,2);
 assert.throws(()=>engine.getContext({requestConditions:{tone:'a',response_tone:'b'}}),/AMBIGUOUS_REQUEST_CONDITIONS/);
 assert.throws(()=>engine.search(undefined,'tone',20,{tone:'a',response_tone:'b'}),/AMBIGUOUS_REQUEST_CONDITIONS/);
 assert.equal(engine.getContext({requestConditions:{tone:'a',response_tone:'a'}}).conditions.filter(c=>c.key==='tone').length,1);
});

test('legacy alias collisions are withheld in both retrieval paths; a project conflict cannot reveal the common fallback',()=>{
 const f=fixture(),scope={type:'project',projectId:f.project.id};
 approve(f.engine,proposal(global,'tone','common fallback'));
 const original=approve(f.engine,proposal(scope,'tone','PROJECT_PRIVATE_ONE'));
 const engine=legacyAliasCollision(f.engine,original,'response_tone','PROJECT_PRIVATE_TWO');
 const state=engine.snapshot();
 for(const result of [engine.getContext({projectId:f.project.id}),engine.search(f.project.id,'tone')]){
  assert.equal(result.keyConflictCount,1);assert.equal(result.keyConflicts[0].origin,'project');
  assert.equal(result.keyConflicts[0].memoryIds.length,2);
  assert.ok(!JSON.stringify(result).includes('PROJECT_PRIVATE'));assert.ok(!JSON.stringify(result).includes('common fallback'));
 }
 assert.deepEqual(engine.getContext({projectId:f.project.id}).conditions,[]);
 assert.deepEqual(engine.search(f.project.id,'tone').matches,[]);
 const other=engine.getContext({projectId:f.other.id});assert.equal(other.keyConflictCount,0);assert.equal(other.conditions[0].value,'common fallback');
 assert.equal(engine.getContext({projectId:f.project.id,requestConditions:{output_tone:'temporary'}}).keyConflictCount,0);
 assert.deepEqual(engine.snapshot(),state);
 const candidate=engine.propose(proposal(scope,'output_tone','reviewed winner'));
 assert.throws(()=>engine.review(candidate.id,'approve',original),/MULTIPLE_SUPERSESSIONS_REQUIRED/);
 engine.retireMemory(f.project.id,engine.snapshot().memories.at(-2).id,'Explicitly resolve legacy ambiguity');
 engine.review(candidate.id,'approve',original);
 assert.equal(new MemoryEngine(engine.snapshot()).getContext({projectId:f.project.id}).conditions[0].value,'reviewed winner');
});

test('alias conflicts respect conditional selection and scopes, including ambiguous common defaults',()=>{
 const {engine,project}=fixture();
 const common=approve(engine,proposal(global,'tone','common one'));
 const collision=legacyAliasCollision(engine,common,'response_tone','common two');
 assert.equal(collision.getContext({}).keyConflictCount,1);
 const writing=approve(collision,proposal(global,'output_tone','writing only',tasks('writing')));
 assert.equal(collision.getContext({taskType:'writing'}).conditions[0].memoryId,writing);
 assert.equal(collision.getContext({taskType:'writing'}).keyConflictCount,0);
 assert.equal(collision.getContext({taskType:'translation'}).keyConflictCount,1);
 approve(collision,proposal(global,'tone','coding only',tasks('coding')));
 const overlapping=collision.propose(proposal(global,'response_tone','overlap',tasks('coding')));
 assert.throws(()=>collision.review(overlapping.id,'approve'),/EXPLICIT_SUPERSESSION_REQUIRED/);
 approve(collision,proposal({type:'project',projectId:project.id},'tone','project wins'));
 assert.equal(collision.getContext({projectId:project.id}).keyConflictCount,0);
 assert.equal(collision.search(project.id,'tone').matches[0].value,'project wins');
});

test('v8 ciphertext is preserved before a cross-alias v9 supersession and remains independently recoverable',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gb-alias-migrate-')),owner=randomUUID(),password=randomBytes(24).toString('base64url');
 let vault;
 try{
  const engine=MemoryEngine.empty(owner),project=engine.addProject('synthetic'),old=approve(engine,proposal(global,'response_tone','old'));
  const state=engine.snapshot();state.version=8;
  const salt=randomBytes(16),key=await derive(password,salt),envelope=seal({snapshot:()=>state},key,{version:1,ownerId:owner,salt:salt.toString('base64')});key.fill(0);
  await writeFile(join(directory,'vault.json'),JSON.stringify(envelope),{mode:0o600});
  vault=await VaultSession.open(directory,owner,password);
  await vault.mutate(e=>approve(e,proposal(global,'tone','new',{supersedesId:old})));
  const backups=(await readdir(directory)).filter(n=>n.startsWith('pre-state-v9-'));assert.equal(backups.length,1);
  const previous=JSON.parse(await readFile(join(directory,backups[0]),'utf8'));assert.deepEqual(previous,envelope);
  const decoded=await decrypt(previous,owner,password);assert.equal(decoded.sourceStateVersion,8);decoded.key.fill(0);
  await vault.close();vault=await VaultSession.open(directory,owner,password);
  assert.equal(vault.getContext({projectId:project.id}).conditions[0].value,'new');
  assert.equal(vault.read(e=>e.snapshot().version),9);
 }finally{await vault?.close();await rm(directory,{recursive:true,force:true});}
});
