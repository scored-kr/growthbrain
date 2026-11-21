// One cached vault belongs to one verified account. Only authenticated portable
// state leaves the device. The high-water mark survives closing the application.
import { createHash, createHmac } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { createPortableKeys, localVaultPassword, openPortable, portableState, sealPortable, unwrapPortableKeys, type PortableKeys } from './account-envelope.js';
import { MemoryEngine } from './engine.js';
import { identifier, type State } from './model.js';
import { privateDirectory, readPrivateJSON, writePrivateJSON } from './secure-files.js';
import type { RemoteSnapshot, RemoteVault, RemoteHead } from './sync-remote.js';
import { prepareClosedVaultDeletion, VaultSession } from './vault.js';

const snapshotDigest = (snapshot:RemoteSnapshot) => createHash('sha256').update(JSON.stringify(snapshot.payload)).digest('hex');
/** Raised only when a schema-validated remote snapshot cannot unwrap for a verified account. */
export class UnrecoverableSnapshot extends Error {
  readonly expiresAt=Date.now()+300000;
  constructor(readonly accountId:string, readonly revision:string, readonly digest:string) { super('ACCOUNT_RECOVERY_REQUIRED'); }
  async erase(remote:RemoteVault,userId:string,wrappingKey:Buffer,accountDirectory:string) {
    if(userId!==this.accountId || Date.now()>=this.expiresAt) throw Error('ACCOUNT_RECOVERY_EXPIRED');
    const snapshot=await remote.pull();
    if(!snapshot || snapshot.revision!==this.revision || snapshotDigest(snapshot)!==this.digest) throw Error('SYNC_CONFLICT');
    let accessible:PortableKeys|undefined;
    try { accessible=unwrapPortableKeys(userId,wrappingKey,snapshot.payload); }
    catch(e) { if(!(e instanceof Error && e.message==='UNLOCK_FAILED')) throw e; }
    if(accessible){accessible.secret.fill(0);throw Error('SYNC_CONFLICT');}
    const local=await prepareOldCaches(accountDirectory,userId);
    try {
      const deleted=await remote.purge(this.revision);
      if(deleted.bytes!==0 || !deleted.revision || deleted.revision===this.revision) throw Error('SYNC_PROTOCOL');
      try { await local.remove(); } catch { throw Error('SYNC_PURGED_LOCAL_INCOMPLETE'); }
    } finally { await local.release(); }
  }
}

const checkpointSchema = z.object({
  accountId:identifier, vaultId:identifier, revision:identifier, sequence:z.number().int().positive(),
  digest:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
const fingerprint = (state: State, keys: PortableKeys) =>
  createHmac('sha256',keys.secret).update('portable-state-digest/v1:').update(JSON.stringify(portableState(state))).digest('hex');

async function exists(file:string) {
  try { await lstat(file); return true; }
  catch (e) { if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return false; throw e; }
}

// Only generations with both the matching account receipt and vault owner ID
// can be removed. Unknown files (including user exports) are never recursively deleted.
async function prepareOldCaches(directory:string, accountId:string, current?:string) {
  const generations=join(directory,'generations');
  const removals:Array<()=>Promise<void>>=[], releases:Array<()=>Promise<void>>=[];
  const release=async()=>{
    const results=await Promise.allSettled(releases.map(fn=>fn()));
    for (const result of results) if(result.status==='rejected') throw result.reason;
  };
  try {
    if (await exists(generations)) {
      await privateDirectory(generations);
      for (const entry of await readdir(generations,{withFileTypes:true})) {
        if(!identifier.safeParse(entry.name).success || entry.name===current) continue;
        if(!entry.isDirectory() || entry.isSymbolicLink()) throw Error('SYNC_LOCAL_CACHE_INVALID');
        const generation=join(generations,entry.name);
        await privateDirectory(generation);
        const receipt=join(generation,'remote.json'), vaultDir=join(generation,'vault');
        const vaultExists=await exists(join(vaultDir,'vault.json'));
        if(!await exists(receipt)) {
          if(vaultExists) throw Error('SYNC_LOCAL_CACHE_INVALID');
          continue;
        }
        const meta=checkpointSchema.parse(await readPrivateJSON(receipt,4096));
        if(meta.accountId!==accountId || meta.vaultId!==entry.name) throw Error('SYNC_LOCAL_CACHE_INVALID');
        if(vaultExists) {
          const pending=await prepareClosedVaultDeletion(vaultDir,entry.name);
          releases.push(pending.release);removals.push(pending.remove);
        }
        removals.push(()=>unlink(receipt));
      }
    }
    return {release,remove:async()=>{for(const fn of removals) await fn();}};
  } catch(e){await release();throw e;}
}

export class AccountReplica {
  private stopped = false;
  private running?:Promise<void>;
  private confirmed = -1;
  private syncError:string|null = null;
  private lastCheck = 0;
  private monitor?: NodeJS.Timeout;
  private deleting=false;
  private constructor(readonly accountId:string, private keys:PortableKeys, readonly vault:VaultSession,
    private file:string, private remote:RemoteVault, private checkpoint:Checkpoint|undefined,
    private head:RemoteHead) {}

  static async connect(base:string,accountId:string,wrappingKey:Buffer,remote:RemoteVault,startFresh=false) {
    identifier.parse(accountId);
    const directory = join(base,'accounts',accountId);
    await privateDirectory(directory);
    const pointerFile=join(directory,'current.json');
    const pointer=await exists(pointerFile) ? z.object({accountId:identifier,vaultId:identifier}).strict()
      .parse(await readPrivateJSON(pointerFile,512)) : undefined;
    if (pointer && pointer.accountId!==accountId) throw Error('ACCOUNT_VAULT_MISMATCH');
    let head = await remote.head();
    let snapshot = head.bytes ? await remote.pull() : null;
    if (!snapshot) {
      // An empty head with a non-null revision is a deletion tombstone. Never
      // regenerate it with an old client's locally retained copy.
      if (head.bytes || (head.revision ? !startFresh : !!pointer)) throw Error('SYNC_REMOTE_MISSING');
      const first = createPortableKeys(accountId,wrappingKey);
      try {
        const payload = sealPortable(first,accountId,{sequence:1,parentRevision:head.revision,state:MemoryEngine.empty(first.vaultId).snapshot()});
        try {
          head = await remote.push(head.revision,payload);
          if (!head.revision) throw Error('SYNC_INVALID_RESPONSE');
          snapshot = {revision:head.revision,payload};
        } catch (e) {
          if (!(e instanceof Error && e.message === 'SYNC_CONFLICT')) throw e;
          snapshot = await remote.pull();
          if (!snapshot) throw e;
        }
      } finally { first.secret.fill(0); }
    }
    let keys:PortableKeys;
    try { keys=unwrapPortableKeys(accountId,wrappingKey,snapshot.payload); }
    catch(e) {
      if (e instanceof Error && e.message==='UNLOCK_FAILED')
        throw new UnrecoverableSnapshot(accountId,snapshot.revision,snapshotDigest(snapshot));
      throw e;
    }
    let vault:VaultSession|undefined;
    try {
      const record = openPortable(keys,accountId,snapshot.payload);
      // Each incarnation has a new key and directory, even when the same account
      // explicitly starts over after deletion. Never upload a former generation.
      const generation=join(directory,'generations',keys.vaultId);
      const file=join(generation,'remote.json'),vaultDir=join(generation,'vault');
      const checkpoint=await exists(file) ? checkpointSchema.parse(await readPrivateJSON(file,4096)) : undefined;
      if (pointer && pointer.vaultId!==keys.vaultId) {
        if (checkpoint) throw Error('SYNC_ROLLBACK');
        if (!startFresh) throw Error('SYNC_EPOCH_CHANGED');
      }
      if (checkpoint && (checkpoint.vaultId!==keys.vaultId || checkpoint.accountId!==accountId)) throw Error('ACCOUNT_VAULT_MISMATCH');
      const existing=await exists(join(vaultDir,'vault.json'));
      if (checkpoint && !existing) throw Error('SYNC_LOCAL_MISSING');
      vault = await VaultSession.open(vaultDir,keys.vaultId,localVaultPassword(keys),!existing);
      const replica = new AccountReplica(accountId,keys,vault,file,remote,checkpoint,head);
      await replica.reconcile(snapshot,record,existing);
      if (!pointer || pointer.vaultId!==keys.vaultId)
        await writePrivateJSON(pointerFile,{accountId,vaultId:keys.vaultId},!pointer,512);
      replica.monitor=setInterval(()=>replica.poll(),5000).unref();
      return replica;
    } catch (e) { await vault?.close();keys.secret.fill(0);throw e; }
  }

  private readState() { return this.vault.read(e=>e.snapshot()); }
  private assertActive() { if(this.stopped) throw Error('VAULT_LOCKED'); }

  // Compare both sides with the last acknowledgement. If a write committed on
  // the server but its reply was lost, equality lets the next sync acknowledge it.
  private async reconcile(snapshot:RemoteSnapshot,record:ReturnType<typeof openPortable>,existing=true) {
    this.assertActive();
    const currentVersion=this.vault.changeCounter;
    const local=this.readState();
    const localHash=fingerprint(local,this.keys), remoteHash=fingerprint(record.state,this.keys);
    const old=this.checkpoint;
    if (old) {
      if (record.sequence < old.sequence ||
          (snapshot.revision === old.revision && (old.sequence !== record.sequence || old.digest !== remoteHash)) ||
          (snapshot.revision !== old.revision && (record.sequence === old.sequence ||
           (record.sequence === old.sequence+1 && record.parentRevision !== old.revision)))) throw Error('SYNC_ROLLBACK');
    }
    let revision = snapshot.revision, sequence = record.sequence, digest = remoteHash, observed = currentVersion;
    if (localHash !== remoteHash) {
      if (old && old.revision === snapshot.revision && existing) {
        const payload = sealPortable(this.keys,this.accountId,{sequence:sequence+1,parentRevision:revision,state:local});
        this.head = await this.remote.push(revision,payload);
        this.assertActive();
        if (!this.head.revision) throw Error('SYNC_INVALID_RESPONSE');
        revision=this.head.revision;sequence++;digest=localHash;
      } else {
        const pristine = localHash === fingerprint(MemoryEngine.empty(this.keys.vaultId).snapshot(),this.keys);
        if (existing && ((old && localHash !== old.digest) || (!old && !pristine))) throw Error('SYNC_CONFLICT');
        await this.vault.mutate(engine=>{
          if (fingerprint(engine.snapshot(),this.keys) !== localHash) throw Error('SYNC_CONFLICT');
          engine.applyAccountState(record.state);
        });
        observed = currentVersion + 1;
      }
    }
    this.assertActive();
    const next={accountId:this.accountId,vaultId:this.keys.vaultId,revision,sequence,digest};
    if (!old || old.revision !== revision) await writePrivateJSON(this.file,next,!old);
    this.checkpoint=next;this.confirmed=observed;this.lastCheck=Date.now();this.syncError=null;
  }

  accessPermitted() {
    return !this.stopped && !['SYNC_CONFLICT','SYNC_REMOTE_MISSING','SYNC_ROLLBACK','SYNC_INVALID_REMOTE','SYNC_EPOCH_CHANGED','ACCOUNT_VAULT_MISMATCH','SYNC_AUTH_REQUIRED'].includes(this.syncError ?? '');
  }

  async purge() {
    this.deleting=true;
    if (this.running) await this.running;
    this.assertActive();
    if (!this.checkpoint) throw Error('SYNC_CONFLICT');
    const current=await this.remote.head();
    if (current.revision !== this.checkpoint.revision || !current.bytes) throw Error('SYNC_CONFLICT');
    const accountDirectory=dirname(dirname(dirname(this.file)));
    const oldCaches=await prepareOldCaches(accountDirectory,this.accountId,this.keys.vaultId);
    try {
      const tombstone=await this.remote.purge(current.revision);
      if (tombstone.bytes !== 0 || !tombstone.revision || tombstone.revision === current.revision) throw Error('SYNC_PROTOCOL');
      try {
        await this.vault.deleteAll();
        await oldCaches.remove();
        const stored=checkpointSchema.parse(await readPrivateJSON(this.file,4096));
        if(stored.accountId!==this.accountId || stored.vaultId!==this.keys.vaultId) throw Error('SYNC_LOCAL_CACHE_INVALID');
        await unlink(this.file);
      } catch { throw Error('SYNC_PURGED_LOCAL_INCOMPLETE'); }
    } finally { await oldCaches.release(); }
  }

  sync() {
    this.assertActive();
    if (this.running) return this.running;
    this.running=this.syncOnce().catch(e=>{
      this.syncError=e instanceof Error && ['SYNC_CONFLICT','SYNC_ROLLBACK','SYNC_QUOTA','SYNC_REMOTE_MISSING','SYNC_UNCONFIGURED','SYNC_AUTH_REQUIRED','SYNC_INVALID_REMOTE','SYNC_EPOCH_CHANGED','ACCOUNT_VAULT_MISMATCH'].includes(e.message)
        ? e.message : 'SYNC_UNAVAILABLE';
      throw e;
    }).finally(()=>{this.running=undefined;this.lastCheck=Date.now()});
    return this.running;
  }

  private async syncOnce() {
    this.head=await this.remote.head();this.assertActive();
    if (!this.head.bytes || !this.head.revision) throw Error('SYNC_REMOTE_MISSING');
    if (this.head.revision === this.checkpoint?.revision && this.confirmed === this.vault.changeCounter) {
      this.syncError=null;return;
    }
    const snapshot=await this.remote.pull();this.assertActive();
    if (!snapshot) throw Error('SYNC_REMOTE_MISSING');
    if (snapshot.payload.vaultId !== this.keys.vaultId) throw Error('SYNC_EPOCH_CHANGED');
    let record:ReturnType<typeof openPortable>;
    try { record=openPortable(this.keys,this.accountId,snapshot.payload); }
    catch { throw Error('SYNC_INVALID_REMOTE'); }
    await this.reconcile(snapshot,record);
  }

  poll() {
    if (!this.stopped && !this.deleting && !this.running && Date.now()-this.lastCheck>15000)
      void this.sync().catch(()=>{}); // status exposes the classified error and retries on the next interval
  }
  status() {
    const error=this.syncError;
    return {sync:error ? (['SYNC_CONFLICT','SYNC_ROLLBACK','SYNC_REMOTE_MISSING'].includes(error)?'conflict':'unavailable') :
      (this.running || this.confirmed!==this.vault.changeCounter?'pending':'synced'),error,
      bytes:this.head.bytes,quota:this.head.quota};
  }
  async stop() {
    this.stopped=true;
    clearInterval(this.monitor);
    try { await this.running; } catch { /* The local copy remains intact for the next verified sync. */ }
    finally { this.keys.secret.fill(0); }
  }
}
