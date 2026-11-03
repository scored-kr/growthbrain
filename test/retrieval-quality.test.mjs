import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate,qualityFixture } from './retrieval-quality.mjs';
import { approve,proposal } from './helpers.mjs';

test('expanded retrieval corpus improves topic recall while retaining negative controls and documented misses',()=>{
  const report=evaluate();assert.equal(report.positiveQueries,45);assert.ok(report.top1>=43);assert.ok(report.recallAt5>=43);
  assert.equal(report.falsePositiveCount,0);
  assert.ok(report.misses.every(m=>m.actual.length===0),'unsupported metaphors must not match on a lone Korean syllable');
});
test('topic postings apply current-request, project and review-state filtering before ranking',()=>{
  const {engine,project,other}=qualityFixture(),scope={type:'project',projectId:project.id};
  const query='얼마까지 쓸 수 있지';
  const original=engine.search(project.id,query).matches[0];assert.equal(original.key,'budget');
  assert.deepEqual(original.matchedTopics,['budget']);assert.deepEqual(original.matchedTerms,[]);
  approve(engine,proposal({type:'global'},'budget','COMMON_BUDGET'));
  approve(engine,proposal({type:'project',projectId:other.id},'budget','FOREIGN_BUDGET'));
  const pending=engine.propose(proposal(scope,'budget','PENDING_BUDGET',{supersedesId:original.id}));
  const rejected=engine.propose(proposal(scope,'budget','REJECTED_BUDGET',{supersedesId:original.id}));engine.review(rejected.id,'reject');
  assert.deepEqual(engine.search(project.id,query).matches.map(m=>m.id),[original.id]);
  assert.deepEqual(engine.search(project.id,query,20,{budget:'SESSION_ONLY'}).matches,[]);
  assert.equal(engine.search(undefined,query).matches[0].value,'COMMON_BUDGET');
  engine.review(pending.id,'approve');assert.equal(engine.search(project.id,query).matches[0].value,'PENDING_BUDGET');
  engine.retireMemory(project.id,pending.id,'종료');assert.equal(engine.search(project.id,query).matches[0].value,'COMMON_BUDGET');
  // A topic phrase never selects a project; only explicit user routing can do that.
  engine.configureProjectTriggers(project.id,['금액질문']);engine.configureProjectTriggers(other.id,['금액질문']);
  const ambiguous=engine.search(undefined,'금액질문 '+query);
  assert.equal(ambiguous.routing.reason,'project_selection_required');assert.deepEqual(ambiguous.searchedScopes,['global']);
  assert.deepEqual(ambiguous.matches.map(m=>m.value),['COMMON_BUDGET']);
});
test('topic names are not inferred from provenance or rewritten into stored generic feedback',()=>{
  const {engine,project}=qualityFixture(),scope={type:'project',projectId:project.id};
  const budget=engine.search(project.id,'예산').matches[0];engine.retireMemory(project.id,budget.id,'종료');
  approve(engine,proposal(scope,'feedback.sample','cost ceiling',{source:{kind:'user',reference:'synthetic:budget',excerpt:'budget'},reason:'budget'}));
  assert.deepEqual(engine.search(project.id,'돈을 얼마나 써도 돼').matches,[]);
  assert.equal(engine.search(project.id,'cost ceiling').matches[0].key,'feedback.sample');
  const before=engine.snapshot();engine.search(project.id,'spending ceiling');assert.deepEqual(engine.snapshot(),before);
});
