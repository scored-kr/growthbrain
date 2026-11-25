import { bindProject, captureTurn, listApprovedProjects, lookupContext, type Service } from './memory.ts'
import { approvedHeadlinePreference, decideHeadlinePreference, headlinePreferencePending } from './preferences.ts'
import { withMemory } from './storage.ts'
import { startRelay, reconnectRelay } from './device.ts'

type Grant = { capture: boolean, share: boolean }
type Grants = Record<Service, Grant>
const defaults = (): Grants => ({
  chatgpt: {capture: false, share: false}, claude: {capture: false, share: false}
})
const sites = {chatgpt:'https://chatgpt.com', claude:'https://claude.ai'} as const
const isService = (value: unknown): value is Service => value === 'chatgpt' || value === 'claude'
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w.-]{1,180}$/.test(id)

let tail: Promise<unknown> = Promise.resolve()
// The service worker is the sole writer. Acknowledgement follows the IDB commit,
// including when an event races with another tab, a permission change or relay read.
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = tail.then(fn)
  tail = result.catch(() => {})
  return result
}
async function grants(): Promise<Grants> {
  const stored = await chrome.storage.local.get<{grants?: Grants}>('grants')
  return stored.grants ?? defaults()
}
async function locked() {
  return (await chrome.storage.local.get('locked')).locked === true
}

async function clearDrafts(service?: Service, tab?: number) {
  const keys = await chrome.storage.session.get(null)
  await chrome.storage.session.remove(Object.keys(keys).filter(k =>
    k.startsWith('draft:') && (!service || k.startsWith('draft:' + service + ':')) &&
    (tab === undefined || k.split(':')[2] === String(tab))))
}
async function announce() {
  const tabs = await chrome.tabs.query({url: ['https://chatgpt.com/*', 'https://claude.ai/*']})
  await Promise.allSettled(tabs.filter(t => t.id !== undefined).map(t => chrome.tabs.sendMessage(t.id!, {type:'settingsChanged'})))
}

function chatAddress(raw: string): {service: Service, conversationId: string} | undefined {
  const url = new URL(raw)
  const service = url.origin === sites.chatgpt ? 'chatgpt' : url.origin === sites.claude ? 'claude' : undefined
  if (!service) return
  const match = service === 'chatgpt' ? /^\/c\/([\w.-]+)\/?$/.exec(url.pathname) : /^\/chat\/([\w.-]+)\/?$/.exec(url.pathname)
  if (match) return {service, conversationId:match[1]}
  if (url.pathname === '/' || (service === 'claude' && /^\/new\/?$/.test(url.pathname))) return {service,conversationId:'new'}
}

// A decision can already be visible in the source tab while its DOM observer's
// capture is queued. Flush those opted-in tabs before reading the latest revision.
// This handshake stays outside the worker's write queue: each tab writes through it.
async function flushSourceTabs(service: Service, requestingTab?: number) {
  const settings = await grants()
  if (!settings[service].share || await locked()) return
  const tabs = await chrome.tabs.query({url:['https://chatgpt.com/*','https://claude.ai/*']})
  const flush = tabs.flatMap(tab => {
    const address = tab.url && chatAddress(tab.url)
    if (!address || address.conversationId === 'new' || tab.id === undefined || tab.id === requestingTab ||
        tab.discarded || !settings[address.service].capture) return []
    const receipt = chrome.tabs.sendMessage(tab.id, {type:'flushCapture'}, {frameId:0}).catch(() => undefined)
    return [receipt.then(result => {
      if (result?.ok === false) throw new Error('Capture pending')
    })]
  })
  if (!flush.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(flush),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Capture pending')), 2500) })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function message(raw: unknown, sender: chrome.runtime.MessageSender) {
  if (!raw || typeof raw !== 'object' || sender.id !== chrome.runtime.id) return {ok:false}
  const m = raw as Record<string, unknown>
  if (sender.url === chrome.runtime.getURL('popup.html')) {
    const settings = await grants()
    switch (m.type) {
      case 'permissions': return {grants:settings, locked:await locked(), paired:Boolean((await chrome.storage.session.get('pairToken')).pairToken)}
      case 'setGrant': {
        if (!isService(m.service) || (m.field !== 'share' && m.field !== 'capture') || typeof m.value !== 'boolean') break
        settings[m.service][m.field] = m.value
        await chrome.storage.local.set({grants:settings})
        if (!m.value) await clearDrafts(m.service)
        void announce().catch(() => {})
        return {ok:true}
      }
      case 'lock': {
        if (typeof m.value !== 'boolean') break
        await chrome.storage.local.set({locked:m.value})
        if (m.value) await clearDrafts()
        void announce().catch(() => {})
        return {ok:true}
      }
      case 'pair': {
        if (typeof m.token !== 'string' || (m.token !== '' && !/^[\w-]{43}$/.test(m.token))) break
        if (m.token) await chrome.storage.session.set({pairToken:m.token})
        else await chrome.storage.session.remove('pairToken')
        void reconnectRelay()
        return {ok:true}
      }
      case 'preference': return {pending:!(await locked()) && await withMemory(false, state => headlinePreferencePending(state.preferences))}
      case 'decidePreference': {
        if (await locked() || (m.value !== 'accepted' && m.value !== 'declined')) break
        const decision = m.value
        return withMemory(true, state => {
          const pending = headlinePreferencePending(state.preferences)
          if (pending) state.preferences = decideHeadlinePreference(state.preferences, decision)
          return {ok:pending}
        })
      }
      case 'projects': return {projects:await locked() ? [] : await withMemory(false, listApprovedProjects)}
    }
    return {ok:false}
  }
  if (sender.tab?.id === undefined || sender.frameId !== 0 || !sender.url) return {ok:false}
  // MessageSender.url can be the original document URL on SPA navigation.
  // The tab URL is the canonical URL of the top frame for this delivery.
  const address = chatAddress(sender.tab.url || sender.url)
  if (!address || new URL(sender.url).origin !== sites[address.service]) return {ok:false}
  const { service, conversationId } = address
  const grant = (await grants())[service]
  if (await locked()) return m.type === 'settings' ? {capture:false, share:false, guard:grant.capture || grant.share} : {ok:false, status:'denied'}
  if (m.type === 'settings') return grant
  if (m.conversationId !== conversationId || !validId(conversationId)) return {ok:false,status:'missing'}
  const draftKey = 'draft:' + service + ':' + sender.tab.id + ':' + conversationId
  switch (m.type) {
    case 'draft':
      return {text: grant.capture || grant.share ? (await chrome.storage.session.get(draftKey))[draftKey] || '' : ''}
    case 'saveDraft':
      if (typeof m.text !== 'string' || m.text.length > 100_000 || !(grant.capture || grant.share)) break
      if (m.text) await chrome.storage.session.set({[draftKey]:m.text})
      else await chrome.storage.session.remove(draftKey)
      return {ok:true}
    case 'capture': {
      if (!grant.capture || conversationId === 'new' || typeof m.id !== 'string' || !m.id || m.id.length > 256 ||
          (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string' || m.text.length > 100_000) break
      const turn = {service, conversationId, id:m.id, role:m.role as 'user'|'assistant', text:m.text}
      await withMemory(true, state => captureTurn(state, turn))
      return {ok:true}
    }
    case 'lookup': {
      if (!grant.share) return {status:'denied'}
      if (typeof m.query !== 'string' || m.query.length > 32_000 || (m.projectId !== undefined && !validId(m.projectId))) break
      const request = {service, conversationId, query:m.query, projectId:m.projectId}
      return withMemory(false, state => lookupContext(state, request))
    }
    case 'bind': {
      if (!grant.share || !validId(m.projectId) || conversationId === 'new') break
      const project = m.projectId
      return withMemory(true, state => {
        if (!listApprovedProjects(state).some(p => p.projectId === project)) return {ok:false}
        bindProject(state, service, conversationId, project)
        return {ok:true}
      })
    }
  }
  return {ok:false,status:'missing'}
}

chrome.runtime.onMessage.addListener((m, sender, respond) => {
  async function receive() {
    if (m?.type === 'lookup' && sender.id === chrome.runtime.id && sender.frameId === 0 &&
        sender.url && sender.tab?.id !== undefined) {
      const address = chatAddress(sender.tab.url || sender.url)
      if (address && new URL(sender.url).origin === sites[address.service]) {
        await flushSourceTabs(address.service, sender.tab.id)
      }
    }
    return serialized(() => message(m,sender))
  }
  receive().then(respond, () => respond({ok:false,status:'missing'}))
  return true
})
chrome.tabs.onRemoved.addListener(id => { void serialized(() => clearDrafts(undefined,id)) })
void chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})
startRelay(async request => {
  await flushSourceTabs(request.service)
  return serialized(async () => {
    if (await locked() || !(await grants())[request.service].share) return {status:'missing'}
    return withMemory(false, state => {
      const preference = approvedHeadlinePreference(state.preferences, request.query)
      if (preference === '별도 요청이 없으면 제목은 짧게 씁니다.' && listApprovedProjects(state).some(p => p.projectId === request.projectId)) {
        return {status:'preference' as const, projectId:request.projectId, preference}
      }
      const result = lookupContext(state, { ...request, conversationId:'mcp' })
      if (result.status !== 'found' || result.projectId !== request.projectId) return {status:'missing' as const}
      const { projectId, option, version, text } = result
      return {status:'found' as const, projectId, option, version, text}
    })
  })
})
