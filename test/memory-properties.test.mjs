import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, proposal } from './helpers.mjs';
import { MemoryEngine } from '../dist/engine.js';

// Seeded command generation against a tiny user-intent oracle, independent of index internals.
function generator(seed) { let state=seed; return n => { state=(Math.imul(state,1664525)+1013904223)>>>0; return state%n; }; }
test('1920 generated review commands preserve scope, precedence and irreversible history exclusion',()=>{
  const keys=['language','tone','budget','cta'];
  for(let seed=1;seed<=32;seed++) {
    const {engine:initial,project,other}=fixture();let engine=initial;
    const random=generator(seed),scopes=[{type:'global'},{type:'project',projectId:project.id},{type:'project',projectId:other.id}];
    // Oracle contains only currently intended approved values, not implementation snapshots/status logic.
    const intended=[new Map(),new Map(),new Map()];
    for(let step=0;step<60;step++) {
      const which=random(3),key=keys[random(keys.length)],action=random(5),current=intended[which].get(key);
      if(action===0&&current) {
        engine.retireMemory(which===2?other.id:project.id,current.id,'Synthetic retirement');intended[which].delete(key);
      } else {
        const input=proposal(scopes[which],key,`sentinel seed ${seed} step ${step}`,current?{supersedesId:current.id}:{});
        const candidate=engine.propose(input);
        if(action>=2) { engine.review(candidate.id,'approve');intended[which].set(key,{id:candidate.id,value:input.value}); }
        else if(action===1)engine.review(candidate.id,'reject');
        // action=0 with no current deliberately leaves a pending candidate, invisible to the oracle.
      }
      if(step%11===0)engine=new MemoryEngine(engine.snapshot());
      const overrideKey=keys[random(keys.length)],overrides=step%2?{[overrideKey]:'ephemeral current instruction'}:{};
      for(const selection of [0,1,2]) {
        const projectId=selection===0?undefined:scopes[selection].projectId;
        const expected=new Map(intended[0]);if(selection)for(const [k,v] of intended[selection])expected.set(k,v);
        for(const k of Object.keys(overrides))expected.delete(k);
        const context=engine.getContext({projectId,requestConditions:overrides,maxCharacters:32000});
        const search=engine.search(projectId,'sentinel',50,overrides);
        const ids=[...expected.values()].map(v=>v.id).sort();
        const label=`seed=${seed} step=${step} selection=${selection}`;
        assert.deepEqual(context.conditions.filter(c=>c.memoryId).map(c=>c.memoryId).sort(),ids,label);
        assert.deepEqual(search.matches.map(m=>m.id).sort(),ids,label);
        for(const c of context.conditions)assert.equal(c.value,c.origin==='current_request'?overrides[c.key]:expected.get(c.key).value,label);
        assert.deepEqual(context.searchedScopes,selection?['global',`project:${projectId}`]:['global'],label);
      }
      if(step%13===0) {
        const before=engine.snapshot(),fork=engine.fork();
        const pending=fork.propose(proposal(scopes[1],'isolated_fork','sentinel fork only'));fork.review(pending.id,'approve');
        assert.equal(fork.search(project.id,'sentinel fork only').matches.some(m=>m.id===pending.id),true);
        assert.deepEqual(engine.snapshot(),before);assert.ok(!engine.search(project.id,'sentinel fork only').matches.some(m=>m.id===pending.id));
      }
    }
  }
});
