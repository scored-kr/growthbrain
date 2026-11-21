// Staging operator component. No operator credential belongs in the desktop bundle.
const project = 'https://kcvjsvbwinlhzgmnfsji.supabase.co';
const provider = 'https://api.tailscale.com/api/v2';
const tag = 'tag:growthbrain-device';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const authKey = /^tskey-auth-[a-zA-Z0-9_-]{12,256}$/;

function reply(status, data) {
  return new Response(JSON.stringify(data), {status,headers:{
    'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
    'X-Content-Type-Options':'nosniff',
  }});
}

// Cap streaming requests even if Content-Length is absent.
async function readRequest(request) {
  const reader=request.body?.getReader();
  if(!reader)throw Error();
  const parts=[];
  let size=0;
  try{
    while(true){
      const {value,done}=await reader.read();
      if(done)break;
      size+=value.length;
      if(size>512){await reader.cancel();throw Error();}
      parts.push(value);
    }
  }finally{reader.releaseLock();}
  const body=new Uint8Array(size);
  let offset=0;
  for(const part of parts){body.set(part,offset);offset+=part.length;}
  const data=JSON.parse(new TextDecoder().decode(body));
  if(!data||Object.keys(data).sort().join(',')!=='deviceId,requestId'||
     !uuid.test(data.deviceId)||!uuid.test(data.requestId))throw Error();
  return data;
}

function tenantFor(account,config) {
  const list=JSON.parse(config);
  if(!Array.isArray(list)||list.length>256)throw Error();
  const ids=new Set(),clients=new Set(),tailnets=new Set();
  for(const t of list){
    if(!t||!uuid.test(t.accountId)||!/^[A-Za-z0-9_-]{6,100}$/.test(t.clientId)||
       typeof t.clientSecret!=='string'||t.clientSecret.length<20||t.clientSecret.length>512||
       !/^[a-z0-9][a-z0-9.-]{1,100}$/.test(t.tailnet)||ids.has(t.accountId)||
       clients.has(t.clientId)||tailnets.has(t.tailnet))throw Error();
    ids.add(t.accountId);clients.add(t.clientId);tailnets.add(t.tailnet);
  }
  return list.find(t=>t.accountId===account);
}

export function enrollmentHandler(config,fetcher=fetch,now=Date.now) {
  const call=(url,options)=>fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(6000)});
  return async request=>{
    if(request.method!=='POST')return reply(405,{error:'METHOD'});
    if(!request.headers.get('content-type')?.startsWith('application/json'))return reply(415,{error:'INPUT'});
    const authorization=request.headers.get('authorization');
    if(!authorization||!/^Bearer [A-Za-z0-9_.-]{12,8192}$/.test(authorization))return reply(401,{error:'SESSION'});
    let data;
    try{data=await readRequest(request);}catch{return reply(400,{error:'INPUT'});}
    try{
      if(config.origin!==project||!config.publicKey||!config.serviceKey||!config.tenants)throw Error();
      const auth=await call(project+'/auth/v1/user',{headers:{authorization,apikey:config.publicKey}});
      if(auth.status===401||auth.status===403)return reply(401,{error:'SESSION'});
      if(!auth.ok)throw Error();
      const user=await auth.json();
      if(!uuid.test(user.id)||user.role!=='authenticated'||!user.email_confirmed_at||user.is_anonymous)return reply(401,{error:'SESSION'});
      const tenant=tenantFor(user.id,config.tenants);
      if(!tenant)return reply(403,{error:'ENROLLMENT_UNAVAILABLE'});

      // Reserve before the first provider mutation. An ambiguous timeout never
      // triggers a second mint for this request. No key or bearer enters the ledger.
      const reservation=await call(project+'/rest/v1/rpc/gb_route_claim_v1',{
        method:'POST',headers:{apikey:config.serviceKey,authorization:'Bearer '+config.serviceKey,'Content-Type':'application/json'},
        body:JSON.stringify({p_account:user.id,p_device:data.deviceId,p_request:data.requestId}),
      });
      if(!reservation.ok)throw Error();
      const decision=await reservation.json();
      if(decision==='limit')return reply(429,{error:'ENROLLMENT_LIMIT'});
      if(decision==='duplicate')return reply(409,{error:'REQUEST_CONSUMED'});
      if(decision!=='claimed')throw Error();
      const oauth=await call(provider+'/oauth/token',{method:'POST',body:new URLSearchParams({
        grant_type:'client_credentials',client_id:tenant.clientId,client_secret:tenant.clientSecret,
      })});
      if(!oauth.ok)throw Error();
      const token=(await oauth.json()).access_token;
      if(typeof token!=='string'||!token||token.length>8192)throw Error();
      const issuance=await call(provider+'/tailnet/'+tenant.tailnet+'/keys',{
        method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({capabilities:{devices:{create:{reusable:false,ephemeral:true,preauthorized:true,tags:[tag]}}},expirySeconds:300}),
      });
      if(!issuance.ok)throw Error();
      const issued=await issuance.json();
      const caps=issued.capabilities?.devices?.create;
      const expires=Date.parse(issued.expires);
      if(!authKey.test(issued.key)||caps?.reusable!==false||caps.ephemeral!==true||caps.preauthorized!==true||
          !Array.isArray(caps.tags)||caps.tags.length!==1||caps.tags[0]!==tag||
          !Number.isFinite(expires)||expires<=now()||expires>now()+310000) {
        // The provider may have accepted the mutation with different metadata.
        // Revoke its explicit key ID before returning failure where possible.
        if(typeof issued.id==='string' && /^[a-zA-Z0-9_-]{4,128}$/.test(issued.id)){
          await call(provider+'/tailnet/'+tenant.tailnet+'/keys/'+issued.id,{
            method:'DELETE',headers:{Authorization:'Bearer '+token},
          });
        }
        throw Error();
      }
      return reply(200,{authKey:issued.key});
    }catch{return reply(503,{error:'ENROLLMENT_UNAVAILABLE'});}
  };
}
