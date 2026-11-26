import assert from 'node:assert/strict'
import {test} from 'node:test'
import {captureTurn, emptyMemory, lookupContext, type MemoryState, type Turn} from '../src/memory.ts'
import {getJournalTurn, journalLimits, readChatJournal, recordLocalChatTurn} from '../src/journal.ts'

const message = (id:string, text:string, extra:Partial<Turn> = {}): Turn =>
  ({service:'chatgpt', conversationId:'source', id, role:'user', text, ...extra})
const journal = (state:MemoryState, before?:number) => readChatJournal(state, 'chatgpt', 'source', before)

test('ordinary source turns and edits persist across reload without turning into project decisions', () => {
  const original = message('one','  긴 문장\n\n보존할 문단.  ')
  const state = emptyMemory()
  captureTurn(state, original)
  captureTurn(state, message('one','답변',{role:'assistant'}))
  captureTurn(state, message('one','다른 채팅',{conversationId:'elsewhere'}))
  captureTurn(state, message('one','다른 서비스',{service:'claude'}))
  const reopened:MemoryState = JSON.parse(JSON.stringify(state))
  captureTurn(reopened, original)
  assert.deepEqual(reopened, state)
  assert.deepEqual(journal(reopened).entries.map(row => row.text), ['답변',original.text])
  assert.equal(reopened.projects.length,0)
  assert.equal(lookupContext(reopened,{service:'claude',conversationId:'b',query:'최신안을 보여줘'}).status,'missing')
  captureTurn(reopened, {...original,text:'수정한 문장'})
  const latest = journal(reopened)
  assert.equal(latest.savedCount,2)
  assert.equal(latest.entries[0].revision,2)
  assert.equal(latest.entries[0].identity,'stable')
  assert(!JSON.stringify(reopened).includes('보존할 문단'))
  assert.deepEqual(getJournalTurn(reopened,'chatgpt','source','one','assistant'), latest.entries[1])
})

test('legacy fingerprints without archived text backfill once; source data is never fabricated', () => {
  const state = emptyMemory()
  const turn = message('1','다시 화면에서 읽은 내용')
  captureTurn(state,turn)
  delete state.journal
  assert.equal(journal(state).savedCount,0)
  captureTurn(state,turn)
  assert.equal(journal(state).entries[0].revision,1)
  const saved = structuredClone(state)
  captureTurn(state,turn)
  assert.deepEqual(state,saved)
})

test('local-only observations retain distinct occurrences without binding a project or confirming a selection', () => {
  const state = emptyMemory()
  const first = message('local:abc:0','텀블러 상세페이지 원고 세 가지를 만들어줘.')
  const second = {...first,id:'local:abc:1'}
  for (const turn of [first,second,first,message('local:pick:0','2안으로 확정')]) recordLocalChatTurn(state,turn)
  captureTurn(state,first) // The source tab cannot promote the reserved identity via the stable path.
  assert.equal(journal(state).savedCount,3)
  assert(journal(state).entries.every(row => row.identity === 'local'))
  assert.deepEqual(state.projects,[])
  assert.deepEqual(state.conversations,[])
})

test('paged local preview is newest first and scoped to a single source', () => {
  const state = emptyMemory()
  for (let i = 1; i <= 7; i++) captureTurn(state,message(String(i),'turn-' + i))
  captureTurn(state, message('2','other chat',{conversationId:'2'}))
  const first = journal(state)
  const second = journal(state,first.nextBefore!)
  assert.equal(first.savedCount,7)
  assert.deepEqual(first.entries.map(row => row.id),['7','6','5','4','3'])
  assert.deepEqual(second.entries.map(row => row.id),['2','1'])
  assert.equal(second.nextBefore,null)
})

test('text-unit and count bounds discard oldest bodies and prevent scrollback from resurrecting them', () => {
  for (const [n, width] of [[journalLimits.turns+1, 8], [Math.floor(journalLimits.textUnits / 64_000)+2,64_000]]) {
    const state = emptyMemory()
    const turns = Array.from({length:n},(_,i) => message(String(i),String(i).padEnd(width,'가')))
    for (const turn of turns) captureTurn(state,turn)
    const trimmed = n - journal(state).savedCount
    assert(trimmed > 0)
    assert.equal(journal(state).trimmedCount,trimmed)
    assert(state.journal!.retainedUnits <= journalLimits.textUnits)
    assert.equal(getJournalTurn(state,'chatgpt','source','0','user'),undefined)
    const saved = structuredClone(state)
    for (const turn of turns) captureTurn(state,turn)
    assert.deepEqual(state,saved)
    captureTurn(state,{...turns[0],text:'edited after trimming'})
    assert.equal(journal(state).entries[0].revision,2)
    assert.equal(journal(state).entries[0].text,'edited after trimming')
  }
})

test('a full identity ledger declares missed new identities without rewriting it on each rescan', () => {
  const state = emptyMemory()
  recordLocalChatTurn(state, message('local:kept','known'))
  const record = state.journal!.retained[0]
  state.journal!.trimmed = Array.from({length:journalLimits.identities - 1},(_,i) => ({
    service:record.service, conversationId:record.conversationId, role:record.role, identity:record.identity,
    id:'local:trimmed-'+i, sequence:i+2, revision:1, fingerprint:'1/0'
  }))
  state.journal!.lastSequence = journalLimits.identities
  recordLocalChatTurn(state,message('local:new','not retained'))
  assert.equal(journal(state).identityLimitReached,true)
  assert.equal(journal(state).savedCount,1)
  assert.equal(journal(state).trimmedCount,journalLimits.identities-1)
  const before = JSON.stringify(state)
  recordLocalChatTurn(state,message('local:new','not retained'))
  assert.equal(JSON.stringify(state),before)
})
