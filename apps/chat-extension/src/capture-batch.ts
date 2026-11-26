import {recordLocalChatTurn} from './journal.ts'
import {captureTurn, type MemoryState, type Service, type Turn} from './memory.ts'

export const maxCaptureBatchTurns = 16
export const maxCaptureBatchUnits = 128_000

/** The caller already checked collection consent and the canonical top-frame URL.
 * Complete validation before opening the encrypted edit; every row gets that same source. */
export function parseCaptureMessage(message: Record<string, unknown>, service: Service, conversationId: string): Turn[] | undefined {
  const batch = message.type === 'captureBatch'
  if (!batch && message.type !== 'capture' && message.type !== 'captureLocal') return
  const entries = batch ? message.turns : [message]
  if (!Array.isArray(entries) || !entries.length || entries.length > maxCaptureBatchTurns) return
  let units = 0
  const turns: Turn[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return
    const {id,role,text} = entry
    if (typeof id !== 'string' || !id || id.length > 256 || typeof text !== 'string' || text.length > 100_000 ||
        (role !== 'user' && role !== 'assistant')) return
    if (!batch && id.startsWith('local:') !== (message.type === 'captureLocal')) return
    units += text.length
    if (units > maxCaptureBatchUnits) return
    turns.push({service, conversationId, id, role, text})
  }
  return turns
}

export function applyCaptureBatch(state: MemoryState, turns: Turn[]): void {
  for (const turn of turns) {
    if (turn.id.startsWith('local:')) recordLocalChatTurn(state, turn)
    else captureTurn(state, turn)
  }
}
