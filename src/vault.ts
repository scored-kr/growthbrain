import { randomBytes } from 'node:crypto';
import { open, unlink, lstat, rmdir, realpath, readdir } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, basename, sep } from 'node:path';
import { MemoryEngine } from './engine.js';
import { identifier, STATE_VERSION, type TaskType } from './model.js';
import { envelopeSchema, recoverySchema, derive, decrypt, decryptRecovery, seal, sealState, newHeader, type Envelope, type Header } from './envelope.js';

import {ChunkStore,chunkHeadSchema,deltaSchema,ownedChunkObjects} from './chunk-store.js';
import {windowsFiles} from './windows-files.js';
import {privateDirectory,readPrivateJSON,writePrivateJSON,stagingFiles} from './secure-files.js';
export {privateDirectory} from './secure-files.js';

const MAX_BYTES = 16 * 1024 * 1024;
// Reserved for snapshots the app creates before state upgrades; never a recursive delete.
const MIGRATION_BACKUP = /^pre-state-v[1-9][0-9]*-[a-f0-9]{24}\.enc$/;

async function readEnvelope(file:string){return envelopeSchema.parse(await readPrivateJSON(file,MAX_BYTES))}
async function persist(file:string,data:Envelope,initial=false){await writePrivateJSON(file,data,initial,MAX_BYTES)}

async function recoveryDestination(file: string, vaultFile: string) {
  await privateDirectory(dirname(file));
  file = join(await realpath(dirname(file)), basename(file));
  const inside = relative(await realpath(dirname(vaultFile)), file);
  if (!inside || (inside !== '..' && !inside.startsWith('..'+sep) && !isAbsolute(inside))) throw new Error('KEEP_RECOVERY_SEPARATE');
  // Never create a plaintext recovery file inside a working tree, including worktrees with a .git file.
  for (let path = dirname(file); ; path = dirname(path)) {
    const git = await lstat(join(path, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (git) throw new Error('RECOVERY_IN_REPOSITORY');
    if (path === dirname(path)) break;
  }
  return file;
}
async function readRecovery(file: string) {
  try {
    return recoverySchema.parse(await readPrivateJSON(file, 1024));
  } catch {
    throw Error('INVALID_RECOVERY_FILE');
  }
}

async function acquireVaultLock(file: string): Promise<() => Promise<void>> {
  try {
    if (process.platform === 'win32') {
      const handle = await windowsFiles('lock', file);
      if (!/^[1-9][0-9]*$/.test(handle)) throw Error('INVALID_LOCK');
      return async () => { await windowsFiles('release', file, handle); };
    }
    const fd = await open(file, 'wx', 0o600);
    try {
      await fd.writeFile(String(process.pid));
    } catch (error) {
      await unlink(file);
      throw error;
    } finally { await fd.close(); }
    return async () => { await unlink(file); };
  } catch {
    throw Error('VAULT_ALREADY_OPEN_OR_STALE_LOCK');
  }
}

/** A single local process owns the unlocked key. The socket/MCP never receives it. */
export class VaultSession {
  private engine?: MemoryEngine;
  private key?: Buffer;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private failedCommit=false;
  private chunks?:ChunkStore;
  private constructor(private file: string, private header: Header, engine: MemoryEngine, key: Buffer, private releaseLock: () => Promise<void>) {
    this.engine = engine; this.key = key;
  }
  static async open(directory: string, ownerId: string, password: string, create = false) {
    identifier.parse(ownerId);
    directory = resolve(directory);
    await privateDirectory(directory);
    const file = join(directory, 'vault.json');
    const lockFile = join(directory, 'vault.lock');
    const release = await acquireVaultLock(lockFile);
    let key: Buffer | undefined;
    try {
      let engine: MemoryEngine; let header: Header;let chunks:ChunkStore|undefined;
      if (create) {
        const salt = randomBytes(16); key = await derive(password, salt);
        header = {version:1,ownerId,salt:salt.toString('base64')};
        engine = MemoryEngine.empty(ownerId);
        await persist(file, seal(engine, key, header), true);
      } else {
        const raw=await readPrivateJSON(file,MAX_BYTES);
        if(chunkHeadSchema.safeParse(raw).success){
          const opened=await ChunkStore.open(directory,raw,ownerId,password);({engine,key,header}=opened);chunks=opened.store;
          if(opened.sourceStateVersion<STATE_VERSION)await persist(join(directory,`pre-state-v${STATE_VERSION}-${randomBytes(12).toString('hex')}.enc`),sealState(opened.rawState,key,header),true);
        }else{
          const data=envelopeSchema.parse(raw),opened=await decrypt(data,ownerId,password);({engine,key,header}=opened);
          if(opened.sourceStateVersion<STATE_VERSION)await persist(join(directory,`pre-state-v${STATE_VERSION}-${randomBytes(12).toString('hex')}.enc`),data,true);
        }
      }
      const session=new VaultSession(file,header,engine,key,release);session.chunks=chunks;return session;
    } catch (e) { key?.fill(0); await release(); throw e; }
  }
  static async restore(backup: string, directory: string, ownerId: string, password: string) {
    identifier.parse(ownerId);
    const data=await readPrivateJSON(resolve(backup));
    if(deltaSchema.safeParse(data).success){
      const restored=await ChunkStore.restore(data,resolve(directory),ownerId,password);const lockFile=join(resolve(directory),'vault.lock');
      try{const release=await acquireVaultLock(lockFile);const session=new VaultSession(join(resolve(directory),'vault.json'),restored.header,restored.engine,restored.key,release);session.chunks=restored.store;return session;}catch(e){restored.key.fill(0);throw e}
    }
    const {engine,key,header}=await decrypt(envelopeSchema.parse(data),ownerId,password);
    return await this.restoreOpened(directory,engine,key,header);
  }
  static async recover(backup: string, directory: string, ownerId: string, recoveryFile: string, newPassword: string) {
    identifier.parse(ownerId);
    const opened = decryptRecovery(await readEnvelope(resolve(backup)), ownerId, await readRecovery(resolve(recoveryFile)));
    const key = randomBytes(32);
    try {
      // Rotate the data key and do not carry the old recovery credential into the recovered vault.
      const header = await newHeader(ownerId, newPassword, key);
      return await this.restoreOpened(directory, opened.engine, key, header);
    } catch (error) { key.fill(0); throw error; }
    finally { opened.key.fill(0); }
  }
  private static async restoreOpened(directory: string, engine: MemoryEngine, key: Buffer, header: Header) {
    directory=resolve(directory);
    try { await privateDirectory(directory,true); }
    catch(e) { key.fill(0);throw e; }
    const file=join(directory,'vault.json'), lockFile=join(directory,'vault.lock');
    let release;
    try {
      release = await acquireVaultLock(lockFile);
      await persist(file,seal(engine,key,header),true);
      return new VaultSession(file,header,engine,key,release);
    } catch(e) {
      key.fill(0);
      // Only remove files created in the new, owned directory; never overwrite a pre-existing vault.
      await release?.();await rmdir(directory).catch(()=>{});
      throw e;
    }
  }
  async exportBackup(destination: string) {
    if(this.closing)throw new Error('VAULT_LOCKED');
    destination=resolve(destination);
    if (dirname(destination) === dirname(this.file) && MIGRATION_BACKUP.test(basename(destination))) throw new Error('RESERVED_BACKUP_NAME');
    const run=this.queue.then(async()=>{
      this.requireOpen();await privateDirectory(dirname(destination));
      await persist(destination,this.chunks?seal(this.requireOpen(),this.key!,this.header):await readEnvelope(this.file),true);
      return {path:destination,encrypted:true};
    });
    this.queue=run.catch(()=>{});return await run;
  }
  async issueRecovery(password: string, destination: string) {
    if (this.closing) throw new Error('VAULT_LOCKED');
    destination = resolve(destination);
    const run = this.queue.then(async () => {
      const engine = this.requireOpen(), ownerId = engine.snapshot().ownerId;
      destination = await recoveryDestination(destination, this.file);
      // Require the current passphrase again. A caller with only an unlocked socket has no such API.
      const verified = this.chunks?await ChunkStore.open(dirname(this.file),await readPrivateJSON(this.file),ownerId,password):await decrypt(await readEnvelope(this.file),ownerId,password);
      verified.key.fill(0);
      const key = randomBytes(32), recoveryKey = randomBytes(32);
      let created = false, committed = false;
      try {
        const header = await newHeader(ownerId, password, key, recoveryKey);
        const handle = await open(destination, 'wx', 0o600); created = true;
        try {
          await handle.writeFile(JSON.stringify({ format: 'growth-brain-recovery', version: 1, ownerId, key: recoveryKey.toString('base64url') }));
          await handle.sync();
        } finally { await handle.close(); }
        if(this.chunks)await this.chunks.commit(engine,key,header);else await persist(this.file, seal(engine, key, header));
        this.key!.fill(0); this.key = key; this.header = header; committed = true;
        return { path: destination, recoveryEnabled: true };
      } catch(error){if(error instanceof Error&&error.message==='COMMIT_UNCERTAIN')this.failedCommit=true;throw error;} finally {
        recoveryKey.fill(0);
        if (!committed) { key.fill(0); if (created) await unlink(destination).catch(() => {}); }
      }
    });
    this.queue = run.catch(() => {}); return await run;
  }
  private requireOpen() { if (this.failedCommit || !this.engine || !this.key) throw new Error('VAULT_LOCKED'); return this.engine; }
  read<T>(operation: (engine: MemoryEngine) => T) {
    if (this.closing) throw new Error('VAULT_LOCKED');
    // Return a detached view so read operations cannot mutate the durable engine.
    return operation(new MemoryEngine(this.requireOpen().snapshot()));
  }
  assertUnlocked(){if(this.closing)throw new Error('VAULT_LOCKED');this.requireOpen()}
  listProjects(){this.assertUnlocked();return this.requireOpen().listProjects()}
  getContext(input:unknown,commonOnly=false) {
    if(this.closing)throw new Error('VAULT_LOCKED');
    return structuredClone(this.requireOpen().getContext(input,commonOnly));
  }
  search(projectId:string|undefined,query:string,limit=20,requestConditions:unknown={},taskType?:TaskType,commonOnly=false) {
    if(this.closing)throw new Error('VAULT_LOCKED');
    return structuredClone(this.requireOpen().search(projectId,query,limit,requestConditions,taskType,commonOnly));
  }
  mutate<T>(operation: (engine: MemoryEngine) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('VAULT_LOCKED'));
    const run = this.queue.then(async () => {
      const next = this.requireOpen().fork();
      const result = operation(next);
      try{if(this.chunks)await this.chunks.commit(next,this.key!,this.header);else await persist(this.file, seal(next, this.key!, this.header));}catch(error){if(error instanceof Error&&error.message==='COMMIT_UNCERTAIN')this.failedCommit=true;throw error;}
      this.engine = next;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async upgradeStorage(){
    if(this.closing)throw Error('VAULT_LOCKED');const run=this.queue.then(async()=>{
      const engine=this.requireOpen();if(this.chunks)return {format:'chunks',alreadyEnabled:true};
      const backup=join(dirname(this.file),`pre-state-v${STATE_VERSION}-${randomBytes(12).toString('hex')}.enc`);
      await persist(backup,await readEnvelope(this.file),true);
      try{this.chunks=await ChunkStore.upgrade(dirname(this.file),engine,this.key!,this.header);}catch(e){if(e instanceof Error&&e.message==='COMMIT_UNCERTAIN')this.failedCommit=true;throw e}
      return {format:'chunks',backupPreserved:true};
    });this.queue=run.catch(()=>{});return await run;
  }
  storageCheckpoint(){this.assertUnlocked();if(!this.chunks)throw Error('CHUNK_STORAGE_REQUIRED');return this.chunks.checkpoint()}
  async exportDelta(destination:string,previous?:unknown){
    if(this.closing)throw Error('VAULT_LOCKED');const run=this.queue.then(async()=>{this.requireOpen();if(!this.chunks)throw Error('CHUNK_STORAGE_REQUIRED');destination=resolve(destination);if(dirname(destination)===dirname(this.file)&&MIGRATION_BACKUP.test(basename(destination)))throw Error('RESERVED_BACKUP_NAME');if(dirname(destination)===join(dirname(this.file),'objects'))throw Error('RESERVED_BACKUP_NAME');await privateDirectory(dirname(destination));const delta=await this.chunks.exportDelta(previous);await writePrivateJSON(destination,delta,true);return {encrypted:true,changedObjects:Object.keys(delta.objects).length,checkpoint:this.chunks.checkpoint()};});this.queue=run.catch(()=>{});return await run;
  }
  async applyDelta(file:string){
    if(this.closing)throw Error('VAULT_LOCKED');const run=this.queue.then(async()=>{this.requireOpen();if(!this.chunks)throw Error('CHUNK_STORAGE_REQUIRED');try{const next=await this.chunks.applyDelta(await readPrivateJSON(resolve(file)));this.engine=next.engine;this.header=next.header;return {applied:true,checkpoint:this.chunks.checkpoint()};}catch(e){if(e instanceof Error&&e.message==='COMMIT_UNCERTAIN')this.failedCommit=true;throw e}});this.queue=run.catch(()=>{});return await run;
  }
  async pruneStorage(){if(this.closing)throw Error('VAULT_LOCKED');const run=this.queue.then(async()=>{this.requireOpen();if(!this.chunks)throw Error('CHUNK_STORAGE_REQUIRED');return await this.chunks.prune()});this.queue=run.catch(()=>{});return await run;}
  async close() {
    this.closing = true;
    await this.queue;
    if (!this.key) return;
    this.key.fill(0); this.key = undefined; this.engine = undefined;this.chunks?.clear();
    await this.releaseLock();
  }
  async deleteAll() {
    if (this.closing) throw new Error('VAULT_LOCKED');
    this.closing = true;
    const deleting = this.queue.then(async () => {
      this.requireOpen();
      const directory = dirname(this.file);
      await privateDirectory(directory);
      const backups = (await readdir(directory)).filter(name => MIGRATION_BACKUP.test(name)).sort().map(name => join(directory, name));
      // Validate the entire managed set before deleting any file. Historical keys can differ
      // after recovery rotation, so do not require the current key to decrypt old snapshots.
      for (const file of [this.file, ...backups]) {
        const raw=await readPrivateJSON(file,MAX_BYTES);const envelope=file===this.file&&this.chunks?chunkHeadSchema.parse(raw):envelopeSchema.parse(raw);
        if (envelope.ownerId !== this.header.ownerId) throw new Error('BACKUP_OWNER_MISMATCH');
      }
      const stages=await stagingFiles(directory),objectsPath=join(directory,'objects');
      const objectsExist=await lstat(objectsPath).catch((e:NodeJS.ErrnoException)=>{if(e.code!=='ENOENT')throw e;return undefined});
      const objects=objectsExist?await ownedChunkObjects(objectsPath,this.header.ownerId):[];
      // Keep the primary vault until all managed backups are removed. A filesystem failure
      // can still leave a partially deleted set; callers must never report full success then.
      for(const file of objects)await unlink(file);if(objectsExist)await rmdir(objectsPath);
      for(const file of stages)await unlink(file);
      for (const backup of backups) await unlink(backup);
      await unlink(this.file);
    });
    // Concurrent close/signal waits for this operation before releasing the process lock.
    this.queue = deleting.catch(() => {});
    try { await deleting; }
    finally { await this.close(); }
  }
}
