import {constants} from 'node:fs';
import {open,mkdir,lstat,rename,unlink,link} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomBytes} from 'node:crypto';
export const MAX_PRIVATE_BYTES=32*1024*1024;
export async function privateDirectory(path:string){await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||s.uid!==process.getuid?.())throw Error('PRIVATE_DIRECTORY_REQUIRED')}
export async function readPrivateJSON(file:string,limit=MAX_PRIVATE_BYTES):Promise<unknown>{
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await handle.stat();if(!s.isFile()||(s.mode&0o077)||s.uid!==process.getuid?.()||s.size>limit)throw Error('INVALID_VAULT_FILE');const bytes=await handle.readFile();if(bytes.length>limit)throw Error('INVALID_VAULT_FILE');return JSON.parse(bytes.toString('utf8'));}finally{await handle.close()}
}
export async function syncDirectory(path:string){const handle=await open(path,constants.O_RDONLY|constants.O_DIRECTORY);try{await handle.sync()}finally{await handle.close()}}
export async function writePrivateJSON(file:string,value:unknown,initial=false,limit=MAX_PRIVATE_BYTES){
 const text=JSON.stringify(value);if(Buffer.byteLength(text)>limit)throw Error('VAULT_SIZE_LIMIT');
 const temporary=join(dirname(file),`.save-${randomBytes(12).toString('hex')}`),target=temporary;
 const handle=await open(target,'wx',0o600);try{await handle.writeFile(text);await handle.sync()}catch(e){await handle.close();await unlink(target).catch(()=>{});throw e}await handle.close();
 try{if(initial){await link(temporary,file);await unlink(temporary)}else await rename(temporary,file)}catch(e){await unlink(temporary).catch(()=>{});throw e}
 try{await syncDirectory(dirname(file))}catch{throw Error('COMMIT_UNCERTAIN')}
}

// Names are reserved for this module's encrypted staging writes. Validate all
// paths before pruning or deleting; never follow a symlink or recurse.
export async function stagingFiles(directory:string){
 const {readdir}=await import('node:fs/promises');const files=[];
 for(const name of await readdir(directory))if(/^\.save-[a-f0-9]{24}$/.test(name)){
  const file=join(directory,name),handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=await handle.stat();if(!s.isFile()||(s.mode&0o077)||s.uid!==process.getuid?.()||s.size>MAX_PRIVATE_BYTES)throw Error('INVALID_VAULT_FILE');files.push(file)}finally{await handle.close()}
 }return files;
}
