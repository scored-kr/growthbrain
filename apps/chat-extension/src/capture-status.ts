import { lookupContext, type MemoryState } from './memory.ts'

export type CaptureStatus =
  | {status: 'approved', option: number, version: number}
  | {status: 'options', options: number[]}
  | {status: 'open-source' | 'locked' | 'capture-off' | 'reload' | 'unverified' | 'storage-error' |
      'no-turns' | 'no-project' | 'no-options' | 'inactive'}

/** Receipt from the committed local snapshot. Never return text, titles or source identities to the popup. */
export function savedChatStatus(state: MemoryState, conversationId: string): CaptureStatus {
  const chat = state.conversations.find(item => item.service === 'chatgpt' && item.id === conversationId)
  if (!chat?.seen.length) return {status: 'no-turns'}
  const project = state.projects.find(item => item.id === chat.projectId)
  if (!project) return {status: 'no-project'}

  const adopted = project.decisions.filter(item => !item.withdrawn && item.status === 'adopted')
  const latest = adopted.at(-1)
  const belongsToChat = (item: typeof adopted[number]) =>
    item.source.service === 'chatgpt' && item.source.conversationId === conversationId
  if (latest && belongsToChat(latest)) {
    // Check the product's current-read rules too. A later rejection or an excluded revision
    // can prevent an earlier approval from being used.
    const current = lookupContext(state, {service: 'chatgpt', conversationId, projectId: project.id, query: '최신안'})
    if (current.status === 'found' && current.option === latest.option && current.version === latest.version) {
      return {status: 'approved', option: current.option, version: current.version}
    }
  }
  if (adopted.some(belongsToChat)) return {status: 'inactive'}
  if (chat.presented?.length) return {status: 'options', options: chat.presented.map(item => item.option)}
  return {status: 'no-options'}
}
