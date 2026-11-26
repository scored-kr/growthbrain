import {retireEditedSourceCondition} from './approval-state.ts'
import type {MemoryState, Service, Turn} from './memory.ts'

// The journal lives inside the extension's encrypted snapshot. The capped identity
// ledger lets an older rendered turn stay trimmed when a long chat is reopened.
export const journalLimits = {turns:512, textUnits:1_048_576, identities:20_000, pageSize:5} as const

export interface JournalTurn {
  id: string
  role: Turn['role']
  sequence: number
  revision: number
  identity: 'stable' | 'local'
  text: string
}
type StoredTurn = JournalTurn & {service:Service, conversationId:string}
type TrimmedTurn = Omit<StoredTurn,'text'> & {fingerprint:string}
export interface ChatJournal {
  retained: StoredTurn[]
  trimmed: TrimmedTurn[]
  lastSequence: number
  retainedUnits: number
  identityLimitReached: boolean
}

// A compact rerender detector for older trimmed texts, never evidence of approval.
export function captureFingerprint(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return text.length + '/' + hash
}

function storedIdentity(turn: Pick<Turn,'service'|'conversationId'|'id'|'role'>) {
  return (row: StoredTurn | TrimmedTurn) => row.service === turn.service &&
    row.conversationId === turn.conversationId && row.id === turn.id && row.role === turn.role
}

function record(state: MemoryState, turn: Turn, identity: JournalTurn['identity']): void {
  if (!turn.id || turn.id.length > 256 || !turn.conversationId || turn.conversationId.length > 180 ||
      turn.conversationId === 'new' || !turn.text.trim() || turn.text.length > 128_000) return
  if (turn.id.startsWith('local:') !== (identity === 'local')) return
  const journal = state.journal ??= {retained:[], trimmed:[], lastSequence:0, retainedUnits:0, identityLimitReached:false}
  const match = storedIdentity(turn)
  const retainedIndex = journal.retained.findIndex(match)
  const prior = journal.retained[retainedIndex]
  if (prior?.text === turn.text) return

  const trimmedIndex = prior ? -1 : journal.trimmed.findIndex(match)
  const old = journal.trimmed[trimmedIndex]
  if (old && old.fingerprint === captureFingerprint(turn.text)) {
    if (identity === 'stable') retireEditedSourceCondition(state, turn, old.sequence, old.revision)
    return
  }
  if (!prior && !old && journal.retained.length + journal.trimmed.length >= journalLimits.identities) {
    journal.identityLimitReached = true
    return
  }

  if (prior) {
    journal.retained.splice(retainedIndex, 1)
    journal.retainedUnits -= prior.text.length
  }
  if (old) journal.trimmed.splice(trimmedIndex, 1)
  const sequence = ++journal.lastSequence
  const revision = (prior?.revision ?? old?.revision ?? 0) + 1
  const {id, role, text, service, conversationId} = turn
  journal.retained.push({id, role, text, service, conversationId, identity, sequence, revision})
  journal.retainedUnits += turn.text.length
  if ((prior || old) && identity === 'stable') retireEditedSourceCondition(state, turn, sequence, revision)
  while (journal.retained.length > journalLimits.turns || journal.retainedUnits > journalLimits.textUnits) {
    const {text, ...row} = journal.retained.shift()!
    journal.trimmed.push({...row, fingerprint:captureFingerprint(text)})
    journal.retainedUnits -= text.length
  }
}

export function recordStableChatTurn(state: MemoryState, turn: Turn): void {
  record(state, turn, 'stable')
}

/** A local observation has no provider message ID. Recording it never runs decision or approval rules. */
export function recordLocalChatTurn(state: MemoryState, turn: Turn): void {
  record(state, turn, 'local')
}

function preview(row: StoredTurn): JournalTurn {
  const {id, role, identity, sequence, revision, text} = row
  return {id, role, identity, sequence, revision, text}
}

export function getJournalTurn(state: MemoryState, service: Service, conversationId: string, id: string, role: Turn['role']): JournalTurn | undefined {
  const row = state.journal?.retained.find(storedIdentity({service, conversationId, id, role}))
  return row && preview(row)
}

function belongsToChat(service: Service, conversationId: string) {
  return (row: StoredTurn | TrimmedTurn) => row.service === service && row.conversationId === conversationId
}

/** The popup's automatic receipt contains only committed counts. */
export function chatJournalCounts(state: MemoryState, service: Service, conversationId: string) {
  const inChat = belongsToChat(service, conversationId)
  return {
    savedCount:state.journal?.retained.filter(inChat).length ?? 0,
    trimmedCount:state.journal?.trimmed.filter(inChat).length ?? 0,
    identityLimitReached:state.journal?.identityLimitReached ?? false,
  }
}

/** Local popup only. A cursor is the oldest sequence on the preceding page. */
export function readChatJournal(state: MemoryState, service: Service, conversationId: string, before?: number) {
  const journal = state.journal
  const inChat = belongsToChat(service, conversationId)
  const retained = journal?.retained.filter(inChat) ?? []
  const available = retained.filter(row => before === undefined || row.sequence < before)
  const entries = available.slice(-journalLimits.pageSize).reverse().map(preview)
  return {
    savedCount:retained.length,
    trimmedCount:journal?.trimmed.filter(inChat).length ?? 0,
    identityLimitReached:journal?.identityLimitReached ?? false,
    entries,
    nextBefore:available.length > entries.length ? entries.at(-1)!.sequence : null
  }
}
