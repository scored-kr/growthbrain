import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { classifyCapture } from '../dist/classifier.js';
import { fixture } from './helpers.mjs';

const corpus=JSON.parse(await readFile(new URL('./fixtures/extraction-quality.json',import.meta.url),'utf8'));
const capture=(text,role='user')=>({id:randomUUID(),projectId:randomUUID(),text,role,contentHash:createHash('sha256').update(text).digest('hex')});
test('explicit condition corpus preserves typed keys, values, scope and original excerpts',()=>{
  for(const item of corpus.positive) {
    const input=capture(item.text),found=classifyCapture(input);
    assert.deepEqual(found.map(m=>m.key),item.keys,item.text);
    const expected=item.values??item.text.split(/(?<=[.!?。;])\s+|\r?\n/u).filter(Boolean);
    assert.deepEqual(found.map(m=>m.value),expected,item.text);
    for(const m of found){assert.deepEqual(m.scope,{type:'project',projectId:input.projectId});assert.ok(input.text.includes(m.source.excerpt));assert.equal(m.source.reference,`capture:${input.id}`);assert.equal(m.supersedesId,undefined);}
  }
});
test('questions, quoted/code context, conditional and temporary requests do not create durable candidates',()=>{
  for(const text of [...corpus.negative,"'영어로 답변해주세요'",'What tone should I prefer','테스트를 실행해줘','Please run the tests.'])assert.deepEqual(classifyCapture(capture(text)),[],text);
  assert.deepEqual(classifyCapture(capture('예산: 월 50만원','assistant')),[]);
  for(const text of ['한국어로 답변해줘. 단 고객 메일은 영어로.','예산: 50만원\n다만 부가세는 제외.','Please answer in Korean. However, use English for customers.'])assert.deepEqual(classifyCapture(capture(text)),[],text);
});
test('limits do not truncate exceptions, repeated clauses deduplicate and changes stay explicit',()=>{
  assert.deepEqual(classifyCapture(capture('앞으로 '+ '한국어'.repeat(1400)+'로 답변하지 마')),[]);
  assert.deepEqual(classifyCapture(capture(Array.from({length:9},(_,i)=>`예산: ${i+1}만원`).join('\n'))),[]);
  const duplicate=classifyCapture(capture('말투: 차분하게\n말투: 차분하게'));assert.equal(duplicate.length,1);
  const conflicting=classifyCapture(capture('말투: 차분하게\n말투: 활기차게'));assert.equal(conflicting.length,2);
  const {engine,project}=fixture();engine.configureCapture({site:'chatgpt.com',projectId:project.id,enabled:true});
  const input={site:'chatgpt.com',projectId:project.id,url:'https://chatgpt.com/c/synthetic',messageId:'one',role:'user',text:'예산: 월 50만원 이하\n말투: 차분하게'};
  const first=engine.capture(input);assert.equal(first.candidateIds.length,2);assert.deepEqual(engine.getContext({projectId:project.id}).conditions,[]);
  engine.review(first.candidateIds[0],'approve');
  const next=engine.capture({...input,messageId:'two',text:'예산: 월 60만원 이하'});
  assert.throws(()=>engine.review(next.candidateIds[0],'approve'),/EXPLICIT_SUPERSESSION_REQUIRED/);
  engine.review(next.candidateIds[0],'approve',first.candidateIds[0]);
  assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'예산: 월 60만원 이하');
  const skipped=engine.capture({...input,messageId:'three',text:'이번에만 영어로 답변해줘'});
  assert.deepEqual(skipped.candidateIds,[]);assert.equal(engine.snapshot().captures.at(-1).text,'이번에만 영어로 답변해줘');
});
