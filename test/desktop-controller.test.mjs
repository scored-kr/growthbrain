import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DesktopController } from '../dist/desktop-controller.js';
import { callBroker } from '../dist/broker.js';
import { DeviceAuthorization } from '../dist/web-auth.js';

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(),'gb-desktop-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  return dir;
}

test('desktop UI pipe creates a durable vault, confirms replacement, and locks on GUI exit',async t => {
  const home = await temporary(t);
  const dir = process.platform === 'win32' ? join(home,'GrowthBrain','vault') : join(home,'.local','share','growth-brain');
  const child = spawn(process.execPath,[fileURLToPath(new URL('../dist/desktop-controller.js',import.meta.url))],{
    stdio:['pipe','pipe','pipe'],env:{...process.env,HOME:home,LOCALAPPDATA:home},
  });
  const exit = once(child,'exit');
  t.after(() => child.kill());
  const lines = createInterface({input:child.stdout})[Symbol.asyncIterator]();
  let seq = 0;
  const replies = [];
  const run = async (op,params = {}) => {
    const id = ++seq;
    child.stdin.write(JSON.stringify({id,op,...params}) + '\n');
    const {value} = await lines.next();
    assert.ok(value,'controller quit before response');
    const reply = JSON.parse(value);
    assert.equal(reply.id,id);
    replies.push(value);
    return reply;
  };
  const password = randomBytes(20).toString('hex');
  assert.equal((await run('status')).result.exists,false);
  assert.equal((await run('create',{password})).result.unlocked,true);
  const project = (await run('addProject',{name:'Synthetic project'})).result.projects[0].id;
  const save = {projectId:project,key:'brand.format',value:'SYNTHETIC-PREVIOUS'};
  assert.equal((await run('addPreference',save)).ok,true);
  save.value = 'SYNTHETIC-CURRENT';
  const replacement = await run('addPreference',save);
  assert.equal(replacement.error,'EXPLICIT_SUPERSESSION_REQUIRED');
  assert.equal(replacement.previous.value,'SYNTHETIC-PREVIOUS');
  assert.equal((await run('addPreference',{...save,supersedesId:randomUUID()})).error,'STALE_SUPERSESSION');
  assert.equal((await run('addPreference',{...save,supersedesId:replacement.previous.id})).ok,true);
  const get = () => callBroker(join(dir,'memory.sock'),'get_context',{projectId:project});
  assert.deepEqual((await get()).conditions.map(c=>c.value),['SYNTHETIC-CURRENT']);
  const locked = await run('lock');
  assert.deepEqual(locked.result.projects,[]);
  assert.equal(locked.result.web.url,null);
  await assert.rejects(get,/VAULT_LOCKED/);
  assert.equal((await run('create',{password})).error,'VAULT_EXISTS');
  assert.equal((await run('unlock',{password:randomBytes(20).toString('hex')})).error,'UNLOCK_FAILED');
  assert.equal((await run('unlock',{password})).result.projects[0].id,project);
  assert.deepEqual((await get()).conditions.map(c=>c.value),['SYNTHETIC-CURRENT']);
  assert.ok(replies.every(r=>!r.includes(password)));
  assert.ok(!(await readFile(join(dir,'vault.json'),'utf8')).includes('SYNTHETIC'));
  child.stdin.end();
  assert.equal((await exit)[0],0);
  await assert.rejects(get,/VAULT_LOCKED/);
});

test('desktop cancels pending network sign-in on lock and refuses impersonated provider callbacks',async t => {
  const home = await mkdtemp(join(tmpdir(),'gb-route-controller-')), password = randomBytes(20).toString('hex');
  const login = 'https://login.tailscale.com/a/example';
  let tries = 0, auth, cancelled = false, offline = false;
  async function openRoute(vault,root,notify,signal) {
    if (tries++ === 0) {
      notify(login);
      return await new Promise((_,reject)=>signal.addEventListener('abort',()=>{
        cancelled=true;reject(Error('ROUTE_CANCELLED'));
      },{once:true}));
    }
    auth = new DeviceAuthorization(new URL('https://example.invalid/mcp'),()=>vault.assertUnlocked(),()=>{});
    return {url:auth.resource.href,auth,audit:()=>[],status:()=> offline ? 'unavailable' : 'ready',error:()=> offline ? 'ROUTE_CERTIFICATE' : null,close:async()=>auth.close()};
  }
  const desktop = new DesktopController(join(home,'vault'),openRoute);
  t.after(async()=>{ try { await desktop.close(); } finally { await rm(home,{recursive:true,force:true}); } });
  const run = (op,params={}) => desktop.handle({id:1,op,...params});
  assert.equal((await run('create',{password})).ok,true);
  const start = await run('startWeb');
  assert.equal(start.result.web.signInUrl,login);
  assert.equal(start.result.web.state,'starting');
  assert.equal((await run('lock')).ok,true);
  assert.equal(cancelled,true);
  assert.equal((await run('unlock',{password})).ok,true);
  await run('startWeb');
  for (const [callback,trusted] of [
    ['https://example.invalid/claude/callback',false],['https://claude.ai/api/mcp/auth_callback',true],
  ]) {
    const client = await auth.clientsStore.registerClient({client_name:'Claude',redirect_uris:[callback]});
    await auth.authorize(client,{redirectUri:callback,codeChallenge:'a'.repeat(43),resource:auth.resource},{
      cookie:()=>{}, redirect:()=>{},
    });
    const pending = (await run('status')).result.web.requests.find(r=>r.redirectUri === callback);
    const reply = await run('approve',{requestId:pending.id,projectId:null});
    if (trusted) {
      assert.equal(reply.result.web.connections[0].connected,false);
      assert.equal(reply.result.web.connections[0].provider,'claude');
      const revoked = await run('revoke',{connectionId:reply.result.web.connections[0].id});
      assert.deepEqual(revoked.result.web.connections,[]);
    } else {
      assert.equal(reply.error,'UNSUPPORTED_CALLBACK');
      assert.equal((await run('deny',{requestId:pending.id})).ok,true);
    }
  }
  offline = true; auth.close();
  const lost = (await run('status')).result.web;
  assert.equal(lost.state,'unavailable');
  assert.equal(lost.error,'ROUTE_CERTIFICATE');
  assert.equal(lost.url,null);
  assert.deepEqual(lost.connections,[]);
  assert.equal((await run('stopWeb')).result.web.state,'off');
});

test('after lock/restart an existing web registration can be recreated and requires fresh local consent', async t => {
  const dir = await mkdtemp(join(tmpdir(),'gb-reauth-'));
  const password = randomBytes(24).toString('hex');
  const resource = new URL('https://example.invalid/mcp');
  const callback = 'https://claude.ai/api/mcp/auth_callback';
  const verifier = randomBytes(32).toString('base64url');
  const {createHash} = await import('node:crypto');
  const params = {redirectUri:callback, resource, codeChallenge:createHash('sha256').update(verifier).digest('base64url')};
  let auth;
  async function openRoute(vault) {
    auth = new DeviceAuthorization(resource,()=>vault.assertUnlocked(),()=>{});
    return {url:resource.href,auth,audit:()=>[],status:()=> 'ready',close:async()=>auth.close()};
  }
  let desktop = new DesktopController(join(dir,'vault'),openRoute);
  t.after(async()=>{try{await desktop.close()} finally {await rm(dir,{recursive:true,force:true})}});
  const run = (op,fields={}) => desktop.handle({id:1,op,...fields});
  const authenticate = async () => {
    const client = await auth.clientsStore.registerClient({client_name:'Synthetic Claude',redirect_uris:[callback]});
    let cookie;
    await auth.authorize(client,params,{cookie:(_key,value)=>{cookie=value},redirect:()=>{}});
    const requestId = auth.requests()[0].id;
    assert.equal(auth.consent(requestId,cookie).waiting,true);
    assert.equal((await run('approve',{requestId,projectId:null})).ok,true);
    const code = new URL(auth.consent(requestId,cookie).url).searchParams.get('code');
    const tokens = await auth.exchangeAuthorizationCode(client,code,verifier,callback,resource);
    assert.equal((await run('status')).result.web.connections[0].connected,true);
    return {tokens,client};
  };
  await run('create',{password});
  await run('startWeb');
  const previous = await authenticate(), oldAuth = auth;
  await run('lock');
  await assert.rejects(()=>oldAuth.verifyAccessToken(previous.tokens.access_token));
  desktop = new DesktopController(join(dir,'vault'),openRoute);
  await run('unlock',{password});
  await run('startWeb');
  assert.deepEqual((await run('status')).result.web.connections,[]);
  assert.equal(await auth.clientsStore.getClient(previous.client.client_id),undefined);
  await assert.rejects(()=>auth.exchangeRefreshToken(previous.client,previous.tokens.refresh_token,['memory:read'],resource));
  const next = await authenticate();
  assert.notEqual(next.client.client_id,previous.client.client_id);
  await auth.verifyAccessToken(next.tokens.access_token);
});

test('desktop backup and password-loss recovery preserve the original and restore into fresh profiles only', async t => {
  const parent = await mkdtemp(join(tmpdir(),'gb-desktop-restore-'));
  const password = randomBytes(24).toString('base64url'), changed = randomBytes(24).toString('base64url');
  const source = new DesktopController(join(parent,'original'));
  const restored = new DesktopController(join(parent,'restored'));
  const recovered = new DesktopController(join(parent,'recovered'));
  t.after(async()=>{
    try { await Promise.all([source.close(),restored.close(),recovered.close()]); }
    finally { await rm(parent,{force:true,recursive:true}); }
  });
  const backupFile = join(parent,'export','synthetic.enc'), recoveryFile = join(parent,'recovery','synthetic.recovery');
  const run = (client,op,fields={}) => client.handle({id:42,op,...fields});
  assert.equal((await run(source,'create',{password})).ok,true);
  const project = (await run(source,'addProject',{name:'SYNTHETIC RESTORE'})).result.projects[0];
  assert.equal((await run(source,'issueRecovery',{file:recoveryFile,password:changed})).error,'UNLOCK_FAILED');
  assert.equal((await run(source,'issueRecovery',{file:recoveryFile,password})).ok,true);
  assert.equal((await run(source,'backup',{file:backupFile})).ok,true);
  assert.equal((await run(source,'backup',{file:backupFile})).error,'BACKUP_DESTINATION_EXISTS');
  const originalBytes = await readFile(backupFile);
  assert.ok(!originalBytes.includes(project.name));
  await run(source,'lock');
  assert.equal((await run(source,'restore',{backupFile,password})).error,'RESTORE_TARGET_EXISTS');
  const regular = await run(restored,'restore',{backupFile,password});
  assert.equal(regular.result.exists,true);
  assert.equal(regular.result.unlocked,false);
  assert.deepEqual((await run(restored,'unlock',{password})).result.projects,[project]);
  const missingKey = await run(recovered,'recover',{backupFile,password:changed,recoveryFile:recoveryFile+'.missing'});
  assert.equal(missingKey.error,'INVALID_RECOVERY_FILE');
  assert.equal((await run(recovered,'status')).result.exists,false);
  assert.equal((await run(recovered,'recover',{backupFile,recoveryFile,password:changed})).result.unlocked,false);
  assert.equal((await run(recovered,'unlock',{password})).error,'UNLOCK_FAILED');
  assert.deepEqual((await run(recovered,'unlock',{password:changed})).result.projects,[project]);
  assert.deepEqual((await run(source,'unlock',{password})).result.projects,[project]);
  assert.deepEqual(await readFile(backupFile),originalBytes);
});
