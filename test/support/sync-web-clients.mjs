import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const secret=()=>randomBytes(32).toString('base64url');
export const callbacks={
  chatgpt:'https://chatgpt.com/connector_platform_oauth_redirect',
  claude:'https://claude.ai/api/mcp/auth_callback',
};

export function device(profile, backend, tls) {
  const child=fork(new URL('./sync-acceptance-device.mjs',import.meta.url),[profile,backend,tls],{
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

export function loopbackHttps(port,ca) {
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

export async function connectWeb(pc,provider,projectId,ca) {
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

export async function startDeviceWeb(pc) {
  await pc.run('startWeb');
  for (let attempt=0;attempt<100;attempt++) {
    if (pc.port && (await pc.run('status')).web.state==='ready') return;
    await delay(20);
  }
  assert.fail('Device HTTPS MCP listener did not become ready');
}

export async function createLoopbackCertificate(root) {
  const cert=join(root,'cert.pem'),key=join(root,'key.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',key,'-out',cert,
    '-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],{stdio:'ignore'});
  return readFile(cert);
}
