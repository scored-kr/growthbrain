import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultSession } from '../dist/vault.js';
import { startBroker, callBroker } from '../dist/broker.js';
import { proposal, approve } from './helpers.mjs';

async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'gb-recovery-'));
 const owner=randomUUID(), password=randomBytes(32).toString('base64url');
 const directory=join(root,'vault'), keyFile=join(root,'offline','vault.recovery');
 const session=await VaultSession.open(directory,owner,password,true);
 t.after(async()=>{await session.close();await rm(root,{recursive:true,force:true});});
 const project=await session.mutate(e=>e.addProject('RECOVERY_PRIVATE_PROJECT'));
 await session.mutate(e=>approve(e,proposal({type:'project',projectId:project.id},'tone','RECOVERY_PRIVATE_MEMORY')));
 return {root,owner,password,directory,keyFile,session,project};
}

test('v1 opt-in migration, password-loss recovery and fresh-key restoration preserve memory',async t=>{
 const f=await fixture(t), original=join(f.directory,'vault.json'), oldBackup=join(f.root,'before.enc');
 await f.session.exportBackup(oldBackup);
 assert.equal(JSON.parse(await readFile(original,'utf8')).version,1);
 const result=await f.session.issueRecovery(f.password,f.keyFile);
 const key=JSON.parse(await readFile(f.keyFile,'utf8')).key;
 const text=await readFile(original,'utf8');
 assert.equal(JSON.parse(text).version,2);
 for(const secret of [key,f.password,'RECOVERY_PRIVATE'])assert.ok(!text.includes(secret));
 assert.ok(!JSON.stringify(result).includes(key));
 assert.equal((await stat(f.keyFile)).mode&0o777,0o600);
 const backup=join(f.root,'after.enc');await f.session.exportBackup(backup);
 const nextPassword=randomBytes(32).toString('base64url'), target=join(f.root,'recovered');
 await assert.rejects(VaultSession.recover(oldBackup,target,f.owner,f.keyFile,nextPassword),/RECOVERY_NOT_ENABLED/);
 const recovered=await VaultSession.recover(backup,target,f.owner,f.keyFile,nextPassword);
 assert.equal(recovered.read(e=>e.getContext({projectId:f.project.id})).conditions[0].value,'RECOVERY_PRIVATE_MEMORY');
 await recovered.close();
 assert.equal(JSON.parse(await readFile(join(target,'vault.json'),'utf8')).recovery,undefined);
 await assert.rejects(VaultSession.open(target,f.owner,f.password),/UNLOCK_FAILED/);
 const reopened=await VaultSession.open(target,f.owner,nextPassword);await reopened.close();
 await assert.rejects(VaultSession.recover(backup,target,f.owner,f.keyFile,nextPassword),{code:'EEXIST'});
 const legacy=await VaultSession.restore(oldBackup,join(f.root,'legacy'),f.owner,f.password);await legacy.close();
 const regular=await VaultSession.restore(backup,join(f.root,'regular'),f.owner,f.password);await regular.close();
});

test('reissuing recovery invalidates old key on new snapshots, not historical backups',async t=>{
 const f=await fixture(t), backup=join(f.root,'previous.enc'), second=join(f.root,'offline','second.recovery');
 await f.session.issueRecovery(f.password,f.keyFile);await f.session.exportBackup(backup);
 await Promise.all([f.session.issueRecovery(f.password,second),f.session.mutate(e=>e.addProject('AFTER_ROTATION'))]);
 const current=join(f.directory,'vault.json');
 await assert.rejects(VaultSession.recover(current,join(f.root,'bad'),f.owner,f.keyFile,f.password),/UNLOCK_FAILED/);
 const old=await VaultSession.recover(backup,join(f.root,'old'),f.owner,f.keyFile,f.password);await old.close();
 const latest=await VaultSession.recover(current,join(f.root,'latest'),f.owner,second,f.password);
 assert.equal(latest.read(e=>e.snapshot().projects.length),2);await latest.close();
 await f.session.close();const reopened=await VaultSession.open(f.directory,f.owner,f.password);await reopened.close();
});

test('tampered slots, wrong recovery credentials and unsafe files fail before creating a target',async t=>{
 const f=await fixture(t);await f.session.issueRecovery(f.password,f.keyFile);
 const file=join(f.directory,'vault.json'), original=JSON.parse(await readFile(file,'utf8'));
 const badKey=join(f.root,'offline','bad.recovery'), credential=JSON.parse(await readFile(f.keyFile,'utf8'));
 await writeFile(badKey,JSON.stringify({...credential,key:randomBytes(32).toString('base64url')}),{mode:0o600});
 const target=join(f.root,'target');
 await assert.rejects(VaultSession.recover(file,target,f.owner,badKey,f.password),/UNLOCK_FAILED/);
 await assert.rejects(VaultSession.recover(file,target,randomUUID(),f.keyFile,f.password),/OWNER_MISMATCH/);
 await chmod(f.keyFile,0o644);
 await assert.rejects(VaultSession.recover(file,target,f.owner,f.keyFile,f.password),/INVALID_RECOVERY_FILE/);
 await chmod(f.keyFile,0o600);
 const variants=[{...original,tag:Buffer.alloc(16).toString('base64')},
  {...original,password:{...original.password,salt:randomBytes(16).toString('base64')}},
  {...original,recovery:{...original.recovery,tag:Buffer.alloc(16).toString('base64')}}];
 const altered=join(f.root,'altered.enc');
 for(const envelope of variants){
  await writeFile(altered,JSON.stringify(envelope),{mode:0o600});
  await assert.rejects(VaultSession.recover(altered,target,f.owner,f.keyFile,f.password),/UNLOCK_FAILED/);
 }
 await assert.rejects(stat(target),{code:'ENOENT'});
 // Removing a recovery slot also invalidates password-based authentication of the payload.
 const {recovery,...removed}=original;
 await writeFile(altered,JSON.stringify(removed));
 await assert.rejects(VaultSession.restore(altered,target,f.owner,f.password),/UNLOCK_FAILED/);
 assert.equal(await readFile(file,'utf8'),JSON.stringify(original));
});

test('issuance refuses repository/co-located/existing paths and exposes no recovery route over IPC',async t=>{
 const f=await fixture(t), original=await readFile(join(f.directory,'vault.json'),'utf8');
 const repo=join(f.root,'repo');await mkdir(join(repo,'.git'),{recursive:true,mode:0o700});
 await assert.rejects(f.session.issueRecovery(f.password,join(repo,'secret.recovery')),/RECOVERY_IN_REPOSITORY/);
 await assert.rejects(f.session.issueRecovery(f.password,join(f.directory,'secret.recovery')),/KEEP_RECOVERY_SEPARATE/);
 await assert.rejects(f.session.issueRecovery('incorrect-password',f.keyFile),/UNLOCK_FAILED/);
 assert.equal(await readFile(join(f.directory,'vault.json'),'utf8'),original);
 await f.session.issueRecovery(f.password,f.keyFile);
 const before=await readFile(join(f.directory,'vault.json'),'utf8');
 await assert.rejects(f.session.issueRecovery(f.password,f.keyFile),{code:'EEXIST'});
 const link=join(f.root,'link');await symlink(repo,link);
 await assert.rejects(f.session.issueRecovery(f.password,join(link,'secret.recovery')));
 assert.equal(await readFile(join(f.directory,'vault.json'),'utf8'),before);
 const broker=await startBroker(f.session,f.directory);
 try {
  await assert.rejects(callBroker(broker.path,'issue_recovery',{}),/INVALID_REQUEST/);
  await assert.rejects(callBroker(broker.path,'recover',{}),/INVALID_REQUEST/);
 } finally {await broker.close();}
});
