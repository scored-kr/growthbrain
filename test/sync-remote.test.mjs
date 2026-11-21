import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {createSyncRpcFixture} from './support/sync-rpc-fixture.mjs';
import {SupabaseRemoteVault} from '../dist/sync-remote.js';

const publishableKey = 'sb_publishable_'+'synthetic'.repeat(4);
function box(size) {
  return {iv:randomBytes(12).toString('base64'),tag:randomBytes(16).toString('base64'),ciphertext:randomBytes(size).toString('base64')};
}
function envelope(parentRevision = null, sequence = 1, vaultId = randomUUID()) {
  return {version:1,vaultId,sequence,parentRevision,wrapped:box(32),body:box(96)};
}
function client(f, id) {
  return new SupabaseRemoteVault({publishableKey,contractVerified:true,getAccessToken:async()=>id,
    fetch:async(url,options)=>{
      const request = new URL(url);
      assert.equal(request.origin,'https://kcvjsvbwinlhzgmnfsji.supabase.co');
      assert.equal(options.headers.authorization,'Bearer '+id);
      assert.equal(options.redirect,'error');
      const {status,body}=await f.rpc(id,request.pathname.split('/').at(-1),JSON.parse(options.body));
      return Response.json(body,{status});
    }});
}

test('RPC enforces account identity, exact ciphertext shape, concurrent CAS, quota and erase epoch',async t=>{
  const f=await createSyncRpcFixture();t.after(()=>f.close());
  const alice=randomUUID(),bob=randomUUID();
  const a=client(f,alice),b=client(f,bob), first=envelope(), other=envelope();
  assert.equal((await f.rpc(null,'growthbrain_sync_v1_status',{})).status,403);
  assert.equal((await f.rpc(null,'growthbrain_sync_v1_write',{expected_revision:null,payload:first})).status,403);
  assert.deepEqual(await a.head(),{revision:null,bytes:0,quota:52428800});
  const start=await Promise.allSettled([a.push(null,first),a.push(null,first)]);
  assert.equal(start.filter(r=>r.status==='fulfilled').length,1);
  assert.match(start.find(r=>r.status==='rejected').reason.message,/SYNC_CONFLICT/);
  const prior=(await a.head()).revision;
  assert.deepEqual(await a.pull(),{revision:prior,payload:first});
  assert.equal(await b.pull(),null);
  await assert.rejects(b.purge(prior),/SYNC_CONFLICT/);
  const second=await b.push(null,other);
  const next=envelope(prior,2,first.vaultId);
  for(const invalid of [{...next,plaintext:'private string'}, {...next,body:{...next.body,text:'clear'}},
    {...next,wrapped:{...next.wrapped,iv:'not a valid iv!!'}}, {...next,body:{...next.body,ciphertext:'===='}},
    {...next,parentRevision:null}]) {
    const response=await f.rpc(alice,'growthbrain_sync_v1_write',{expected_revision:prior,payload:invalid});
    assert.equal(response.status,400);
  }
  await assert.rejects(a.push(prior,envelope(prior,1,first.vaultId)),/SYNC_CONFLICT/);
  await assert.rejects(a.push(prior,envelope(prior,2)),/SYNC_CONFLICT/);
  // Neither a client-reported byte count nor another account's quota enters the calculation.
  await f.db.query('insert into growthbrain_sync_v1_private.storage_limits values($1,100)',[alice]);
  await assert.rejects(a.push(prior,next),/SYNC_QUOTA/);
  assert.deepEqual(await a.pull(),{revision:prior,payload:first});
  assert.equal((await b.head()).quota,52428800);
  const erased=await a.purge(prior);
  assert.ok(erased.revision && erased.revision!==prior);
  assert.equal(erased.bytes,0);assert.equal(await a.pull(),null);
  assert.equal((await f.inspect()).find(r=>r.owner_id===alice).payload,null);
  assert.deepEqual(await b.pull(),{revision:second.revision,payload:other});
  await assert.rejects(a.push(prior,next),/SYNC_CONFLICT/);
  await assert.rejects(a.push(null,first),/SYNC_CONFLICT/);
  await f.db.query('delete from growthbrain_sync_v1_private.storage_limits where owner_id=$1',[alice]);
  assert.ok((await a.push(erased.revision,envelope(erased.revision))).bytes>0);

  // Even a direct SQL session with the app role cannot edit the private rows,
  // bump its quota, or masquerade as the function's non-login executor role.
  for (const query of ['select * from growthbrain_sync_v1_private.snapshots',
    'delete from growthbrain_sync_v1_private.snapshots','update growthbrain_sync_v1_private.storage_limits set quota_bytes=52428800']) {
    await assert.rejects(f.db.transaction(async tx=>{
      await tx.exec('set local role authenticated');
      await tx.exec(query);
    }),e=>e.code==='42501');
  }
  const membership=await f.db.query("select pg_has_role('authenticated','growthbrain_sync_v1_executor','MEMBER') as member");
  assert.equal(membership.rows[0].member,false);
  // Exercise the actual policy with the restricted function owner, not only
  // public RPC predicates. Forged identifiers cannot target a second account.
  await f.db.transaction(async tx=>{
    await tx.exec('set local role growthbrain_sync_v1_executor');
    await tx.query("select set_config('request.jwt.claim.sub',$1,true)",[alice]);
    const {rows}=await tx.query('select owner_id from growthbrain_sync_v1_private.snapshots');
    assert.deepEqual(rows,[{owner_id:alice}]);
    const deletion=await tx.query('delete from growthbrain_sync_v1_private.snapshots where owner_id=$1 returning owner_id',[bob]);
    assert.deepEqual(deletion.rows,[]);
  });
});

test('unverified contract blocks credentials/network; redirects, unbounded replies and unsafe envelopes fail',async()=>{
  let calls=0;
  const base={publishableKey,getAccessToken:async()=>{calls++;return 'synthetic';},
    fetch:async()=>{throw Error('fixture transport');}};
  await assert.rejects(new SupabaseRemoteVault({...base,contractVerified:false}).head(),/SYNC_UNCONFIGURED/);
  assert.equal(calls,0);
  const remote=new SupabaseRemoteVault({...base,contractVerified:true, fetch:async(_url,opts)=>{
    assert.equal(opts.redirect,'error');return new Response('x'.repeat(4097));}});
  await assert.rejects(remote.head(),/SYNC_PROTOCOL/);
  await assert.rejects(remote.push(null,{...envelope(),body:{text:'clear'}}),/SYNC_INVALID_ENVELOPE/);
  assert.equal(calls,1);
});

test('read-only qualification fingerprint rejects altered function privileges and disabled row isolation',async t=>{
  const f=await createSyncRpcFixture();t.after(()=>f.close());
  const {readFile}=await import('node:fs/promises');
  const {createHash}=await import('node:crypto');
  const sql=await readFile(new URL('../scripts/proposed/inspect-sync-catalog.sql',import.meta.url),'utf8');
  const expected=(await readFile(new URL('../scripts/proposed/account-sync-catalog.sha256',import.meta.url),'utf8')).trim();
  async function fingerprint() {
    return await f.db.transaction(async tx=>{
      await tx.exec('set transaction read only;set local search_path=pg_catalog');
      const {rows}=await tx.query(sql);
      assert.equal(rows[0].report.readOnly,true);
      const canonical=JSON.stringify(rows[0].report.catalog, (key,value) => {
        if (value && typeof value==='object' && !Array.isArray(value)) {
          return Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]]));
        }
        return value;
      });
      return createHash('sha256').update(canonical).digest('hex');
    });
  }
  assert.equal(await fingerprint(),expected);
  await f.db.exec('grant execute on function public.growthbrain_sync_v1_read() to anon');
  assert.notEqual(await fingerprint(),expected);
  await f.db.exec('revoke execute on function public.growthbrain_sync_v1_read() from anon');
  assert.equal(await fingerprint(),expected);
  await f.db.exec('alter table growthbrain_sync_v1_private.snapshots disable row level security');
  assert.notEqual(await fingerprint(),expected);
});
