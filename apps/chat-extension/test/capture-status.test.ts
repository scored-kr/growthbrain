import assert from 'node:assert/strict'
import test from 'node:test'
import { savedChatStatus } from '../src/capture-status.ts'
import { captureTurn, emptyMemory, type MemoryState, type Turn } from '../src/memory.ts'

function say(state: MemoryState, conversationId: string, id: string, role: Turn['role'], text: string) {
  captureTurn(state, {service: 'chatgpt', conversationId, id, role, text})
}
const brief = '휴대용 텀블러 상세페이지 초안 3개를 써줘.'
const options = '1안: 첫 원고.\n2안: 비공개 시험 문장.\n3안: 세 번째 원고.'

test('popup receipt distinguishes capture, parsing and committed approval without returning text or IDs', () => {
  const state = emptyMemory()
  const receipt = () => savedChatStatus(state, 'source-conversation')
  const send = (id: string, role: Turn['role'], text: string) => say(state, 'source-conversation', id, role, text)
  assert.deepEqual(receipt(), {status: 'no-turns'})
  send('hello', 'user', '안녕하세요')
  assert.deepEqual(receipt(), {status: 'no-project'})
  send('brief', 'user', brief)
  assert.deepEqual(receipt(), {status: 'no-options'})
  send('draft', 'assistant', options)
  assert.deepEqual(receipt(), {status: 'options', options: [1, 2, 3]})
  send('approve', 'user', '2안으로 확정')
  assert.deepEqual(receipt(), {status: 'approved', option: 2, version: 1})
  send('retire', 'user', '2안은 보류')
  assert.deepEqual(receipt(), {status: 'inactive'})
})

test('receipt does not attribute another chat’s current decision to this source, even for an identical option and version', () => {
  const state = emptyMemory()
  for (const chat of ['original', 'other']) {
    say(state, chat, 'brief-' + chat, 'user', brief)
    say(state, chat, 'copy-' + chat, 'assistant', options)
  }
  say(state, 'original', 'approve-a', 'user', '2안으로 확정')
  assert.deepEqual(savedChatStatus(state, 'other'), {status: 'options', options: [1, 2, 3]})
  say(state, 'other', 'approve-b', 'user', '2안으로 확정')
  assert.deepEqual(savedChatStatus(state, 'other'), {status: 'approved', option: 2, version: 1})
  assert.deepEqual(savedChatStatus(state, 'original'), {status: 'inactive'})
  assert.deepEqual(savedChatStatus(state, 'unrelated'), {status: 'no-turns'})
})
