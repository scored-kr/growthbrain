import type { DeviceContext } from './device.ts'
import { getJournalTurn } from './journal.ts'
import { approvedHeadlinePreference, resumeHeadlinePreference } from './preferences.ts'
import { resumePrompt } from './recall-command.ts'
import { listApprovedProjects, lookupContext, namedProjects, needsContext, type MemoryState, type Service, type Turn } from './memory.ts'
import { approvalField, maxDecisionLength, maxProjectDecisions, maxProjectReferences, maxReferenceLength } from './approval-state.ts'

export function listApprovalProjects(state: MemoryState) {
  return state.projects.map(({id, title, approvedConditions, approvedReferences}) => ({
    id, title, approvedConditions: (approvedConditions ?? []).map(({id, text}) => ({id, text})),
    approvedReferences: (approvedReferences ?? []).map(({id, text}) => ({id, text})),
  }))
}

export interface ApprovalInput {
  service: Service
  conversationId: string
  id: string
  role?: Turn['role']
  sequence: number
  revision: number
  projectId?: string
  newProjectTitle?: string
  expectedConditionId: string | null
}
type ApprovalResult = {status: 'approved', projectId: string} | {status: 'invalid' | 'conflict' | 'stale' | 'limit'}

export function approveStoredCondition(state: MemoryState, input: ApprovalInput): ApprovalResult {
  const { service, conversationId, id, role = 'user', sequence, revision, projectId, newProjectTitle, expectedConditionId } = input
  const turn = getJournalTurn(state, service, conversationId, id, role)
  if (!turn || turn.sequence !== sequence || turn.revision !== revision) return {status: 'stale'}
  const maxLength = role === 'user' ? maxDecisionLength : maxReferenceLength
  if (!turn.text.trim() || turn.text.length > maxLength) return {status: 'invalid'}
  if ((projectId === undefined) === (newProjectTitle === undefined)) return {status: 'invalid'}
  let project = state.projects.find(p => p.id === projectId)
  if (newProjectTitle !== undefined) {
    const title = newProjectTitle.normalize('NFC').trim()
    if (!title || title.length > 40 || /[\p{Cc}\p{Cf}]/u.test(title)) return {status: 'invalid'}
    if (expectedConditionId !== null || state.projects.some(p => p.title.normalize('NFC').trim().toLowerCase() === title.toLowerCase())) return {status: 'conflict'}
    project = {id:crypto.randomUUID(), title, revisions:[], decisions:[], feedback:[]}
  }
  if (!project) return {status: 'invalid'}
  const field = approvalField(role)
  const existing = project[field] ?? []
  if (expectedConditionId !== null && !existing.some(item => item.id === expectedConditionId)) return {status: 'conflict'}
  const kept = existing.filter(item => item.id !== expectedConditionId)
  const alreadyApproved = kept.find(item => item.source.service === service && item.source.conversationId === conversationId &&
    item.source.id === id && item.source.sequence === sequence && item.source.revision === revision)
  if (alreadyApproved) return expectedConditionId === null ? {status:'approved',projectId:project.id} : {status:'conflict'}
  const maxItems = role === 'user' ? maxProjectDecisions : maxProjectReferences
  if (kept.length >= maxItems) return {status: 'limit'}
  project[field] = [...kept, {id:crypto.randomUUID(), text:turn.text, source:{service, conversationId, id, role, sequence, revision}}]
  if (newProjectTitle !== undefined) state.projects.push(project)
  return {status: 'approved', projectId: project.id}
}

export function retireStoredCondition(state: MemoryState, projectId: string, expectedConditionId: string, role: Turn['role'] = 'user') {
  const project = state.projects.find(p => p.id === projectId)
  const field = approvalField(role)
  const existing = project?.[field]
  if (!project || !existing?.some(item => item.id === expectedConditionId)) return false
  project[field] = existing.filter(item => item.id !== expectedConditionId)
  return true
}

export { resumePrompt }
const previousConditions = /(?:지난번|저번|이전(?:에)?|앞서|전에)\s*(?:(?:정한|정했던|합의한|승인한|확정한)\s*)?(?:조건|기준|선호도|결정)(?:들)?(?:대로|에\s*맞춰|을\s*(?:적용|반영|확인)|를\s*(?:적용|반영|확인))/u

export function readGrantedContext(state: MemoryState, request: {service: Service, projectId: string, query: string}): DeviceContext {
  const {projectId, query} = request
  const [firstParagraph, ...task] = query.trim().split(/\r?\n\s*\r?\n/u)
  const shortcut = firstParagraph === resumePrompt
  const userTask = shortcut ? task.join('\n\n') : query
  if ((shortcut || previousConditions.test(userTask)) && !needsContext(userTask)) {
    const continuation = previousConditions.exec(userTask)
    if (continuation && /^\s*(?:하지\s*(?:마|말)|말고|안\s*(?:해|할|하)|하지는\s*마)/u.test(userTask.slice(continuation.index + continuation[0].length)))
      return {status:'missing'}
    const named = namedProjects(state.projects, userTask)
    if (named.some(project => project.id !== projectId)) return {status:'missing'}
    const project = state.projects.find(p => p.id === projectId)
    if (!project) return {status:'missing'}
    const preference = resumeHeadlinePreference(state.preferences, userTask.replace(previousConditions, '').trim())
    const decisions = (project.approvedConditions ?? []).map(item => item.text)
    const references = (project.approvedReferences ?? []).map(item => item.text)
    if (decisions.length || references.length)
      return {status:'resume', projectId, decisions, ...(references.length && {references}), ...(preference && {preference})}
    if (preference && listApprovedProjects(state).some(p => p.projectId === projectId)) return {status:'preference', projectId, preference}
    return {status:'missing'}
  }
  const preference = approvedHeadlinePreference(state.preferences, userTask)
  if (preference && listApprovedProjects(state).some(p => p.projectId === projectId)) {
    return {status:'preference', projectId, preference}
  }
  const draft = lookupContext(state, {...request, query:userTask, conversationId:'mcp', scope:'service-grant'})
  if (draft.status !== 'found' || draft.projectId !== projectId) return {status:'missing'}
  return {status:'found', projectId, option:draft.option, version:draft.version, text:draft.text}
}
