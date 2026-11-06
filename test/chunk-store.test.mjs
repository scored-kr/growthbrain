import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,writeFile,readdir,rm,symlink,unlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {VaultSession} from '../dist/vault.js';
import {ChunkStore} from '../dist/chunk-store.js';
import {decrypt} from '../dist/envelope.js';
import {proposal,approve} from './helpers.mjs';
async function setup(t){const root=await mkdtemp(join(tmpdir(),'gb-chunks-')),directory=join(root,'vault'),owner=randomUUID(),password=randomBytes(24).toString('base64url'),vault=await VaultSession.open(directory,owner,password,true),project=await vault.mutate(e=>e.addProject('PRIVATE_CHUNK_PROJECT'));const sessions=[vault];t.after(async()=>{for(const s of sessions)await s.close();await rm(root,{recursive:true,force:true})});return {root,directory,owner,password,vault,project,sessions}}
const disk=directory=>readFile(join(directory,'vault.json'),'utf8');
const save=async(file,value)=>writeFile(file,JSON.stringify(value),{mode:0o600});
test('chunk migration preserves original ciphertext; one-record edits reuse other encrypted objects and hide metadata',async t=>{
 const f=await setup(t),ids=await f.vault.mutate(e=>Array.from({length:100},(_,i)=>approve(e,proposal({type:'project',projectId:f.project.id},`condition_${i}`,`PRIVATE_VALUE_${i}`))));
 const before=await disk(f.directory);await f.vault.upgradeStorage();const checkpoint=f.vault.storageCheckpoint();assert.ok(checkpoint.objects.length>20);
 const backups=(await readdir(f.directory)).filter(n=>n.startsWith('pre-state-v9-'));assert.equal(backups.length,1);assert.deepEqual(JSON.parse(await readFile(join(f.directory,backups[0]),'utf8')),JSON.parse(before));
 const oldBytes=new Map(await Promise.all(checkpoint.objects.map(async h=>[h,await readFile(join(f.directory,'objects',`${h}.json`),'utf8')])));
 await f.vault.mutate(e=>e.pinMemory(f.project.id,ids[0],true));const delta=join(f.root,'delta.enc'),result=await f.vault.exportDelta(delta,checkpoint);assert.equal(result.changedObjects,1);
 for(const [id,bytes] of oldBytes)assert.equal(await readFile(join(f.directory,'objects',`${id}.json`),'utf8'),bytes);
 const all=[await disk(f.directory),...await Promise.all((await readdir(join(f.directory,'objects'))).map(n=>readFile(join(f.directory,'objects',n),'utf8')))];
 for(const marker of ['PRIVATE_CHUNK_PROJECT','PRIVATE_VALUE_',f.project.id,ids[0],'inferenceUsage'])assert.ok(!all.join('').includes(marker));
 await f.vault.exportBackup(join(f.root,'full.enc'));const opened=await decrypt(JSON.parse(await readFile(join(f.root,'full.enc'),'utf8')),f.owner,f.password);assert.equal(opened.engine.getContext({projectId:f.project.id}).conditions[0].memoryId,ids[0]);opened.key.fill(0);
 await f.vault.close();const reopened=await VaultSession.open(f.directory,f.owner,f.password);try{assert.equal(reopened.getContext({projectId:f.project.id}).conditions[0].memoryId,ids[0]);assert.equal((await reopened.pruneStorage()).removed,1)}finally{await reopened.close()}
});
test('full encrypted snapshots seed a replica; multi-commit deltas apply only to authenticated ancestors and never merge divergent work',async t=>{
 const f=await setup(t);await f.vault.mutate(e=>approve(e,proposal({type:'global'},'tone','old value')));await f.vault.upgradeStorage();const base=f.vault.storageCheckpoint(),snapshot=join(f.root,'seed.delta');await f.vault.exportDelta(snapshot);
 const replica=await VaultSession.restore(snapshot,join(f.root,'replica'),f.owner,f.password),divergent=await VaultSession.restore(snapshot,join(f.root,'divergent'),f.owner,f.password);f.sessions.push(replica,divergent);
 const old=f.vault.getContext({}).conditions[0].memoryId;await f.vault.mutate(e=>approve(e,proposal({type:'global'},'tone','new value',{supersedesId:old})));await f.vault.mutate(e=>e.propose(proposal({type:'project',projectId:f.project.id},'pending','PENDING_NEVER_CURRENT')));
 const delta=join(f.root,'changed.delta');await f.vault.exportDelta(delta,base);await replica.applyDelta(delta);assert.equal(replica.getContext({}).conditions[0].value,'new value');assert.ok(!JSON.stringify(replica.getContext({projectId:f.project.id})).includes('PENDING_NEVER_CURRENT'));await assert.rejects(replica.applyDelta(delta),/STORAGE_CONFLICT/);
 await divergent.mutate(e=>approve(e,proposal({type:'project',projectId:f.project.id},'local_work','PRESERVE_LOCAL_WORK')));const divergentBefore=await disk(join(f.root,'divergent')),forged=JSON.parse(await readFile(delta,'utf8'));forged.base=divergent.storageCheckpoint().headHash;const malicious=join(f.root,'forged.delta');await save(malicious,forged);await assert.rejects(divergent.applyDelta(malicious),/STORAGE_CONFLICT/);assert.equal(await disk(join(f.root,'divergent')),divergentBefore);
 assert.equal(divergent.getContext({projectId:f.project.id}).conditions.find(c=>c.key==='local_work').value,'PRESERVE_LOCAL_WORK');
});
test('missing, foreign and tampered objects cannot publish a partial snapshot',async t=>{
 const f=await setup(t);await f.vault.upgradeStorage();const base=f.vault.storageCheckpoint(),seed=join(f.root,'seed.delta');await f.vault.exportDelta(seed);const replica=await VaultSession.restore(seed,join(f.root,'replica'),f.owner,f.password);f.sessions.push(replica);
 await f.vault.mutate(e=>approve(e,proposal({type:'project',projectId:f.project.id},'tone','new private value')));const deltaFile=join(f.root,'changed.delta');await f.vault.exportDelta(deltaFile,base);const valid=JSON.parse(await readFile(deltaFile,'utf8')),before=await disk(join(f.root,'replica')),objectId=Object.keys(valid.objects)[0];
 for(const kind of ['missing','tampered','foreign','manifest']){const broken=structuredClone(valid);if(kind==='missing')delete broken.objects[objectId];if(kind==='tampered')broken.objects[objectId].box.ciphertext='AAAA';if(kind==='foreign')broken.objects[objectId].ownerId=randomUUID();if(kind==='manifest')broken.head.manifest.tag=randomBytes(16).toString('base64');const path=join(f.root,`${kind}.delta`);await save(path,broken);await assert.rejects(replica.applyDelta(path));assert.equal(await disk(join(f.root,'replica')),before);}
 await replica.applyDelta(deltaFile);assert.equal(replica.getContext({projectId:f.project.id}).conditions[0].value,'new private value');
});
test('interruption before publishing the head leaves a complete previous snapshot; stale writers cannot replace a later head',async t=>{
 const f=await setup(t);await f.vault.upgradeStorage();const previous=await disk(f.directory);await f.vault.mutate(e=>approve(e,proposal({type:'project',projectId:f.project.id},'tone','later value')));await f.vault.close();
 // Simulate the durable filesystem boundary: new immutable objects exist, old head is still committed.
 await writeFile(join(f.directory,'vault.json'),previous,{mode:0o600});const restored=await VaultSession.open(f.directory,f.owner,f.password);assert.deepEqual(restored.getContext({projectId:f.project.id}).conditions,[]);assert.ok((await restored.pruneStorage()).removed>0);await restored.close();
 const raw=JSON.parse(await disk(f.directory)),a=await ChunkStore.open(f.directory,raw,f.owner,f.password),b=await ChunkStore.open(f.directory,raw,f.owner,f.password);
 try{b.engine.addProject('newer local state');await b.store.commit(b.engine,b.key,b.header);const current=await disk(f.directory);a.engine.addProject('stale local state');await assert.rejects(a.store.commit(a.engine,a.key,a.header),/STORAGE_CONFLICT/);assert.equal(await disk(f.directory),current)}finally{a.key.fill(0);b.key.fill(0)}
});
test('recovery-key rotation works with chunks; compatible full backups recover into a new vault and exports survive local deletion',async t=>{
 const f=await setup(t),recoveryOne=join(f.root,'recovery-one','key.json'),recoveryTwo=join(f.root,'recovery-two','key.json');await f.vault.issueRecovery(f.password,recoveryOne);await f.vault.upgradeStorage();await f.vault.mutate(e=>approve(e,proposal({type:'global'},'language','PRIVATE_RECOVERY_VALUE')));
 await f.vault.issueRecovery(f.password,recoveryTwo);const backup=join(f.root,'full.enc');await f.vault.exportBackup(backup);const recovered=await VaultSession.recover(backup,join(f.root,'recovered'),f.owner,recoveryTwo,randomBytes(24).toString('base64url'));assert.equal(recovered.getContext({}).conditions[0].value,'PRIVATE_RECOVERY_VALUE');await recovered.close();
 await assert.rejects(VaultSession.recover(backup,join(f.root,'wrong-recovery'),f.owner,recoveryOne,randomBytes(24).toString('base64url')));
 await f.vault.deleteAll();assert.deepEqual(await readdir(f.directory),[]);assert.ok((await readFile(backup)).length>0);assert.ok((await readFile(recoveryTwo)).length>0);
});
test('prune and deletion preflight ownership, unknown files and symlinks before removing any object',async t=>{
 const f=await setup(t);await f.vault.upgradeStorage();await f.vault.mutate(e=>approve(e,proposal({type:'global'},'tone','first')));await f.vault.mutate(e=>e.pinMemory(f.project.id,e.getContext({}).conditions[0].memoryId,true));
 const objectDir=join(f.directory,'objects'),before=await readdir(objectDir),outside=join(f.root,'outside');await writeFile(outside,'DO_NOT_TOUCH',{mode:0o600});const evil=join(objectDir,`${'f'.repeat(64)}.json`);await symlink(outside,evil);await assert.rejects(f.vault.pruneStorage());assert.equal((await readdir(objectDir)).length,before.length+1);assert.equal(await readFile(outside,'utf8'),'DO_NOT_TOUCH');await unlink(evil);assert.ok((await f.vault.pruneStorage()).removed>0);
 await save(join(objectDir,'unrelated.json'),{private:'preserve'});await assert.rejects(f.vault.deleteAll());assert.ok(await readFile(join(f.directory,'vault.json')));assert.equal(JSON.parse(await readFile(join(objectDir,'unrelated.json'),'utf8')).private,'preserve');
});

test('reserved encrypted staging files are pruned safely and failed-upgrade objects are included in local deletion',async t=>{
 const f=await setup(t),old=await disk(f.directory);await f.vault.upgradeStorage();
 const temporary=join(f.directory,'objects',`.save-${'a'.repeat(24)}`);await writeFile(temporary,'partial-encrypted-write',{mode:0o600});assert.equal((await f.vault.pruneStorage()).removed,1);
 await f.vault.close();await writeFile(join(f.directory,'vault.json'),old,{mode:0o600});await writeFile(join(f.directory,`.save-${'b'.repeat(24)}`),'partial-encrypted-head',{mode:0o600});
 const reopened=await VaultSession.open(f.directory,f.owner,f.password);f.sessions.push(reopened);await reopened.deleteAll();assert.deepEqual(await readdir(f.directory),[]);
});
