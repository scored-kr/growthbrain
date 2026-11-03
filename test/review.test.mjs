import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryEngine } from '../dist/engine.js';
import { fixture, proposal, approve } from './helpers.mjs';

test('human correction preserves scope/source/history and remains pending until an explicit replacement',()=>{
 const {engine,project,other}=fixture(),scope={type:'project',projectId:project.id};
 const prior=approve(engine,proposal(scope,'tone','approved original'));
 const candidate=engine.propose(proposal(scope,'tone','AI inferred badly',{source:{kind:'ai',reference:'synthetic:ai',excerpt:'original conversation'},supersedesId:prior}));
 const before=engine.snapshot();
 assert.throws(()=>engine.correctCandidate(other.id,candidate.id,'x','wrong project'),/CANDIDATE_NOT_FOUND/);
 assert.throws(()=>engine.correctCandidate(project.id,candidate.id,'','empty'));
 assert.deepEqual(engine.snapshot(),before);
 const next=engine.correctCandidate(project.id,candidate.id,'user corrected','User clarified the intended style');
 assert.equal(next.status,'candidate');assert.equal(next.reviewRequired,true);
 const memories=engine.snapshot().memories,old=memories.find(m=>m.id===candidate.id),corrected=memories.find(m=>m.id===next.id);
 assert.equal(old.status,'rejected');assert.equal(old.value,'AI inferred badly');
 assert.equal(corrected.correctionOf,old.id);assert.deepEqual(corrected.scope,old.scope);assert.deepEqual(corrected.source,old.source);
 assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'approved original');
 assert.throws(()=>engine.review(next.id,'approve'),/EXPLICIT_SUPERSESSION_REQUIRED/);
 engine.review(next.id,'approve',prior);
 assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'user corrected');
 assert.equal(new MemoryEngine(engine.snapshot()).snapshot().version,3);
});

test('retirement excludes current memory without resurrecting superseded decisions; defaults remain explicit',()=>{
 const {engine,project,other}=fixture(),scope={type:'project',projectId:project.id};
 const common=approve(engine,proposal({type:'global'},'tone','global default'));
 const old=approve(engine,proposal(scope,'tone','superseded project condition'));
 const current=approve(engine,proposal(scope,'tone','current project condition',{supersedesId:old}));
 const stale=engine.propose(proposal(scope,'tone','pending replacement',{supersedesId:current}));
 assert.throws(()=>engine.retireMemory(other.id,current,'wrong project'),/ACTIVE_MEMORY_NOT_FOUND/);
 assert.throws(()=>engine.retireMemory(project.id,current,' '));
 engine.retireMemory(project.id,current,'This project condition no longer applies');
 assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'global default');
 assert.deepEqual(engine.search(project.id,'project condition').matches,[]);
 assert.throws(()=>engine.review(current,'approve'),/CANDIDATE_NOT_FOUND/);
 assert.throws(()=>engine.review(stale.id,'approve'),/STALE_SUPERSESSION/);
 assert.throws(()=>engine.retireMemory(project.id,old,'cannot revive'),/ACTIVE_MEMORY_NOT_FOUND/);
 const retired=engine.listMemories(project.id,'all').memories.find(m=>m.id===current);
 assert.equal(retired.status,'retired');assert.ok(retired.retiredAt);assert.match(retired.retirementReason,/no longer/);
 engine.retireMemory(project.id,common,'Remove shared default for every project');
 assert.deepEqual(engine.getContext({projectId:other.id}).conditions,[]);
 assert.deepEqual(new MemoryEngine(engine.snapshot()).getContext({projectId:project.id}).conditions,[]);
});

test('v1/v2 migrate to v3 but invalid corrections and retirement evidence fail closed',()=>{
 const {engine,project}=fixture();const v2=engine.snapshot();v2.version=2;
 assert.equal(new MemoryEngine(v2).snapshot().version,3);
 const v1={version:1,ownerId:randomUUID(),projects:[],memories:[]};assert.equal(new MemoryEngine(v1).snapshot().version,3);
 const scope={type:'project',projectId:project.id};
 const first=engine.propose(proposal(scope,'tone','first'));
 const next=engine.correctCandidate(project.id,first.id,'second','clarification');
 let state=engine.snapshot();state.memories.at(-1).correctionOf=next.id;
 assert.throws(()=>new MemoryEngine(state),/INVALID_CORRECTION/);
 state=engine.snapshot();state.memories.at(-1).key='another';assert.throws(()=>new MemoryEngine(state),/INVALID_CORRECTION/);
 engine.review(next.id,'approve');engine.retireMemory(project.id,next.id,'outdated');
 state=engine.snapshot();delete state.memories.at(-1).retiredAt;
 assert.throws(()=>new MemoryEngine(state),/INVALID_RETIREMENT/);
 state=engine.snapshot();state.version=2;assert.throws(()=>new MemoryEngine(state));
});
