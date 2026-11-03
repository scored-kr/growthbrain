import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID,randomBytes } from 'node:crypto';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { VaultSession } from '../dist/vault.js';
import { startBroker } from '../dist/broker.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real native frames collect and review only with explicit site consent; origin and methods are restricted',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gb-native-'));const id='a'.repeat(32);
  const vault=await VaultSession.open(directory,randomUUID(),randomBytes(24).toString('base64url'),true);
  const project=await vault.mutate(e=>e.addProject('Synthetic native project'));const broker=await startBroker(vault,directory);
  async function call(method,params,origin=`chrome-extension://${id}/`){
    const child=spawn(process.execPath,[resolve('dist/native-host.js'),origin],{env:{GROWTH_BRAIN_EXTENSION_ID:id,GROWTH_BRAIN_SOCKET:broker.path},stdio:['pipe','pipe','pipe']});
    const payload=Buffer.from(JSON.stringify({id:randomUUID(),method,params})),header=Buffer.alloc(4);header.writeUInt32LE(payload.length);
    let output=Buffer.alloc(0);child.stdout.on('data',c=>output=Buffer.concat([output,c]));
    child.stdin.on('error',()=>{});
    // Exercise split header/body boundaries as Chrome's stream may fragment frames.
    child.stdin.write(header.subarray(0,2));child.stdin.write(Buffer.concat([header.subarray(2),payload.subarray(0,5)]));child.stdin.end(payload.subarray(5));
    const code=await new Promise(r=>child.on('close',r));
    if(code!==0)return{code};assert.equal(output.length,output.readUInt32LE()+4);
    return JSON.parse(output.subarray(4).toString());
  }
  try {
    assert.equal((await call('list_projects',{})).result.projects[0].id,project.id);
    assert.equal((await call('list_projects',{},'chrome-extension://'+'b'.repeat(32)+'/')).code,1);
    assert.equal((await call('unlock',{password:'not-a-real-secret'})).error,'INVALID_REQUEST');
    const input={site:'chatgpt.com',projectId:project.id,url:'https://chatgpt.com/c/test',messageId:'1',role:'user',text:'한국어로 답변해주세요'};
    assert.equal((await call('capture',input)).error,'CAPTURE_NOT_CONSENTED');
    await call('configure_capture',{site:'chatgpt.com',projectId:project.id,enabled:true});
    const capture=(await call('capture',input)).result;
    assert.equal((await call('list_memories',{projectId:project.id})).result.memories[0].captureSource.url,input.url);
    await call('review_memory',{projectId:project.id,id:capture.candidateIds[0],decision:'approve'});
    assert.equal(vault.read(e=>e.getContext({projectId:project.id})).conditions[0].value,'한국어');
    const edited=(await call('capture',{...input,text:'영어로 답변해주세요'})).result;
    const corrected=(await call('correct_candidate',{projectId:project.id,id:edited.candidateIds[0],value:'English',reason:'Human checked the intended language'})).result;
    assert.equal(corrected.status,'candidate');edited.candidateIds=[corrected.id];
    const pending=(await call('list_memories',{projectId:project.id})).result.memories[0];
    assert.equal(pending.conflict.id,capture.candidateIds[0]);
    assert.equal((await call('review_memory',{projectId:project.id,id:edited.candidateIds[0],decision:'approve'})).error,'EXPLICIT_SUPERSESSION_REQUIRED');
    await call('review_memory',{projectId:project.id,id:edited.candidateIds[0],decision:'approve',supersedesId:capture.candidateIds[0]});
    assert.equal(vault.read(e=>e.getContext({projectId:project.id})).conditions[0].value,'English');
    // A new, separate MCP process reads the same approved result written via native messaging.
    const client=new Client({name:'native-to-mcp-protocol-check',version:'1.0.0'});
    try{
      await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('dist/mcp.js')],env:{GROWTH_BRAIN_SOCKET:broker.path},stderr:'pipe'}));
      const result=await client.callTool({name:'get_context',arguments:{projectId:project.id}});
      assert.ok(!result.isError);
      const context=JSON.parse(result.content[0].text);assert.equal(context.conditions[0].value,'English');
      assert.equal(context.conditions[0].supersedesId,capture.candidateIds[0]);
      const retired=(await call('retire_memory',{projectId:project.id,id:corrected.id,reason:'Language constraint no longer applies'})).result;
      assert.equal(retired.status,'retired');
      const after=await client.callTool({name:'get_context',arguments:{projectId:project.id}});
      assert.deepEqual(JSON.parse(after.content[0].text).conditions,[]);
      const forbidden=await client.callTool({name:'retire_memory',arguments:{projectId:project.id,id:corrected.id,reason:'AI cannot retire'}});
      assert.equal(forbidden.isError,true);
    }finally{await client.close()}
    await vault.close();assert.equal((await call('list_projects',{})).error,'VAULT_LOCKED');
  }finally{await broker.close();await vault.close();await rm(directory,{recursive:true,force:true});}
});
