import assert from 'node:assert/strict'
import {test} from 'node:test'
import {applyCaptureBatch, maxCaptureBatchTurns, maxCaptureBatchUnits, parseCaptureMessage} from '../src/capture-batch.ts'
import {readChatJournal} from '../src/journal.ts'
import {emptyMemory, lookupContext} from '../src/memory.ts'

const user = (id:string,text:string) => ({id, role:'user', text})
const question = user('brief','텀블러 상세페이지 초안을 세 개 만들어줘.')
const draft = {id:'options', role:'assistant', text:'1안: 처음.\n2안: 두 번째 본문.'}
const pick = user('confirmed','2안으로 확정')
const parse = (turns:unknown) => parseCaptureMessage({type:'captureBatch', turns}, 'chatgpt', 'source')

test('mixed batches retain local-only and stable turns in order with one immutable source scope', () => {
  const state = emptyMemory()
  const turns = parse([question, draft, {...user('local:unchecked',pick.text), service:'claude', conversationId:'elsewhere'}])!
  applyCaptureBatch(state,turns)
  const get = () => lookupContext(state,{service:'claude',conversationId:'elsewhere',query:'최신안을 보여줘'})
  assert.equal(get().status,'missing')
  assert.equal(readChatJournal(state,'chatgpt','source').savedCount,3)
  assert.equal(readChatJournal(state,'claude','elsewhere').savedCount,0)
  applyCaptureBatch(state,parse([pick])!)
  const approved = get()
  assert.equal(approved.status,'found')
  assert.equal(approved.text,'두 번째 본문.')
  const saved = structuredClone(state)
  applyCaptureBatch(state,[...turns, ...parse([pick])!])
  assert.deepEqual(state,saved)
})

test('capture request bounds and invalid final entries reject the entire batch', () => {
  const half = 'x'.repeat(maxCaptureBatchUnits / 2)
  assert.equal(parse([user('1',half),user('2',half)])!.length,2)
  assert.equal(parse([user('1',half),user('2',half+'x')]),undefined)
  assert.equal(parse(Array.from({length:maxCaptureBatchTurns},(_,i)=>user(String(i),'value')))!.length,maxCaptureBatchTurns)
  for (const bad of [null, [], [question,null], [draft, {id:'bad',role:'system',text:'skip'}],
    [draft,user('','bad')], [draft,user('oversized','x'.repeat(100_001))], Array(maxCaptureBatchTurns + 1).fill(pick)]) {
    assert.equal(parse(bad), undefined)
  }
})

test('legacy single capture callers keep their original identity boundary', () => {
  const single = (type:string, id:string) => parseCaptureMessage({type,...user(id,'original')},'claude','c')
  assert.deepEqual(single('capture','id'),[{service:'claude',conversationId:'c',...user('id','original')}])
  assert.deepEqual(single('captureLocal','local:abc'),[{service:'claude',conversationId:'c',...user('local:abc','original')}])
  assert.equal(single('capture','local:abc'),undefined)
  assert.equal(single('captureLocal','id'),undefined)
  assert.equal(single('review','id'),undefined)
})
