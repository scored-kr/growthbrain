import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectTestClient } from './fixtures/mcp-client.ts';
import { startRelay } from '../server/relay.ts';
import { approveStoredCondition, readGrantedContext, resumePrompt } from '../src/approved-context.ts';
import { getJournalTurn } from '../src/journal.ts';
import { deviceOrigin } from '../src/device-origin.ts';
import { importPairingKey, answerChallenge } from '../src/pairing.ts';
import { emptyMemory, captureTurn, bindProject } from '../src/memory.ts';

type Service = 'chatgpt' | 'claude';
const secret = () => randomBytes(32).toString('base64url');
test('real SDK get_context over HTTP OAuth and a paired synthetic device reads only the granted confirmed revision', async (t) => {
  const token = secret();
  const relay = await startRelay({ token, httpPort: 0, devicePort: 0 });
  t.after(() => relay.close());
  const origin = new URL(relay.url).origin;
  const json = (path: string, body: unknown) =>
    fetch(origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal((await json('/mcp', {})).status, 401);
  assert.equal(
    (await (await fetch(origin + '/.well-known/oauth-protected-resource/mcp')).json()).resource,
    relay.url,
  );
  const deviceUrl = 'ws://127.0.0.1:' + relay.devicePort + '/device';
  const wrong = new WebSocket(deviceUrl);
  await once(wrong, 'open');
  wrong.send(JSON.stringify({ type: 'hello', nonce: randomUUID() }));
  const challenge = JSON.parse((await once(wrong, 'message'))[0].toString());
  wrong.send(JSON.stringify({ type: 'pair', proof: challenge.proof }));
  assert.equal((await once(wrong, 'close'))[0], 1008);
  const peer = new WebSocket(deviceUrl);
  await once(peer, 'open');
  const nonce = randomUUID();
  peer.send(JSON.stringify({ type: 'hello', nonce }));
  const challenge2 = JSON.parse((await once(peer, 'message'))[0].toString());
  const key = await importPairingKey(token);
  assert.equal(
    await answerChallenge(key, nonce, challenge),
    undefined,
    'the worker rejects an old or forged relay challenge',
  );
  const proof = await answerChallenge(key, nonce, challenge2);
  assert.ok(proof);
  peer.send(JSON.stringify({ type: 'pair', proof }));
  assert.equal(JSON.parse((await once(peer, 'message'))[0].toString()).type, 'ready');

  const state = emptyMemory();
  const turn = (service: Service, conversationId: string, role: 'user' | 'assistant', text: string) =>
    captureTurn(state, { service, conversationId, id: randomUUID(), role, text });
  const suffix = '\n' + randomUUID() + '를 그대로 둡니다.';
  function seed(chat: string, title: string, text: string) {
    turn('chatgpt', chat, 'user', title + ' 상세페이지 초안 세 개를 비교해줘');
    turn('chatgpt', chat, 'assistant', '1안: 제외할 원고.\n2안: ' + text + '\n3안: 보류할 원고.');
    turn('chatgpt', chat, 'user', '2안으로 확정');
    return state.projects.find((p) => p.title === title)!.id;
  }
  const old = '오늘의 찻잔.' + suffix;
  const project = seed('demo', '찻잔', old);
  const other = seed('sibling', '보온병', '다른 프로젝트의 원고.');
  const seen: Service[] = [];
  let substitute = false;
  peer.on('message', (data) => {
    const req = JSON.parse(data.toString());
    if (req.type !== 'get_context') return;
    seen.push(req.service);
    const context = readGrantedContext(state, {query:req.query, projectId:substitute ? other : req.projectId, service:req.service});
    peer.send(JSON.stringify({ type: 'result', id: req.id, context }));
  });
  const registration = (redirect: string) =>
    json('/register', {
      redirect_uris: [redirect],
      client_name: 'Synthetic OAuth client',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  assert.equal((await registration('https://example.test/callback')).status, 400);
  const claude = await connectTestClient(relay, 'claude', project);
  t.after(() => claude.close());
  const chatgpt = await connectTestClient(relay, 'chatgpt', project);
  t.after(() => chatgpt.close());
  assert.deepEqual(
    (await claude.listTools()).tools.map((t) => t.name),
    ['get_context'],
  );
  const query = '찻잔 상세페이지에서 어제 고른 2안의 첫 문장만 바꿔줘';
  const get = (c: Client, question = query) => c.callTool({ name: 'get_context', arguments: { query: question } });
  const first = await get(claude);
  assert.equal(first.isError, undefined);
  assert.deepEqual(first.structuredContent?.context, {
    status: 'found',
    option: 2,
    version: 1,
    projectId: project,
    text: old,
  });
  assert.equal(
    (await claude.callTool({ name: 'get_context', arguments: { query, projectId: other } })).isError,
    true,
  );
  substitute = true;
  assert.equal((await get(claude)).isError, true);
  substitute = false;
  bindProject(state, 'claude', 'new', project);
  turn('claude', 'new', 'user', query);
  turn('claude', 'new', 'assistant', '달라진 찻잔.');
  assert.equal((await get(chatgpt, '찻잔의 최신안 보여줘')).structuredContent?.context.text, old);
  turn('claude', 'new', 'user', '이 문장으로 확정');
  assert.equal((await get(chatgpt, '찻잔의 최신안 보여줘')).structuredContent?.context.text, '달라진 찻잔.' + suffix);
  state.preferences = {status:'accepted'};
  const preferred = await get(claude, '헤드라인 써줘');
  assert.deepEqual(preferred.structuredContent?.context, {
    status: 'preference',
    projectId: project,
    preference: '별도 요청이 없으면 제목은 짧게 씁니다.',
  });
  assert.equal((await get(claude, '이번에는 긴 제목을 써줘')).isError, true);
  assert.deepEqual(seen, ['claude', 'claude', 'chatgpt', 'chatgpt', 'claude', 'claude']);
  const receipts = relay.reads();
  assert.deepEqual(
    receipts.map((r) => [r.service, r.projectId, r.option, r.version]),
    [
      ['claude', project, 2, 1],
      ['chatgpt', project, 2, 1],
      ['chatgpt', project, 2, 2],
      ['claude', project, undefined, undefined],
    ],
  );
  for (const r of receipts)
    assert.ok(Object.keys(r).every((key) => ['at', 'service', 'projectId', 'option', 'version'].includes(key)));
  assert.equal((await get(chatgpt, resumePrompt + '\n\n찻잔의 최신안 보여줘')).structuredContent?.context.text, '달라진 찻잔.' + suffix);
  const question = '지난번 정한 조건대로 다음 작업을 진행해줘';
  assert.deepEqual((await get(claude, question)).structuredContent?.context, preferred.structuredContent?.context);
  assert.equal((await get(claude, question + '. 이번에는 제목을 길게 써 줘.')).isError, true);
  state.preferences = {status:'pending'};
  assert.equal((await get(claude, question)).isError, true);
  state.preferences = {status:'accepted'};
  turn('chatgpt', 'ordinary', 'assistant', 'Unapproved conversation text stays local');
  const decision = '예약 전에 수량을 확인한다.';
  captureTurn(state,{service:'chatgpt',conversationId:'ordinary',id:'source-private-marker',role:'user',text:decision});
  const source = getJournalTurn(state,'chatgpt','ordinary','source-private-marker','user')!;
  const approval = approveStoredCondition(state,{service:'chatgpt',conversationId:'ordinary',id:source.id,sequence:source.sequence,revision:source.revision,projectId:project,expectedConditionId:null});
  assert.equal(approval.status, 'approved');
  const fresh = await connectTestClient(relay,'claude',project);
  t.after(() => fresh.close());
  const result = await get(fresh, question);
  const exported = {context:{status:'resume',projectId:project,decisions:[decision],preference:'별도 요청이 없으면 제목은 짧게 씁니다.'}};
  assert.deepEqual(result.structuredContent, exported);
  assert.deepEqual(result.content, [{type:'text',text:JSON.stringify(exported)}]);
  assert.equal((await get(fresh, '보온병에서 ' + question)).isError, true);
  const reference = '다른 프로젝트에만 승인된 자료.\n  이 문단과 여백까지 포함.  ';
  const generated = {id:'assistant-work', role:'assistant', service:'claude', conversationId:'claude-private'} as const;
  captureTurn(state, {...generated, text:reference});
  const row = getJournalTurn(state, generated.service, generated.conversationId, generated.id, generated.role)!;
  assert.equal(approveStoredCondition(state, {...generated, revision:row.revision, sequence:row.sequence, projectId:other, expectedConditionId:null}).status,'approved');
  const otherClient = await connectTestClient(relay, 'chatgpt', other);
  t.after(() => otherClient.close());
  state.preferences = {status:'pending'};
  const referenceOnly = {context:{status:'resume',projectId:other,decisions:[],references:[reference]}};
  const next = await get(otherClient, question);
  assert.deepEqual(next.structuredContent, referenceOnly);
  assert.deepEqual(next.content, [{type:'text',text:JSON.stringify(referenceOnly)}]);
  assert.deepEqual((await get(fresh, question)).structuredContent, {context:{status:'resume',projectId:project,decisions:[decision]}});
  assert.ok(!JSON.stringify(relay.reads()).includes(decision));
  assert.ok(!JSON.stringify(relay.reads()).includes(reference));
  peer.close();
  await once(peer, 'close');
  assert.equal((await json('/mcp', {})).status, 401);
  assert.equal((await get(claude)).isError, true);
});

test('staging build uses a single exact TLS origin while default builds stay on loopback', () => {
  assert.equal(deviceOrigin(), 'ws://127.0.0.1:43127');
  assert.equal(deviceOrigin('wss://test.example/'), 'wss://test.example');
  for (const bad of [
    'ws://test.example',
    'wss://*.example',
    'wss://test.example:8888',
    'wss://test.example/other',
    'wss://user@test.example',
  ]) {
    assert.throws(() => deviceOrigin(bad));
  }
});
