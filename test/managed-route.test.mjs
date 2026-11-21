import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {enrollmentHandler} from '../scripts/proposed/growthbrain-route-enroll/handler.mjs';
import {enrollRouteDevice} from '../dist/route-enrollment.js';

const origin='https://kcvjsvbwinlhzgmnfsji.supabase.co';
const accountId=randomUUID(), deviceId=randomUUID(),requestId=randomUUID();
const token=()=>randomBytes(24).toString('base64url');
const grant='tskey-auth-'+token(), publicKey=token(),serviceKey=token(),access=token();
const tenant={accountId,tailnet:'managed.example.test',clientId:token(),clientSecret:token()};
const config={origin,publicKey,serviceKey,tenants:JSON.stringify([tenant])};

test('verified account and operator-only SQL reservation precede each single-use scoped enrollment',async t=>{
  const db=new PGlite();
  t.after(()=>db.close());
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
  await db.exec(await readFile(new URL('../scripts/proposed/route-enrollment-v1.sql',import.meta.url),'utf8'));
  const claim=async(role,device=deviceId,id=requestId)=>await db.transaction(async tx=>{
    if(!['service_role','anon','authenticated'].includes(role))throw Error();
    await tx.exec('set local role '+role);
    return (await tx.query('select public.gb_route_claim_v1($1,$2,$3) decision',[accountId,device,id])).rows[0].decision;
  });
  await assert.rejects(()=>claim('anon'),/permission denied/i);
  await assert.rejects(()=>claim('authenticated'),/permission denied/i);
  const issued=[],apiToken=token();
  const fetcher=async(url,init)=>{
    assert.equal(init.redirect,'error');
    if(url===origin+'/auth/v1/user'){
      assert.equal(init.headers.apikey,publicKey);
      return init.headers.authorization==='Bearer '+access ?
        Response.json({id:accountId,email_confirmed_at:new Date().toISOString(),role:'authenticated'}) : new Response(null,{status:401});
    }
    if(url.endsWith('/rpc/gb_route_claim_v1')){
      assert.equal(init.headers.authorization,'Bearer '+serviceKey);
      const {p_account,p_device,p_request}=JSON.parse(init.body);
      assert.equal(p_account,accountId);
      return Response.json(await claim('service_role',p_device,p_request));
    }
    if(url==='https://api.tailscale.com/api/v2/oauth/token'){
      assert.equal(init.body.get('client_secret'),tenant.clientSecret);
      return Response.json({access_token:apiToken});
    }
    assert.equal(url,'https://api.tailscale.com/api/v2/tailnet/'+tenant.tailnet+'/keys');
    assert.equal(init.headers.Authorization,'Bearer '+apiToken);
    const body=JSON.parse(init.body);
    assert.deepEqual(body,{capabilities:{devices:{create:{ephemeral:true,reusable:false,preauthorized:true,tags:['tag:growthbrain-device']}}},expirySeconds:300});
    issued.push(1);
    return Response.json({key:grant,expires:new Date(Date.now()+300000).toISOString(),capabilities:body.capabilities});
  };
  const endpoint=enrollmentHandler(config,fetcher);
  const invoke=(payload={requestId,deviceId},credential=access)=>endpoint(new Request(origin,{method:'POST',
    headers:{authorization:'Bearer '+credential,'content-type':'application/json'},body:JSON.stringify(payload)}));
  assert.equal((await invoke({requestId,deviceId,tags:['tag:admin']})).status,400);
  assert.equal((await invoke(undefined,token())).status,401);
  const result=await invoke();
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{authKey:grant});
  assert.equal(result.headers.get('cache-control'),'no-store');
  assert.equal((await invoke()).status,409);
  assert.equal(issued.length,1);
  const fromClient=await enrollRouteDevice({accessToken:async()=>access,publishableKey:publicKey},deviceId,new AbortController().signal,
    async(url,init)=>{
      assert.equal(url,origin+'/functions/v1/growthbrain-route-enroll');
      assert.equal(init.redirect,'error');
      assert.equal(init.headers.apikey,publicKey);
      return endpoint(new Request(url,init));
    });
  assert.equal(fromClient,grant);
  for(let i=0;i<4;i++)assert.equal(await claim('service_role',randomUUID(),randomUUID()),'claimed');
  assert.equal(await claim('service_role',randomUUID(),randomUUID()),'limit');
  for(let i=0;i<18;i++)assert.equal(await claim('service_role',deviceId,randomUUID()),'claimed');
  assert.equal(await claim('service_role',deviceId,randomUUID()),'limit');
  assert.equal(issued.length,2);
});

test('unmapped users, duplicate tenant bindings and unexpected provider capabilities fail closed',async()=>{
  const unsafeKey='tskey-auth-'+token();
  for(const mode of ['unknown','duplicate','long-lived','reusable']){
    const wrong={...tenant,accountId:randomUUID()};
    const settings={...config,tenants:JSON.stringify(mode==='unknown'?[wrong]:mode==='duplicate'?[tenant,wrong]:[tenant])};
    let mints=0, revocations=0;
    const handle=enrollmentHandler(settings,async (url,init)=>{
      if(url.endsWith('/keys/keyFixtureId')){assert.equal(init.method,'DELETE');revocations++;return new Response(null,{status:204});}
      if(url.endsWith('/user'))return Response.json({id:accountId,email_confirmed_at:'today',role:'authenticated'});
      if(url.includes('/rpc/'))return Response.json('claimed');
      if(url.endsWith('/oauth/token'))return Response.json({access_token:token()});
      mints++;
      return Response.json({id:'keyFixtureId',key:unsafeKey,expires:new Date(Date.now()+(mode==='long-lived'?86400000:300000)).toISOString(),
        capabilities:{devices:{create:{reusable:mode==='reusable',ephemeral:true,preauthorized:true,tags:['tag:growthbrain-device']}}}});
    });
    const res=await handle(new Request(origin,{method:'POST',headers:{authorization:'Bearer '+access,'content-type':'application/json'},
      body:JSON.stringify({deviceId,requestId:randomUUID()})}));
    assert.ok(res.status===403||res.status===503);
    assert.equal((await res.text()).includes(unsafeKey),false);
    assert.equal(mints,['unknown','duplicate'].includes(mode)?0:1);
    assert.equal(revocations,mints);
  }
});
