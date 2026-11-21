// Simulated Supabase Auth/HTTP only. The RPC fixture runs the candidate SQL under
// the request's authenticated Postgres role and subject.
import { createServer } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createSyncRpcFixture } from './sync-rpc-fixture.mjs';

const projectOrigin = 'https://kcvjsvbwinlhzgmnfsji.supabase.co';
const digest = value => createHash('sha256').update(value).digest('hex');
export async function accountServer() {
  const sql = await createSyncRpcFixture();
  const users = new Map(), access = new Map(), refresh = new Map();
  const tokenKey = randomBytes(32);
  const accountCalls = [];
  const emailCode = '637292';
  const identity = entry => ({
    id:entry.id, email:entry.email, aud:'authenticated', role:'authenticated',
    email_confirmed_at:entry.verified ? new Date().toISOString() : null,
    app_metadata:{provider:'email',providers:['email']}, user_metadata:{}, identities:[],
    created_at:new Date().toISOString(), updated_at:new Date().toISOString(),
  });
  function issue(user) {
    const now = Math.floor(Date.now()/1000);
    const claims = {sub:user.id, email:user.email, role:'authenticated', aud:'authenticated',
      exp:now+3600, iat:now, iss:projectOrigin+'/auth/v1', session_id:randomUUID()};
    const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const signed = encode({alg:'HS256',typ:'JWT'}) + '.' + encode(claims);
    const token = signed + '.' + createHmac('sha256',tokenKey).update(signed).digest('base64url');
    const refreshToken = randomBytes(32).toString('base64url');
    access.set(token,user); refresh.set(refreshToken,user);
    return {access_token:token,refresh_token:refreshToken,token_type:'bearer',expires_in:3600,expires_at:now+3600,user:identity(user)};
  }
  async function respond(req) {
    const url = new URL(req.url,'http://127.0.0.1');
    const parts=[]; let bytes=0;
    for await(const chunk of req){bytes+=chunk.length;if(bytes>32*1024*1024)throw Error('Fixture input too large');parts.push(chunk)}
    const body=bytes?JSON.parse(Buffer.concat(parts).toString()):{};
    const token=(req.headers.authorization??'').replace(/^Bearer /,'');
    const caller=access.get(token), entry=users.get(body.email);
    const denied={status:401,body:{code:'bad_credentials',message:'Invalid credentials'}};
    if(req.method==='POST' && url.pathname.startsWith('/rest/v1/rpc/')){
      if(!caller || !caller.verified) return denied;
      return sql.rpc(caller.id,url.pathname.slice('/rest/v1/rpc/'.length),body);
    }
    accountCalls.push({path:url.pathname, passwordDigest:typeof body.password==='string'?digest(body.password):null});
    if(url.pathname==='/auth/v1/signup' && req.method==='POST' && !entry) {
      const user={id:randomUUID(),email:body.email,passwordHash:digest(body.password),verified:false};
      users.set(user.email,user);
      return {status:200,body:identity(user)};
    }
    if(url.pathname==='/auth/v1/verify' && req.method==='POST' && entry && body.token===emailCode && body.type==='signup'){
      entry.verified=true;
      return {status:200,body:issue(entry)};
    }
    if(url.pathname==='/auth/v1/token' && req.method==='POST'){
      if(url.searchParams.get('grant_type')==='password' && entry?.verified && entry.passwordHash===digest(body.password)) return {status:200,body:issue(entry)};
      if(url.searchParams.get('grant_type')==='refresh_token' && refresh.has(body.refresh_token)) return {status:200,body:issue(refresh.get(body.refresh_token))};
      return denied;
    }
    if(url.pathname==='/auth/v1/user' && req.method==='GET' && caller)return {status:200,body:identity(caller)};
    if(url.pathname==='/auth/v1/logout' && req.method==='POST' && caller){
      access.delete(token);
      for(const [key,user] of refresh)if(user===caller)refresh.delete(key);
      return {status:204};
    }
    return {status:404,body:{message:'Unimplemented fixture endpoint'}};
  }
  const server=createServer((req,res)=>{
    respond(req).then(({status,body})=>{
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','X-Supabase-Api-Version':'2024-01-01'});
      res.end(body===undefined?undefined:JSON.stringify(body));
    }).catch(()=>{res.writeHead(500);res.end('Synthetic backend error')});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {origin:'http://127.0.0.1:'+server.address().port,emailCode,accountCalls,inspect:()=>sql.inspect(),
    async setFixtureQuota(id, quota) {
      await sql.db.query('insert into auth.users(id) values($1) on conflict do nothing', [id]);
      await sql.db.query('insert into growthbrain_sync_v1_private.storage_limits values($1,$2) on conflict(owner_id) do update set quota_bytes=excluded.quota_bytes', [id,quota]);
    },
    async close(){await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});await sql.close()}};
}
