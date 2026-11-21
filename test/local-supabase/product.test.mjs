import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callBroker } from '../../dist/broker.js';
import { deviceNetwork } from './device-network.mjs';
import { verifyFreshDeviceRecall } from '../support/verify-synced-context.mjs';
import { device, startDeviceWeb, connectWeb, secret, callbacks, createLoopbackCertificate, loopbackHttps } from '../support/sync-web-clients.mjs';

test('new device signs in to GoTrue and serves approved memories to both scoped MCP clients', {timeout:120000},
  t=>verifyFreshDeviceRecall(t,deviceNetwork));

test('independent offline writes resolve into a single durable cloud snapshot served over consented product MCP on B',
  {timeout:120000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'gb-actual-mcp-'));
  const domain=randomUUID().slice(0,8)+'.example.test';
  const email='offline@'+domain, password='Aa7!'+secret();
  const aNet=await deviceNetwork(domain), bNet=await deviceNetwork(domain);
  const workers=[],clients=[];
  t.after(async()=>{
    for(const client of clients) await client.close().catch(()=>{});
    for(const pc of workers) await pc.stop();
    await Promise.all([aNet.close(),bNet.close()]);
    await rm(root,{recursive:true,force:true});
  });
  const a=device(join(root,'a','vault'),aNet.origin,root);workers.push(a);
  await a.run('accountSignup',{email,password});
  assert.ok((await a.run('accountLogin',{email,password})).unlocked);
  const project=(await a.run('addProject',{name:'합성 독립 수정'})).projects[0];
  const side=(await a.run('addProject',{name:'합성 다른 프로젝트'})).projects.find(p=>p.id!==project.id);
  const old='이전 인쇄 광고', pending='미승인 라디오 광고', other='다른 프로젝트만의 전시회';
  const approvedGlobal='한국어로 답변', approvedProject='뉴스레터 사용';
  await a.run('addPreference',{projectId:side.id,key:'channel',value:other});
  await a.run('addPreference',{projectId:project.id,key:'channel',value:old});
  const socket=(side)=>join(root,side,'active','memory.sock');
  const list=(pc,projectId=project.id)=>callBroker(socket(pc),'list_memories',{projectId,status:'all'}).then(v=>v.memories);
  const candidate=await callBroker(socket('a'),'propose_memory',{
    scope:{type:'project',projectId:project.id},kind:'decision',key:'channel',value:pending,
    source:{kind:'ai',reference:'sandbox:pending',excerpt:'검토 전 원문'},reason:'합성 미승인 제안',
  });
  assert.equal(candidate.status,'candidate');
  assert.equal((await a.run('accountSync')).account.sync,'synced');
  const b=device(join(root,'b','vault'),bNet.origin,root);workers.push(b);
  assert.ok((await b.run('accountLogin',{email,password})).unlocked);
  const original=(await list('b')).find(m=>m.value===old && m.status==='active');
  assert.ok(original);
  const [initial]=await aNet.inspect();
  aNet.setOnline(false);bNet.setOnline(false);
  const writeA=await a.send('addPreference',{projectId:null,key:'language',value:approvedGlobal});
  const writeB=await b.send('addPreference',{projectId:project.id,key:'channel',value:approvedProject,supersedesId:original.id});
  assert.equal(writeA.ok,true);assert.equal(writeB.ok,true);
  assert.equal(writeA.localSaved,true);assert.equal(writeB.localSaved,true);
  const rowA=(await list('a')).find(m=>m.value===approvedGlobal&&m.status==='active');
  const rowB=(await list('b')).find(m=>m.value===approvedProject&&m.status==='active');
  assert.ok(rowA && rowB);
  assert.notEqual(rowA.id,rowB.id);
  const [snapshot]=await aNet.inspect();
  assert.equal(snapshot.revision,initial.revision);
  const writeCount=aNet.committedWrites.length;
  aNet.cutNextWrite('before'); aNet.setOnline(true);
  assert.equal((await a.send('accountSync')).ok,false);
  assert.equal(aNet.lastCut,'before');
  assert.deepEqual((await aNet.inspect())[0],initial);
  assert.equal(aNet.committedWrites.length,writeCount);
  aNet.cutNextWrite('after'); aNet.setOnline(true);
  assert.equal((await a.send('accountSync')).ok,false);
  assert.equal(aNet.lastCut,'after');
  const [committed]=await aNet.inspect();
  assert.notEqual(committed.revision,initial.revision);
  assert.equal(committed.payload.sequence,initial.payload.sequence+1);
  assert.equal(aNet.committedWrites.length,writeCount+1);
  assert.equal(aNet.committedWrites.at(-1).revision,committed.revision);
  assert.ok(aNet.committedWrites.at(-1).bytes>0);
  const chargedBytes=aNet.committedWrites.at(-1).bytes;
  aNet.setOnline(true);
  assert.equal((await a.run('accountSync')).account.sync,'synced');
  const [afterA]=await aNet.inspect();
  assert.deepEqual(afterA,committed,'retry must preserve confirmed revision, sequence and exact ciphertext');
  assert.equal(aNet.committedWrites.length,writeCount+1,'retry must not commit a duplicate snapshot');
  assert.equal((await a.run('status')).account.bytes,chargedBytes);
  assert.equal((await list('a')).filter(m=>m.id===rowA.id && m.status==='active').length,1);
  t.diagnostic('Controlled loopback write failure before submit changed no SQL rows. Successful backend write then lost its response; retry added zero commits and preserved the exact ciphertext, byte usage, sequence, revision and originally approved ID.');
  await a.close();await rm(join(root,'a'),{recursive:true});
  bNet.setOnline(true);
  assert.equal((await b.run('accountSync')).account.sync,'synced');
  const [merged]=await bNet.inspect();
  assert.notEqual(merged.revision,afterA.revision);
  assert.equal(merged.payload.sequence,afterA.payload.sequence+1);
  for(const str of [approvedGlobal,approvedProject,old,pending,other])assert.ok(!JSON.stringify(merged).includes(str));
  // Re-open a fresh replica with no local B data to establish cloud durability of both original IDs.
  await b.close();await rm(join(root,'b'),{recursive:true});
  const restored=device(join(root,'b','vault'),bNet.origin,root);workers.push(restored);
  assert.equal((await restored.run('accountLogin',{email,password})).account.sync,'synced');
  const review=await list('b');
  for(const [id,status] of [[rowA.id,'active'],[rowB.id,'active'],[candidate.id,'candidate'],[original.id,'superseded']])
    assert.equal(review.filter(row=>row.id===id && row.status===status).length,1);
  const ca=await createLoopbackCertificate(root);
  await startDeviceWeb(restored);
  let bearer;
  for(const provider of Object.keys(callbacks)){
    const grant=await connectWeb(restored,provider,project.id,ca);
    bearer=grant.bearer;
    const mcp=grant.mcp;clients.push(mcp);
    const reply=await mcp.callTool({name:'get_context',arguments:{query:'지난번 정한 조건대로 다음 작업을 진행해줘'}});
    assert.notEqual(reply.isError,true);
    const context=JSON.parse(reply.content[0].text);
    assert.equal(context.projectId,project.id);
    assert.deepEqual(context.conditions.map(c=>[c.origin,c.memoryId,c.value]).sort(),
      [['global',rowA.id,approvedGlobal],['project',rowB.id,approvedProject]]);
    const wire=JSON.stringify(reply);
    for(const marker of [other,side.id,old,pending,candidate.id,original.id])assert.ok(!wire.includes(marker));
    assert.equal((await mcp.callTool({name:'get_context',arguments:{projectId:side.id}})).isError,true);
    t.diagnostic(provider+' callback: real scoped get_context returned the original IDs of both independently saved approvals, cross-project denied.');
  }
  t.diagnostic('Backend unchanged while both clients were offline. Two distinct later committed revisions; fresh B restored the same active, superseded and pending IDs without duplicates.');

  // Start from the merged snapshot and replace the same active decision on each device.
  const peer=device(join(root,'a','vault'),aNet.origin,root);workers.push(peer);
  await peer.run('accountLogin',{email,password});
  const left='이메일 브리핑으로 발행', right='앱 알림으로 발행';
  const change={projectId:project.id,key:'channel',supersedesId:rowB.id};
  aNet.setOnline(false);bNet.setOnline(false);
  assert.equal((await peer.send('addPreference',{...change,value:left})).localSaved,true);
  assert.equal((await restored.send('addPreference',{...change,value:right})).localSaved,true);
  const fromA=(await list('a')).find(m=>m.value===left && m.status==='active');
  const fromB=(await list('b')).find(m=>m.value===right && m.status==='active');
  assert.ok(fromA && fromB);
  aNet.setOnline(true);await peer.run('accountSync');await peer.close();
  const [beforeReview]=await bNet.inspect();
  bNet.setOnline(true);
  assert.equal((await restored.send('accountSync')).error,'SYNC_CONFLICT');
  const request={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'get_context',arguments:{}}};
  const denied=await loopbackHttps(restored.port,ca)('/mcp',{method:'POST',
    headers:{Authorization:'Bearer '+bearer,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
    body:JSON.stringify(request)});
  assert.equal(denied.status,401,'An already authorized MCP client must not receive an unreviewed conflict');
  const preview=await restored.send('reviewSyncConflicts');
  assert.equal(preview.ok,true);
  assert.equal(preview.conflict.total,1);
  const [item]=preview.conflict.items;
  assert.deepEqual([item.key,item.projectId,item.localValue,item.remoteValue],['channel',project.id,right,left]);
  assert.equal((await restored.send('resolveSyncConflicts',{token:randomUUID(),decisions:'R'})).error,'SYNC_CONFLICT');
  assert.deepEqual((await bNet.inspect())[0],beforeReview);
  const resolved=await restored.run('resolveSyncConflicts',{token:preview.conflict.token,decisions:'R'});
  assert.equal(resolved.account.review,false);assert.equal(resolved.account.sync,'synced');
  const [afterReview]=await bNet.inspect();
  assert.equal(afterReview.payload.sequence,beforeReview.payload.sequence+1);
  const reviewed=await list('b');
  for(const [id,status] of [[fromA.id,'active'],[fromB.id,'retired']]) {
    const versions=reviewed.filter(m=>m.id===id && m.status===status && m.supersedesId===rowB.id);
    assert.equal(versions.length,1,'Resolution must preserve the identity and ancestry of both edits');
  }
  for(const mcp of clients) {
    const result=await mcp.callTool({name:'get_context',arguments:{query:'지난번 정한 조건대로 다음 작업을 진행해줘'}});
    assert.notEqual(result.isError,true);
    const selected=JSON.parse(result.content[0].text);
    assert.deepEqual(selected.conditions.map(c=>[c.origin,c.memoryId,c.value]).sort(),
      [['global',rowA.id,approvedGlobal],['project',fromA.id,left]]);
    for(const hidden of [right,fromB.id,approvedProject,rowB.id,pending,candidate.id,old,other])
      assert.ok(!JSON.stringify(result).includes(hidden));
  }
  t.diagnostic('Both competing values appeared in the product review. An existing grant returned HTTP 401 while they conflicted. Both authenticated MCP clients served only the explicitly chosen decision and the unchanged common preference after review.');
});
