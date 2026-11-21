import {constants} from 'node:fs';
import {open, mkdir, lstat, rename, unlink, link, readdir} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {windowsFiles} from './windows-files.js';

export const MAX_PRIVATE_BYTES = 32 * 1024 * 1024;
const onWindows = process.platform === 'win32';

export async function privateDirectory(path: string, exclusive = false) {
  if (onWindows) {
    await windowsFiles(exclusive ? 'new-directory' : 'directory', path);
    return;
  }
  await mkdir(path, {recursive: !exclusive, mode: 0o700});
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) {
    throw Error('PRIVATE_DIRECTORY_REQUIRED');
  }
}

async function openCheckedFile(path: string, limit: number, isPrivate: boolean) {
  if (onWindows) await windowsFiles(isPrivate ? 'private-file' : 'public-file', path);
  const handle = await open(path, onWindows ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    const invalidUnixAccess = !onWindows && (stat.uid !== process.getuid?.() || (isPrivate && (stat.mode & 0o077)));
    if (!stat.isFile() || invalidUnixAccess || stat.size > limit) throw Error('INVALID_VAULT_FILE');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readOwnedFile(path: string, limit: number, isPrivate = true) {
  const handle = await openCheckedFile(path, limit, isPrivate);
  try {
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw Error('INVALID_VAULT_FILE');
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function readPrivateJSON(file: string, limit = MAX_PRIVATE_BYTES): Promise<unknown> {
  return JSON.parse((await readOwnedFile(file, limit)).toString('utf8'));
}

export async function syncDirectory(path: string) {
  // Windows commits each staged, flushed file with MoveFileExW(WRITE_THROUGH).
  // FlushFileBuffers on directory handles requires privileges a standard user lacks.
  if (onWindows) return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writePrivateJSON(file: string, value: unknown, initial = false, limit = MAX_PRIVATE_BYTES) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > limit) throw Error('VAULT_SIZE_LIMIT');
  const directory = dirname(file);
  if (onWindows) await privateDirectory(directory);
  const temporary = join(directory, `.save-${randomBytes(12).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (onWindows) {
      await windowsFiles(initial ? 'move' : 'replace', temporary, file);
    } else if (initial) {
      await link(temporary, file);
      await unlink(temporary);
    } else {
      await rename(temporary, file);
    }
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  try { await syncDirectory(directory); } catch { throw Error('COMMIT_UNCERTAIN'); }
}

// Validate all reserved staging files before pruning or deletion.
export async function stagingFiles(directory: string, limit = MAX_PRIVATE_BYTES) {
  const files: string[] = [];
  for (const name of await readdir(directory)) {
    if (!/^\.save-[a-f0-9]{24}$/.test(name)) continue;
    const file = join(directory, name);
    const handle = await openCheckedFile(file, limit, true);
    await handle.close();
    files.push(file);
  }
  return files;
}
