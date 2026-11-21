import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { get } from 'node:https';
import { dirname, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { privateDirectory, type VaultSession } from './vault.js';
import { enrollRouteDevice, routeDeviceId, type RouteAccount } from './route-enrollment.js';
import { startDesktopWebMcp } from './web-mcp.js';

const routeCodes = z.enum(['ROUTE_UNAVAILABLE','ROUTE_OFFLINE','ROUTE_POLICY_BLOCKED','ROUTE_CERTIFICATE','ROUTE_CANCELLED','ROUTE_ENROLLMENT_UNAVAILABLE','ROUTE_ENROLLMENT_LIMIT','ROUTE_AUTH_REQUIRED']);
const eventSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('error'), code:routeCodes}).strict(),
  z.object({type:z.literal('login'), url:z.string().max(2048)}).strict(),
  z.object({type:z.literal('certificate'), origin:z.string().max(256), cert:z.base64().max(48000), key:z.base64().max(16000)}).strict(),
  z.object({type:z.literal('listening')}).strict(),
  z.object({type:z.literal('enroll')}).strict(),
]);
type WebServer = Awaited<ReturnType<typeof startDesktopWebMcp>>;
type RouteProcess = ChildProcessByStdio<Writable,Readable,null>;

function runHelper() {
  const env:NodeJS.ProcessEnv = {TS_NO_LOGS_NO_SUPPORT:'true'};
  for(const name of ['SystemRoot','WINDIR','LOCALAPPDATA','APPDATA','USERPROFILE','TEMP','TMP','ProgramData','HTTPS_PROXY','HTTP_PROXY','NO_PROXY']) {
    if(process.env[name] !== undefined) env[name]=process.env[name];
  }
  return spawn(join(dirname(process.execPath),'growth-brain-route.exe'),[],{
    shell:false,windowsHide:true,stdio:['pipe','pipe','ignore'],env,
  });
}

// Health requests contain no credentials or memory. Verify the public chain,
// device leaf and OAuth metadata before offering the URL to a client.
export function probeRoute(origin:URL, fingerprint:string, signal:AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = AbortSignal.timeout(6000);
    const request=get(new URL('/.well-known/oauth-protected-resource/mcp',origin),{
      agent:false, signal:AbortSignal.any([signal,timeout]), rejectUnauthorized:true,
    },response=>{
      const socket=response.socket;
      if(!('getPeerCertificate' in socket) || typeof socket.getPeerCertificate !== 'function' ||
        socket.getPeerCertificate().fingerprint256 !== fingerprint || response.statusCode!==200) {
        response.destroy();resolve(false);return;
      }
      let body='';
      response.setEncoding('utf8');
      response.on('data',(part:string)=>{
        body+=part;if(body.length>8192){response.destroy();resolve(false);}
      });
      response.on('end',()=>{
        try{resolve(JSON.parse(body).resource === new URL('/mcp',origin).href);}
        catch{resolve(false);}
      });
      response.on('error',()=>resolve(false));
      response.on('close',()=>resolve(false));
    });
    request.on('error',()=>resolve(false));
  });
}

async function* readEvents(stream:Readable) {
  // stdout is an inherited private device pipe and may contain a TLS key.
  let line='';
  for await(const bytes of stream) {
    for(const text of Buffer.from(bytes).toString('ascii').split(/(?<=\n)/)) {
      line+=text;
      if(line.length>65536)throw Error('ROUTE_UNAVAILABLE');
      if(line.endsWith('\n')){
        yield eventSchema.parse(JSON.parse(line));
        line='';
      }
    }
  }
  throw Error('ROUTE_OFFLINE');
}

export function openDesktopRoute(vault:VaultSession,directory:string,onSignIn?:(url:string)=>void,signal?:AbortSignal) {
  return openRoute(vault,directory,onSignIn,signal);
}
export function openAccountDesktopRoute(vault:VaultSession,directory:string,account:RouteAccount,signal?:AbortSignal) {
  return openRoute(vault,directory,undefined,signal,account);
}
async function openRoute(vault:VaultSession,directory:string,onSignIn?: (url:string)=>void,signal?:AbortSignal,account?:RouteAccount) {
  vault.assertUnlocked();
  if(signal?.aborted)throw Error('ROUTE_CANCELLED');
  const stateDir=join(directory,account?'managed-web-identity-v1':'web-identity');
  await privateDirectory(stateDir);
  const deviceId=account?await routeDeviceId(stateDir):undefined;
  const child:RouteProcess=runHelper();
  const life=new AbortController();
  let web:WebServer|undefined;
  let healthy=false;
  let failure:string|null=null;
  let fingerprint='';
  let origin:URL|undefined;
  let resolveStartup!:(server:WebServer)=>void;
  let rejectStartup!:(e:Error)=>void;
  const started=new Promise<WebServer>((resolve,reject)=>{resolveStartup=resolve;rejectStartup=reject;});
  const exited=new Promise<void>(resolve=>child.once('close',()=>resolve()));
  const close=async(code='ROUTE_CANCELLED')=>{
    healthy=false;
    if(!life.signal.aborted){
      failure=code;
      life.abort();
      rejectStartup(Error(code));
      child.stdin.end();
      // Let tsnet withdraw the Funnel registration and flush user state.
      if(child.exitCode===null && child.signalCode===null){
        const timer=setTimeout(()=>child.kill(),3000);timer.unref();
        child.once('close',()=>clearTimeout(timer));
      }
    }
    await Promise.all([exited,web?.close()]);
  };
  const stop=(code:string)=>{void close(code).catch(()=>{});};
  child.once('error',()=>stop('ROUTE_UNAVAILABLE'));
  child.once('close',()=>stop('ROUTE_OFFLINE'));
  child.stdin.on('error',()=>stop('ROUTE_OFFLINE'));
  const cancel=()=>stop('ROUTE_CANCELLED');
  signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  life.signal.addEventListener('abort',()=>signal?.removeEventListener('abort',cancel),{once:true});
  const startupTimer=setTimeout(()=>stop('ROUTE_OFFLINE'),25*60*1000);
  startupTimer.unref();
  child.stdin.write(JSON.stringify({stateDir,deviceId})+'\n');

  async function monitor(address:URL,server:WebServer) {
    // DNS propagation at first enrollment can lag the Funnel announcement.
    const deadline=Date.now()+10*60*1000;
    while(Date.now()<deadline){
      healthy=await probeRoute(address,fingerprint,life.signal);
      if(healthy||life.signal.aborted)break;
      await delay(5000,undefined,{signal:life.signal});
    }
    if(!healthy || life.signal.aborted){stop('ROUTE_OFFLINE');return;}
    resolveStartup(server);
    while(!life.signal.aborted){
      await delay(30000,undefined,{signal:life.signal});
      healthy=await probeRoute(address,fingerprint,life.signal);
      // Disconnect OAuth sessions if the route becomes unreachable. The UI
      // can request a new route and the user chooses the scope again.
      if(!healthy){stop('ROUTE_OFFLINE');return;}
    }
  }

  void (async()=>{
    let listening=false, enrolled=false;
    for await(const message of readEvents(child.stdout)){
      if(life.signal.aborted)return;
      if(message.type==='error'){stop(message.code);return;}
      if(message.type==='enroll'){
        if(!account||!deviceId||enrolled||web)throw Error();
        enrolled=true;
        try{
          const authKey=await enrollRouteDevice(account,deviceId,life.signal);
          if(!life.signal.aborted)child.stdin.write(JSON.stringify({authKey})+'\n');
        }catch(error){
          stop(error instanceof Error && routeCodes.safeParse(error.message).success?error.message:'ROUTE_ENROLLMENT_UNAVAILABLE');
          return;
        }
      }else if(message.type==='login'){
        if(account){stop('ROUTE_POLICY_BLOCKED');return;}
        if(!/^https:\/\/login\.tailscale\.com\/(?:a\/[A-Za-z0-9_-]+|f\/funnel\?node=[A-Za-z0-9_-]+)$/.test(message.url))throw Error();
        onSignIn?.(message.url);
      }else if(message.type==='certificate'){
        if(!/^https:\/\/(?:[a-z0-9-]+\.)+ts\.net$/.test(message.origin) || (origin && origin.origin!==message.origin))throw Error();
        origin=new URL(message.origin);
        const cert=Buffer.from(message.cert,'base64'),key=Buffer.from(message.key,'base64');
        try {
          const leaf=new X509Certificate(cert);
          if(!leaf.checkHost(origin.hostname) || Date.parse(leaf.validTo)<=Date.now())throw Error();
          if(web) web.updateCertificate({cert,key});
          else {
            web=await startDesktopWebMcp(vault,origin,{cert,key});
            if(life.signal.aborted){await web.close();return;}
            child.stdin.write(JSON.stringify({port:web.port})+'\n');
          }
          fingerprint=leaf.fingerprint256;
        } finally {key.fill(0);}
      }else {
        if(listening||!web||!origin)throw Error();
        listening=true;
        void monitor(origin,web).catch(()=>stop('ROUTE_OFFLINE'));
      }
    }
  })().catch(()=>stop('ROUTE_UNAVAILABLE'));
  try {
    const server=await started;
    if(!healthy)throw Error('ROUTE_OFFLINE');
    return {url:server.url,auth:server.auth,audit:server.audit,error:()=>failure,
      status:():'ready'|'unavailable'=>healthy&&!life.signal.aborted?'ready':'unavailable',
      close:()=>close()};
  }catch(error){
    await close();
    throw error;
  }finally{clearTimeout(startupTimer);}
}
