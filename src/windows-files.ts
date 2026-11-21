import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const execute = promisify(execFile);
const executable = fileURLToPath(new URL('./growthbrain-files.exe', import.meta.url));

type FileOperation = 'directory' | 'new-directory' | 'private-file' | 'public-file' |
  'move' | 'replace' | 'lock' | 'release';

/** Only paths and an opaque process handle go through the native helper. */
export async function windowsFiles(operation: FileOperation, ...args: string[]) {
  if (process.platform !== 'win32') throw Error('WINDOWS_REQUIRED');
  try {
    const {stdout} = await execute(executable, [operation, ...args], {windowsHide: true, maxBuffer: 256});
    return stdout;
  } catch (cause) {
    const status = cause instanceof Error && 'code' in cause ? cause.code : undefined;
    if (status === 2 || status === 3) {
      throw Object.assign(Error('WINDOWS_FILE_UNAVAILABLE'), {code: status === 2 ? 'EEXIST' : 'ENOENT'});
    }
    throw Error('WINDOWS_PRIVATE_STORAGE_REQUIRED');
  }
}
