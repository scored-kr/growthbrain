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

test('untyped continuation is never detached from the condition it qualifies',()=>{
  for(const text of ['예산: 50만원\n부가세 포함이고 월 단위야.', '한국어로 답변해줘. 영어 원문은 그대로 유지해줘.', 'Budget: $500. That includes tax each month.', 'Tone: friendly\nAvoid jokes about customers.']) {
    const result=classifyCapture(capture(text));
    assert.equal(result.length,1,text);assert.match(result[0].key,/^feedback\./);
    assert.equal(result[0].value,text);assert.equal(result[0].source.excerpt,text);
  }
  const qualifiers=['세금 포함','연간 한도야','최소 금액이야','프로모션은 제외','부가세 별도'];
  for(const amount of [0,1,50,99999]) for(const joiner of ['\n','. ','; ','\r\n']) for(const suffix of qualifiers) {
    const text=`예산: ${amount}만원${joiner}${suffix}`;
    for(const candidate of classifyCapture(capture(text))) assert.ok(candidate.value.includes(suffix),text);
  }
  for(const text of ['예산: 50만원\n세금은 포함할까?', '예산: 50만원\n> 세금 포함', '예산: 50만원\n```\n세금 별도\n```', '예산: 50만원\n'+'x'.repeat(4001)]) assert.deepEqual(classifyCapture(capture(text)),[],text);
});

test('a newsletter naming decision captured from chat is project-scoped and needs approval for every change', () => {
  const { engine, project, other } = fixture();
  engine.configureCapture({ site: 'chatgpt.com', projectId: project.id, enabled: true });
  const message = {
    site: 'chatgpt.com', projectId: project.id, role: 'user',
    url: 'https://chatgpt.com/c/synthetic-campaign',
    messageId: 'first-name', text: '이번 뉴스레터 이름은 라임우체통으로 하자'
  };
  const first = engine.capture(message);
  assert.equal(first.candidateIds.length, 1);
  const [pending] = engine.listMemories(project.id, 'candidate').memories;
  assert.equal(pending.id, first.candidateIds[0]);
  assert.equal(pending.key, 'newsletter.name');
  assert.equal(pending.kind, 'decision');
  assert.equal(pending.value, message.text);
  assert.deepEqual(pending.scope, { type: 'project', projectId: project.id });
  assert.deepEqual(engine.getContext({ projectId: project.id }).conditions, []);
  assert.deepEqual(engine.listMemories(other.id, 'candidate').memories, []);

  engine.review(pending.id, 'approve');
  const changedText = '뉴스레터 이름을 “귤 우체통”으로 정하자.';
  const change = engine.capture({ ...message, messageId: 'renamed', text: changedText });
  assert.equal(change.candidateIds.length, 1);
  assert.throws(() => engine.review(change.candidateIds[0], 'approve'), /EXPLICIT_SUPERSESSION_REQUIRED/);
  const campaignValues = () => engine.getContext({ projectId: project.id }).conditions.map(c => c.value);
  assert.deepEqual(campaignValues(), [message.text]);
  engine.review(change.candidateIds[0], 'approve', pending.id);
  assert.deepEqual(campaignValues(), [changedText]);
  assert.deepEqual(engine.getContext({ projectId: other.id }).conditions, []);
  assert.deepEqual(engine.getContext({}).conditions, []);
});

test('newsletter naming suggestions, quotes and one-off tasks stay out of memory', () => {
  const texts = [
    '이번 뉴스레터 이름은 라임우체통으로 할까?',
    '이번 뉴스레터 이름은 라임우체통 같은 걸로 추천해줘',
    '이번에만 뉴스레터 이름은 라임우체통으로 하자',
    '이번 뉴스레터 이름은 임시로 라임우체통으로 하자',
    '이번 뉴스레터 이름은 나중으로 하자',
    '뉴스레터 이름은 그대로 하자',
    '뉴스레터 이름은 “ ”으로 하자',
    '이번 뉴스레터 이름은 라임우체통으로 하자고 했어',
    '“이번 뉴스레터 이름은 라임우체통으로 하자”',
    '이번 뉴스레터 이름은 다음 회의에서 정하자',
    '이번 뉴스레터 이름은 라임우체통으로 검색하자'
  ];
  for (const text of texts) assert.deepEqual(classifyCapture(capture(text)), [], text);
  assert.deepEqual(classifyCapture(capture('이번 뉴스레터 이름은 라임우체통으로 하자', 'assistant')), []);
});
