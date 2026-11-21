import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopController } from '../dist/desktop-controller.js';
import { privateDirectory } from '../dist/secure-files.js';
import { SupabaseRemoteVault } from '../dist/sync-remote.js';
import { createSyncRpcFixture } from './support/sync-rpc-fixture.mjs';

test('desktop reports a local save while sync is stalled, reviews both decisions, then fails closed on expired identity', {timeout:process.platform==='win32'?240000:90000}, async t => {
  const root=join(process.platform==='win32'?homedir():tmpdir(),'gb-desktop-offline-'+randomUUID());
  await privateDirectory(root,true);
  const server=await createSyncRpcFixture();
  const userId=randomUUID(), email='desktop@example.invalid', password=randomBytes(24).toString('hex');
  const wrappingKey=randomBytes(32), clients=[];
  const blocked=Promise.withResolvers(), entered=Promise.withResolvers();
  t.after(async()=>{
    blocked.resolve();
    try { for (const pc of clients) await pc.controller.close(); }
    finally { wrappingKey.fill(0);await server.close();await rm(root,{recursive:true,force:true}); }
  });
  function device(name) {
    let identity=null, sequence=0;
    const link={offline:false,hold:false,expired:false};
    const auth={
      configured:true,contractVerified:true,clear:()=>{identity=null;},
      identity:()=>link.expired ? null : identity,
      async login(e,p) {
        if (e!==email || p!==password || link.offline) throw Error('ACCOUNT_AUTH_FAILED');
        identity={userId,email,expiresAt:Date.now()+3600000};
        return {...identity,wrappingKey:Buffer.from(wrappingKey)};
      },
      async requireVerifiedUser() {
        if (!this.identity()) throw Error('ACCOUNT_SESSION_EXPIRED');
        if (link.offline) throw Error('ACCOUNT_NETWORK_UNAVAILABLE');
        return identity;
      },
    };
    const remote=new SupabaseRemoteVault({
      publishableKey:'sb_publishable_'+'fixture'.repeat(6),contractVerified:true,getAccessToken:async()=>userId,
      fetch:async(url,init)=>{
        if (link.hold) { entered.resolve();await blocked.promise; }
        if (link.offline) throw new TypeError('Test network disconnected');
        const {body,status}=await server.rpc(userId,new URL(url).pathname.split('/').at(-1),JSON.parse(init.body));
        return Response.json(body,{status});
      },
    });
    const controller=new DesktopController(join(root,name,'vault'),undefined,{auth,remote});
    const send=(op,fields={})=>controller.handle({id:++sequence,op,...fields});
    const pc={controller,send,link,async run(op,fields={}) {
      const reply=await send(op,fields);assert.ok(reply.ok,op+': '+reply.error);return reply;
    }};
    clients.push(pc);return pc;
  }
  const a=device('A'), b=device('B');
  await a.run('accountLogin',{email,password});
  const projectId=(await a.run('addProject',{name:'Campaign'})).result.projects[0].id;
  const initial={projectId,key:'channel',value:'Print'};
  await a.run('addPreference',initial);
  await a.run('accountSync');
  await b.run('accountLogin',{email,password});
  const previous=(await b.send('addPreference',{...initial,value:'Newsletter'})).previous;
  assert.ok(previous);
  const change={...initial,supersedesId:previous.id};
  b.link.offline=true;b.link.hold=true;
  const local=await b.run('addPreference',{...change,value:'Newsletter'});
  assert.equal(local.localSaved,true);
  await entered.promise;
  assert.equal(local.result.account.pendingChanges,true);
  assert.equal((await b.run('previewContext',{projectId})).preview.conditions[0].value,'Newsletter');
  b.link.hold=false;blocked.resolve();
  assert.equal((await b.send('accountSync')).error,'ACCOUNT_NETWORK_UNAVAILABLE');
  const offline=(await b.run('status')).result.account;
  assert.ok(offline.signedIn && offline.pendingChanges);
  assert.equal(offline.sync,'unavailable');

  await a.run('addPreference',{...change,value:'Blog'});
  await a.run('accountSync');
  b.link.offline=false;
  assert.equal((await b.send('accountSync')).error,'SYNC_CONFLICT');
  const state=(await b.run('status')).result;
  assert.ok(state.account.signedIn && state.account.review);
  assert.deepEqual(state.projects,[]);assert.equal(state.web.state,'off');
  assert.equal((await b.send('previewContext',{projectId})).error,'VAULT_LOCKED');
  const {conflict}=await b.run('reviewSyncConflicts');
  assert.equal(conflict.total,1);assert.equal(conflict.items[0].localValue,'Newsletter');
  assert.equal(conflict.items[0].remoteValue,'Blog');assert.equal(conflict.items[0].projectId,projectId);
  assert.equal((await b.send('resolveSyncConflicts',{token:randomUUID(),decisions:'L'})).error,'SYNC_CONFLICT');
  assert.equal((await b.send('resolveSyncConflicts',{token:conflict.token,decisions:'LR'})).error,'SYNC_CONFLICT');
  b.link.offline=true;
  assert.equal((await b.send('resolveSyncConflicts',{token:conflict.token,decisions:'L'})).error,'ACCOUNT_NETWORK_UNAVAILABLE');
  assert.equal((await b.run('reviewSyncConflicts')).conflict.token,conflict.token);
  b.link.offline=false;
  const resolved=(await b.run('resolveSyncConflicts',{token:conflict.token,decisions:'R'})).result.account;
  assert.equal(resolved.review,false);assert.equal(resolved.sync,'synced');
  assert.equal((await b.run('previewContext',{projectId})).preview.conditions[0].value,'Blog');
  b.link.expired=true;
  assert.equal((await b.run('status')).result.account.signedIn,false);
  assert.equal((await b.send('reviewSyncConflicts')).error,'ACCOUNT_SESSION_EXPIRED');
  assert.equal((await b.send('previewContext',{projectId})).error,'VAULT_LOCKED');
});
