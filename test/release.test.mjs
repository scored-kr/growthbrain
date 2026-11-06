import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {validateExtension} from '../scripts/validate-extension.mjs';
test('release gate accepts the current manifest and rejects privilege expansion, inline code, stale browser code and secret-shaped assets',async t=>{
 const root=await mkdtemp(join(tmpdir(),'gb-release-'));t.after(()=>rm(root,{recursive:true,force:true}));const ext=join(root,'extension');await cp(resolve('extension'),ext,{recursive:true});assert.equal((await validateExtension(ext)).manifestV3,true);
 const manifest=JSON.parse(await readFile(join(ext,'manifest.json'),'utf8'));await writeFile(join(ext,'manifest.json'),JSON.stringify({...manifest,host_permissions:['<all_urls>']}));await assert.rejects(validateExtension(ext),/UNEXPECTED_EXTENSION_ACCESS/);await writeFile(join(ext,'manifest.json'),JSON.stringify(manifest));
 const page=await readFile(join(ext,'app.html'),'utf8');await writeFile(join(ext,'app.html'),page+'<script>alert(1)</script>');await assert.rejects(validateExtension(ext),/NONLOCAL_SCRIPT/);await writeFile(join(ext,'app.html'),page);
 const module=await readFile(join(ext,'account-auth.js'),'utf8');await writeFile(join(ext,'account-auth.js'),module+'\n// stale');await assert.rejects(validateExtension(ext),/STALE_BROWSER_MODULE/);await writeFile(join(ext,'account-auth.js'),module);
 await writeFile(join(ext,'unsafe.js'),'-----BEGIN PRIVATE KEY-----');await assert.rejects(validateExtension(ext),/POSSIBLE_SECRET/);
});
