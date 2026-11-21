import {execFile} from 'node:child_process';
import {unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {privateDirectory, readPrivateJSON, syncDirectory, writePrivateJSON} from './secure-files.js';

export interface TrustedAccount {
  userId: string;
  refreshToken: string;
  wrappingKey: Buffer;
}

const executable = fileURLToPath(new URL('./growthbrain-files.exe', import.meta.url));
const slotName = 'trusted-session.v1.json';
const fileSchema = z.object({
  format: z.literal('growth-brain-dpapi-session-v1'),
  blob: z.base64().min(4).max(44000),
}).strict();
const sessionSchema = z.object({
  userId: z.uuid(),
  refreshToken: z.string().min(1).max(8192),
  wrappingKey: z.base64().length(44),
}).strict();

function dpapi(operation: 'protect-session' | 'unprotect-session', input: Buffer): Promise<Buffer> {
  if (process.platform !== 'win32') throw Error('WINDOWS_TRUST_REQUIRED');
  return new Promise((resolve, reject) => {
    const failure = () => reject(Error('WINDOWS_TRUST_UNAVAILABLE'));
    const child = execFile(executable, [operation], {
      encoding: 'buffer', windowsHide: true, maxBuffer: 32 * 1024, timeout: 10000,
    }, (error, stdout) => {
      if (error) { stdout?.fill(0); failure(); }
      else resolve(stdout);
    });
    child.stdin!.on('error', failure);
    child.stdin!.end(input);
  });
}

async function readSlot(directory: string) {
  await privateDirectory(directory);
  try {
    return fileSchema.parse(await readPrivateJSON(join(directory, slotName), 46000));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw Error('TRUSTED_SESSION_INVALID');
  }
}

export async function readTrusted(directory: string): Promise<TrustedAccount | null> {
  const slot = await readSlot(directory);
  if (!slot) return null;
  const plaintext = await dpapi('unprotect-session', Buffer.from(slot.blob, 'base64'));
  try {
    const session = sessionSchema.parse(JSON.parse(plaintext.toString('utf8')));
    const wrappingKey = Buffer.from(session.wrappingKey, 'base64');
    if (wrappingKey.length !== 32) throw Error();
    return {userId: session.userId, refreshToken: session.refreshToken, wrappingKey};
  } catch {
    throw Error('TRUSTED_SESSION_INVALID');
  } finally {
    plaintext.fill(0);
  }
}

export async function writeTrusted(directory: string, record: TrustedAccount) {
  if (record.wrappingKey.length !== 32) throw Error('TRUSTED_SESSION_INVALID');
  const previous = await readSlot(directory);
  const session = sessionSchema.parse({
    userId: record.userId, refreshToken: record.refreshToken, wrappingKey: record.wrappingKey.toString('base64'),
  });
  const plaintext = Buffer.from(JSON.stringify(session));
  try {
    const blob = await dpapi('protect-session', plaintext);
    await writePrivateJSON(join(directory, slotName), {
      format: 'growth-brain-dpapi-session-v1', blob: blob.toString('base64'),
    }, previous === null, 46000);
  } finally {
    plaintext.fill(0);
  }
}

export async function forgetTrusted(directory: string) {
  if (!await readSlot(directory)) return;
  await unlink(join(directory, slotName));
  await syncDirectory(directory);
}
