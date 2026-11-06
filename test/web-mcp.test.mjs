import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {createServer} from 'node:net';
import {DeviceAuthorization} from '../dist/web-auth.js';
import {startWebMcp} from '../dist/web-mcp.js';
import {VaultSession} from '../dist/vault.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {approve,proposal} from './helpers.mjs';
const hash=s=>createHash('sha256').update(s).digest('base64url');
const random=()=>randomBytes(32).toString('base64url');
async function registered(auth,name='Synthetic client'){
 return await auth.clientsStore.registerClient({redirect_uris:['https://client.example/callback'],client_name:name,token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});
}
async function authorized(auth,client,projectId=null){
 const verifier=random(),params={redirectUri:client.redirect_uris[0],resource:auth.resource,codeChallenge:hash(verifier),scopes:['memory:read'],state:random()};
 let cookie,location;await auth.authorize(client,params,{cookie:(_name,value)=>{cookie=value},redirect:(_code,value)=>{location=value}});
 const id=new URL(location,'https://device.example').searchParams.get('request');
 assert.equal(auth.consent(id,cookie).waiting,true);const grant=auth.approve(id,projectId);
 const redirect=new URL(auth.consent(id,cookie).url);assert.equal(redirect.searchParams.get('state'),params.state);
 return {code:redirect.searchParams.get('code'),verifier,params,grant};
}

test('device OAuth binds one-time code to PKCE/client/redirect/resource and requires local approval',async()=>{
 const auth=new DeviceAuthorization(new URL('https://device.example/mcp'),()=>{},()=>{}),client=await registered(auth),other=await registered(auth);
 const a=await authorized(auth,client);
 for(const args of [[other,a.code,a.verifier,a.params.redirectUri,auth.resource],[client,a.code,random(),a.params.redirectUri,auth.resource],[client,a.code,a.verifier,'https://evil.example/',auth.resource],[client,a.code,a.verifier,a.params.redirectUri,new URL('https://evil.example/mcp')]])await assert.rejects(()=>auth.exchangeAuthorizationCode(...args));
 const tokens=await auth.exchangeAuthorizationCode(client,a.code,a.verifier,a.params.redirectUri,auth.resource);
 assert.equal((await auth.verifyAccessToken(tokens.access_token)).extra.projectId,null);
 await assert.rejects(()=>auth.exchangeAuthorizationCode(client,a.code,a.verifier,a.params.redirectUri,auth.resource));
 auth.revoke(a.grant.id);await assert.rejects(()=>auth.verifyAccessToken(tokens.access_token));
 assert.throws(()=>auth.clientsStore.registerClient({...client,redirect_uris:['http://client.example/callback']}));
 assert.throws(()=>auth.clientsStore.registerClient({...client,client_name:'name\nforged instruction'}));
 auth.close();
});

test('refresh rotation detects replay, respects expiry, and never revives a revoked grant',async()=>{
 let now=Date.now();const auth=new DeviceAuthorization(new URL('https://device.example/mcp'),()=>{},()=>{},()=>now),client=await registered(auth);
 const a=await authorized(auth,client),first=await auth.exchangeAuthorizationCode(client,a.code,a.verifier,a.params.redirectUri,auth.resource);
 now+=900001;await assert.rejects(()=>auth.verifyAccessToken(first.access_token));
 await assert.rejects(()=>auth.exchangeRefreshToken(client,first.refresh_token,['memory:write'],auth.resource));
 const second=await auth.exchangeRefreshToken(client,first.refresh_token,['memory:read'],auth.resource);
 assert.equal((await auth.verifyAccessToken(second.access_token)).scopes[0],'memory:read');
 await assert.rejects(()=>auth.exchangeRefreshToken(client,first.refresh_token,['memory:read'],auth.resource));
 await assert.rejects(()=>auth.verifyAccessToken(second.access_token));
 await assert.rejects(()=>auth.exchangeRefreshToken(client,second.refresh_token,['memory:read'],auth.resource));
 const b=await authorized(auth,client),fresh=await auth.exchangeAuthorizationCode(client,b.code,b.verifier,b.params.redirectUri,auth.resource);
 now+=86400001;await assert.rejects(()=>auth.exchangeRefreshToken(client,fresh.refresh_token,['memory:read'],auth.resource));auth.close();
});

test('pending authorization is browser-bound, expires, rejects write scope, and cannot approve an unknown project',async()=>{
 let now=Date.now();const auth=new DeviceAuthorization(new URL('https://device.example/mcp'),()=>{},()=>{throw Error('PROJECT_NOT_FOUND')},()=>now),client=await registered(auth);
 const params={redirectUri:client.redirect_uris[0],resource:auth.resource,codeChallenge:hash(random()),scopes:['memory:read']};let cookie,location;
 const res={cookie:(_n,value)=>{cookie=value},redirect:(_s,value)=>{location=value}};
 await assert.rejects(()=>auth.authorize(client,{...params,scopes:['memory:write']},res));
 await auth.authorize(client,params,res);const id=new URL(location,'https://device.example').searchParams.get('request');
 assert.throws(()=>auth.consent(id,random()));assert.throws(()=>auth.approve(id,randomUUID()),/PROJECT_NOT_FOUND/);
 auth.deny(id);assert.equal(new URL(auth.consent(id,cookie).url).searchParams.get('error'),'access_denied');
 await auth.authorize(client,params,res);now+=300001;assert.equal(auth.requests().length,0);auth.close();
});

test('actual HTTPS OAuth and MCP protect common/project scopes, write boundary, revocation and lock',async()=>{
 const root=await mkdtemp(join(tmpdir(),'gb-web-mcp-')),key=join(root,'key.pem'),cert=join(root,'cert.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,'-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});await chmod(key,0o600);
 const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const origin=`https://localhost:${port}`,ca=await readFile(cert),vault=await VaultSession.open(join(root,'vault'),randomUUID(),random(),true);
 const [project,other]=await vault.mutate(e=>{const p=e.addProject('PRIVATE_PROJECT'),o=e.addProject('OTHER_PRIVATE_PROJECT');approve(e,proposal({type:'global'},'language','한국어'));approve(e,proposal({type:'project',projectId:p.id},'tone','PRIVATE_TONE'));approve(e,proposal({type:'project',projectId:o.id},'tone','OTHER_PRIVATE_TONE'));e.configureProjectTriggers(o.id,['other-trigger']);return [p,o]});
 const web=await startWebMcp(vault,{origin,certificateFile:cert,privateKeyFile:key}),clients=[];
 const http=(path,init={})=>new Promise((resolve,reject)=>{
  const url=new URL(path,origin),req=request(url,{hostname:'127.0.0.1',servername:'localhost',ca,method:init.method??'GET',headers:{host:url.host,...Object.fromEntries(new Headers(init.headers))}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));
  });req.on('error',reject);if(init.body)req.write(String(init.body));req.end();
 });
 const json=async(path,data,headers={})=>http(path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 const form=async(path,data)=>http(path,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data).toString()});
 async function login(projectId){
  const registered=await json('/register',{client_name:'Synthetic HTTPS client',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code']});assert.equal(registered.status,201);
  const client=JSON.parse(registered.text),verifier=random(),query=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:client.redirect_uris[0],code_challenge:hash(verifier),code_challenge_method:'S256',scope:'memory:read',resource:web.url,state:'synthetic-state'});
  const response=await http('/authorize?'+query);assert.equal(response.status,303);const cookie=response.headers['set-cookie'][0].split(';')[0];
  const pending=await http(response.headers.location,{headers:{Cookie:cookie}});assert.match(pending.text,/기기에서 연결/);
  const id=new URL(response.headers.location,origin).searchParams.get('request'),grant=web.auth.approve(id,projectId);
  const consent=await http(response.headers.location,{headers:{Cookie:cookie}});assert.equal(consent.status,303);
  const code=new URL(consent.headers.location).searchParams.get('code');
  const exchanged=await form('/token',{grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:client.redirect_uris[0],resource:web.url});assert.equal(exchanged.status,200);
  return {...JSON.parse(exchanged.text),grant,client};
 }
 async function mcp(token){
  const client=new Client({name:'synthetic-web',version:'1'});clients.push(client);
  const fetch=async(url,init)=>{const r=await http(String(url),init);return new Response(r.status===202||r.status===204?null:r.text,{status:r.status,headers:r.headers})};
  await client.connect(new StreamableHTTPClientTransport(new URL(web.url),{fetch,requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return client;
 }
 try{
  const unauthorized=await json('/mcp',{});assert.equal(unauthorized.status,401);assert.match(unauthorized.headers['www-authenticate'],/oauth-protected-resource/);
  assert.equal((await http('/.well-known/oauth-authorization-server')).status,200);
  const metadata=JSON.parse((await http('/.well-known/oauth-protected-resource/mcp')).text);assert.equal(metadata.resource,web.url);
  assert.equal((await json('/mcp',{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await http('/.well-known/oauth-authorization-server',{headers:{Host:'evil.example'}})).status,403);
  const common=await login(null),commonClient=await mcp(common.access_token);
  assert.match(commonClient.getInstructions(),/Before answering/);
  assert.deepEqual((await commonClient.listTools()).tools.map(t=>t.name),['get_context','search_memory']);
  for(const name of ['get_context','search_memory']){
   const result=JSON.parse((await commonClient.callTool({name,arguments:{query:'other-trigger language'}})).content[0].text);
   assert.equal(result.routing.projectId,null);assert.deepEqual(result.routing.candidateProjectIds,[]);assert.deepEqual(result.searchedScopes,['global']);assert.ok(!JSON.stringify(result).includes('OTHER_PRIVATE'));
  }
  assert.equal((await commonClient.callTool({name:'get_context',arguments:{projectId:project.id}})).isError,true);
  assert.equal((await commonClient.callTool({name:'propose_memory',arguments:{}})).isError,true);
  const selected=await login(project.id),projectClient=await mcp(selected.access_token);
  const context=JSON.parse((await projectClient.callTool({name:'get_context',arguments:{requestConditions:{tone:'current_override'}}})).content[0].text);
  assert.equal(context.projectId,project.id);assert.equal(context.conditions.find(c=>c.key==='tone').value,'current_override');assert.ok(!JSON.stringify(context).includes('OTHER_PRIVATE'));
  assert.equal((await projectClient.callTool({name:'get_context',arguments:{projectId:other.id}})).isError,true);
  await form('/revoke',{client_id:selected.client.client_id,token:selected.refresh_token});
  assert.equal((await json('/mcp',{}, {Authorization:`Bearer ${selected.access_token}`})).status,401);
  const audit=JSON.stringify(web.audit());for(const forbidden of ['PRIVATE','한국어',common.access_token,'current_override'])assert.ok(!audit.includes(forbidden));
  await vault.close();const locked=await json('/mcp',{}, {Authorization:`Bearer ${common.access_token}`});assert.equal(locked.status,401);assert.match(locked.text,/VAULT_LOCKED/);
 }finally{for(const c of clients)await c.close();await web.close();await vault.close();await rm(root,{recursive:true,force:true})}
});
