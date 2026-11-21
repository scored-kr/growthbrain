import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { callBroker } from '../dist/broker.js';
import { privateDirectory } from '../dist/secure-files.js';
import { accountServer } from './support/synthetic-supabase.mjs';

const secret=()=>randomBytes(32).toString('base64url');
const callbacks={
  chatgpt:'https://chatgpt.com/connector_platform_oauth_redirect',
  claude:'https://claude.ai/api/mcp/auth_callback',
};

function device(profile, backend, tls) {
  const child=fork(new URL('./support/sync-acceptance-device.mjs',import.meta.url),[profile,backend,tls],{
    stdio:['ignore','ignore','inherit','ipc'],execArgv:[],
  });
  const exited=once(child,'exit');
  const pending=new Map();
  let id=0,port;
  child.on('message', message => {
    if (message.port) port=message.port;
    if (message.response) pending.get(message.response.id)?.resolve(message.response);
  });
  child.once('exit', () => {
    for (const entry of pending.values()) entry.reject(Error('Device exited during a request'));
  });
  async function send(op,params={}) {
    const requestId=++id;
    const response=Promise.withResolvers();
    pending.set(requestId,response);
    const timer=setTimeout(()=>response.reject(Error('Device request timed out: '+op)),process.platform==='win32'?60000:30000);
    try {
      child.send({id:requestId,op,...params});
      return await response.promise;
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  }
  return {
    send,get port(){return port},
    async run(op,params={}){const reply=await send(op,params);assert.ok(reply.ok,op+' failed: '+reply.error);return reply.result},
    async close(){if(child.exitCode!==null)return;child.send({end:true});const [code]=await exited;assert.equal(code,0)},
    async stop(){if(child.exitCode===null && child.signalCode===null){child.kill();await exited}},
  };
}

function loopbackHttps(port,ca) {
  return (path,init={})=>new Promise((resolve,reject)=>{
    const url=new URL(path,'https://localhost');
    if(url.origin!=='https://localhost')return reject(Error('Unexpected synthetic device endpoint'));
    const req=request({protocol:'https:',hostname:'127.0.0.1',port,path:url.pathname+url.search,servername:'localhost',
      ca,method:init.method??'GET',headers:{...Object.fromEntries(new Headers(init.headers)),host:'localhost'}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()});
      });
    });
    req.on('error',reject);
    req.end(init.body);
  });
}

async function connectWeb(pc,provider,projectId,ca) {
  const http=loopbackHttps(pc.port,ca);
  async function post(path,data,form=false) {
    return http(path,{method:'POST',headers:{'content-type':form?'application/x-www-form-urlencoded':'application/json'},
      body:form?new URLSearchParams(data).toString():JSON.stringify(data)});
  }
  const callback=callbacks[provider];
  const registration=await post('/register',{client_name:'Synthetic '+provider,redirect_uris:[callback],
    token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
  assert.equal(registration.status,201);
  const {client_id}=JSON.parse(registration.text);
  const verifier=secret(),resource='https://localhost/mcp';
  const query=new URLSearchParams({response_type:'code',client_id,redirect_uri:callback,scope:'memory:read',resource,
    state:'synthetic-state',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  const redirect=await http('/authorize?'+query);
  assert.equal(redirect.status,303);
  const browser={headers:{cookie:redirect.headers['set-cookie'][0].split(';')[0]}};
  const pending=await http(redirect.headers.location,browser);
  assert.equal(pending.status,200);
  const requestId=new URL(redirect.headers.location,resource).searchParams.get('request');
  await pc.run('approve',{requestId,projectId});
  const approved=await http(redirect.headers.location,browser);
  assert.equal(approved.status,303);
  const completed=new URL(approved.headers.location);
  assert.equal(completed.origin+completed.pathname,callback);
  const exchange=await post('/token',{grant_type:'authorization_code',code:completed.searchParams.get('code'),client_id,
    code_verifier:verifier,redirect_uri:callback,resource},true);
  assert.equal(exchange.status,200);
  const bearer=JSON.parse(exchange.text).access_token;
  const mcp=new Client({name:'fixture-'+provider,version:'1'});
  const fetch=async(url,init)=>{
    const reply=await http(String(url),init);
    return new Response([202,204].includes(reply.status)?null:reply.text,{status:reply.status,headers:reply.headers});
  };
  await mcp.connect(new StreamableHTTPClientTransport(new URL(resource),{fetch,requestInit:{headers:{Authorization:'Bearer '+bearer}}}));
  return {mcp, bearer};
}

async function startDeviceWeb(pc) {
  await pc.run('startWeb');
  for (let attempt=0;attempt<100;attempt++) {
    if (pc.port && (await pc.run('status')).web.state==='ready') return;
    await delay(20);
  }
  assert.fail('Device HTTPS MCP listener did not become ready');
}

test('fresh device serves approved latest memories to both web MCP clients after source exits',
  {timeout:process.platform==='win32'?240000:120000},async t=>{
  // Windows vaults require a private NTFS directory beneath the token's user profile.
  const root=join(process.platform==='win32'?homedir():tmpdir(),'gb-pcs-'+randomUUID());
  await privateDirectory(root,true);
  const service=await accountServer();
  const pcs=[],clients=[];
  t.after(async()=>{
    for(const client of clients)await client.close().catch(()=>{});
    for(const pc of pcs)await pc.stop();
    try{await service.close()}finally{await rm(root,{recursive:true,force:true})}
  });
  const a=device(join(root,'pc-a','vault'),service.origin,root);
  pcs.push(a);
  const primary={email:'alpha@example.test',password:'Aa7!'+secret()},other={email:'beta@example.test',password:'Aa7!'+secret()};
  async function enrol(pc,account) {
    await pc.run('accountSignup',account);
    await pc.run('accountVerify',{email:account.email,code:service.emailCode});
    return pc.run('accountLogin',account);
  }
  const language='한국어로 답변', channel='뉴스레터 사용', stale='인쇄 카탈로그', separate='별도 프로젝트 전용 결제 채널', unapproved='미승인 라디오 광고';
  const first=await enrol(a,primary);
  assert.equal(first.unlocked,true);
  await a.run('addPreference',{projectId:null,key:'language',value:language});
  const mainProject=(await a.run('addProject',{name:'여름 합성 캠페인'})).projects[0];
  const sideProject=(await a.run('addProject',{name:'별도 합성 프로젝트'})).projects.find(p=>p.id!==mainProject.id);
  await a.run('addPreference',{projectId:sideProject.id,key:'channel',value:separate});
  await a.run('addPreference',{projectId:mainProject.id,key:'channel',value:stale});
  const next={projectId:mainProject.id,key:'channel',value:channel};
  const existing=await a.send('addPreference',next);
  assert.equal(existing.error,'EXPLICIT_SUPERSESSION_REQUIRED');
  const saved=await a.run('addPreference',{...next,supersedesId:existing.previous.id});
  assert.equal(saved.account.sync,'synced');
  const candidate=await callBroker(join(root,'pc-a','active','memory.sock'),'propose_memory',{
    scope:{type:'project',projectId:mainProject.id},kind:'decision',key:'channel',value:unapproved,
    source:{kind:'ai',reference:'fixture:pending',excerpt:'합성 검토 원문'},reason:'사용자가 검토할 합성 제안',
  });
  assert.equal(candidate.status,'candidate');
  assert.equal((await a.run('accountSync')).account.sync,'synced');
  await a.close(); // A's controller, broker, data key and all sockets are gone before B starts.
  await rm(join(root,'pc-a'),{recursive:true});
  t.diagnostic('Synthetic PC A exited and its local profile was removed before PC B signed in.');
  const stored=JSON.stringify(await service.inspect());
  assert.ok(stored.length>100,'Expected a remote snapshot');
  for(const marker of [language,channel,stale,separate,unapproved,mainProject.name,sideProject.name,primary.password]){
    assert.ok(!stored.includes(marker),'Plaintext reached the remote snapshot');
  }

  // Only a temporary localhost certificate stands in for the remote route. MCP, OAuth, scoped
  // consent and results use the actual web server. Neither client contacts a live AI service.
  const cert=join(root,'cert.pem'),key=join(root,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  const ca=await readFile(cert);
  const b=device(join(root,'pc-b','vault'),service.origin,root);pcs.push(b);
  assert.equal((await b.send('accountLogin',{...primary,password:'Aa7!'+secret()})).ok,false);
  const restored=await b.run('accountLogin',primary);
  assert.equal(restored.account.sync,'synced');
  assert.deepEqual(new Set(restored.projects.map(p=>p.id)),new Set([mainProject.id,sideProject.id]));
  const restoredReview=await callBroker(join(root,'pc-b','active','memory.sock'),'list_memories',{projectId:mainProject.id,status:'all'});
  assert.ok(restoredReview.memories.some(m=>m.id===candidate.id && m.value===unapproved && m.status==='candidate'));
  assert.ok(restoredReview.memories.some(m=>m.id===existing.previous.id && m.value===stale && m.status==='superseded'));
  await startDeviceWeb(b);
  let previousToken;
  for(const provider of Object.keys(callbacks)) {
    const {mcp,bearer}=await connectWeb(b,provider,mainProject.id,ca);
    previousToken=bearer;
    clients.push(mcp);
    const context=await mcp.callTool({name:'get_context',arguments:{query:'지난번 정한 조건대로 다음 작업을 진행해줘'}});
    assert.notEqual(context.isError,true);
    const recalled=JSON.parse(context.content[0].text);
    assert.equal(recalled.projectId,mainProject.id,'OAuth grant must select the project for this unqualified request');
    assert.deepEqual(recalled.conditions.map(c=>[c.origin,c.value]).sort(),[['global',language],['project',channel]]);
    const wire=JSON.stringify(context);
    for(const marker of [stale,separate,sideProject.name,unapproved,candidate.id,existing.previous.id,'fixture:pending','desktop:explicit-entry']) {
      assert.ok(!wire.includes(marker), 'Inactive memory, source or approval history escaped the read boundary');
    }
    for(const localField of ['excerpt','reference','supersedesId','reason']) {
      assert.ok(!JSON.stringify(recalled.conditions).includes(JSON.stringify(localField)+':'),
        'Unexpected local review field on a returned condition: '+localField);
    }
    const current=(await b.run('status')).web;
    const connection=current.connections.find(c=>c.provider===provider);
    assert.ok(connection?.connected, 'Expected an authenticated provider connection');
    assert.deepEqual(current.audit.filter(e=>e.connectionId===connection.id).map(e=>[e.method,e.success]),[['get_context',true]]);
    assert.equal((await mcp.callTool({name:'get_context',arguments:{projectId:sideProject.id}})).isError,true);
    t.diagnostic(`${provider}: simulated callback; authenticated HTTPS MCP get_context without project ID returned ${language} / ${channel}; other project, superseded and pending values excluded.`);
  }
  await b.run('accountLogout');
  const isolated=await enrol(b,other);
  assert.deepEqual(isolated.projects,[]);
  const betaLanguage='English-only synthetic account';
  await b.run('addPreference',{projectId:null,key:'language',value:betaLanguage});
  await startDeviceWeb(b);
  const refused=await loopbackHttps(b.port,ca)('/mcp',{
    method:'POST',headers:{Authorization:'Bearer '+previousToken,'content-type':'application/json'},body:'{}',
  });
  assert.equal(refused.status,401,'Alpha OAuth token must be rejected on the same device after switching accounts');
  const betaClient=await connectWeb(b,'claude',null,ca);
  clients.push(betaClient.mcp);
  const betaReply=await betaClient.mcp.callTool({name:'get_context',arguments:{}});
  assert.notEqual(betaReply.isError,true);
  assert.deepEqual(JSON.parse(betaReply.content[0].text).conditions.map(c=>c.value),[betaLanguage]);
  assert.equal((await betaClient.mcp.callTool({name:'get_context',arguments:{projectId:mainProject.id}})).isError,true);
  await b.run('accountLogout');
  const storedAccounts=await service.inspect();
  assert.equal(storedAccounts.length,2);
  assert.equal(new Set(storedAccounts.map(row=>row.owner_id)).size,2);
  assert.ok(!JSON.stringify(storedAccounts).includes(betaLanguage));
  const back=await b.run('accountLogin',primary);
  assert.deepEqual(new Set(back.projects.map(p=>p.id)),new Set([mainProject.id,sideProject.id]));
  // A remote auth provider sees only an independently derived credential.
  const submitted=service.accountCalls.map(call=>call.passwordDigest).filter(Boolean);
  assert.ok(submitted.length>=4);
  for(const pw of [primary.password,other.password])assert.ok(!submitted.includes(createHash('sha256').update(pw).digest('hex')));
  await b.close();
});
