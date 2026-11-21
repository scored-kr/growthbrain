import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { callBroker } from '../../dist/broker.js';
import { privateDirectory } from '../../dist/secure-files.js';
import { callbacks, connectWeb, createLoopbackCertificate, device, loopbackHttps, secret, startDeviceWeb } from './sync-web-clients.mjs';

export async function verifyFreshDeviceRecall(t, accountServer) {
  // Windows vaults require a private NTFS directory beneath the token's user profile.
  const root=join(process.platform==='win32'?homedir():tmpdir(),'gb-pcs-'+randomUUID());
  await privateDirectory(root,true);
  const domain=randomUUID().slice(0,8)+'.example.test';
  const service=await accountServer(domain);
  const pcs=[],clients=[];
  t.after(async()=>{
    for(const client of clients)await client.close().catch(()=>{});
    for(const pc of pcs)await pc.stop();
    try{await service.close()}finally{await rm(root,{recursive:true,force:true})}
  });
  const a=device(join(root,'pc-a','vault'),service.origin,root);
  pcs.push(a);
  const primary={email:'alpha@'+domain,password:'Aa7!'+secret()},other={email:'beta@'+domain,password:'Aa7!'+secret()};
  async function enrol(pc,account) {
    await pc.run('accountSignup',account);
    if (service.emailCode) await pc.run('accountVerify',{email:account.email,code:service.emailCode});
    return pc.run('accountLogin',account);
  }
  const language='한국어로 답변', channel='뉴스레터 사용', stale='인쇄 카탈로그', separate='별도 프로젝트 전용 결제 채널', unapproved='미승인 라디오 광고';
  const first=await enrol(a,primary);
  assert.equal(first.unlocked,true);
  await a.run('addPreference',{projectId:null,key:'language',value:language});
  const mainProject=(await a.run('addProject',{name:'여름 합성 캠페인'})).projects[0];
  const sideProject=(await a.run('addProject',{name:'별도 합성 프로젝트'})).projects.find(p=>p.id!==mainProject.id);
  await a.run('addPreference',{projectId:sideProject.id,key:'channel',value:separate});
  await a.run('addPreference',{projectId:mainProject.id,key:'channel',value:stale});
  const next={projectId:mainProject.id,key:'channel',value:channel};
  const existing=await a.send('addPreference',next);
  assert.equal(existing.error,'EXPLICIT_SUPERSESSION_REQUIRED');
  const saved=await a.run('addPreference',{...next,supersedesId:existing.previous.id});
  assert.ok(['pending','synced'].includes(saved.account.sync));
  assert.equal((await a.run('accountSync')).account.sync,'synced');
  const candidate=await callBroker(join(root,'pc-a','active','memory.sock'),'propose_memory',{
    scope:{type:'project',projectId:mainProject.id},kind:'decision',key:'channel',value:unapproved,
    source:{kind:'ai',reference:'fixture:pending',excerpt:'합성 검토 원문'},reason:'사용자가 검토할 합성 제안',
  });
  assert.equal(candidate.status,'candidate');
  assert.equal((await a.run('accountSync')).account.sync,'synced');
  await a.close(); // A's controller, broker, data key and all sockets are gone before B starts.
  await rm(join(root,'pc-a'),{recursive:true});
  t.diagnostic('Synthetic PC A exited and its local profile was removed before PC B signed in.');
  const stored=JSON.stringify(await service.inspect());
  assert.ok(stored.length>100,'Expected a remote snapshot');
  for(const marker of [language,channel,stale,separate,unapproved,mainProject.name,sideProject.name,primary.password]){
    assert.ok(!stored.includes(marker),'Plaintext reached the remote snapshot');
  }

  // Only a temporary localhost certificate stands in for the remote route. MCP, OAuth, scoped
  // consent and results use the actual web server. Neither client contacts a live AI service.
  const ca=await createLoopbackCertificate(root);
  const b=device(join(root,'pc-b','vault'),service.origin,root);pcs.push(b);
  assert.equal((await b.send('accountLogin',{...primary,password:'Aa7!'+secret()})).ok,false);
  const restored=await b.run('accountLogin',primary);
  assert.equal(restored.account.sync,'synced');
  assert.deepEqual(new Set(restored.projects.map(p=>p.id)),new Set([mainProject.id,sideProject.id]));
  const restoredReview=await callBroker(join(root,'pc-b','active','memory.sock'),'list_memories',{projectId:mainProject.id,status:'all'});
  assert.ok(restoredReview.memories.some(m=>m.id===candidate.id && m.value===unapproved && m.status==='candidate'));
  assert.ok(restoredReview.memories.some(m=>m.id===existing.previous.id && m.value===stale && m.status==='superseded'));
  await startDeviceWeb(b);
  let previousToken;
  for(const provider of Object.keys(callbacks)) {
    const {mcp,bearer}=await connectWeb(b,provider,mainProject.id,ca);
    previousToken=bearer;
    clients.push(mcp);
    const context=await mcp.callTool({name:'get_context',arguments:{query:'지난번 정한 조건대로 다음 작업을 진행해줘'}});
    assert.notEqual(context.isError,true);
    const recalled=JSON.parse(context.content[0].text);
    assert.equal(recalled.projectId,mainProject.id,'OAuth grant must select the project for this unqualified request');
    assert.deepEqual(recalled.conditions.map(c=>[c.origin,c.value]).sort(),[['global',language],['project',channel]]);
    const wire=JSON.stringify(context);
    for(const marker of [stale,separate,sideProject.name,unapproved,candidate.id,existing.previous.id,'fixture:pending','desktop:explicit-entry']) {
      assert.ok(!wire.includes(marker), 'Inactive memory, source or approval history escaped the read boundary');
    }
    for(const localField of ['excerpt','reference','supersedesId','reason']) {
      assert.ok(!JSON.stringify(recalled.conditions).includes(JSON.stringify(localField)+':'),
        'Unexpected local review field on a returned condition: '+localField);
    }
    const current=(await b.run('status')).web;
    const connection=current.connections.find(c=>c.provider===provider);
    assert.ok(connection?.connected, 'Expected an authenticated provider connection');
    assert.deepEqual(current.audit.filter(e=>e.connectionId===connection.id).map(e=>[e.method,e.success]),[['get_context',true]]);
    assert.equal((await mcp.callTool({name:'get_context',arguments:{projectId:sideProject.id}})).isError,true);
    t.diagnostic(`${provider}: simulated callback; authenticated HTTPS MCP get_context without project ID returned ${language} / ${channel}; other project, superseded and pending values excluded.`);
  }
  await b.run('accountLogout');
  const isolated=await enrol(b,other);
  assert.deepEqual(isolated.projects,[]);
  const betaLanguage='English-only synthetic account';
  await b.run('addPreference',{projectId:null,key:'language',value:betaLanguage});
  assert.equal((await b.run('accountSync')).account.sync,'synced');
  await startDeviceWeb(b);
  const refused=await loopbackHttps(b.port,ca)('/mcp',{
    method:'POST',headers:{Authorization:'Bearer '+previousToken,'content-type':'application/json'},body:'{}',
  });
  assert.equal(refused.status,401,'Alpha OAuth token must be rejected on the same device after switching accounts');
  const betaClient=await connectWeb(b,'claude',null,ca);
  clients.push(betaClient.mcp);
  const betaReply=await betaClient.mcp.callTool({name:'get_context',arguments:{}});
  assert.notEqual(betaReply.isError,true);
  assert.deepEqual(JSON.parse(betaReply.content[0].text).conditions.map(c=>c.value),[betaLanguage]);
  assert.equal((await betaClient.mcp.callTool({name:'get_context',arguments:{projectId:mainProject.id}})).isError,true);
  await b.run('accountLogout');
  const storedAccounts=await service.inspect();
  assert.equal(storedAccounts.length,2);
  assert.equal(new Set(storedAccounts.map(row=>row.owner_id)).size,2);
  assert.ok(!JSON.stringify(storedAccounts).includes(betaLanguage));
  const back=await b.run('accountLogin',primary);
  assert.deepEqual(new Set(back.projects.map(p=>p.id)),new Set([mainProject.id,sideProject.id]));
  // A remote auth provider sees only an independently derived credential.
  const submitted=service.accountCalls.map(call=>call.passwordDigest).filter(Boolean);
  assert.ok(submitted.length>=4);
  for(const pw of [primary.password,other.password])assert.ok(!submitted.includes(createHash('sha256').update(pw).digest('hex')));
  await b.close();
}
