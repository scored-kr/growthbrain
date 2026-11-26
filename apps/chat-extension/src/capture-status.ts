import { lookupContext, type MemoryState, type Service } from './memory.ts'

export type ChatSource = {tabId:number, service:Service, conversationId:string}
export type TurnReference = {id:string, role:'user'|'assistant', sequence:number, revision:number}
export type CapturePreview = {
  source: ChatSource
  observed: number
  readable: number
  savedCount: number
  trimmedCount: number
  identityLimitReached: boolean
  nextBefore: number | null
  entries: (TurnReference & {preview:string})[]
}

export type CaptureStatus =
  | {status: 'approved', option: number, version: number}
  | {status: 'options', options: number[]}
  | {status: 'open-source' | 'locked' | 'capture-off' | 'reload' | 'route-unverified' | 'unverified' | 'storage-error' |
      'no-turns' | 'no-project' | 'no-options' | 'inactive' | 'captured' | 'stale'}

/** Text-free status for the requested chat's committed decisions. */
export function savedChatStatus(state: MemoryState, conversationId: string, service: Service = 'chatgpt'): CaptureStatus {
  const chat = state.conversations.find(item => item.service === service && item.id === conversationId)
  if (!chat?.seen.length) return {status: 'no-turns'}
  const project = state.projects.find(item => item.id === chat.projectId)
  if (!project) return {status: 'no-project'}

  const adopted = project.decisions.filter(item => !item.withdrawn && item.status === 'adopted')
  const latest = adopted.at(-1)
  const belongsToChat = (item: typeof adopted[number]) =>
    item.source.service === service && item.source.conversationId === conversationId
  if (latest && belongsToChat(latest)) {
    // Check the product's current-read rules too. A later rejection or an excluded revision
    // can prevent an earlier approval from being used.
    const current = lookupContext(state, {service, conversationId, projectId: project.id, query: '최신안'})
    if (current.status === 'found' && current.option === latest.option && current.version === latest.version) {
      return {status: 'approved', option: current.option, version: current.version}
    }
  }
  if (adopted.some(belongsToChat)) return {status: 'inactive'}
  if (chat.presented?.length) return {status: 'options', options: chat.presented.map(item => item.option)}
  return {status: 'no-options'}
}
