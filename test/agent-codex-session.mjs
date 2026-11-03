// Actual Codex hook dispatch attempt. Never bypasses hook trust; uses synthetic data only.
import { mkdtemp,mkdir,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { VaultSession } from '../dist/vault.js';
import { startBroker } from '../dist/broker.js';
const root=await mkdtemp(join(tmpdir(),'gb-codex-hooks-')),workspace=join(root,'work');await mkdir(workspace);
const vault=await VaultSession.open(join(root,'vault'),randomUUID(),randomBytes(32).toString('base64url'),true);
const project=await vault.mutate(e=>e.addProject('Synthetic hooks only'));
await vault.mutate(e=>e.configureAgentCapture({client:'codex',workspace,projectId:project.id,enabled:true}));
const broker=await startBroker(vault,join(root,'vault'));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const command=[process.execPath,resolve('dist/agent-hook-cli.js'),'codex','--socket',broker.path].map(quote).join(' ');
const hook=`[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=8}]}]`;
let fixtureServer;
try {
 const args=['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','-C',workspace];
 for(const event of ['SessionStart','UserPromptSubmit','Stop'])args.push('-c',`hooks.${event}=${hook}`);
 if(process.env.GROWTH_BRAIN_FIXTURE_MODEL==='1') {
  fixtureServer=createServer(async(req,res)=>{
   for await(const _ of req){} // Consume only this synthetic session's request; never persist it.
   const message={id:'fixture-message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'SYNTHETIC_HOOK_REPLY',annotations:[]}]};
   const events=[{type:'response.created',response:{id:'fixture-response',status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
    {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'SYNTHETIC_HOOK_REPLY'},
    {type:'response.output_item.done',output_index:0,item:message},
    {type:'response.completed',response:{id:'fixture-response',status:'completed',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
   res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise(r=>fixtureServer.listen(0,'127.0.0.1',r));
  args.push('-c','model_provider="growthbrain_fixture"','-c','model="synthetic-fixture"','-c',`model_providers.growthbrain_fixture={name="Growth Brain synthetic test",base_url="http://127.0.0.1:${fixtureServer.address().port}",wire_api="responses",requires_openai_auth=false}`);
 }
 args.push('Synthetic hook check: reply with a short greeting.');
 const env={...process.env};delete env.IGN8T_API_KEY;
 const child=spawn('codex',args,{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
 const code=await new Promise((res,rej)=>{child.once('error',rej);child.once('close',res)});clearTimeout(timer);
 const captures=vault.read(e=>e.snapshot().agentCaptures),all=stdout+'\n'+stderr;
 const summary={actualCodexRuntime:true,syntheticData:true,syntheticModel:!!fixtureServer,trustBypassed:false,code,userCaptures:captures.filter(c=>c.role==='user').length,assistantCaptures:captures.filter(c=>c.role==='assistant').length,authenticationBlocked:/401|could not be refreshed/.test(all),hookTrust:captures.length?'executed':'not established; inspect hooks/list or /hooks',success:code===0&&captures.some(c=>c.role==='user')&&captures.some(c=>c.role==='assistant')};
 if(process.env.GROWTH_BRAIN_TEST_OUTPUT){await mkdir(process.env.GROWTH_BRAIN_TEST_OUTPUT,{recursive:true,mode:0o700});await writeFile(join(process.env.GROWTH_BRAIN_TEST_OUTPUT,'hook-runtime-summary.json'),JSON.stringify(summary,null,2),{mode:0o600});}
 console.log(JSON.stringify(summary));if(!summary.success)process.exitCode=1;
}finally{fixtureServer?.closeAllConnections();await new Promise(r=>fixtureServer?fixtureServer.close(r):r());await broker.close();await vault.close();await rm(root,{recursive:true,force:true});}
