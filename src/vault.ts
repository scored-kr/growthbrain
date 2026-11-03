import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { open, readFile, rename, unlink, mkdir, lstat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { MemoryEngine } from './engine.js';
import { identifier } from './model.js';

const MAX_BYTES = 16 * 1024 * 1024;
const envelopeSchema = z.object({
  version: z.literal(1), ownerId: identifier,
  salt: z.string().base64(), iv: z.string().base64(), tag: z.string().base64(), ciphertext: z.string().base64(),
}).strict();
type Envelope = z.infer<typeof envelopeSchema>;

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('PRIVATE_DIRECTORY_REQUIRED');
}
async function derive(password: string, salt: Buffer) {
  if (password.length < 12 || password.length > 1024) throw new Error('PASSPHRASE_LENGTH');
  return await new Promise<Buffer>((resolveKey, reject) => {
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolveKey(key));
  });
}
function seal(engine: MemoryEngine, key: Buffer, salt: Buffer): Envelope {
  const state = engine.snapshot();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`growth-brain:1:${state.ownerId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  return { version: 1, ownerId: state.ownerId, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
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

/** A single local process owns the unlocked key. The socket/MCP never receives it. */
export class VaultSession {
  private engine?: MemoryEngine;
  private key?: Buffer;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private constructor(private file: string, private salt: Buffer, engine: MemoryEngine, key: Buffer, private lockFile: string) {
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
      let engine: MemoryEngine; let salt: Buffer;
      if (create) {
        salt = randomBytes(16); key = await derive(password, salt);
        engine = MemoryEngine.empty(ownerId);
        await persist(file, seal(engine, key, salt), true);
      } else {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > MAX_BYTES) throw new Error('INVALID_VAULT_FILE');
        const data = envelopeSchema.parse(JSON.parse(await readFile(file, 'utf8')));
        if (data.ownerId !== ownerId) throw new Error('OWNER_MISMATCH');
        salt = Buffer.from(data.salt, 'base64');
        const iv = Buffer.from(data.iv, 'base64'); const tag = Buffer.from(data.tag, 'base64');
        if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('INVALID_ENVELOPE');
        key = await derive(password, salt);
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAAD(Buffer.from(`growth-brain:1:${ownerId}`)); decipher.setAuthTag(tag);
        let plaintext: Buffer;
        try { plaintext = Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]); }
        catch { throw new Error('UNLOCK_FAILED'); }
        try { engine = new MemoryEngine(JSON.parse(plaintext.toString('utf8'))); }
        finally { plaintext.fill(0); }
        if (engine.snapshot().ownerId !== ownerId) throw new Error('OWNER_MISMATCH');
      }
      return new VaultSession(file, salt, engine, key, lockFile);
    } catch (e) { key?.fill(0); await unlink(lockFile); throw e; }
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
      await persist(this.file, seal(next, this.key!, this.salt));
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
