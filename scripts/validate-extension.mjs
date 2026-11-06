import {readFile,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export async function validateExtension(directory=resolve('extension')){
 const names=await readdir(directory),manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 if(manifest.manifest_version!==3||manifest.background?.type!=='module'||manifest.background?.service_worker!=='background.js')throw Error('MV3_BACKGROUND_REQUIRED');
 const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
 if(!same(manifest.permissions??[],['storage','scripting','nativeMessaging'])||!same(manifest.optional_host_permissions??[],['https://chatgpt.com/*','https://claude.ai/*'])||manifest.host_permissions?.length||manifest.externally_connectable||manifest.web_accessible_resources?.length)throw Error('UNEXPECTED_EXTENSION_ACCESS');
 if(manifest.content_security_policy?.extension_pages!=="script-src 'self'; object-src 'none'")throw Error('EXTENSION_CSP_REQUIRED');
 for(const name of names){
  const path=join(directory,name),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||!/^[-a-z0-9]+\.(?:json|html|css|js)$/.test(name))throw Error(`UNEXPECTED_EXTENSION_FILE: ${name}`);
  const text=await readFile(path,'utf8');
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sb_secret_|sk-proj-)[A-Za-z0-9_-]{24,}/.test(text))throw Error(`POSSIBLE_SECRET: ${name}`);
  if(name.endsWith('.js')&&(/\beval\s*\(|\bnew\s+Function\s*\(/.test(text)||/\bimport\s*(?:\(|[^;]*?from\s*)["']https?:/m.test(text)))throw Error(`REMOTE_OR_DYNAMIC_CODE: ${name}`);
  if(name.endsWith('.html')){
   if(/\son[a-z]+\s*=/i.test(text))throw Error(`INLINE_EVENT_HANDLER: ${name}`);
   for(const script of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    const src=/\bsrc="([-a-z0-9]+\.js)"/.exec(script[1]);if(!src||!names.includes(src[1])||script[2].trim())throw Error(`NONLOCAL_SCRIPT: ${name}`);
   }
  }
 }
 // Build emits this browser-safe module; a stale checked-in copy must fail release validation.
 const generated=await readFile(resolve('dist/account-auth.js'),'utf8');if(await readFile(join(directory,'account-auth.js'),'utf8')!==generated)throw Error('STALE_BROWSER_MODULE');
 return {manifestV3:true,minimalDeclaredPermissions:true,localScripts:true,files:names.length,secretPatternScan:'limited static check; not a complete secret audit'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await validateExtension()));
