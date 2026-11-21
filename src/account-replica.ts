// One cached vault belongs to one verified account. Only authenticated portable
// state leaves the device. The high-water mark survives closing the application.
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createPortableKeys, localVaultPassword, openPortable, portableState, portableEnvelopeSchema, sealPortable, unwrapPortableKeys, type PortableKeys } from './account-envelope.js';
import { describePortableConflicts, mergePortableState } from './account-merge.js';
import { MemoryEngine } from './engine.js';
import { identifier, type State } from './model.js';
import { privateDirectory, readPrivateJSON, stagingFiles, writePrivateJSON } from './secure-files.js';
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

// Older versions kept only the fingerprint. The first verified common state upgrades
// that receipt in place. A write in flight may additionally need its local input
// and proposed result to recover a lost acknowledgement without replacing later edits.
const maxReceiptBytes = 49 * 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const pendingSchema = z.object({
  source: portableEnvelopeSchema.optional(), target: portableEnvelopeSchema,
}).strict();
const checkpointSchema = z.object({
  accountId:identifier, vaultId:identifier, revision:identifier, sequence:z.number().int().positive(),
  digest:digestSchema, ancestor:portableEnvelopeSchema.optional(), pending:pendingSchema.optional(),
  installSource:portableEnvelopeSchema.optional(),
  mac:digestSchema.optional(),
}).strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
type Choices = Readonly<Record<string,'local'|'remote'>>;
type Choice = {token:string;choices:Choices};
type ConflictItem = ReturnType<typeof describePortableConflicts>[number] & {projectName?:string};
type Review = {token:string;items:ConflictItem[];revision:string;remoteDigest:string;localDigest:string};
class ConcurrentWrite extends Error {}
class ReviewChanged extends Error {
  constructor(){super('SYNC_CONFLICT');}
}
const unsafe = new Set(['SYNC_CONFLICT','SYNC_REMOTE_MISSING','SYNC_ROLLBACK','SYNC_INVALID_REMOTE',
  'SYNC_EPOCH_CHANGED','ACCOUNT_VAULT_MISMATCH','SYNC_AUTH_REQUIRED','SYNC_PROTOCOL']);

function checkpointMac(keys:PortableKeys, row:Checkpoint) {
  const {mac: _mac, ...content}=row;
  return createHmac('sha256',keys.secret).update('local-account-checkpoint/v2:').update(JSON.stringify(content)).digest();
}
async function readCheckpoint(file:string) {
  return checkpointSchema.parse(await readPrivateJSON(file,maxReceiptBytes));
}
function verifyCheckpoint(row:Checkpoint, keys:PortableKeys) {
  if (!row.mac && !row.ancestor && !row.pending && !row.installSource) return; // Original digest-only receipt.
  if (!row.mac || !row.ancestor || !timingSafeEqual(checkpointMac(keys,row),Buffer.from(row.mac,'hex')))
    throw Error('SYNC_LOCAL_CACHE_INVALID');
}
const fingerprint = (state: State, keys: PortableKeys) =>
  createHmac('sha256',keys.secret).update('portable-state-digest/v1:').update(JSON.stringify(portableState(state))).digest('hex');

// A digest-only client can already have unsent edits when the other device
// first upgrades. Guess only bounded common histories and require an exact MAC
// of the *entire* portable state before treating any candidate as the ancestor.
function recoverLegacyAncestor(local:State,remote:State,digest:string,keys:PortableKeys):State|undefined {
  function common<T>(rows:T[],others:T[],id:(row:T)=>string) {
    const ids=new Set(others.map(id));
    return rows.filter(row=>ids.has(id(row)));
  }
  const byId=(row:{id:string})=>row.id;
  for (const [first,second] of [[local,remote],[remote,local]] as const) {
    const candidate={...first,
      projects:common(first.projects,second.projects,byId),
      memories:common(first.memories,second.memories,byId),
      handoffs:common(first.handoffs,second.handoffs,byId),
      projectTriggers:common(first.projectTriggers,second.projectTriggers,r=>r.projectId),
    };
    function beforeReplacement<T extends {id:string;status:string;supersedesId?:string}>(rows:T[],left:T[],right:T[]) {
      const commonEdges=new Set(rows.map(row=>row.supersedesId));
      const allEdges=new Set([...left,...right].map(row=>row.supersedesId));
      return rows.map(row=>row.status==='superseded' && !commonEdges.has(row.id) && allEdges.has(row.id)
        ? {...row,status:'active'} : row);
    }
    for (const state of [candidate,{...candidate,
      memories:beforeReplacement(candidate.memories,first.memories,second.memories),
      handoffs:beforeReplacement(candidate.handoffs,first.handoffs,second.handoffs),
    }]) {
      try { if (fingerprint(state,keys)===digest) return state; }
      catch { /* A partial or ambiguous history is never accepted. */ }
    }
  }
}
// A later writer may have replaced the exact acknowledged envelope before our
// reply arrived. Its authenticated history must still contain every effect of
// our proposed write, including the original review and retirement evidence.
function containsProposal(target:State,current:State,base:State|undefined,source:State) {
  function contains<T>(expected:T[],actual:T[],id:(row:T)=>string,
      matches:(before:T,after:T)=>boolean=isDeepStrictEqual) {
    const rows=new Map(actual.map(row=>[id(row),row]));
    return expected.every(before=>{
      const after=rows.get(id(before));
      return after!==undefined && matches(before,after);
    });
  }
  const byId=(row:{id:string})=>row.id;
  const triggerId=(row:{projectId:string})=>row.projectId;
  const wantedTriggers=new Set(target.projectTriggers.map(triggerId));
  const currentTriggers=new Set(current.projectTriggers.map(triggerId));
  for (const prior of [...(base?.projectTriggers ?? []),...source.projectTriggers]) {
    if (!wantedTriggers.has(prior.projectId) && currentTriggers.has(prior.projectId)) return false;
  }
  return contains(target.projects,current.projects,byId) &&
    contains(target.projectTriggers,current.projectTriggers,triggerId) &&
    contains(target.handoffs,current.handoffs,byId) &&
    contains(target.memories,current.memories,byId,(before,after)=>{
      if (before.status==='active' && after.status==='superseded')
        return isDeepStrictEqual({...before,status:'superseded'},after);
      if (before.status==='active' && after.status==='retired')
        return isDeepStrictEqual({...before,status:'retired',retiredAt:after.retiredAt,retirementReason:after.retirementReason},after);
      return isDeepStrictEqual(before,after);
    });
}

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
        const meta=await readCheckpoint(receipt);
        if(meta.accountId!==accountId || meta.vaultId!==entry.name) throw Error('SYNC_LOCAL_CACHE_INVALID');
        if(vaultExists) {
          const pending=await prepareClosedVaultDeletion(vaultDir,entry.name);
          releases.push(pending.release);removals.push(pending.remove);
        }
        // The generation receipt now contains encrypted history. Include its
        // reserved, private atomic-write staging files in an explicit purge.
        for (const file of await stagingFiles(generation,maxReceiptBytes)) removals.push(()=>unlink(file));
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
  private review?:Review;
  private unsafeReason:string|null=null;
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
      const checkpoint=await exists(file) ? await readCheckpoint(file) : undefined;
      if (checkpoint) verifyCheckpoint(checkpoint,keys);
      if (pointer && pointer.vaultId!==keys.vaultId) {
        if (checkpoint) throw Error('SYNC_ROLLBACK');
        if (!startFresh) throw Error('SYNC_EPOCH_CHANGED');
      }
      if (checkpoint && (checkpoint.vaultId!==keys.vaultId || checkpoint.accountId!==accountId)) throw Error('ACCOUNT_VAULT_MISMATCH');
      const existing=await exists(join(vaultDir,'vault.json'));
      if (checkpoint && !existing) throw Error('SYNC_LOCAL_MISSING');
      vault = await VaultSession.open(vaultDir,keys.vaultId,localVaultPassword(keys),!existing);
      const replica = new AccountReplica(accountId,keys,vault,file,remote,checkpoint,head);
      try { await replica.reconcile(snapshot,record,existing); }
      catch (error) {
        if (error instanceof ConcurrentWrite) {
          try { await replica.sync(); }
          catch (retryError) { if (!replica.reviewPending()) throw retryError; }
        } else if (!replica.reviewPending()) throw error;
      }
      if (!pointer || pointer.vaultId!==keys.vaultId)
        await writePrivateJSON(pointerFile,{accountId,vaultId:keys.vaultId},!pointer,512);
      replica.monitor=setInterval(()=>replica.poll(),5000).unref();
      return replica;
    } catch (e) { await vault?.close();keys.secret.fill(0);throw e; }
  }

  private assertActive() { if(this.stopped) throw Error('VAULT_LOCKED'); }

  private async remember(next:Checkpoint) {
    this.assertActive();
    const checked=checkpointSchema.parse(next);
    checked.mac=checkpointMac(this.keys,checked).toString('hex');
    await writePrivateJSON(this.file,checked,!this.checkpoint,maxReceiptBytes);
    this.checkpoint=checked;
  }
  private receipt(snapshot:RemoteSnapshot,state:State):Checkpoint {
    return {accountId:this.accountId,vaultId:this.keys.vaultId,revision:snapshot.revision,
      sequence:snapshot.payload.sequence,digest:fingerprint(state,this.keys),ancestor:snapshot.payload};
  }
  private showConflict(revision:string,remoteDigest:string,localDigest:string,base:State|undefined,local:State,remote:State):never {
    if (this.review?.revision!==revision || this.review.localDigest!==localDigest || this.review.remoteDigest!==remoteDigest) {
      const items=base ? describePortableConflicts(base,local,remote) : [];
      const projects=new Map([...remote.projects,...local.projects].map(p=>[p.id,p.name]));
      this.review={revision,remoteDigest,localDigest,token:randomUUID(),items:items.map(item=>({
        ...item,projectName:item.projectId ? projects.get(item.projectId) : undefined,
      }))};
    }
    this.unsafeReason=this.syncError='SYNC_CONFLICT';
    throw Error('SYNC_CONFLICT');
  }
  reviewPending() { return !!this.review && this.unsafeReason==='SYNC_CONFLICT'; }
  conflictPreview() {
    if (!this.review || !this.reviewPending() || this.stopped) return null;
    const {token,items}=this.review;
    return {token,items:structuredClone(items)};
  }

  private async reconcile(snapshot:RemoteSnapshot,record:ReturnType<typeof openPortable>,existing=true,resolution?:Choice):Promise<void> {
    this.assertActive();
    const currentVersion=this.vault.changeCounter;
    const local=portableState(this.vault.replicationSnapshot());
    const localHash=fingerprint(local,this.keys), remoteHash=fingerprint(record.state,this.keys);
    const old=this.checkpoint;
    if (old && (record.sequence < old.sequence ||
        (snapshot.revision === old.revision && (old.sequence !== record.sequence || old.digest !== remoteHash)) ||
        (snapshot.revision !== old.revision && (record.sequence === old.sequence ||
         (record.sequence === old.sequence+1 && record.parentRevision !== old.revision))))) throw Error('SYNC_ROLLBACK');

    if (resolution && (!this.review || this.review.token!==resolution.token ||
        this.review.localDigest!==localHash || this.review.revision!==snapshot.revision || this.review.remoteDigest!==remoteHash)) {
      throw new ReviewChanged(); // Recompute the preview for the current branches.
    }

    let base:State|undefined;
    if (old?.ancestor) base=openPortable(this.keys,this.accountId,old.ancestor).state;
    else if (old?.revision===snapshot.revision) base=record.state;
    else if (old?.digest===localHash) base=local;
    else if (old) base=recoverLegacyAncestor(local,record.state,old.digest,this.keys);
    if (old?.installSource && base) {
      // A committed incoming snapshot and the old local input were journaled
      // together, but the process exited before finishing the local replacement.
      const source=openPortable(this.keys,this.accountId,old.installSource).state;
      if (localHash!==old.digest) {
        let recovered=base;
        if (fingerprint(source,this.keys)!==localHash) {
          try { recovered=mergePortableState(source,local,base,resolution?.choices); }
          catch { this.showConflict(snapshot.revision,remoteHash,localHash,
            old.revision===snapshot.revision ? source : undefined,local,base); }
        }
        await this.vault.applyReplica(current=>{
          if (fingerprint(current,this.keys)!==localHash) throw new ConcurrentWrite();
        },recovered);
      }
      await this.remember({...old,installSource:undefined});
      return this.reconcile(snapshot,record,existing);
    }
    let desired=local;
    const pending=old?.pending;
    const targetState=pending && openPortable(this.keys,this.accountId,pending.target).state;
    const sourceState=pending?.source ? openPortable(this.keys,this.accountId,pending.source).state : targetState;
    const accepted=pending && JSON.stringify(snapshot.payload)===JSON.stringify(pending.target);
    const awaiting=pending && snapshot.revision===pending.target.parentRevision;
    const retained=pending && targetState && sourceState && record.sequence>pending.target.sequence &&
      containsProposal(targetState,record.state,base,sourceState);
    if (pending && targetState && sourceState && (accepted || awaiting || retained)) {
      // Rebase only the edits made after the journaled local input. The remote
      // branch may already contain both the reviewed choice and newer records.
      const applied=retained ? record.state : targetState;
      if (localHash===fingerprint(sourceState,this.keys) || localHash===fingerprint(applied,this.keys)) desired=applied;
      else if (!pending.source && !retained) desired=local;
      else {
        try { desired=mergePortableState(sourceState,local,applied,resolution?.choices); }
        catch { this.showConflict(snapshot.revision,remoteHash,localHash,sourceState,local,applied); }
      }
    } else if (localHash!==remoteHash) {
      if (old && !base) this.showConflict(snapshot.revision,remoteHash,localHash,undefined,local,record.state);
      if (!old) {
        const pristine=fingerprint(MemoryEngine.empty(this.keys.vaultId).snapshot(),this.keys)===localHash;
        if (existing && !pristine) this.showConflict(snapshot.revision,remoteHash,localHash,undefined,local,record.state);
        desired=record.state;
      } else if (old.digest===localHash) {
        // Preserve the remote record order verbatim on a clean pull. Merging
        // here could reorder independent additions and publish a phantom edit.
        desired=record.state;
      } else if (snapshot.revision!==old.revision && old.digest!==remoteHash) {
        try { desired=mergePortableState(base!,local,record.state,resolution?.choices); }
        catch { this.showConflict(snapshot.revision,remoteHash,localHash,base,local,record.state); }
      }
    }
    let acknowledged=snapshot;
    const desiredHash=fingerprint(desired,this.keys);
    if (desiredHash!==remoteHash) {
      const target=awaiting && pending && targetState && fingerprint(targetState,this.keys)===desiredHash
        ? pending.target : sealPortable(this.keys,this.accountId,{
          sequence:record.sequence+1,parentRevision:snapshot.revision,state:desired});
      const input=desiredHash===localHash ? undefined : sealPortable(this.keys,this.accountId,{
        sequence:record.sequence,parentRevision:record.parentRevision,state:local});
      // Save the original common ancestor and intended change together before
      // attempting CAS. A crash cannot leave a plaintext ancestor or lose intent.
      const origin=old && base ? {...old,ancestor:old.ancestor ?? sealPortable(this.keys,this.accountId,{
        sequence:old.sequence,parentRevision:null,state:base,
      })} : this.receipt(snapshot,record.state);
      await this.remember({...origin,pending:{source:input,target}});
      this.assertActive();
      try { this.head=await this.remote.push(snapshot.revision,target); }
      catch (error) {
        if (error instanceof Error && error.message==='SYNC_CONFLICT') {
          if (resolution) throw new ReviewChanged();
          throw new ConcurrentWrite();
        }
        throw error;
      }
      this.assertActive();
      if (!this.head.revision || !this.head.bytes || this.head.revision===snapshot.revision) throw Error('SYNC_PROTOCOL');
      acknowledged={revision:this.head.revision,payload:target};
    }
    this.assertActive();
    let observed=currentVersion;
    if (desiredHash!==localHash) {
      const source=sealPortable(this.keys,this.accountId,{
        sequence:record.sequence,parentRevision:record.parentRevision,state:local,
      });
      await this.remember({...this.receipt(acknowledged,desired),installSource:source});
      await this.vault.applyReplica(current=>{
        if (fingerprint(current,this.keys)!==localHash) throw new ConcurrentWrite();
      },desired);
      observed++;
    }
    if (acknowledged.revision!==old?.revision || !old?.ancestor || this.checkpoint?.pending || this.checkpoint?.installSource)
      await this.remember(this.receipt(acknowledged,desired));
    this.confirmed=observed;this.lastCheck=Date.now();this.syncError=null;this.unsafeReason=null;this.review=undefined;
  }

  async resolveConflict(token:string,choices:Choices) {
    if (this.running) await this.running.catch(()=>{});
    this.assertActive();
    if (this.deleting || !this.review || this.review.token!==token || !this.review.items.length ||
        Object.keys(choices).length!==this.review.items.length ||
        !this.review.items.every(item=>Object.hasOwn(choices,item.id) && ['local','remote'].includes(choices[item.id]!)))
      throw Error('SYNC_CONFLICT');
    return this.runSync({token,choices});
  }

  accessPermitted() {
    return !this.stopped && !this.unsafeReason;
  }

  async purge() {
    this.deleting=true;
    if (this.running) await this.running;
    this.assertActive();
    if (!this.checkpoint) throw Error('SYNC_CONFLICT');
    const current=await this.remote.head();
    if (current.revision !== this.checkpoint.revision || !current.bytes) throw Error('SYNC_CONFLICT');
    const accountDirectory=dirname(dirname(dirname(this.file)));
    const stages=await stagingFiles(dirname(this.file),maxReceiptBytes);
    const oldCaches=await prepareOldCaches(accountDirectory,this.accountId,this.keys.vaultId);
    try {
      const tombstone=await this.remote.purge(current.revision);
      if (tombstone.bytes !== 0 || !tombstone.revision || tombstone.revision === current.revision) throw Error('SYNC_PROTOCOL');
      try {
        await this.vault.deleteAll();
        await oldCaches.remove();
        const stored=await readCheckpoint(this.file);
        if(stored.accountId!==this.accountId || stored.vaultId!==this.keys.vaultId) throw Error('SYNC_LOCAL_CACHE_INVALID');
        for (const file of stages) await unlink(file);
        await unlink(this.file);
      } catch { throw Error('SYNC_PURGED_LOCAL_INCOMPLETE'); }
    } finally { await oldCaches.release(); }
  }

  sync() {
    this.assertActive();
    if (this.running) return this.running;
    return this.runSync();
  }
  private runSync(resolution?:Choice) {
    this.running=this.syncRetry(resolution).catch(e=>{
      if (e instanceof ReviewChanged) throw e;
      if (e instanceof Error && unsafe.has(e.message)) this.unsafeReason=e.message;
      this.syncError=e instanceof Error && (unsafe.has(e.message) || ['SYNC_QUOTA','SYNC_UNCONFIGURED'].includes(e.message))
        ? e.message : 'SYNC_UNAVAILABLE';
      throw e;
    }).finally(()=>{this.running=undefined;this.lastCheck=Date.now()});
    return this.running;
  }

  private async syncRetry(resolution?:Choice) {
    for (let attempt=0;attempt<4;attempt++) {
      try { return await this.syncOnce(resolution); }
      catch(error) {
        if (error instanceof ReviewChanged || (resolution && error instanceof ConcurrentWrite)) {
          // Discard the outdated decision. If the latest branches still diverge,
          // normal reconciliation rebuilds the review and keeps external reads gated.
          await this.syncRetry();
          throw new ReviewChanged();
        }
        if (!(error instanceof ConcurrentWrite)) throw error;
      }
    }
    throw Error('SYNC_UNAVAILABLE');
  }
  private async syncOnce(resolution?:Choice) {
    this.head=await this.remote.head();this.assertActive();
    if (!this.head.bytes || !this.head.revision) throw Error('SYNC_REMOTE_MISSING');
    if (!resolution && !this.unsafeReason && !this.checkpoint?.pending && !this.checkpoint?.installSource && this.head.revision === this.checkpoint?.revision && this.confirmed === this.vault.changeCounter) {
      this.syncError=null;return;
    }
    const snapshot=await this.remote.pull();this.assertActive();
    if (!snapshot) throw Error('SYNC_REMOTE_MISSING');
    if (snapshot.payload.vaultId !== this.keys.vaultId) throw Error('SYNC_EPOCH_CHANGED');
    let record:ReturnType<typeof openPortable>;
    try { record=openPortable(this.keys,this.accountId,snapshot.payload); }
    catch { throw Error('SYNC_INVALID_REMOTE'); }
    await this.reconcile(snapshot,record,true,resolution);
  }

  poll() {
    if (!this.stopped && !this.deleting && !this.running && Date.now()-this.lastCheck>15000)
      void this.sync().catch(()=>{}); // status exposes the classified error and retries on the next interval
  }
  status() {
    const error=this.unsafeReason ?? this.syncError;
    return {sync:error ? (['SYNC_CONFLICT','SYNC_ROLLBACK','SYNC_REMOTE_MISSING'].includes(error)?'conflict':'unavailable') :
      (this.running || this.confirmed!==this.vault.changeCounter?'pending':'synced'),error,
      pendingChanges:!!this.checkpoint?.pending || this.confirmed!==this.vault.changeCounter,bytes:this.head.bytes,quota:this.head.quota};
  }
  async stop() {
    this.stopped=true;
    clearInterval(this.monitor);
    try { await this.running; } catch { /* The local copy remains intact for the next verified sync. */ }
    finally { this.keys.secret.fill(0); }
  }
}
