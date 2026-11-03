import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryEngine } from '../dist/engine.js';
import { fixture, proposal, approve } from './helpers.mjs';

test('a new project sees approved common preferences, never an AI candidate', () => {
  const engine = MemoryEngine.empty(randomUUID());
  const project = engine.addProject('콘텐츠 캠페인');
  const candidate = engine.propose({scope:{type:'global'},kind:'preference',key:'language',value:'한국어',source:{kind:'user',reference:'synthetic:feedback',excerpt:'한국어로 작성해줘'},reason:'명시적 언어 선호'});
  assert.equal(engine.getContext({projectId:project.id}).conditions.length,0);
  engine.review(candidate.id,'approve');
  assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'한국어');
});

test('current request wins over project and global without changing stored preferences', () => {
  const {engine,project}=fixture();
  approve(engine,proposal({type:'global'},'tone','friendly'));
  approve(engine,proposal({type:'project',projectId:project.id},'tone','formal'));
  const current=engine.getContext({projectId:project.id,requestConditions:{tone:'concise'}});
  assert.deepEqual(current.conditions.map(x=>[x.key,x.value,x.origin]),[['tone','concise','current_request']]);
  assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'formal');
});

test('supersession is explicit, same scope, acyclic, and older decisions never return', () => {
  const {engine,project,other}=fixture();const scope={type:'project',projectId:project.id};
  const old=approve(engine,proposal(scope,'cta','Buy now'));
  const conflict=engine.propose(proposal(scope,'cta','Ask for a consultation'));
  assert.throws(()=>engine.review(conflict.id,'approve'),/EXPLICIT_SUPERSESSION_REQUIRED/);
  const next=approve(engine,proposal(scope,'cta','Free trial',{supersedesId:old}));
  assert.equal(engine.snapshot().memories.find(x=>x.id===old).status,'superseded');
  assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'Free trial');
  assert.deepEqual(engine.search(project.id,'Buy'),[]);
  assert.throws(()=>engine.propose(proposal({type:'project',projectId:other.id},'cta','Other',{supersedesId:next})),/INVALID_SUPERSESSION/);
  assert.throws(()=>engine.review(old,'approve'),/CANDIDATE_NOT_FOUND/);
  assert.throws(()=>engine.propose(proposal(scope,'cta','Revive',{supersedesId:old})),/INVALID_SUPERSESSION/);
});

test('pending replacements become stale if another replacement is approved first', () => {
  const {engine,project}=fixture();const scope={type:'project',projectId:project.id};
  const old=approve(engine,proposal(scope,'tone','neutral'));
  const a=engine.propose(proposal(scope,'tone','direct',{supersedesId:old}));
  const b=engine.propose(proposal(scope,'tone','warm',{supersedesId:old}));
  engine.review(a.id,'approve');
  assert.throws(()=>engine.review(b.id,'approve'),/EXPLICIT_SUPERSESSION_REQUIRED|STALE_SUPERSESSION/);
  assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'direct');
});

test('project isolation, no promotion to global, and candidate/rejected exclusion', () => {
  const {engine,project,other}=fixture();
  approve(engine,proposal({type:'project',projectId:other.id},'client','secret competitor'));
  const ai=engine.propose(proposal({type:'project',projectId:project.id},'tone','inferred',{source:{kind:'ai',reference:'synthetic:ai',excerpt:'I infer a formal tone'}}));
  assert.deepEqual(engine.getContext({projectId:project.id}).conditions,[]);
  assert.deepEqual(engine.search(project.id,'secret'),[]);
  engine.review(ai.id,'reject');assert.deepEqual(engine.search(project.id,'inferred'),[]);
  assert.throws(()=>engine.propose({...proposal({type:'global'},'goal','Sell more'),kind:'goal'}));
  assert.throws(()=>engine.propose({...proposal({type:'global'},'tone','warm'),status:'active'}));
  assert.throws(()=>engine.getContext({projectId:randomUUID()}),/PROJECT_NOT_FOUND/);
});

test('search does not resurrect overridden global values or miss data outside context budget', () => {
  const {engine,project}=fixture();
  approve(engine,proposal({type:'global'},'tone','friendly'));
  approve(engine,proposal({type:'project',projectId:project.id},'tone','formal'));
  for(let i=0;i<20;i++)approve(engine,proposal({type:'global'},`field_${i}`,'x'.repeat(900)));
  approve(engine,proposal({type:'global'},'z_last','unique-needle'));
  assert.deepEqual(engine.search(project.id,'friendly'),[]);
  assert.equal(engine.search(project.id,'unique-needle')[0].value,'unique-needle');
  const context=engine.getContext({projectId:project.id,maxCharacters:512});
  assert.ok(context.omittedCount>0);
  assert.ok(context.conditions.some(x=>x.value==='formal'));
  assert.ok(!context.conditions.some(x=>x.value==='friendly'));
});
