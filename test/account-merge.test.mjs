import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEngine } from '../dist/engine.js';
import { describePortableConflicts, mergePortableState } from '../dist/account-merge.js';
import { approve, fixture, proposal } from './helpers.mjs';

function branches() {
  const {engine,project,other}=fixture();
  const base=engine.snapshot(), local=new MemoryEngine(base), remote=new MemoryEngine(base);
  return {base,local,remote,project,other};
}

test('merge preserves a correction chain, independent active memories and original per-device ordering',()=>{
  const {base,local,remote,project}=branches(), scope={type:'project',projectId:project.id};
  const candidate=local.propose(proposal(scope,'theme','Blue')).id;
  const corrected=local.correctCandidate(project.id,candidate,'Green','User correction').id;
  local.review(corrected,'approve');
  const other=approve(remote,proposal(scope,'margin','Twenty'));
  local.configureCapture({site:'chatgpt.com',projectId:project.id,enabled:true});
  const state=mergePortableState(base,local.snapshot(),remote.snapshot());
  assert.deepEqual(state,mergePortableState(base,remote.snapshot(),local.snapshot()));
  assert.deepEqual(state,mergePortableState(state,state,state));
  assert.deepEqual(state.captureSettings,[]);
  assert.deepEqual(new Set(state.memories.map(m=>m.id)),new Set([candidate,corrected,other]));
  assert.ok(state.memories.findIndex(m=>m.id===candidate)<state.memories.findIndex(m=>m.id===corrected));
  assert.equal(state.memories.find(m=>m.id===corrected).correctionOf,candidate);
});

test('alias decisions match within the same scope and task while distinct scopes and nonoverlapping tasks survive',()=>{
  const {base,local,remote,project,other}=branches();
  const scope={type:'project',projectId:project.id}, writing={applicability:{taskTypes:['writing']}};
  const a=approve(local,proposal(scope,'response_tone','Direct',writing));
  const b=approve(remote,proposal(scope,'output_tone','Formal',writing));
  const otherProject=approve(local,proposal({type:'project',projectId:other.id},'tone','Gentle',writing));
  const translation=approve(remote,proposal(scope,'tone','Precise',{applicability:{taskTypes:['translation']}}));
  const general=approve(remote,proposal(scope,'tone','Neutral'));
  const [review]=describePortableConflicts(base,local.snapshot(),remote.snapshot());
  assert.match(review.id,/^[0-9a-f]{64}$/);
  assert.deepEqual(review,{id:review.id,key:'tone',projectId:project.id,localValue:'Direct',remoteValue:'Formal'});
  const resolve=(choices)=>mergePortableState(base,local.snapshot(),remote.snapshot(),choices,'2026-11-22T10:00:00.000Z');
  assert.throws(()=>resolve({}),/SYNC_CONFLICT/);
  assert.throws(()=>resolve({[review.id]:'ignore'}),/SYNC_CONFLICT/);
  assert.throws(()=>resolve({[review.id]:'local',stale:'remote'}),/SYNC_CONFLICT/);
  const state=resolve({[review.id]:'remote'}), retained=state.memories.find(m=>m.id===a);
  assert.equal(retained.retirementReason.includes(b),true);
  assert.equal(retained.value,'Direct');
  assert.equal(retained.source.excerpt,'Direct');
  assert.equal(retained.status,'retired');
  assert.equal(retained.retiredAt,'2026-11-22T10:00:00.000Z');
  assert.deepEqual(new Set(state.memories.filter(m=>m.status==='active').map(m=>m.id)),new Set([b,otherProject,translation,general]));
  assert.deepEqual(state,resolve({[review.id]:'remote'}));
  const updated=remote.snapshot();
  updated.memories.find(m=>m.id===b).pinned=true;
  assert.throws(()=>mergePortableState(base,local.snapshot(),updated,{[review.id]:'remote'}),/SYNC_CONFLICT/);
});

test('overlapping task subsets require a richer resolution than retiring one entire decision',()=>{
  const {base,local,remote}=branches(), scope={type:'global'};
  approve(local,proposal(scope,'tone','Direct',{applicability:{taskTypes:['writing','translation']}}));
  approve(remote,proposal(scope,'tone','Polite',{applicability:{taskTypes:['writing','analysis']}}));
  assert.deepEqual(describePortableConflicts(base,local.snapshot(),remote.snapshot()),[]);
  assert.throws(()=>mergePortableState(base,local.snapshot(),remote.snapshot()),/SYNC_CONFLICT/);
});

test('removing an approved row fails closed, while an intentional trigger removal is preserved',()=>{
  const {engine,project}=fixture();
  const original=approve(engine,proposal({type:'global'},'format','Ten lines'));
  const base=engine.snapshot();
  base.projectTriggers=[{projectId:project.id,keywords:['example']}];
  const local=structuredClone(base), remote=new MemoryEngine(base);
  local.projectTriggers=[];
  const added=approve(remote,proposal({type:'global'},'language','French'));
  const merged=mergePortableState(base,local,remote.snapshot());
  assert.deepEqual(merged.projectTriggers,[]);
  assert.deepEqual(merged.memories.map(m=>m.id),[original,added]);
  local.memories=[];
  assert.throws(()=>mergePortableState(base,local,remote.snapshot()),/SYNC_CONFLICT/);
});
