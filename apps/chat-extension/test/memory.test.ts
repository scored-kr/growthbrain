import assert from 'node:assert/strict'
import test from 'node:test'
import {bindProject, captureTurn, compareFirstSentenceReply, emptyMemory, listApprovedProjects, lookupContext, needsContext} from '../src/memory.ts'
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

test('withhold labelled personal or editorial asides inside a numbered section, including inline and fenced text', () => {
  const secret = '보라빛-병원-372'
  for (const mixed of [
    '제품 문구.\n참고: 동생의 치료 기록은 ' + secret,
    '제품 문구. **개인 메모:** ' + secret,
    '제품 문구.\n[비공개 기록] ' + secret,
    '제품 문구. 참고로, ' + secret,
    '```text\n제품 문구.\n> Note: ' + secret + '\n```'
  ]) {
    const state = emptyMemory()
    send(state, 'chatgpt', 'a', 'user', '달빛 커피 상세페이지 초안 세 가지 비교해 줘.\n1안: 첫 문구.\n2안: ' + mixed + '\n3안: 마지막 문구.')
    send(state, 'chatgpt', 'a', 'user', '2안으로 확정')
    assert.equal(read(state).status, 'missing')
    assert(!JSON.stringify(state.projects).includes(secret))
  }
})

test('refuse marked aside as a replacement sentence and block earlier snapshots with unsafe copy', () => {
  const state = emptyMemory()
  adopted(state)
  send(state, 'claude', 'b', 'user', ask)
  send(state, 'claude', 'b', 'assistant', '수정한 첫 문장: 참고: 동생의 치료 기록은 보라빛-병원-372.')
  send(state, 'claude', 'b', 'user', '그 문장으로 확정')
  assert.equal(copy(state).text, original)
  assert(!JSON.stringify(state.projects).includes('보라빛-병원-372'))
  state.projects[0].revisions.find(item => item.option === 2)!.text += '\n개인적인 이야기: 보라빛-병원-372.'
  assert.equal(read(state).status, 'missing')
  assert.deepEqual(listApprovedProjects(state), [])
})

test('fenced DOM-rendered work keeps ordinary family/product words, paragraph breaks and trailing spaces', () => {
  const state = emptyMemory()
  const tail = '\n엄마와 가족이 함께 마시는 차.  \n\n향긋한 마지막 모금.  '
  const original = '산뜻한 차.' + tail
  send(state, 'chatgpt', 'a', 'user', '루이보스 상세페이지 초안 세 가지를 비교해 줘.')
  send(state, 'chatgpt', 'a', 'assistant', '1안\n첫 번째.\n2안\n```text\n' + original +
    '\n```\n참고: 동생의 치료 기록은 보라빛-병원-372.\n3안\n세 번째.')
  send(state, 'chatgpt', 'a', 'user', '2안으로 확정')
  assert.equal(copy(state).text, original)
  send(state, 'claude', 'b', 'user', ask)
  send(state, 'claude', 'b', 'assistant', '```text\n아침에 즐기는 차.' + tail + '\n```')
  send(state, 'claude', 'b', 'user', '그 문장으로 확정')
  assert.equal(copy(state).text, '아침에 즐기는 차.' + tail)
  assert(!JSON.stringify(state.projects).includes('보라빛-병원-372'))
})

test('a connector grant authorizes one project without deciding which manuscript an ambiguous question meant', () => {
  const state = emptyMemory()
  adopted(state, 'cup', '유리잔')
  adopted(state, 'towel', '면수건')
  const [cup, towel] = listApprovedProjects(state)
  const grant = (query: string, projectId: string) => lookupContext(state, {
    scope: 'service-grant', service: 'claude', conversationId: 'test-client', query, projectId
  })
  assert.deepEqual(grant('면수건의 2안 원문을 보여줘', cup.projectId), {status:'missing'})
  assert.deepEqual(grant('유리잔과 면수건 중 어제 고른 2안 원고 보여줘', cup.projectId), {status:'missing'})
  assert.deepEqual(grant(ask, cup.projectId), {status:'missing'})
  assert.equal(grant('면수건의 2안 원문을 보여줘', towel.projectId).status, 'found')
  assert.equal(read(state, ask).status, 'ambiguous')
  assert.equal(read(state, ask, 'new', cup.projectId).status, 'found')

  // Even if only one project still has an active draft, a two-title question has no unique target.
  send(state, 'chatgpt', 'towel', 'user', '2안은 보류')
  assert.deepEqual(grant('유리잔과 면수건의 최신안을 보여줘', cup.projectId), {status:'missing'})
  assert.deepEqual(grant('면수건의 최신안을 보여줘', cup.projectId), {status:'missing'})
  assert.deepEqual(grant('유리잔의 1안과 2안 원고를 보여줘', cup.projectId), {status:'missing'})
})

test('an embedded short project name yields to the full title, unless mentioned separately', () => {
  const state = emptyMemory()
  adopted(state, 'short', '커피')
  adopted(state, 'long', '달빛 커피')
  const [short, long] = listApprovedProjects(state)
  const query = '달빛 커피의 2안 원문을 보여줘'
  const request = {scope:'service-grant' as const, service:'claude' as const, conversationId:'official', query}
  assert.deepEqual(lookupContext(state, {...request, projectId:short.projectId}), {status:'missing'})
  const found = lookupContext(state, {...request, projectId:long.projectId})
  assert.equal(found.status, 'found')
  assert.equal(found.projectId, long.projectId)
  assert.equal(found.sourceService, 'chatgpt')
  assert.equal(copy(state, query).projectId, long.projectId)
  const multiple = '달빛 커피와 커피의 2안 원고를 보여줘'
  assert.equal(read(state, multiple).status, 'ambiguous')
  assert.deepEqual(lookupContext(state, {...request, query:multiple, projectId:short.projectId}), {status:'missing'})
  assert.deepEqual(lookupContext(state, {...request, query:multiple, projectId:long.projectId}), {status:'missing'})
})

test('only an actually returned exact suffix counts as a verified model reply', () => {
  const original = '첫 문장.\n\n보존할 문장.  '
  assert.equal(compareFirstSentenceReply(original, '바뀐 문장.'), 'unverified')
  assert.equal(compareFirstSentenceReply(original, original), 'unverified')
  const padded = '  같은 제목  \n보존할 문장.'
  assert.equal(compareFirstSentenceReply(padded, padded), 'unverified')
  const twoReplies = '```text\n바뀐 문장.\n\n보존할 문장.  \n```\n```text\n다른 후보.\n```'
  assert.equal(compareFirstSentenceReply(original, twoReplies), 'unverified')
  assert.equal(compareFirstSentenceReply(original, '원문을 확인할 수 없어요. 다시 보여 주세요.'), 'unverified')
  assert.equal(compareFirstSentenceReply(original, '바뀐 문장.\n\n보존할 문장.  '), 'match')
  assert.equal(compareFirstSentenceReply(original, '바뀐 문장.\n\n보존할 문장.'), 'changed')
})
