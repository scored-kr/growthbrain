import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir, lstat, rmdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, basename } from 'node:path';
import { MemoryEngine } from './engine.js';
import { identifier } from './model.js';
import { envelopeSchema, recoverySchema, derive, decrypt, decryptRecovery, seal, newHeader, type Envelope, type Header } from './envelope.js';

const MAX_BYTES = 16 * 1024 * 1024;

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('PRIVATE_DIRECTORY_REQUIRED');
}
async function readEnvelope(file: string) {
  const stat=await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid!==process.getuid?.() || (stat.mode & 0o077) || stat.size>MAX_BYTES) throw new Error('INVALID_VAULT_FILE');
  return envelopeSchema.parse(JSON.parse(await readFile(file,'utf8')));
}
async function persist(file: string, data: Envelope, initial = false) {
  const text = JSON.stringify(data);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('VAULT_SIZE_LIMIT');
  const temporary = join(dirname(file), `.save-${randomBytes(12).toString('hex')}`);
  const target = initial ? file : temporary;
  const handle = await open(target, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  catch (e) { await handle.close(); await unlink(target).catch(() => {}); throw e; }
  await handle.close();
  if (!initial) {
    try { await rename(temporary, file); } catch (e) { await unlink(temporary).catch(() => {}); throw e; }
  }
}

async function recoveryDestination(file: string, vaultFile: string) {
  await privateDirectory(dirname(file));
  file = join(await realpath(dirname(file)), basename(file));
  const inside = relative(await realpath(dirname(vaultFile)), file);
  if (!inside || (inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside))) throw new Error('KEEP_RECOVERY_SEPARATE');
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
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > 1024) throw new Error('INVALID_RECOVERY_FILE');
  return recoverySchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

/** A single local process owns the unlocked key. The socket/MCP never receives it. */
export class VaultSession {
  private engine?: MemoryEngine;
  private key?: Buffer;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private constructor(private file: string, private header: Header, engine: MemoryEngine, key: Buffer, private lockFile: string) {
    this.engine = engine; this.key = key;
  }
  static async open(directory: string, ownerId: string, password: string, create = false) {
    identifier.parse(ownerId);
    directory = resolve(directory);
    await privateDirectory(directory);
    const file = join(directory, 'vault.json');
    const lockFile = join(directory, 'vault.lock');
    let lock;
    try { lock = await open(lockFile, 'wx', 0o600); } catch { throw new Error('VAULT_ALREADY_OPEN_OR_STALE_LOCK'); }
    await lock.writeFile(String(process.pid)); await lock.close();
    let key: Buffer | undefined;
    try {
      let engine: MemoryEngine; let header: Header;
      if (create) {
        const salt = randomBytes(16); key = await derive(password, salt);
        header = {version:1,ownerId,salt:salt.toString('base64')};
        engine = MemoryEngine.empty(ownerId);
        await persist(file, seal(engine, key, header), true);
      } else {
        ({engine,key,header}=await decrypt(await readEnvelope(file),ownerId,password));
      }
      return new VaultSession(file, header, engine, key, lockFile);
    } catch (e) { key?.fill(0); await unlink(lockFile); throw e; }
  }
  static async restore(backup: string, directory: string, ownerId: string, password: string) {
    identifier.parse(ownerId);
    const {engine,key,header}=await decrypt(await readEnvelope(resolve(backup)),ownerId,password);
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
    try { await mkdir(directory,{mode:0o700}); }
    catch(e) { key.fill(0);throw e; }
    const file=join(directory,'vault.json'), lockFile=join(directory,'vault.lock');
    try {
      const lock=await open(lockFile,'wx',0o600);
      try {await lock.writeFile(String(process.pid));} finally {await lock.close();}
      await persist(file,seal(engine,key,header),true);
      return new VaultSession(file,header,engine,key,lockFile);
    } catch(e) {
      key.fill(0);
      // Only remove files created in the new, owned directory; never overwrite a pre-existing vault.
      await unlink(lockFile).catch(()=>{});await unlink(file).catch(()=>{});await rmdir(directory).catch(()=>{});
      throw e;
    }
  }
  async exportBackup(destination: string) {
    if(this.closing)throw new Error('VAULT_LOCKED');
    destination=resolve(destination);
    const run=this.queue.then(async()=>{
      this.requireOpen();await privateDirectory(dirname(destination));
      await persist(destination,await readEnvelope(this.file),true);
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
      const verified = await decrypt(await readEnvelope(this.file), ownerId, password);
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
        await persist(this.file, seal(engine, key, header));
        this.key!.fill(0); this.key = key; this.header = header; committed = true;
        return { path: destination, recoveryEnabled: true };
      } finally {
        recoveryKey.fill(0);
        if (!committed) { key.fill(0); if (created) await unlink(destination).catch(() => {}); }
      }
    });
    this.queue = run.catch(() => {}); return await run;
  }
  private requireOpen() { if (!this.engine || !this.key) throw new Error('VAULT_LOCKED'); return this.engine; }
  read<T>(operation: (engine: MemoryEngine) => T) {
    if (this.closing) throw new Error('VAULT_LOCKED');
    // Return a detached view so read operations cannot mutate the durable engine.
    return operation(new MemoryEngine(this.requireOpen().snapshot()));
  }
  mutate<T>(operation: (engine: MemoryEngine) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('VAULT_LOCKED'));
    const run = this.queue.then(async () => {
      const next = new MemoryEngine(this.requireOpen().snapshot());
      const result = operation(next);
      await persist(this.file, seal(next, this.key!, this.header));
      this.engine = next;
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async close() {
    this.closing = true;
    await this.queue;
    if (!this.key) return;
    this.key.fill(0); this.key = undefined; this.engine = undefined;
    await unlink(this.lockFile);
  }
  async deleteAll() {
    this.closing = true;
    await this.queue;
    this.requireOpen();
    await unlink(this.file);
    await this.close();
  }
}
