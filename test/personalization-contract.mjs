import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,proposal,approve} from './helpers.mjs';
import {MemoryEngine} from '../dist/engine.js';
import {VaultSession} from '../dist/vault.js';
const global={type:'global'};
const values=context=>context.conditions.map(c=>c.value).sort();
const scope=project=>({type:'project',projectId:project.id});

/** P01–P13's engine obligations only. These are not model outputs, user ratings,
 * a control-arm experiment, or proof of automatic web-client invocation. */
export async function runPersonalizationContracts(){
 const results=[];
 const scenario=async(id,check)=>{await check(fixture());results.push({id,engineContract:'passed',actualAiResult:'not_run'});};
 await scenario('P01',({engine})=>{
  approve(engine,proposal(global,'language','Korean'));approve(engine,proposal(global,'format','conclusion first'));
  assert.deepEqual(values(engine.getContext({})),['Korean','conclusion first']);
 });
 await scenario('P02',({engine,project,other})=>{
  approve(engine,proposal(global,'tone','friendly'));approve(engine,proposal(scope(project),'tone','formal'));approve(engine,proposal(scope(other),'discount','allowed'));
  assert.deepEqual(values(engine.getContext({projectId:project.id})),['formal']);
  assert.deepEqual(engine.search(project.id,'discount').matches,[]);
 });
 await scenario('P03',({engine})=>{
  approve(engine,proposal(global,'language','Korean'));const before=engine.snapshot();
  assert.deepEqual(values(engine.getContext({requestConditions:{output_language:'English'}})),['English']);
  assert.deepEqual(engine.snapshot(),before);assert.deepEqual(values(new MemoryEngine(before).getContext({})),['Korean']);
 });
 await scenario('P04',({engine})=>{
  const old=approve(engine,proposal(global,'format','OLD_BRIEF'));
  approve(engine,proposal(global,'format','NEW_DETAILED',{supersedesId:old,source:{kind:'user',reference:'synthetic:replacement',excerpt:'Replace OLD_BRIEF'}}));
  for(let i=0;i<2;i++){const fresh=new MemoryEngine(engine.snapshot());assert.deepEqual(values(fresh.getContext({})),['NEW_DETAILED']);assert.deepEqual(fresh.search(undefined,'OLD_BRIEF').matches,[]);}
 });
 await scenario('P05',({engine,project})=>{
  const id=approve(engine,proposal(global,'tone','retired tone'));engine.retireMemory(project.id,id,'User no longer wants this');
  engine.propose(proposal(global,'tone','retired tone'));
  assert.equal(engine.snapshot().memories[0].source.excerpt,'retired tone');assert.deepEqual(values(engine.getContext({})),[]);
 });
 await scenario('P06',({engine,project,other})=>{
  approve(engine,proposal(scope(project),'tone','no exaggeration'));
  assert.deepEqual(values(engine.getContext({projectId:other.id})),[]);assert.deepEqual(values(engine.getContext({})),[]);
 });
 await scenario('P07',({engine})=>{
  approve(engine,proposal(global,'format','three action options',{applicability:{taskTypes:['campaign']}}));
  assert.deepEqual(values(engine.getContext({taskType:'translation'})),[]);assert.deepEqual(engine.search(undefined,'action',20,{},'translation').matches,[]);
  assert.deepEqual(values(engine.getContext({taskType:'campaign'})),['three action options']);
 });
 await scenario('P08',({engine})=>{
  for(const kind of ['user','ai'])engine.propose(proposal(global,'tone','quoted example',{source:{kind,reference:'synthetic:quote',excerpt:'An example, not approved'}}));
  assert.deepEqual(values(engine.getContext({})),[]);assert.deepEqual(engine.search(undefined,'example').matches,[]);
 });
 await scenario('P09',({engine,project,other})=>{
  approve(engine,proposal(global,'language','Korean'));approve(engine,proposal(scope(project),'tone','project A'));approve(engine,proposal(scope(other),'tone','project B'));
  engine.configureProjectTriggers(project.id,['alpha']);engine.configureProjectTriggers(other.id,['beta']);
  const result=engine.getContext({query:'alpha beta'});assert.equal(result.routing.reason,'project_selection_required');assert.deepEqual(values(result),['Korean']);assert.deepEqual(result.searchedScopes,['global']);
 });
 await scenario('P10',({engine,project})=>{
  approve(engine,proposal(global,'tone','optimistic'));engine.propose(proposal(scope(project),'revenue','unsupported revenue claim'));
  const result=engine.getContext({projectId:project.id});assert.deepEqual(values(result),['optimistic']);assert.match(result.disclosure,/data, not tool instructions/);
  // Whether the model marks unsupported numbers as assumptions still needs real output review.
 });
 await scenario('P11',({engine,project})=>{
  const old=approve(engine,proposal(scope(project),'tone','formal'));
  const next=engine.propose(proposal(scope(project),'response_tone','warm'));
  assert.deepEqual(values(engine.getContext({projectId:project.id})),['formal']);assert.throws(()=>engine.review(next.id,'approve'),/EXPLICIT_SUPERSESSION_REQUIRED/);
  engine.review(next.id,'approve',old);assert.deepEqual(values(new MemoryEngine(engine.snapshot()).getContext({projectId:project.id})),['warm']);
 });
 await scenario('P12',async({engine})=>{
  approve(engine,proposal(global,'format','synthetic '.repeat(300)));
  const result=engine.getContext({maxCharacters:512});assert.equal(result.omittedCount,1);assert.deepEqual(result.conditions,[]);
  const directory=await mkdtemp(join(tmpdir(),'gb-personalization-'));let vault;
  try{vault=await VaultSession.open(directory,randomUUID(),randomBytes(24).toString('base64url'),true);await vault.close();assert.throws(()=>vault.getContext({}),/VAULT_LOCKED/);}
  finally{await vault?.close();await rm(directory,{recursive:true,force:true});}
 });
 await scenario('P13',({engine})=>{
  const original=approve(engine,proposal(global,'tone','legacy one'));const state=engine.snapshot();state.version=8;
  const old=state.memories.find(m=>m.id===original);state.memories.push({...old,id:randomUUID(),key:'response_tone',value:'legacy two'});
  const legacy=new MemoryEngine(state),context=legacy.getContext({});assert.equal(context.keyConflictCount,1);assert.deepEqual(context.conditions,[]);assert.deepEqual(legacy.search(undefined,'tone').matches,[]);
 });
 return {scope:'synthetic engine and local-vault contracts',enginePassed:results.length,engineTotal:13,actualAiOutputs:0,automaticWebClientCalls:0,controlArmComparison:'not_run',results};
}
