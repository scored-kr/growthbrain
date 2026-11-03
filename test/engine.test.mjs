import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MemoryEngine } from '../dist/engine.js';

test('a new project sees approved common preferences, never an AI candidate', () => {
  const engine = MemoryEngine.empty(randomUUID());
  const project = engine.addProject('콘텐츠 캠페인');
  const candidate = engine.propose({scope:{type:'global'},kind:'preference',key:'language',value:'한국어',source:{kind:'user',reference:'synthetic:feedback',excerpt:'한국어로 작성해줘'},reason:'명시적 언어 선호'});
  assert.equal(engine.getContext({projectId:project.id}).conditions.length,0);
  engine.review(candidate.id,'approve');
  assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'한국어');
});
