import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fixture } from './helpers.mjs';
import { MemoryEngine } from '../dist/engine.js';
import { VaultSession } from '../dist/vault.js';
import { startBroker, callBroker } from '../dist/broker.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const bind=(engine,project,extra={})=>engine.configureAgentCapture({client:'codex',workspace:'/synthetic/work',projectId:project.id,enabled:true,...extra});
const input=(binding,extra={})=>({client:binding.client,workspace:binding.workspace,bindingId:binding.id,sessionId:'session-a',turnId:'turn-a',role:'user',text:'한국어로 답변해주세요',...extra});
test('agent capture requires explicit workspace consent and separates clients, projects and consent generations',()=>{
  const {engine,project,other}=fixture(),binding=bind(engine,project);
  assert.throws(()=>engine.captureAgent(input(binding,{workspace:'/other'})),/NOT_CONSENTED/);
  assert.throws(()=>engine.captureAgent(input(binding,{client:'claude-code'})),/NOT_CONSENTED/);
  const first=engine.captureAgent(input(binding));assert.equal(first.candidateIds.length,1);
  assert.equal(engine.captureAgent(input(binding)).duplicate,true);
  const reply=engine.captureAgent(input(binding,{role:'assistant',text:'한국어로 답변해주세요'}));assert.deepEqual(reply.candidateIds,[]);
  const edited=engine.captureAgent(input(binding,{text:'영어로 답변해주세요'}));
  assert.equal(engine.snapshot().agentCaptures.at(-1).previousId,first.id);
  assert.equal(edited.duplicate,false);assert.deepEqual(engine.getContext({projectId:project.id}).conditions,[]);
  bind(engine,project,{enabled:false});assert.throws(()=>engine.captureAgent(input(binding)),/NOT_CONSENTED/);
  const changed=bind(engine,other);
  assert.throws(()=>engine.captureAgent(input(binding,{turnId:'late'})),/STALE_AGENT_CONSENT/);
  assert.throws(()=>engine.captureAgent(input(changed,{role:'assistant',text:'late old response'})),/SESSION_SCOPE_MISMATCH/);
  assert.throws(()=>engine.captureAgent(input(changed,{turnId:'new-turn'})),/SESSION_SCOPE_MISMATCH/);
  engine.captureAgent(input(changed,{sessionId:'new-session'}));
  assert.equal(new MemoryEngine(engine.snapshot()).snapshot().version,4);
});

test('paused and resumed turns cannot attach a delayed answer without a captured prompt in the new consent',()=>{
  const {engine,project}=fixture(),binding=bind(engine,project);
  engine.captureAgent(input(binding));bind(engine,project,{enabled:false});const next=bind(engine,project);
  assert.throws(()=>engine.captureAgent(input(next,{role:'assistant',text:'late response'})),/TURN_NOT_CAPTURED/);
  engine.captureAgent(input(next,{turnId:'new-turn'}));
  engine.captureAgent(input(next,{turnId:'new-turn',role:'assistant',text:'new response'}));
  const state=engine.snapshot();state.agentCaptures.at(-1).projectId=randomUUID();
  assert.throws(()=>new MemoryEngine(state),/INVALID_AGENT_CAPTURE/);
});

async function runHook(client,event,socket){
  const child=spawn(process.execPath,['dist/agent-hook-cli.js',client,'--socket',socket],{stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.stdin.end(JSON.stringify(event));const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res)});
  assert.equal(code,0);assert.equal(stderr,'');return {output:JSON.parse(stdout),stdout};
}
test('Codex and Claude hook subprocesses capture via real IPC, encrypt raw text, keep candidates pending and reach a fresh MCP',async t=>{
  const root=await mkdtemp(join(tmpdir(),'gb-agent-'));await mkdir(join(root,'work'));
  const directory=join(root,'vault'),owner=randomUUID(),password=randomBytes(24).toString('base64url');
  let vault=await VaultSession.open(directory,owner,password,true);const project=await vault.mutate(e=>e.addProject('PRIVATE_AGENT_PROJECT'));
  const broker=await startBroker(vault,directory);
  const client=new Client({name:'agent-capture-test',version:'1'});
  t.after(async()=>{await client.close().catch(()=>{});await broker.close();await vault.close();await rm(root,{recursive:true,force:true});});
  const unbound=await runHook('codex',{cwd:join(root,'work'),session_id:randomUUID(),turn_id:randomUUID(),hook_event_name:'UserPromptSubmit',prompt:'UNCONSENTED_TEXT'},broker.path);
  assert.match(unbound.output.hookSpecificOutput.additionalContext,/common preferences first/);
  assert.match(unbound.output.hookSpecificOutput.additionalContext,/Capture is disabled/);
  assert.equal(vault.read(e=>e.snapshot().agentCaptures.length),0);
  for(const agent of ['codex','claude-code']) {
    await vault.mutate(e=>e.configureAgentCapture({client:agent,workspace:join(root,'work'),projectId:project.id,enabled:true}));
    const event={cwd:join(root,'work'),session_id:randomUUID(),...(agent==='codex'?{turn_id:randomUUID()}:{prompt_id:randomUUID()}),transcript_path:'/must/not/be/read/auth.json'};
    const start=await runHook(agent,{...event,hook_event_name:'SessionStart'},broker.path);
    assert.ok(start.output.hookSpecificOutput.additionalContext.includes(project.id));
    const prompt={...event,hook_event_name:'UserPromptSubmit',prompt:'PRIVATE_AGENT_TEXT 대신 한국어로 답변해주세요'};
    const received=await runHook(agent,prompt,broker.path);await runHook(agent,prompt,broker.path);
    assert.ok(!received.stdout.includes('PRIVATE_AGENT_TEXT'));
    await runHook(agent,{...event,hook_event_name:'Stop',last_assistant_message:'PRIVATE_AGENT_ANSWER'},broker.path);
    await runHook(agent,{...event,hook_event_name:'Stop',last_assistant_message:'PRIVATE_AGENT_ANSWER'},broker.path);
  }
  assert.equal(vault.read(e=>e.snapshot().agentCaptures.length),4);
  assert.equal(vault.read(e=>e.snapshot().memories.length),2);
  const pending=vault.read(e=>e.snapshot().memories[0]);assert.equal(pending.status,'candidate');
  const toolsTransport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.js')],env:{GROWTH_BRAIN_SOCKET:broker.path},stderr:'ignore'});
  await client.connect(toolsTransport);
  const context=async()=>JSON.parse((await client.callTool({name:'get_context',arguments:{projectId:project.id}})).content[0].text);
  assert.deepEqual((await context()).conditions,[]);
  await vault.mutate(e=>e.review(pending.id,'approve'));
  assert.equal((await context()).conditions.length,1);
  await assert.rejects(callBroker(broker.path,'configure_agent_capture',{}),/INVALID_REQUEST/);
  const disk=await readFile(join(directory,'vault.json'),'utf8');
  for(const value of ['PRIVATE_AGENT_TEXT','PRIVATE_AGENT_ANSWER','PRIVATE_AGENT_PROJECT',join(root,'work')])assert.ok(!disk.includes(value));
  await vault.close();
  const locked=await runHook('codex',{cwd:join(root,'work'),session_id:randomUUID(),turn_id:randomUUID(),hook_event_name:'UserPromptSubmit',prompt:'DO_NOT_LOG_ME'},broker.path);
  assert.match(locked.output.systemMessage,/VAULT_LOCKED/);assert.ok(!locked.stdout.includes('DO_NOT_LOG_ME'));
  vault=await VaultSession.open(directory,owner,password);assert.equal(vault.read(e=>e.snapshot().agentCaptures.length),4);
});
