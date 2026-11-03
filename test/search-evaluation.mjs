// Legacy synthetic corpus retained for regression; broader coverage is in test:retrieval.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MemoryEngine } from '../dist/engine.js';
import { fixture, proposal, approve } from './helpers.mjs';

const {engine,project,other}=fixture(),scope={type:'project',projectId:project.id};
for(const [key,value] of [['language','한국어'],['tone','친근한 문체'],['format','Short paragraphs']])approve(engine,proposal({type:'global'},key,value));
for(const [key,value] of [['tone','과장 없는 전문적인 문체'],['cta','무료 상담'],['budget','오백만원'],['deadline','11월 30일'],['audience','초기 창업자'],['brand','Aurora']])approve(engine,proposal(scope,key,value));
const old=approve(engine,proposal(scope,'offer','옛날할인'));
approve(engine,proposal(scope,'offer','새로운혜택',{supersedesId:old,reason:'옛날할인 폐기',source:{kind:'user',reference:'synthetic:old',excerpt:'옛날할인 대신 새로운혜택'}}));
approve(engine,proposal({type:'project',projectId:other.id},'secret','타사기밀'));
engine.propose(proposal(scope,'pending','미승인제안'));
const retired=approve(engine,proposal(scope,'retired','종료된사항'));engine.retireMemory(project.id,retired,'폐기');
const cases=[
  ['한국어','language'],['언어','language'],['말투','tone'],['말투는','tone'],['전문적인','tone'],
  ['상담을','cta'],['무료 상담','cta'],['cta','cta'],['예산','budget'],['마감','deadline'],
  ['대상','audience'],['브랜드','brand'],['ＡＵＲＯＲＡ','brand'],['paragraph','format'],['새로운혜택','offer'],
  // These chapter-12 misses are now covered by limited topic cues.
  ['돈을 얼마나 써도 돼','budget'],['독자가 행동하게 만드는 문구','cta'],
];
const active=engine.getContext({projectId:project.id,maxCharacters:32000}).conditions;
let top1=0,recall5=0,baselineTop1=0,baselineRecall5=0;const misses=[];
for(const [query,key] of cases){
  const found=engine.search(project.id,query,5).matches;
  const baseline=active.filter(m=>`${m.key} ${m.value}`.toLowerCase().includes(query.toLowerCase())).slice(0,5);
  top1+=Number(found[0]?.key===key);recall5+=Number(found.some(m=>m.key===key));
  baselineTop1+=Number(baseline[0]?.key===key);baselineRecall5+=Number(baseline.some(m=>m.key===key));
  if(!found.some(m=>m.key===key))misses.push(query);
}
const negatives=['타사기밀','미승인제안','옛날할인','종료된사항','친근한'];
const falsePositives=negatives.filter(query=>engine.search(project.id,query).matches.length>0);
assert.deepEqual(falsePositives,[]);
// Regression floor for the stated lexical coverage, not a general accuracy claim.
assert.ok(recall5>=15);

const state=engine.snapshot();state.memories=[];
for(let i=0;i<5000;i++)state.memories.push({...proposal(i%2?scope:{type:'global'},`condition_${i}`,`synthetic token${i} preference`),id:randomUUID(),status:'active',createdAt:new Date().toISOString(),reviewedAt:new Date().toISOString()});
const large=new MemoryEngine(state),start=performance.now();large.search(project.id,'token4001');const firstQueryMs=performance.now()-start;
const times=[];for(let i=0;i<100;i++){const at=performance.now();const result=large.search(project.id,`token${i*41}`);assert.equal(result.matches.length,1);times.push(performance.now()-at);}
times.sort((a,b)=>a-b);
console.log(JSON.stringify({kind:'synthetic lexical evaluation; not real-user accuracy',positiveQueries:cases.length,index:{top1,recallAt5:recall5},literalBaseline:{top1:baselineTop1,recallAt5:baselineRecall5},knownMisses:misses,negativeQueries:negatives.length,falsePositives,performance:{documents:5000,sampledQueries:100,firstQueryIncludingIndexMs:firstQueryMs,warmMedianMs:times[50],warmP95Ms:times[95]},limitations:['No learned semantic embeddings','No real AI personalization evaluated','Timing is this machine and synthetic data only']},null,2));
