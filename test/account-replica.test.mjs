import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopController } from '../dist/desktop-controller.js';
import { AccountReplica } from '../dist/account-replica.js';
import { approve, proposal } from './helpers.mjs';

class Remote {
  revision=null;
  payload=null;
  async head(){return {revision:this.revision,bytes:this.payload?JSON.stringify(this.payload).length:0,quota:2000000};}
  async pull(){return this.payload?structuredClone({revision:this.revision,payload:this.payload}):null;}
  async push(prev,payload){if(prev!==this.revision)throw Error('SYNC_CONFLICT');this.revision=randomUUID();this.payload=structuredClone(payload);return this.head();}
  async purge(prev){if(prev!==this.revision)throw Error('SYNC_CONFLICT');this.revision=randomUUID();this.payload=null;return this.head();}
}

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'gb-replica-')), remote=new Remote(),user=randomUUID(),wrap=randomBytes(32);
  const sessions=[];
  t.after(async()=>{
    for(const x of sessions){await x.stop();await x.vault.close();}
    await rm(root,{recursive:true,force:true});
  });
  async function open(label,startFresh=false){const x=await AccountReplica.connect(join(root,label),user,wrap,remote,startFresh);sessions.push(x);return x;}
  return {root,remote,user,open,wrap};
}

test('pull keeps device-specific consents local, preserving project scope on both devices',async t=>{
  const {open,remote}=await setup(t);
  const a=await open('A');
  const project=await a.vault.mutate(e=>e.addProject('Secret project'));
  await a.vault.mutate(e=>{
    e.configureCapture({enabled:true,site:'chatgpt.com',projectId:project.id});
    approve(e,proposal({type:'project',projectId:project.id},'tone','Approved conditional'));
  });
  await a.sync();
  const b=await open('B');
  assert.equal(b.vault.read(e=>e.snapshot().captureSettings.length),0);
  assert.deepEqual(b.vault.getContext({}).conditions,[]);
  assert.equal(b.vault.getContext({projectId:project.id}).conditions[0].value,'Approved conditional');
  await b.vault.mutate(e=>approve(e,proposal({type:'global'},'language','Explicit global choice')));
  await b.sync();await a.sync();
  assert.equal(a.vault.read(e=>e.snapshot().captureSettings.length),1);
  assert.equal(a.vault.getContext({}).conditions[0].value,'Explicit global choice');
  assert.ok(!JSON.stringify(remote.payload).includes('Secret project'));
});

test('disjoint projects from live writers survive reconciliation and an older remote snapshot is rejected',async t=>{
  const {open,remote}=await setup(t),a=await open('A'),b=await open('B');
  const first=await remote.pull();
  await a.vault.mutate(e=>e.addProject('A divergent'));
  await b.vault.mutate(e=>e.addProject('B divergent'));
  await a.sync();
  await b.sync();
  assert.equal(b.status().sync,'synced');
  assert.deepEqual(b.vault.listProjects().map(p=>p.name).sort(),['A divergent','B divergent']);
  await a.sync();
  assert.deepEqual(a.vault.listProjects().map(p=>p.name).sort(),['A divergent','B divergent']);
  await b.stop();await b.vault.close();
  remote.payload=first.payload;
  remote.revision=first.revision;
  await assert.rejects(a.sync(),/SYNC_ROLLBACK/);
  assert.equal(a.accessPermitted(),false);
});

test('reauthenticated purge removes only the account vault, preserves unrelated local files and prevents stale resurrection',async t=>{
  const {open,remote,root,user}=await setup(t),a=await open('A'),b=await open('B');
  const sibling=join(root,'A','accounts',user,'generations',remote.payload.vaultId,'vault','unrelated.txt');
  await writeFile(sibling,'SYNTHETIC');
  await a.purge();
  assert.equal(await readFile(sibling,'utf8'),'SYNTHETIC');
  assert.equal((await remote.head()).bytes,0);
  await assert.rejects(b.sync(),/SYNC_REMOTE_MISSING/);
  assert.equal(b.accessPermitted(),false);
  await assert.rejects(open('fresh'),/SYNC_REMOTE_MISSING/);
  const previousId=b.vault.read(e=>e.snapshot().ownerId);
  const fresh=await open('fresh',true);
  assert.notEqual(fresh.vault.read(e=>e.snapshot().ownerId),previousId);
  assert.deepEqual(fresh.vault.listProjects(),[]);
  await b.stop();await b.vault.close();
  const oldCache=join(root,'B','accounts',user,'generations',previousId,'vault','vault.json');
  const saved=await readFile(oldCache);
  await assert.rejects(open('B'),/SYNC_EPOCH_CHANGED/);
  const renewed=await open('B',true);
  assert.deepEqual(renewed.vault.listProjects(),[]);
  assert.deepEqual(await readFile(oldCache),saved);
  const sentinel=join(root,'B','accounts',user,'generations',previousId,'vault','user-owned');
  await writeFile(sentinel,'keep');
  await renewed.purge();
  await assert.rejects(access(oldCache),{code:'ENOENT'});
  assert.equal(await readFile(sentinel,'utf8'),'keep');
});

test('password reset cannot replace account ciphertext until fresh reauth and exact-revision erase confirmation',async t=>{
  const {root,user,wrap,open,remote}=await setup(t), old=await open('PC');
  await old.vault.mutate(e=>e.addProject('Prior memory'));
  await old.sync();await old.stop();await old.vault.close();
  const email='synthetic@example.invalid', password=randomBytes(24).toString('base64url'), resetKey=randomBytes(32);
  let identity=null;
  const auth={
    configured:true,contractVerified:true,
    identity:()=>identity, clear:()=>{identity=null;},
    login:async(e,p)=>{
      if (e!==email || p!==password) throw Error('ACCOUNT_AUTH_FAILED');
      identity={userId:user,email,expiresAt:Date.now()+3600000};return {...identity,wrappingKey:Buffer.from(resetKey)};
    },
    logout:async()=>{identity=null;},
  };
  const desktop = new DesktopController(join(root,'PC','vault'),undefined,{auth,remote});
  t.after(()=>desktop.close());
  const run=(op,fields={})=>desktop.handle({id:7,op,...fields});
  const erase={email,password,confirmation:'ERASE UNRECOVERABLE MEMORY'};
  const prev=await remote.pull();
  assert.equal((await run('accountPurgeUnrecoverable',erase)).error,'ACCOUNT_RECOVERY_EXPIRED');
  assert.equal((await run('accountLogin',{email,password})).error,'ACCOUNT_RECOVERY_REQUIRED');
  assert.equal((await run('status')).result.unlocked,false);
  assert.equal((await run('accountPurgeUnrecoverable',{...erase,password:'a wrong password'})).error,'ACCOUNT_AUTH_FAILED');
  assert.deepEqual(await remote.pull(),prev);
  // Same owner commits another authenticated change while the recovery warning is open.
  const other=await AccountReplica.connect(join(root,'other'),user,wrap,remote);
  try {await other.vault.mutate(e=>e.addProject('Concurrent')); await other.sync();}
  finally {await other.stop();await other.vault.close();}
  assert.equal((await run('accountPurgeUnrecoverable',erase)).error,'SYNC_CONFLICT');
  assert.equal((await run('accountLogin',{email,password})).error,'ACCOUNT_RECOVERY_REQUIRED');
  assert.equal((await run('accountPurgeUnrecoverable',{...erase,confirmation:'no'})).error,'INVALID_INPUT');
  const fresh=await run('accountPurgeUnrecoverable',erase);
  assert.equal(fresh.ok,true,fresh.error);
  assert.equal(fresh.result.account.signedIn,true);
  assert.deepEqual(fresh.result.projects,[]);
  assert.notEqual(remote.payload.vaultId,prev.payload.vaultId);
  await assert.rejects(access(join(root,'PC','accounts',user,'generations',prev.payload.vaultId,'vault','vault.json')),{code:'ENOENT'});
  await desktop.close();
});
