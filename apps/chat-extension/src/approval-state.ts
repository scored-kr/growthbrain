import type { MemoryState, Service, Turn } from './memory.ts'

export const maxDecisionLength = 2000
export const maxProjectDecisions = 8
export const maxReferenceLength = 8000
export const maxProjectReferences = 4

/** Only the reviewed text leaves the device. Local snapshot IDs cannot associate later provider edits. */
export interface ApprovedItem {
  id: string
  text: string
  source: {
    service: Service
    conversationId: string
    id: string
    role?: Turn['role']
    sequence: number
    revision: number
  }
}

export function approvalField(role: Turn['role']): 'approvedConditions' | 'approvedReferences' {
  return role === 'user' ? 'approvedConditions' : 'approvedReferences'
}

export function retireEditedSourceCondition(state: MemoryState, turn: Turn, sequence?: number, revision?: number) {
  const field = approvalField(turn.role)
  for (const project of state.projects) {
    const existing = project[field]
    if (!existing?.length) continue
    project[field] = existing.filter(({source, text}) =>
      source.service !== turn.service || source.conversationId !== turn.conversationId || source.id !== turn.id ||
      (source.role ?? 'user') !== turn.role ||
      (text === turn.text && (sequence === undefined || source.sequence === sequence) &&
        (revision === undefined || source.revision === revision)))
  }
}
