import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateDirectory } from '../dist/secure-files.js';
import { AccountReplica } from '../dist/account-replica.js';
import { SupabaseRemoteVault } from '../dist/sync-remote.js';
import { approve, proposal } from './helpers.mjs';
import { createSyncRpcFixture } from './support/sync-rpc-fixture.mjs';

let sql;
after(async () => sql?.close());

// Each profile uses its own client transport. All committed snapshots and conflict
// responses are produced by the PostgreSQL functions under an authenticated role.
async function mesh(t) {
  sql ??= await createSyncRpcFixture();
  const root = join(process.platform==='win32'?homedir():tmpdir(),'gb-offline-test-'+randomUUID());
  await privateDirectory(root,true);
  const user = randomUUID(), key = randomBytes(32), devices = [];
  const accepted = [];
  t.after(async () => {
    try { for (const d of devices) await d.close(); }
    finally { key.fill(0); await rm(root, { recursive: true, force: true }); }
  });
  async function boot(name) {
    const profile = join(root, name);
    const link = { online: true, interrupt: null, beforeWrite: null, committed: null, malformedRead: false };
    const remote = new SupabaseRemoteVault({
      publishableKey: 'sb_publishable_' + 'synthetic'.repeat(4),
      contractVerified: true, getAccessToken: async () => user,
      fetch: async (url, init) => {
        const method = new URL(url).pathname.split('/').at(-1);
        const write = method === 'growthbrain_sync_v1_write';
        if (write && link.interrupt === 'before') link.online = false;
        if (!link.online) throw new TypeError('Synthetic link down');
        if (write && link.beforeWrite) await link.beforeWrite();
        const result = await sql.rpc(user, method, JSON.parse(init.body));
        if (write && result.status === 200) {
          accepted.push({ device:name, revision: result.body.revision, bytes: result.body.bytes });
          link.committed?.();
          if (link.interrupt === 'after') {
            link.online = false;
            throw new TypeError('Synthetic response lost');
          }
        }
        if (method === 'growthbrain_sync_v1_read' && link.malformedRead) {
          return Response.json({...result.body, payload:{...result.body.payload, wrapped:null}});
        }
        return Response.json(result.body, { status: result.status });
      },
    });
    const replica = await AccountReplica.connect(profile, user, key, remote);
    let stopped = false;
    const device = { replica, link, profile, remote, close: async () => {
      if (!stopped) {
        stopped = true;
        try { await replica.stop(); } finally { await replica.vault.close(); }
      }
    }};
    devices.push(device);
    return device;
  }
  return { boot, accepted, user };
}

const globalScope = { type: 'global' };
const add = (d, key, value, scope=globalScope, extra={}) => d.replica.vault.mutate(e=>approve(e,proposal(scope,key,value,extra)));

function live(d) { return d.replica.vault.read(e=>e.snapshot().memories.filter(m=>m.status==='active')); }
function byId(d) { return live(d).map(m=>[m.id,m.key,m.value]).sort(([a],[b])=>a.localeCompare(b)); }
function assertIds(d, ids) {
  const records = live(d);
  assert.equal(records.length,ids.length);
  assert.deepEqual(records.map(m=>m.id).sort(),[...ids].sort());
}

test('independent offline approvals converge from both upload orders and survive shutdown of the writers', async t=>{
  for (const order of [['A','B'],['B','A']]) {
    await t.test('first writer '+order[0],async t=>{
      const {boot}=await mesh(t);
      const devices = { A:await boot('A'), B:await boot('B') };
      const a=devices.A,b=devices.B;
      a.link.online=false; b.link.online=false;
      const idA=await add(a,'campaign-format','Start each task with a short brief');
      const idB=await add(b,'analysis-format','Include the comparison table');
      await assert.rejects(a.replica.sync(),/SYNC_UNAVAILABLE/);
      await assert.rejects(b.replica.sync(),/SYNC_UNAVAILABLE/);
      for (const name of order) { devices[name].link.online=true; await devices[name].replica.sync(); }
      await devices[order[0]].replica.sync();
      assertIds(a,[idA,idB]); assert.deepEqual(byId(a),byId(b));
      await Promise.all([a.close(),b.close()]);
      const c=await boot('Fresh');
      assertIds(c,[idA,idB]);
      assert.equal(c.replica.status().sync,'synced');
    });
  }
});

test('retry around PostgreSQL commit preserves the exact approval ID and never uploads an empty replacement',async t=>{
  for (const fault of ['before','after']) {
    await t.test('connection lost '+fault+' commit',async t=>{
      const {boot,accepted}=await mesh(t);
      const a=await boot('A');
      const baseline=await add(a,'retained','Already synchronized');
      await a.replica.sync();
      const before=accepted.length;
      a.link.online=false;
      const id=await add(a,'unsent','Created before the interruption');
      a.link.interrupt=fault; a.link.online=true;
      await assert.rejects(a.replica.sync(),/SYNC_UNAVAILABLE/);
      await a.close();
      const reopened=await boot('A');
      await reopened.replica.sync();
      await reopened.replica.sync();
      assertIds(reopened,[baseline,id]);
      assert.equal(accepted.length-before,1,'one committed change, including when the first reply was lost');
      assert.ok(accepted.every(w=>w.bytes>0));
      await reopened.close();
      assertIds(await boot('Clean installation'),[baseline,id]);
    });
  }
});

test('a receipt lost after commit plus another offline approval retains both through restart',async t=>{
  const {boot,accepted}=await mesh(t);
  const a=await boot('A');
  const before=accepted.length;
  a.link.online=false;
  const first=await add(a,'initial-offline','Keep first');
  a.link.interrupt='after'; a.link.online=true;
  await assert.rejects(a.replica.sync(),/SYNC_UNAVAILABLE/);
  const second=await add(a,'subsequent-offline','Keep second');
  await a.close();
  const reopened=await boot('A');
  await reopened.replica.sync();
  assertIds(reopened,[first,second]);
  assert.equal(accepted.length-before,2);
  await reopened.close();
  assertIds(await boot('B'),[first,second]);
});

async function dropToLegacyReceipt(d,user) {
  const {payload}=await d.remote.pull();
  const receipt=join(d.profile,'accounts',user,'generations',payload.vaultId,'remote.json');
  await d.close();
  const current=JSON.parse(await readFile(receipt,'utf8'));
  const legacy=Object.fromEntries(['accountId','vaultId','revision','sequence','digest'].map(key=>[key,current[key]]));
  await writeFile(receipt,JSON.stringify(legacy));
  return receipt;
}

test('an existing digest-only checkpoint upgrades without discarding its nonempty vault',async t=>{
  const {boot,user}=await mesh(t);
  const a=await boot('A');
  const first=await add(a,'old-format','Retain the original value');
  await a.replica.sync();
  const receipt=await dropToLegacyReceipt(a,user);
  const migrated=await boot('A'), other=await boot('B');
  assertIds(migrated,[first]);
  const second=await add(migrated,'legacy-device','Contributed after upgrade');
  const third=await add(other,'new-device','Contributed on a different PC');
  await other.replica.sync(); await migrated.replica.sync();
  assertIds(migrated,[first,second,third]);
  assert.ok(!(await readFile(receipt,'utf8')).includes('Retain the original value'));
  assertIds(await boot('C'),[first,second,third]);
});

async function syncForReview(d) {
  try { await d.replica.sync(); }
  catch (e) { assert.match(e.message,/SYNC_(?:CONFLICT|REVIEW_REQUIRED)/); }
  const preview=d.replica.conflictPreview();
  assert.ok(preview,'both alternatives require local review');
  assert.equal(d.replica.accessPermitted(),false,'MCP must not export an unreviewed collision');
  return preview;
}

test('same project decision retains both histories until the reviewer selects either version',async t=>{
  for (const choice of ['local','remote']) {
    await t.test('review and keep '+choice,async t=>{
      const {boot,accepted}=await mesh(t);
      const a=await boot('A');
      const project=(await a.replica.vault.mutate(e=>e.addProject('Client briefing'))).id;
      const scope={type:'project',projectId:project};
      const base=await add(a,'budget','Original budget',scope);
      await a.replica.sync();
      let b=await boot('B');
      a.link.online=false; b.link.online=false;
      const aChoice=await add(a,'budget','Approved on PC A',scope,{supersedesId:base});
      const bChoice=await add(b,'budget','Approved on PC B',scope,{supersedesId:base});
      const aOther=await add(a,'a-only','Keep this style');
      const bOther=await add(b,'b-only','Keep this language');
      a.link.online=true; await a.replica.sync();
      b.link.online=true;
      let preview=await syncForReview(b);
      assert.equal(preview.items.length,1);
      assert.equal(preview.items[0].projectId,project);
      assert.equal(preview.items[0].localValue,'Approved on PC B');
      assert.equal(preview.items[0].remoteValue,'Approved on PC A');
      const remoteBefore=await a.remote.pull();
      await assert.rejects(b.replica.resolveConflict(preview.token,{}));
      assert.deepEqual(await a.remote.pull(),remoteBefore);
      const old=preview;
      // While B reviews, A legitimately updates a different project decision.
      const later=await add(a,'after-review','Preserve concurrent change',scope);
      await a.replica.sync();
      const unchanged=await a.remote.pull();
      await assert.rejects(b.replica.resolveConflict(old.token,{[old.items[0].id]:choice}));
      assert.deepEqual(await a.remote.pull(),unchanged,'stale approval cannot overwrite a changed revision');
      assert.equal(b.replica.reviewPending(),true,'stale answer must leave the user in review');
      b.link.online=false;
      await assert.rejects(b.replica.sync(),/SYNC_UNAVAILABLE/);
      assert.equal(b.replica.reviewPending(),true);
      assert.equal(b.replica.accessPermitted(),false);
      b.link.online=true;
      await b.close();
      b=await boot('B');
      preview=await syncForReview(b);
      assert.equal(preview.items.length,1);
      const count=accepted.length;
      await b.replica.resolveConflict(preview.token,{[preview.items[0].id]:choice});
      await b.replica.sync();
      assert.equal(accepted.length-count,1,'only one resolution is committed');
      assert.equal(b.replica.conflictPreview(),null);
      assert.equal(b.replica.accessPermitted(),true);
      await Promise.all([a.close(),b.close()]);
      const fresh=await boot('New install');
      const [kept,retired] = choice==='local'?[bChoice,aChoice]:[aChoice,bChoice];
      assertIds(fresh,[kept,aOther,bOther,later]);
      const history=fresh.replica.vault.read(e=>e.snapshot().memories);
      const record=id=>history.find(r=>r.id===id);
      assert.equal(record(base).status,'superseded');
      assert.equal(record(retired).status,'retired');
      for(const id of [kept,retired]) assert.equal(record(id).supersedesId,base);
      assert.equal(record(retired).value,choice==='local'?'Approved on PC A':'Approved on PC B');
      const conditions=fresh.replica.vault.getContext({projectId:project}).conditions;
      assert.equal(conditions.filter(c=>c.key==='budget').length,1);
      assert.equal(conditions.find(c=>c.key==='budget').value,record(kept).value);
      assert.ok(fresh.replica.vault.getContext({}).conditions.every(c=>c.key!=='budget'));
    });
  }
});

test('concurrent reconnects from the same base survive a real server-side compare-and-swap loss',async t=>{
  const {boot,accepted}=await mesh(t), a=await boot('A'), b=await boot('B');
  a.link.online=false; b.link.online=false;
  const idA=await add(a,'memo-alpha','A approved this');
  const idB=await add(b,'memo-bravo','B approved this');
  const gate=Promise.withResolvers(), firstCommit=Promise.withResolvers();
  // Both requests have passed the read-only head/version preflight. Make the
  // higher UUID commit first so the canonical merged order differs from that
  // device's ancestor order; a clean reader must not re-upload merely to reorder.
  const [leader,follower]=idA>idB?[a,b]:[b,a];
  let arrived=0;
  const timeout=setTimeout(()=>gate.reject(Error('Both clients did not reach the write boundary')),process.platform==='win32'?90000:15000);
  t.after(()=>clearTimeout(timeout));
  const rendezvous=async()=>{
    if(++arrived===2) gate.resolve();
    await gate.promise;
  };
  a.link.online=true; b.link.online=true;
  leader.link.beforeWrite=rendezvous;
  leader.link.committed=()=>firstCommit.resolve();
  follower.link.beforeWrite=async()=>{await rendezvous(); await firstCommit.promise;};
  const before=accepted.length;
  await Promise.all([a.replica.sync(),b.replica.sync()]);
  clearTimeout(timeout);
  a.link.beforeWrite=null; b.link.beforeWrite=null;
  await Promise.all([a.replica.sync(),b.replica.sync()]);
  assertIds(a,[idA,idB]); assert.deepEqual(byId(a),byId(b));
  assert.equal(accepted.length-before,2);
});

test('legacy PC closing before upgrade reconstructs its previously acknowledged digest when both PCs diverged', async t=>{
  for (const collision of [false,true]) {
    await t.test(collision?'superseding the same decision':'independent approved conditions',async t=>{
      const {boot,user}=await mesh(t), a=await boot('A');
      const original=await add(a,'shared-key','Baseline');
      await a.replica.sync();
      const legacy=await boot('Legacy');
      const local=await add(legacy,collision?'shared-key':'local-key','Local edit',globalScope,collision?{supersedesId:original}:{});
      // Write the receipt exactly as the previous release left it. Both local and
      // server state will already differ from that base when the new app opens.
      await dropToLegacyReceipt(legacy,user);
      const remote=await add(a,collision?'shared-key':'other-key','Remote edit',globalScope,collision?{supersedesId:original}:{});
      await a.replica.sync();
      const upgraded=await boot('Legacy');
      if (collision) {
        const review=await syncForReview(upgraded);
        assert.equal(review.items.length,1);
        assert.equal(review.items[0].localValue,'Local edit');
        assert.equal(review.items[0].remoteValue,'Remote edit');
        await upgraded.replica.resolveConflict(review.token,{[review.items[0].id]:'local'});
        assertIds(upgraded,[local]);
        assert.equal(upgraded.replica.vault.read(e=>e.snapshot().memories.find(m=>m.id===remote)?.status),'retired');
      } else {
        await upgraded.replica.sync();
        assertIds(upgraded,[original,local,remote]);
      }
    });
  }
});

test('an observed remote deletion keeps shared reads blocked if a later poll loses network',async t=>{
  const {boot}=await mesh(t), a=await boot('A'), b=await boot('B');
  await a.replica.purge();
  await assert.rejects(b.replica.sync(),/SYNC_REMOTE_MISSING/);
  assert.equal(b.replica.accessPermitted(),false);
  b.link.online=false;
  await assert.rejects(b.replica.sync(),/SYNC_UNAVAILABLE/);
  assert.equal(b.replica.accessPermitted(),false);
});

test('interrupted incoming vault install resumes after the server advances without uploading the old device state',async t=>{
  const {boot,user,accepted}=await mesh(t);
  const a=await boot('A');
  const untouched=await add(a,'language','Use Korean');
  await a.replica.sync();
  const b=await boot('B');
  const incoming=await add(a,'release-channel','First approved decision');
  await a.replica.sync();
  const head=await a.remote.pull();
  const receipt=join(b.profile,'accounts',user,'generations',head.payload.vaultId,'remote.json');
  // Fail only the final installation into the local vault. Keep the real remote
  // download, authenticated receipt write, and on-disk profile for restart.
  b.replica.vault.applyReplica=async()=>{throw Error('SIMULATED_DISK_POWER_LOSS');};
  await assert.rejects(b.replica.sync(),/SIMULATED_DISK_POWER_LOSS/);
  assertIds(b,[untouched]);
  assert.equal(JSON.parse(await readFile(receipt,'utf8')).revision,head.revision);
  await b.close();

  const replacement=await add(a,'release-channel','New decision while B was closed',globalScope,{supersedesId:incoming});
  await a.replica.sync();
  const expected=await a.remote.head(), writes=accepted.length;
  await a.close();
  const recovered=await boot('B');
  await recovered.replica.sync();
  assertIds(recovered,[untouched,replacement]);
  assert.equal(recovered.replica.vault.read(e=>e.snapshot().memories.find(m=>m.id===incoming)?.status),'superseded');
  assert.equal(recovered.replica.status().sync,'synced');
  assert.equal(accepted.length,writes);
  assert.deepEqual(await recovered.remote.head(),expected);
});

test('an interrupted decision resolution is checked against later remote edits before replay',async t=>{
  for (const fault of ['before','after']) {
    await t.test('write interrupted '+fault+' commit',async t=>{
      const {boot,accepted}=await mesh(t);
      const a=await boot('A');
      const original=await add(a,'tone','Original tone');
      await a.replica.sync();
      const b=await boot('B');
      const aTone=await add(a,'tone','Warm',globalScope,{supersedesId:original});
      const bTone=await add(b,'tone','Direct',globalScope,{supersedesId:original});
      await b.replica.sync();
      const review=await syncForReview(a);
      a.link.interrupt=fault;
      const count=accepted.length;
      await assert.rejects(a.replica.resolveConflict(review.token,{[review.items[0].id]:'remote'}),/SYNC_UNAVAILABLE/);
      assert.equal(accepted.length-count,fault==='after'?1:0);

      // An already open writer may append locally around the interrupted operation.
      const late=await add(a,'digest','Keep the offline digest');
      await a.close();
      const c=await boot('C');
      const third=await add(c,'language','Korean');
      await c.replica.sync();
      await c.close();

      const restarted=await boot('A');
      if (fault==='before') {
        const fresh=await syncForReview(restarted);
        assert.equal(fresh.items.length,1);
        assert.equal(fresh.items[0].localValue,'Warm');
        assert.equal(fresh.items[0].remoteValue,'Direct');
        assert.notEqual(fresh.token,review.token);
        await restarted.replica.resolveConflict(fresh.token,{[fresh.items[0].id]:'local'});
      } else {
        assert.equal(restarted.replica.conflictPreview(),null,'the committed retirement is already in the successor');
      }
      await restarted.replica.sync();
      const [winner,loser]=fault==='after'?[bTone,aTone]:[aTone,bTone];
      assertIds(restarted,[winner,late,third]);
      const fourth=await boot('Fresh');
      assertIds(fourth,[winner,late,third]);
      const retired=fourth.replica.vault.read(e=>e.snapshot().memories.find(m=>m.id===loser));
      assert.equal(retired.status,'retired');
      assert.ok(retired.retirementReason.includes(winner));
    });
  }
});


test('an invalid remote envelope pauses access until a verified read succeeds',async t=>{
  const {boot}=await mesh(t), a=await boot('A'), b=await boot('B');
  const approved=await add(b,'format','Readable');
  await b.replica.sync();
  a.link.malformedRead=true;
  await assert.rejects(a.replica.sync(),/SYNC_PROTOCOL/);
  assert.equal(a.replica.accessPermitted(),false);
  a.link.online=false;
  await assert.rejects(a.replica.sync(),/SYNC_UNAVAILABLE/);
  assert.equal(a.replica.accessPermitted(),false,'network loss cannot clear the integrity failure');
  a.link.online=true;
  a.link.malformedRead=false;
  await a.replica.sync();
  assert.equal(a.replica.accessPermitted(),true);
  assertIds(a,[approved]);
});
