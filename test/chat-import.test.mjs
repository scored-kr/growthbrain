import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {readChatGPTExport,selectChatGPTConversation,importBatches,readChatExport,selectChatConversation} from '../extension/chat-import.js';
import {chatExport} from './fixtures/chatgpt-export.mjs';
import {claudeExport} from './fixtures/claude-export.mjs';
import {fixture,proposal,approve} from './helpers.mjs';
import {MemoryEngine} from '../dist/engine.js';
import {VaultSession} from '../dist/vault.js';
import {derive,seal,decrypt} from '../dist/envelope.js';
import {startBroker} from '../dist/broker.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const selection=()=>selectChatGPTConversation(readChatGPTExport(JSON.stringify([chatExport()]))[0]);
const params=projectId=>{return importBatches(selection(),projectId)[0]};

test('Claude flat exports retain text blocks and provenance, require explicit unverified-branch consent and keep provider scopes separate',()=>{
 const chosen=selectChatConversation(readChatExport(JSON.stringify([claudeExport()]),'claude-export')[0]);
 assert.equal(chosen.branchMode,'unverified-flat');assert.equal(chosen.branchLeafId,null);assert.equal(chosen.messages.length,3);
 assert.equal(chosen.messages[0].text,'  한국어로 답변해주세요  ');assert.equal(chosen.messages[0].createdAt,'2024-01-02T03:04:05.123Z');
 assert.equal(chosen.unsupportedParts,3);
 for(const marker of ['PRIVATE_CLAUDE','PRIVATE_ATTACHMENT','FALLBACK'])assert.ok(!JSON.stringify(chosen).includes(marker));
 const {engine,project,other}=fixture(),input=importBatches(chosen,project.id)[0],before=engine.snapshot();
 assert.throws(()=>engine.importChat({...input,allowUnverifiedBranch:false}));assert.deepEqual(engine.snapshot(),before);
 const result=engine.importChat(input);assert.equal(result.imported,3);assert.equal(result.candidateIds.length,2);
 assert.equal(engine.snapshot().captures[0].url,`https://claude.ai/chat/${chosen.conversationId}`);
 assert.match(engine.snapshot().memories[0].reason,/UNVERIFIED/);assert.deepEqual(engine.getContext({projectId:project.id}).conditions,[]);
 const otherProvider=selectChatGPTConversation(readChatGPTExport(JSON.stringify([chatExport(chosen.conversationId)]))[0]);
 assert.equal(engine.importChat(importBatches(otherProvider,other.id)[0]).imported,4);
 assert.equal(new MemoryEngine(engine.snapshot()).snapshot().captures.length,7);
 assert.throws(()=>readChatExport(JSON.stringify([claudeExport()]),'chatgpt-export'));
 assert.throws(()=>readChatExport(JSON.stringify([chatExport()]),'claude-export'));
});

test('Claude current branches exclude alternatives and fail on missing, cyclic or partial branch metadata',()=>{
 const c=claudeExport();c.current_leaf_message_uuid='claude-u2';c.chat_messages.forEach((m,i)=>m.parent_message_uuid=i?c.chat_messages[i-1].uuid:null);
 c.chat_messages.push({...structuredClone(c.chat_messages[1]),uuid:'abandoned',parent_message_uuid:'claude-u1',content:[{type:'text',text:'ABANDONED_CLAUDE'}]});
 const parse=c=>selectChatConversation(readChatExport(JSON.stringify([c]),'claude-export')[0]);
 const selected=parse(c);assert.equal(selected.branchMode,'current');assert.equal(selected.excludedBranchNodes,1);assert.ok(!JSON.stringify(selected).includes('ABANDONED_CLAUDE'));
 for(const mutate of [c=>delete c.current_leaf_message_uuid,c=>c.current_leaf_message_uuid='missing',c=>c.chat_messages[0].parent_message_uuid='claude-u2',c=>delete c.chat_messages[0].parent_message_uuid,c=>c.chat_messages[0].truncated=true,c=>c.chat_messages[0].created_at='yesterday',c=>c.chat_messages[1].uuid='claude-u1']){const copy=structuredClone(c);mutate(copy);assert.throws(()=>parse(copy));}
 const noFallback=claudeExport();noFallback.chat_messages[1].content=[{type:'thinking',thinking:'PRIVATE_REASONING'}];
 assert.equal(parse(noFallback).messages.length,2);
});

test('ChatGPT export selects only current branch visible dialogue with exact text, role and original time',()=>{
 const entries=readChatGPTExport(JSON.stringify([chatExport(),chatExport('unselected')]));
 const selected=selectChatGPTConversation(entries[0]);
 assert.deepEqual(selected.messages.map(m=>m.id),['message-u1','message-a1','message-u2','message-a2']);
 assert.equal(selected.messages[0].text,'  한국어로 답변해주세요  ');
 assert.equal(selected.messages[0].createdAt,'2023-11-14T22:13:20.000Z');
 assert.equal(selected.messages[1].role,'assistant');
 assert.deepEqual(selected.skipped,{nonDialogue:1,hidden:1,nonText:1,empty:0});assert.equal(selected.excludedBranchNodes,1);
 for(const forbidden of ['ABANDONED_BRANCH','PRIVATE_REASONING','PRIVATE_TOOL_OUTPUT','private-attachment','unselected'])assert.ok(!JSON.stringify(selected).includes(forbidden));
});

test('unsupported, ambiguous and corrupt export paths fail without choosing a different conversation branch',()=>{
 for(const input of ['broken','{}','[]',JSON.stringify([chatExport(),chatExport()])])assert.throws(()=>readChatGPTExport(input));
 for(const mutate of [
  c=>delete c.current_node,c=>c.current_node='missing',c=>c.mapping.u1.parent='a2',c=>c.mapping.u1.parent='missing',
  c=>c.mapping.a1.id='wrong',c=>c.mapping.a1.message.id=c.mapping.u1.message.id,
  c=>c.mapping.u1.message.create_time='yesterday',c=>c.mapping.u1.message.content.parts=['x'.repeat(12001)],
  c=>c.mapping.u1.parent='__proto__',
 ]){const c=chatExport();mutate(c);assert.throws(()=>selectChatGPTConversation(readChatGPTExport(JSON.stringify([c]))[0]));}
 const c=chatExport();delete c.mapping.u1.message.create_time;
 assert.equal(selectChatGPTConversation(readChatGPTExport(JSON.stringify([c]))[0]).messages[0].createdAt,null);
});

test('import batches respect UTF-8 IPC limits and reject an unsendable message before any write',()=>{
 const selected=selection();selected.messages=Array.from({length:45},(_,i)=>({...selected.messages[0],id:`m-${i}`,text:'가'.repeat(12000)}));
 const batches=importBatches(selected,randomUUID());assert.equal(batches.flatMap(b=>b.messages).length,45);
 for(const params of batches)assert.ok(Buffer.byteLength(JSON.stringify({method:'import_chat',params})+'\n')<=60000);
 selected.messages[44].text='\u0000'.repeat(12000);assert.throws(()=>importBatches(selected,randomUUID()),/IMPORT_MESSAGE_TOO_LARGE/);
});

test('import creates project-only pending user proposals, preserves provenance and never revives a reviewed replay',()=>{
 const {engine,project,other}=fixture(),input=params(project.id),before=engine.snapshot();
 assert.throws(()=>engine.importChat({...input,confirmed:false}));assert.deepEqual(engine.snapshot(),before);
 const result=engine.importChat(input);assert.equal(result.imported,4);assert.equal(result.duplicates,0);assert.equal(result.candidateIds.length,2);
 assert.deepEqual(engine.getContext({projectId:project.id}).conditions,[]);
 const snapshot=engine.snapshot();assert.equal(snapshot.captures[0].text,input.messages[0].text);
 assert.equal(snapshot.captures[0].importSource.createdAt,input.messages[0].createdAt);
 assert.equal(snapshot.captureSettings.length,0); // one-off import never enables live collection
 assert.ok(snapshot.memories.every(m=>m.status==='candidate'&&m.scope.type==='project'&&m.scope.projectId===project.id));
 assert.ok(!JSON.stringify(snapshot.memories).includes('999억원'));
 const list=engine.listMemories(project.id,'candidate');assert.equal(list.memories[0].captureSource.importSource.title,input.title);
 const id=result.candidateIds[0];engine.review(id,'approve');engine.retireMemory(project.id,id,'Historical preference no longer valid');
 engine.review(result.candidateIds[1],'reject');
 assert.equal(engine.importChat(input).duplicates,4);assert.equal(engine.snapshot().memories.length,2);
 assert.deepEqual(engine.getContext({projectId:project.id}).conditions,[]);
 assert.throws(()=>engine.importChat({...input,projectId:other.id}),/IMPORT_PROJECT_MISMATCH/);
 // Imported revisions remain history; replaying an older version must not recreate a candidate.
 engine.importChat({...input,messages:[{...input.messages[0],text:'영어로 답변해주세요'}]});
 const count=engine.snapshot().memories.length;assert.equal(engine.importChat(input).duplicates,4);assert.equal(engine.snapshot().memories.length,count);
 const restored=new MemoryEngine(engine.snapshot());assert.deepEqual(restored.snapshot(),engine.snapshot());
 const corrupt=engine.snapshot();corrupt.captures[0].importSource.conversationId='forged';assert.throws(()=>new MemoryEngine(corrupt),/INVALID_IMPORT_SOURCE/);
 const legacy=engine.snapshot();legacy.version=5;assert.throws(()=>new MemoryEngine(legacy));
});

test('v5 migration preserves original ciphertext and imported provenance survives encrypted restore',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gb-import-v6-')),directory=join(root,'vault'),owner=randomUUID(),password=randomBytes(24).toString('base64url');
 const e=MemoryEngine.empty(owner),project=e.addProject('PRIVATE_IMPORT_PROJECT');
 approve(e,proposal({type:'global'},'format','previous condition',{applicability:{taskTypes:['campaign']}}));
 const state=e.snapshot();state.version=5;const salt=randomBytes(16),key=await derive(password,salt),envelope=seal({snapshot:()=>state},key,{version:1,ownerId:owner,salt:salt.toString('base64')});key.fill(0);
 await mkdir(directory,{mode:0o700});await writeFile(join(directory,'vault.json'),JSON.stringify(envelope),{mode:0o600});let vault,restored;
 try{
  vault=await VaultSession.open(directory,owner,password);
  const backups=(await readdir(directory)).filter(p=>p.startsWith('pre-state-v6-'));assert.equal(backups.length,1);
  assert.deepEqual(JSON.parse(await readFile(join(directory,backups[0]),'utf8')),envelope);
  await vault.mutate(e=>e.importChat(params(project.id)));await vault.exportBackup(join(root,'export.enc'));await vault.close();
  const encrypted=await readFile(join(directory,'vault.json'),'utf8');for(const text of ['PRIVATE_IMPORT_PROJECT','Synthetic general chat','한국어','importSource'])assert.ok(!encrypted.includes(text));
  const old=await decrypt(envelope,owner,password);assert.equal(old.sourceStateVersion,5);old.key.fill(0);
  restored=await VaultSession.restore(join(root,'export.enc'),join(root,'restored'),owner,password);
  assert.equal(restored.read(e=>e.snapshot().version),6);assert.equal(restored.read(e=>e.snapshot().captures[0].importSource.branchLeafId),'a2');
  assert.equal((await restored.mutate(e=>e.importChat(params(project.id)))).duplicates,4);
  assert.deepEqual(restored.getContext({projectId:project.id}).conditions,[]);
 }finally{await vault?.close();await restored?.close();await rm(root,{recursive:true,force:true});}
});

test('real native import requires confirmation and local approval before a separate MCP can retrieve it',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'gb-import-native-')),extension='a'.repeat(32),vault=await VaultSession.open(directory,randomUUID(),randomBytes(24).toString('base64url'),true),broker=await startBroker(vault,directory);
 const client=new Client({name:'import-mcp-check',version:'1'});
 const call=async(method,params)=>{
  const child=spawn(process.execPath,[resolve('dist/native-host.js'),`chrome-extension://${extension}/`],{env:{GROWTH_BRAIN_EXTENSION_ID:extension,GROWTH_BRAIN_SOCKET:broker.path},stdio:['pipe','pipe','pipe']});
  const body=Buffer.from(JSON.stringify({id:randomUUID(),method,params})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);
  let output=Buffer.alloc(0);child.stdout.on('data',c=>output=Buffer.concat([output,c]));child.stdin.end(Buffer.concat([header,body]));
  assert.equal(await new Promise(r=>child.on('close',r)),0);assert.equal(output.length,output.readUInt32LE()+4);return JSON.parse(output.subarray(4));
 };
 try{
  const p=(await call('create_project',{name:'Synthetic web chat'})).result,input=params(p.id);
  assert.equal((await call('import_chat',{...input,confirmed:false})).error,'INVALID_REQUEST');
  const imported=(await call('import_chat',input)).result;assert.equal(imported.imported,4);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.js')],env:{GROWTH_BRAIN_SOCKET:broker.path},stderr:'ignore'}));
  assert.equal((await client.callTool({name:'import_chat',arguments:input})).isError,true);
  const context=async()=>JSON.parse((await client.callTool({name:'get_context',arguments:{projectId:p.id}})).content[0].text);
  assert.deepEqual((await context()).conditions,[]);
  await call('review_memory',{projectId:p.id,id:imported.candidateIds[0],decision:'approve'});
  assert.equal((await context()).conditions[0].value,'한국어');
  const cp=(await call('create_project',{name:'Synthetic Claude web chat'})).result;
  const chosen=selectChatConversation(readChatExport(JSON.stringify([claudeExport()]),'claude-export')[0]),ci=importBatches(chosen,cp.id)[0];
  assert.equal((await call('import_chat',{...ci,allowUnverifiedBranch:false})).error,'INVALID_REQUEST');
  const cr=(await call('import_chat',ci)).result;assert.equal(cr.imported,3);
  await call('review_memory',{projectId:cp.id,id:cr.candidateIds[1],decision:'approve'});
  const cc=JSON.parse((await client.callTool({name:'get_context',arguments:{projectId:cp.id}})).content[0].text);
  assert.equal(cc.conditions.length,1);assert.equal(cc.conditions[0].key,'budget');assert.equal(cc.conditions[0].value,'예산: 50만원');
  await vault.close();assert.equal((await call('import_chat',input)).error,'VAULT_LOCKED');
 }finally{await client.close();await broker.close();await vault.close();await rm(directory,{recursive:true,force:true});}
});
