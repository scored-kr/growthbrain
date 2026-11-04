// Verify golden answers through actual MCP, not an LLM evaluation or automatic tool-choice claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { randomUUID,randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { VaultSession } from '../dist/vault.js';
import { startBroker } from '../dist/broker.js';
import { proposal,approve } from './helpers.mjs';

test('ten independent evaluation answers are grounded in read-only real MCP calls',async t=>{
  const pairs=[...(await readFile(new URL('./fixtures/mcp-evaluation.xml',import.meta.url),'utf8')).matchAll(/<qa_pair><question>(.*?)<\/question><answer>(.*?)<\/answer><\/qa_pair>/gs)];
  assert.equal(pairs.length,10);
  const directory=await mkdtemp(join(tmpdir(),'gb-evaluation-'));
  const vault=await VaultSession.open(directory,randomUUID(),randomBytes(32).toString('base64url'),true);
  await vault.mutate(e=>{
    const a=e.addProject('Synthetic Aurora'),b=e.addProject('Synthetic Boreal'),scope={type:'project',projectId:a.id};
    e.configureProjectTriggers(a.id,['오로라작업','공동캠페인']);e.configureProjectTriggers(b.id,['보레알작업','공동캠페인']);
    approve(e,proposal({type:'global'},'language','한국어'));approve(e,proposal({type:'global'},'tone','친근한 문체'));
    approve(e,proposal(scope,'tone','과장 없는 전문적인 문체'));approve(e,proposal(scope,'budget','오백만원'));
    approve(e,proposal({type:'project',projectId:b.id},'budget','타사예산'));
    const old=approve(e,proposal(scope,'offer','옛날할인'));
    approve(e,proposal(scope,'offer','새로운혜택',{supersedesId:old,source:{kind:'user',reference:'synthetic:decision:new',excerpt:'옛날할인 대신 새로운혜택'}}));
    e.propose(proposal(scope,'pending','미승인제안'));
    const retired=approve(e,proposal(scope,'retired','종료된사항'));e.retireMemory(a.id,retired,'종료');
  });
  const broker=await startBroker(vault,directory),client=new Client({name:'golden-answer-verification',version:'1.0.0'});
  t.after(async()=>{await client.close();await broker.close();await vault.close();await rm(directory,{recursive:true,force:true});});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.js')],env:{GROWTH_BRAIN_SOCKET:broker.path},stderr:'ignore'}));
  const invoke=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError);return result.structuredContent;};
  const before=await readFile(join(directory,'vault.json'));
  const plans=[['오로라작업','새로운혜택','offer'],['','언어','language'],['오로라작업','말투','tone'],['오로라작업','말투','tone',{tone:'짧게'}],['','예산','budget'],['공동캠페인','예산',null],['오로라작업','예산','budget'],['오로라작업','미승인제안','pending'],['오로라작업','종료된사항','retired'],['오로라작업','새로운혜택','offer']];
  for(let i=0;i<plans.length;i++) {
    const [query,search,key,requestConditions={}]=plans[i];
    const context=await invoke('get_context',{query,requestConditions});
    const found=await invoke('search_memory',{...(context.projectId?{projectId:context.projectId}:{}),query:search,requestConditions});
    const condition=context.conditions.find(c=>c.key===key),match=found.matches.find(m=>m.key===key);
    let answer;
    if(i===5){assert.equal(context.routing.reason,'project_selection_required');assert.deepEqual(found.searchedScopes,['global']);answer='프로젝트 선택 필요';}
    else if(i===3){assert.equal(match,undefined);answer=condition.value;}
    else if(!condition){assert.equal(match,undefined);answer='조회되지 않음';}
    else {assert.equal(condition.memoryId,match.id);answer=i===9?match.source.reference:match.value;}
    if(i===0)assert.deepEqual((await invoke('search_memory',{projectId:context.projectId,query:'옛날할인'})).matches,[]);
    assert.equal(answer,pairs[i][2],pairs[i][1]);
  }
  assert.deepEqual(await readFile(join(directory,'vault.json')),before);
});
