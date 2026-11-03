import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MemoryEngine } from '../dist/engine.js';
import { fixture, proposal, approve } from './helpers.mjs';
export const corpus=JSON.parse(await readFile(new URL('./fixtures/retrieval-quality.json',import.meta.url),'utf8'));
export function qualityFixture(){
  const f=fixture(),{engine,project,other}=f,scope={type:'project',projectId:project.id};
  for(const [key,value] of [['language','한국어'],['tone','친근한 문체'],['format','Short paragraphs']])approve(engine,proposal({type:'global'},key,value));
  for(const [key,value] of [['tone','과장 없는 전문적인 문체'],['cta','무료 상담'],['budget','오백만원'],['deadline','11월 30일'],['audience','초기 창업자'],['brand','Aurora']])approve(engine,proposal(scope,key,value));
  const old=approve(engine,proposal(scope,'offer','옛날할인'));
  approve(engine,proposal(scope,'offer','새로운혜택',{supersedesId:old,reason:'obsolete_campaign 폐기',source:{kind:'user',reference:'synthetic:old',excerpt:'옛날할인 대신 새로운혜택'}}));
  approve(engine,proposal({type:'project',projectId:other.id},'secret','타사기밀'));
  engine.propose(proposal(scope,'pending','미승인제안'));
  const retired=approve(engine,proposal(scope,'retired','종료된사항'));engine.retireMemory(project.id,retired,'폐기');
  return f;
}
export function evaluate(){
  const {engine,project}=qualityFixture();let top1=0,recall5=0,mrr=0;const misses=[];
  for(const [query,key] of corpus.positive){
    const found=engine.search(project.id,query,5).matches,index=found.findIndex(m=>m.key===key);
    top1+=Number(index===0);recall5+=Number(index>=0);mrr+=index>=0?1/(index+1):0;
    if(index!==0)misses.push({query,expected:key,actual:found.map(m=>m.key)});
  }
  const falsePositives=corpus.negative.flatMap(query=>{const result=engine.search(project.id,query);return result.matches.length?[{query,keys:result.matches.map(m=>m.key)}]:[];});
  return {kind:corpus.description,positiveQueries:corpus.positive.length,top1,recallAt5:recall5,mrrAt5:mrr/corpus.positive.length,negativeQueries:corpus.negative.length,falsePositiveCount:falsePositives.length,misses,falsePositives};
}
export function measure(){
  const {engine,project}=qualityFixture(),state=engine.snapshot(),scope={type:'project',projectId:project.id};state.memories=[];
  for(let i=0;i<5000;i++)state.memories.push({...proposal(i%2?scope:{type:'global'},`condition_${i}`,`synthetic token${i} preference`),id:randomUUID(),status:'active',createdAt:new Date().toISOString(),reviewedAt:new Date().toISOString()});
  const large=new MemoryEngine(state),start=performance.now();large.search(project.id,'token4001');const firstQueryMs=performance.now()-start;
  for(let i=0;i<20;i++)large.search(project.id,`token${i*41}`);
  const rounds=[];
  for(let r=0;r<5;r++){
    const times=[];for(let i=0;i<100;i++){const at=performance.now();large.search(project.id,`token${i*41}`);times.push(performance.now()-at);}
    times.sort((a,b)=>a-b);rounds.push({medianMs:times[50],p95Ms:times[95]});
  }
  return {documents:5000,queriesPerRound:100,rounds,firstQueryMs,scope:'Synchronous engine queries, synthetic data, no IPC or disk writes'};
}
