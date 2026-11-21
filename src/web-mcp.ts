import express from 'express';
import { createServer } from 'node:https';
import { readOwnedFile } from './secure-files.js';
import type { Duplex } from 'node:stream';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMemoryMcp } from './mcp-server.js';
import { consentCookieName, DeviceAuthorization } from './web-auth.js';
import { contextSchema, searchSchema } from './model.js';
import type { VaultSession } from './vault.js';

async function tlsFile(path:string,privateKey:boolean){
  try { return await readOwnedFile(path, 65536, privateKey); }
  catch { throw Error('INVALID_TLS_FILE'); }
}
export type WebMcpConfig={origin:string;certificateFile:string;privateKeyFile:string;host?:string;port?:number};
/** TLS terminates on the user's device. No reverse proxy trust, plaintext listener or cloud key upload. */
export async function startWebMcp(vault:VaultSession,config:WebMcpConfig){
  const key=await tlsFile(config.privateKeyFile,true);
  try {
    const cert=await tlsFile(config.certificateFile,false);
    const origin=new URL(config.origin);
    const port=config.port??Number(origin.port||443);
    if(port<1) throw Error('HTTPS_ORIGIN_REQUIRED');
    return await listenWebMcp(vault,origin,config.host??'127.0.0.1',port,{cert,key},false);
  } finally { key.fill(0); }
}

// The Windows controller receives certificate material over its device-local
// inherited helper pipe. Port zero allocates a fresh loopback port atomically.
export function startDesktopWebMcp(vault:VaultSession,origin:URL,credentials:{cert:Buffer;key:Buffer}) {
  return listenWebMcp(vault,origin,'127.0.0.1',0,credentials,true);
}
async function listenWebMcp(vault:VaultSession,origin:URL,host:string,port:number,credentials:{cert:Buffer;key:Buffer},desktop:boolean) {
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||!Number.isInteger(port)||port<0||port>65535||!['127.0.0.1','0.0.0.0','::1'].includes(host))throw Error('HTTPS_ORIGIN_REQUIRED');
  vault.assertUnlocked();
  const auth=new DeviceAuthorization(new URL('/mcp',origin),()=>vault.assertUnlocked(),id=>{vault.getContext({projectId:id})});
  const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
  let closing=false,inFlight=0,windowStart=Date.now(),requests=0;
  const audit:Array<{at:string;method:string;success:boolean;connectionId:string}>=[];
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});
    if(closing){res.status(503).json({error:'CONNECTION_CLOSED'});return}
    if(req.headers.host!==origin.host||(req.headers.origin!==undefined&&req.headers.origin!==origin.origin)){res.status(403).json({error:'ORIGIN_REJECTED'});return}
    if(req.url.length>8192||req.headers['content-encoding']){res.status(400).json({error:'INVALID_REQUEST'});return}
    if(Date.now()-windowStart>=60000){windowStart=Date.now();requests=0}
    if(++requests>600||inFlight>=32){res.status(429).json({error:'RATE_LIMITED'});return}
    inFlight++;let ended=false;const end=()=>{if(!ended){inFlight--;ended=true}};res.once('finish',end);res.once('close',end);next();
  });
  app.use(express.json({limit:'64kb',strict:true,inflate:false}));
  app.use(express.urlencoded({extended:false,limit:'16kb',parameterLimit:20,inflate:false}));
  app.use(mcpAuthRouter({provider:auth,issuerUrl:origin,resourceServerUrl:auth.resource,scopesSupported:['memory:read'],resourceName:'Growth Brain device memory'}));
  app.get('/consent',(req,res)=>{
    try{
      const id = typeof req.query.request === 'string' ? req.query.request : '';
      if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('INVALID_REQUEST');
      const cookieName = consentCookieName(id);
      const prefix = cookieName + '=';
      const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(prefix))?.slice(prefix.length) ?? '';
      const result = auth.consent(id, cookie);
      if(!result.waiting){res.clearCookie(cookieName,{secure:true,httpOnly:true,sameSite:'lax',path:'/'});res.redirect(303,result.url);return}
      // UUID only, no client-provided HTML. Refresh keeps the code out of any script.
      res.type('html').send(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="3"><title>Growth Brain 연결 승인</title><h1>기기에서 연결을 승인하세요</h1><p>${desktop?'Growth Brain 앱에서 아래 요청 번호와 서비스 주소를 확인하고, 허용할 기억 범위를 선택하세요.':'Growth Brain 로컬 터미널에서 web-requests로 요청을 확인하고 web-approve로 읽기 범위를 승인하세요.'}</p><p>요청 번호: ${result.id}</p><p>비밀번호나 복구 키를 이 페이지 또는 AI 대화에 입력하지 마세요. 승인하면 자동으로 원래 서비스로 돌아갑니다.</p></html>`);
    }catch{res.status(400).json({error:'CONNECTION_REQUEST_UNAVAILABLE'})}
  });
  const bearer=requireBearerAuth({verifier:auth,requiredScopes:['memory:read'],expectedResource:auth.resource,resourceMetadataUrl:new URL('/.well-known/oauth-protected-resource/mcp',origin).href});
  app.post('/mcp',bearer,async(req,res)=>{
    const token=req.auth!.token;
    const mcp=createMemoryMcp(async(method,raw)=>{
      let success=false;
      try{
        const verified=await auth.verifyAccessToken(token),projectId=verified.extra.projectId as string|null;
        if(method==='get_context'){
          const p=contextSchema.parse(raw);
          if(p.projectId&&p.projectId!==projectId)throw Error('PROJECT_ACCESS_DENIED');
          const result=vault.getContext({...p,projectId:projectId??undefined},projectId===null);success=true;return result;
        }
        if(method==='search_memory'){
          const p=searchSchema.parse(raw);
          if(p.projectId&&p.projectId!==projectId)throw Error('PROJECT_ACCESS_DENIED');
          const result=vault.search(projectId??undefined,p.query,p.limit,p.requestConditions,p.taskType,projectId===null);success=true;return result;
        }
        throw Error('INVALID_REQUEST');
      }finally{audit.push({at:new Date().toISOString(),method,success,connectionId:String(req.auth!.extra!.grantId)});if(audit.length>200)audit.shift()}
    },true);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    const cleanup=()=>{void mcp.close().catch(()=>{})};res.once('close',cleanup);
    try{await mcp.connect(transport);await transport.handleRequest(req,res,req.body)}
    catch{if(!res.headersSent)res.status(400).json({error:'INVALID_MCP_REQUEST'});else res.end()}
  });
  app.all('/mcp',bearer,(_req,res)=>{res.set('Allow','POST');res.status(405).json({error:'METHOD_NOT_ALLOWED'})});
  app.use((_req,res)=>{res.status(404).json({error:'NOT_FOUND'})});
  app.use(((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
    if(!res.headersSent)res.status(400).json({error:'INVALID_REQUEST'});else res.end();
  }) as express.ErrorRequestHandler);
  const server=createServer({...credentials,minVersion:'TLSv1.2',maxHeaderSize:16384},app);
  const sockets=new Set<Duplex>();server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxConnections=64;
  server.setTimeout(15000,socket=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve)});
  let closePromise:Promise<void>|undefined;
  const address=server.address();
  if(!address || typeof address==='string')throw Error('HTTPS_LISTENER_UNAVAILABLE');
  return {port:address.port,updateCertificate:(pair:{cert:Buffer;key:Buffer})=>server.setSecureContext({...pair,minVersion:'TLSv1.2'}),url:auth.resource.href,auth,audit:()=>structuredClone(audit),close:()=>{
    if(closePromise)return closePromise;closing=true;auth.close();audit.length=0;
    closePromise=new Promise<void>((resolve,reject)=>{server.close(e=>e?reject(e):resolve());for(const s of sockets)s.destroy()});return closePromise;
  }};
}
