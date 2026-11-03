import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultSession } from '../dist/vault.js';
import { proposal, approve } from './helpers.mjs';

async function setup(t) {
  const directory=await mkdtemp(join(tmpdir(),'gb-vault-'));
  const owner=randomUUID();const password=randomBytes(24).toString('base64url');
  let session=await VaultSession.open(directory,owner,password,true);
  t.after(async()=>{await session.close();await rm(directory,{recursive:true,force:true});});
  return {directory,owner,password,get session(){return session},set session(v){session=v}};
}
test('all content/provenance is encrypted; fresh IV on write; reopen and owner/passphrase checks',async t=>{
  const f=await setup(t);
  const project=await f.session.mutate(e=>e.addProject('SENSITIVE_PROJECT_MARKER'));
  const first=JSON.parse(await readFile(join(f.directory,'vault.json'),'utf8'));
  await f.session.mutate(e=>approve(e,proposal({type:'project',projectId:project.id},'tone','SENSITIVE_MEMORY_MARKER',{source:{kind:'user',reference:'SENSITIVE_SOURCE_MARKER',excerpt:'SENSITIVE_EXCERPT_MARKER'}})));
  const text=await readFile(join(f.directory,'vault.json'),'utf8');const second=JSON.parse(text);
  for(const marker of ['SENSITIVE_PROJECT_MARKER','SENSITIVE_MEMORY_MARKER','SENSITIVE_SOURCE_MARKER','SENSITIVE_EXCERPT_MARKER',f.password])assert.ok(!text.includes(marker));
  assert.notEqual(first.iv,second.iv);
  assert.equal((await stat(join(f.directory,'vault.json'))).mode & 0o777,0o600);
  await assert.rejects(VaultSession.open(f.directory,f.owner,f.password),/VAULT_ALREADY_OPEN/);
  await f.session.close();
  assert.throws(()=>f.session.read(e=>e.snapshot()),/VAULT_LOCKED/);
  await assert.rejects(VaultSession.open(f.directory,randomUUID(),f.password),/OWNER_MISMATCH/);
  await assert.rejects(VaultSession.open(f.directory,f.owner,'wrong-passphrase-long-enough'),/UNLOCK_FAILED/);
  f.session=await VaultSession.open(f.directory,f.owner,f.password);
  assert.equal(f.session.read(e=>e.getContext({projectId:project.id})).conditions[0].value,'SENSITIVE_MEMORY_MARKER');
});
test('authenticated ciphertext rejects tampering and unknown versions',async t=>{
  const f=await setup(t);await f.session.close();
  const path=join(f.directory,'vault.json');const original=JSON.parse(await readFile(path,'utf8'));
  const changed={...original,tag:Buffer.alloc(16).toString('base64')};
  await writeFile(path,JSON.stringify(changed));
  await assert.rejects(VaultSession.open(f.directory,f.owner,f.password),/UNLOCK_FAILED/);
  await writeFile(path,JSON.stringify({...original,version:99}));
  await assert.rejects(VaultSession.open(f.directory,f.owner,f.password));
});
test('serialized concurrent writes survive reopen; invalid mutation rolls back; delete removes only local vault',async t=>{
  const f=await setup(t);
  await Promise.all(Array.from({length:10},(_,i)=>f.session.mutate(e=>e.addProject(`Project ${i}`))));
  await assert.rejects(f.session.mutate(e=>{e.addProject('Must rollback');throw new Error('abort');}));
  assert.equal(f.session.read(e=>e.snapshot().projects.length),10);
  await f.session.close();f.session=await VaultSession.open(f.directory,f.owner,f.password);
  assert.equal(f.session.read(e=>e.snapshot().projects.length),10);
  await f.session.deleteAll();
  await assert.rejects(readFile(join(f.directory,'vault.json')), {code:'ENOENT'});
  await assert.rejects(f.session.mutate(e=>e.addProject('after lock')),/VAULT_LOCKED/);
});

test('encrypted backup restores only to a new directory after authentication',async t=>{
  const f=await setup(t);
  const project=await f.session.mutate(e=>e.addProject('BACKUP_PRIVATE_NAME'));
  await f.session.mutate(e=>approve(e,proposal({type:'project',projectId:project.id},'tone','BACKUP_PRIVATE_MEMORY')));
  const backup=join(f.directory,'backup.enc');await f.session.exportBackup(backup);
  const bytes=await readFile(backup,'utf8');assert.ok(!bytes.includes('BACKUP_PRIVATE'));
  await assert.rejects(f.session.exportBackup(backup),{code:'EEXIST'});
  assert.equal(await readFile(backup,'utf8'),bytes);
  const target=join(f.directory,'restored');
  await assert.rejects(VaultSession.restore(backup,target,f.owner,'incorrect-long-password'),/UNLOCK_FAILED/);
  await assert.rejects(stat(target),{code:'ENOENT'});
  await assert.rejects(VaultSession.restore(backup,f.directory,f.owner,f.password),{code:'EEXIST'});
  const restored=await VaultSession.restore(backup,target,f.owner,f.password);
  try {assert.equal(restored.read(e=>e.getContext({projectId:project.id})).conditions[0].value,'BACKUP_PRIVATE_MEMORY');}
  finally {await restored.close();}
  assert.equal(f.session.read(e=>e.snapshot().projects[0].name),'BACKUP_PRIVATE_NAME');
});
