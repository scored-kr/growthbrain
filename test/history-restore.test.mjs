import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,proposal,approve} from './helpers.mjs';
import {MemoryEngine} from '../dist/engine.js';
import {VaultSession} from '../dist/vault.js';
import {derive,seal} from '../dist/envelope.js';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('every approved historical edge survives later replacement and retirement across scopes, aliases and chain depths',()=>{
 for(const scopeType of ['global','project'])for(const aliases of [false,true])for(let length=3;length<=9;length++){
  const {engine,project}=fixture(),scope=scopeType==='global'?{type:'global'}:{type:'project',projectId:project.id};
  let previous;
  for(let n=0;n<length;n++)previous=approve(engine,proposal(scope,aliases&&n%2?'response_tone':'tone',`generation ${n}`,previous?{supersedesId:previous}:{}));
  engine.retireMemory(project.id,previous,'User stopped the latest condition');
  const original=engine.snapshot(),restored=new MemoryEngine(original);
  assert.deepEqual(restored.getContext({projectId:project.id}).conditions,[]);
  assert.deepEqual(restored.search(project.id,'generation').matches,[]);
  for(let ancestor=0;ancestor<length-1;ancestor++){
   const invalid=structuredClone(original);invalid.memories[ancestor].status='active';
   assert.throws(()=>new MemoryEngine(invalid),/INVALID_SUPERSESSION_STATUS/,`scope=${scopeType} aliases=${aliases} length=${length} ancestor=${ancestor}`);
  }
 }
});

test('an authenticated but inconsistent backup cannot open or restore and does not overwrite any ciphertext',async()=>{
 const {engine,project}=fixture(),scope={type:'global'};
 const a=approve(engine,proposal(scope,'tone','obsolete'));
 const b=approve(engine,proposal(scope,'tone','intermediate',{supersedesId:a}));
 const c=approve(engine,proposal(scope,'tone','latest',{supersedesId:b}));
 engine.retireMemory(project.id,c,'No current preference');
 const state=engine.snapshot();state.memories[0].status='active';
 const root=await mkdtemp(join(tmpdir(),'gb-history-restore-')),password=randomBytes(24).toString('base64url'),salt=randomBytes(16),key=await derive(password,salt);
 try{
  const envelope=seal({snapshot:()=>state},key,{version:1,ownerId:state.ownerId,salt:salt.toString('base64')}),bytes=JSON.stringify(envelope);
  const file=join(root,'vault.json');await writeFile(file,bytes,{mode:0o600});
  await assert.rejects(VaultSession.open(root,state.ownerId,password),/INVALID_SUPERSESSION_STATUS/);
  assert.equal(await readFile(file,'utf8'),bytes);assert.deepEqual((await readdir(root)).sort(),['vault.json']);
  await assert.rejects(VaultSession.restore(file,join(root,'new'),state.ownerId,password),/INVALID_SUPERSESSION_STATUS/);
  assert.equal(await readFile(file,'utf8'),bytes);
 }finally{key.fill(0);await rm(root,{recursive:true,force:true});}
});
