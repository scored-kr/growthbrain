import assert from 'node:assert/strict'
import test from 'node:test'
import {bindProject, captureTurn, emptyMemory, listApprovedProjects, lookupContext, needsContext} from '../src/memory.ts'
import type {MemoryState, Service, Turn} from '../src/memory.ts'

const suffix = '\n기억의 원두 7B-눈꽃은 그대로.  두 칸도 보존합니다.'
const original = '햇빛을 한 모금.' + suffix
const ask = '어제 고른 2안의 첫 문장만 바꿔줘'
function send(state: MemoryState, service: Service, conversationId: string, role: Turn['role'], text: string, id = crypto.randomUUID() as string) {
  captureTurn(state, {service, conversationId, role, text, id})
}
function draft(state: MemoryState, chat = 'source', name = '달빛 커피') {
  send(state, 'chatgpt', chat, 'user', name + ' 상세페이지 초안 세 개를 비교해 줘.')
  send(state, 'chatgpt', chat, 'assistant', '1안: 볕이 드는 창.\n\n2안\n' + original + '\n\n3안: 아침의 커피.', 'draft')
}
function adopted(state: MemoryState, chat = 'source', name = '달빛 커피') {
  draft(state, chat, name)
  send(state, 'chatgpt', chat, 'user', '2안으로 확정', 'pick')
}
function read(state: MemoryState, query = ask, chat = 'new', projectId?: string) {
  return lookupContext(state, {service: 'claude', conversationId: chat, query, projectId})
}
function copy(state: MemoryState, query?: string, chat?: string) {
  const context = read(state, query, chat)
  assert.equal(context.status, 'found')
  return context
}

test('a confirmed edit of only the first sentence preserves every character of the approved suffix', () => {
  const state = emptyMemory()
  const unique = crypto.randomUUID()
  const exact = '바람 한 모금.\r\n' + unique + '  이 문장은 그대로.\r\n\r\n마지막 문단!'
  send(state, 'chatgpt', 'a', 'user', '상품명: 우롱차\n상세페이지 원고 세 개를 제안해 줘.')
  send(state, 'chatgpt', 'a', 'assistant', '1안: 첫 시안.\n2안:\n```text\r\n' + exact + '\r\n```\n3안: 세 번째.')
  send(state, 'chatgpt', 'a', 'user', '2안을 채택할게.')
  assert.equal(copy(state).text, exact)
  send(state, 'claude', 'b', 'user', ask)
  send(state, 'claude', 'b', 'assistant', '한 잔의 바람.')
  assert.equal(copy(state).text, exact)
  send(state, 'claude', 'b', 'user', '좋아, 그 문장으로 확정해 줘.')
  const latest = lookupContext(state, {service:'chatgpt', conversationId:'c', query:'최신안을 보여줘'})
  assert.equal(latest.status, 'found')
  assert.equal(latest.text, exact.replace('바람 한 모금.', '한 잔의 바람.'))
  assert.equal(latest.version, 2)
  assert.equal(latest.option, 2)
})

test('a complete reply with a modified tail cannot be confirmed', () => {
  const state = emptyMemory()
  adopted(state)
  send(state, 'claude', 'b', 'user', ask)
  send(state, 'claude', 'b', 'assistant', '한 잔의 햇살.\n본문까지 바꿉니다.')
  send(state, 'claude', 'b', 'user', '이대로 확정')
  assert.equal(copy(state).text, original)
  send(state, 'claude', 'b', 'user', ask)
  send(state, 'claude', 'b', 'assistant', '한 잔의 햇살.' + suffix)
  send(state, 'claude', 'b', 'user', '이대로 확정')
  assert.equal(copy(state).text, '한 잔의 햇살.' + suffix)
})

test('only explicit user decisions adopt a version; rejection and scoped feedback stay separate', () => {
  const state = emptyMemory()
  draft(state)
  send(state, 'chatgpt', 'source', 'assistant', '2안으로 확정')
  for (const text of ['2안이 좋아', '2안을 확정할까?', '2안을 확정하지 마', '예시: 2안을 채택', '“2안으로 확정”이라고 말했어.']) {
    send(state, 'chatgpt', 'source', 'user', text)
  }
  assert.equal(read(state).status, 'missing')
  assert.equal(state.projects[0].feedback.length, 1)
  send(state, 'chatgpt', 'source', 'user', '1안은 설명이 길어')
  assert.equal(state.projects[0].feedback.at(-1)?.option, 1)
  send(state, 'chatgpt', 'source', 'user', '1안은 탈락')
  send(state, 'chatgpt', 'source', 'user', '2안을 선택할게요.')
  assert.equal(copy(state, '탈락한 1안 원문을 다시 보여줘').text, '볕이 드는 창.')
  assert.equal(copy(state).text, original)
  assert.equal(read(state, '3안 원문 보여줘').status, 'missing')
})

test('two projects require a choice, bound conversation reuses the choice, grant stays strict', () => {
  const state = emptyMemory()
  adopted(state)
  adopted(state, 'second', '해솔 차')
  const r = read(state)
  assert.equal(r.status, 'ambiguous')
  assert.deepEqual(r.projects.map(x => x.title), ['달빛 커피', '해솔 차'])
  assert.deepEqual(r.projects, listApprovedProjects(state))
  assert.equal(copy(state, '해솔 차의 최신안 보여줘').projectId, r.projects[1].projectId)
  bindProject(state, 'claude', 'new', r.projects[0].projectId)
  assert.equal(copy(state).projectId, r.projects[0].projectId)
  assert.equal(lookupContext(state, {service:'chatgpt', conversationId:'new', query:ask}).status, 'ambiguous')
  assert.equal(read(state, ask, 'new', 'missing-project').status, 'missing')
})

test('simultaneous changes must confirm the same base revision', () => {
  const state = emptyMemory()
  adopted(state)
  for (const id of ['b', 'c']) {
    send(state, 'claude', id, 'user', ask)
    send(state, 'claude', id, 'assistant', id + '의 첫 문장.')
  }
  send(state, 'claude', 'c', 'user', '새 문장으로 확정')
  send(state, 'claude', 'b', 'user', '새 문장으로 확정')
  assert.equal(copy(state).text, 'c의 첫 문장.' + suffix)
})

test('rerenders deduplicate and editing a decision withdraws its original approval', () => {
  const state = emptyMemory()
  adopted(state)
  send(state, 'chatgpt', 'source', 'user', '2안으로 확정', 'pick')
  assert.equal(state.projects[0].decisions.length, 1)
  send(state, 'chatgpt', 'source', 'user', '아직 아무 안도 확정하지 않을게.', 'pick')
  assert.equal(read(state).status, 'missing')
  assert.equal(state.projects[0].decisions[0].withdrawn, true)
})

test('private conversations and arbitrary ambiguous trailing text never enter the result', () => {
  const state = emptyMemory()
  send(state, 'chatgpt', 'personal', 'user', '내 가족 이야기에만 등장하는 비밀-라벤더')
  send(state, 'chatgpt', 'personal', 'assistant', '1안: 예문1.\n2안: 비밀-라벤더\n3안: 예문3.')
  send(state, 'chatgpt', 'personal', 'user', '2안으로 확정')
  assert.deepEqual(state.projects, [])
  assert(!JSON.stringify(state).includes('비밀-라벤더'))
  draft(state)
  send(state, 'chatgpt', 'source', 'assistant', '1안: 첫 초안.\n2안: 다른 원고.\n\n개인적 사연: 비밀-라벤더\n3안: 마지막.', 'mixed')
  send(state, 'chatgpt', 'source', 'user', '2안으로 확정')
  assert.equal(read(state).status, 'missing')
  assert(!JSON.stringify(state.projects).includes('비밀-라벤더'))
  assert.equal(needsContext('오늘의 개인 일기'), false)
  assert.equal(read(state, '오늘의 개인 일기').status, 'missing')
})

test('fresh creation with option 2 instructions reaches capture, independent of natural selection variants', () => {
  const brief = '달빛 커피 상세페이지 원고 세 가지를 만들어줘. 2안에는 금빛-55를 넣어줘.'
  assert.equal(needsContext(brief), false)
  for (const decision of ['2안으로 할게', '2안으로 하자', '2안을 택할게', '2안으로 가자. 이유는 짧은 헤드라인이 좋아서.']) {
    const state = emptyMemory()
    send(state, 'chatgpt', 'a', 'user', brief)
    send(state, 'chatgpt', 'a', 'assistant', '시안 1: 첫 안.\n[2안]: 금빛-55.\n제3안: 셋째 안.')
    send(state, 'chatgpt', 'a', 'user', decision)
    assert.equal(copy(state).text, '금빛-55.')
    if (decision.includes('이유는')) {
      assert.equal(state.projects[0].decisions[0].reason, '짧은 헤드라인이 좋아서')
      assert.equal(state.preferences?.status, 'observed')
      assert(!JSON.stringify(copy(state)).includes('짧은 헤드라인'))
    }
  }
})

test('only selected work on two distinct products can prompt for a short-headline default', () => {
  const state = emptyMemory()
  const pick = '2안으로 가자. 이유는 짧은 헤드라인이 좋아서.'
  send(state, 'chatgpt', 'personal', 'user', pick)
  assert.equal(state.preferences, undefined)
  for (const title of ['블루 카카오', '로즈 카카오']) {
    draft(state, title, title)
    send(state, 'chatgpt', title, 'user', '2안은 짧은 헤드라인이 좋아')
    send(state, 'chatgpt', title, 'user', '2안으로 하자')
  }
  assert.deepEqual(state.preferences, {status:'pending'})
})
