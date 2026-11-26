import { bindProject, listApprovedProjects, lookupContext, recoverInitialApproval, type Service, type Turn } from './memory.ts'
import { approveStoredCondition, listApprovalProjects, readGrantedContext, retireStoredCondition } from './approved-context.ts'
import { applyCaptureBatch, parseCaptureMessage } from './capture-batch.ts'
import { decideHeadlinePreference, headlinePreferencePending } from './preferences.ts'
import { withMemory } from './storage.ts'
import { startRelay, reconnectRelay } from './device.ts'
import { savedChatStatus, type ChatSource, type TurnReference } from './capture-status.ts'
import { getJournalTurn, readChatJournal } from './journal.ts'

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

async function activeChat(service?: Service): Promise<ChatSource | undefined> {
  const [tab] = await chrome.tabs.query({active:true, lastFocusedWindow:true})
  if (!tab?.id || !tab.url || tab.discarded) return
  const address = chatAddress(tab.url)
  if (address && (!service || address.service === service) && address.conversationId !== 'new') {
    return {tabId:tab.id, ...address}
  }
}

function sameSource(source: ChatSource, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object') return false
  const other = expected as Partial<ChatSource>
  return source.tabId === other.tabId && source.service === other.service && source.conversationId === other.conversationId
}

async function captureRestriction(service: Service) {
  if (await locked()) return {status: 'locked' as const}
  if (!(await grants())[service].capture) return {status: 'capture-off' as const}
}

function validReference(value: unknown): value is TurnReference {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<TurnReference>
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 256 &&
    (item.role === 'user' || item.role === 'assistant') &&
    Number.isSafeInteger(item.sequence) && Number.isSafeInteger(item.revision)
}

type SourceTurn = Pick<Turn, 'id' | 'role' | 'text'>
function validRecoveryTurns(turns: unknown): turns is SourceTurn[] {
  return Array.isArray(turns) && turns.length >= 3 && turns.length <= 4 && turns.every(turn =>
    turn && typeof turn.id === 'string' && turn.id.length > 0 && turn.id.length <= 160 &&
    (turn.role === 'user' || turn.role === 'assistant') &&
    typeof turn.text === 'string' && turn.text.length > 0 && turn.text.length <= 64_000)
}

async function activeCaptureAction(m: Record<string, unknown>) {
  const source = await activeChat()
  if (!source) return {status: 'open-source'}
  const checking = m.type === 'checkActiveCapture'
  if ((!checking || m.before !== undefined || m.source !== undefined) && !sameSource(source, m.source)) return {status:'stale'}
  const restriction = await captureRestriction(source.service)
  if (restriction) return restriction

  // The source responds only after its capture writes through this worker. Holding
  // the serialized queue here would make the check wait on its own writes.
  let recoveryTurns: SourceTurn[] | undefined
  let observed = 0
  let readable = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const receipt = await Promise.race([
      chrome.tabs.sendMessage(source.tabId,
        {type: 'flushCapture', conversationId: source.conversationId, checkInitialApproval: checking && source.service === 'chatgpt'}, {frameId: 0}),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000) }),
    ])
    if (!receipt?.ok) return {status: receipt?.status === 'route-unverified' ? 'route-unverified' : 'unverified'}
    if (receipt.conversationId !== source.conversationId ||
        !Number.isSafeInteger(receipt.observed) || receipt.observed < 0 ||
        !Number.isSafeInteger(receipt.readable) || receipt.readable < 0) return {status: 'reload'}
    observed = receipt.observed
    readable = receipt.readable
    if (receipt.recoveryTurns !== undefined) {
      if (!checking || source.service !== 'chatgpt' || !validRecoveryTurns(receipt.recoveryTurns)) return {status: 'unverified'}
      recoveryTurns = receipt.recoveryTurns
    }
  } catch {
    return {status: 'reload'}
  } finally {
    clearTimeout(timer)
  }

  const interrupted = new Error('Capture check interrupted')
  const requireSameSource = async () => {
    if (!sameSource(source, await activeChat()) || await captureRestriction(source.service)) throw interrupted
  }
  return serialized(async () => {
    try {
      await requireSameSource()
      const edit = Boolean(recoveryTurns) || m.type === 'approveJournalTurn' || m.type === 'retireJournalCondition'
      const status = await withMemory(edit, state => {
        if (checking) {
          if (recoveryTurns) recoverInitialApproval(state, source.conversationId, recoveryTurns)
          const result = savedChatStatus(state, source.conversationId, source.service)
          if (m.preview !== true) return result
          if (m.before !== undefined && (!Number.isSafeInteger(m.before) || Number(m.before) <= 0)) return {status:'invalid'}
          const page = readChatJournal(state, source.service, source.conversationId, m.before as number | undefined)
          const entries = page.entries.map(({id,role,sequence,revision,text}) =>
            ({id,role,sequence,revision,preview:text.length > 180 ? text.slice(0,180) + '…' : text}))
          const status = result.status === 'no-turns' && page.savedCount > 0 ? {status:'captured'} : result
          return {...status, source, observed, readable, entries, savedCount:page.savedCount,
            trimmedCount:page.trimmedCount, identityLimitReached:page.identityLimitReached, nextBefore:page.nextBefore}
        }

        const ref = m.turn
        if (!validReference(ref)) return {status:'invalid'}
        const turn = getJournalTurn(state, source.service, source.conversationId, ref.id, ref.role)
        if (!turn || turn.sequence !== ref.sequence || turn.revision !== ref.revision) return {status:'stale'}
        if (m.type === 'reviewJournalTurn') {
          const projects = listApprovalProjects(state)
          const selected = projects.find(project => project.id === m.projectId)
          if (m.projectId !== undefined && !selected) return {status:'stale'}
          return {status:'review', text:turn.text, identity:turn.identity, projects:projects.map(({id,title}) => ({id,title})),
            priorItems:(ref.role === 'user' ? selected?.approvedConditions : selected?.approvedReferences) ?? []}
        }
        if (m.type === 'approveJournalTurn') {
          if ((m.expectedConditionId !== null && !validId(m.expectedConditionId)) ||
              (m.projectId !== undefined && !validId(m.projectId)) ||
              (m.newProjectTitle !== undefined && typeof m.newProjectTitle !== 'string')) return {status:'invalid'}
          return approveStoredCondition(state, {service:source.service,conversationId:source.conversationId,
            id:ref.id,role:ref.role,sequence:ref.sequence,revision:ref.revision,
            projectId:m.projectId as string | undefined,newProjectTitle:m.newProjectTitle as string | undefined,
            expectedConditionId:m.expectedConditionId as string | null})
        }
        if (m.type === 'retireJournalCondition' && validId(m.projectId) && validId(m.expectedConditionId)) {
          const retired = retireStoredCondition(state, m.projectId, m.expectedConditionId, ref.role)
          return {status:retired ? 'retired' : 'conflict'}
        }
        return {status:'invalid'}
      }, requireSameSource)
      await requireSameSource()
      return status
    } catch (error) {
      if (error === interrupted) return {status: 'unverified'}
      throw error
    }
  })
}

async function canCompareReply() {
  const {claude} = await grants()
  return claude.capture && claude.share && !await locked()
}

// Content compares the visible reply locally and asks this worker to revalidate
// its approved revision. Keep this call outside the queue serving that request.
async function compareActiveReply() {
  const unavailable = {status:'unverified'}
  if (!await canCompareReply()) return unavailable
  const chat = await activeChat('claude')
  if (!chat) return unavailable
  const result = await chrome.tabs.sendMessage(chat.tabId, {type:'compareReply',conversationId:chat.conversationId}, {frameId:0})
  if (!(result?.status === 'match' || result?.status === 'changed') ||
      !Number.isSafeInteger(result.option) || result.option < 1 ||
      !Number.isSafeInteger(result.version) || result.version < 1) return unavailable
  const current = await activeChat('claude')
  if (current?.tabId !== chat.tabId || current.conversationId !== chat.conversationId || !await canCompareReply()) return unavailable
  return {status:result.status, option:result.option, version:result.version}
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
      case 'projects': return await locked() ? {status:'locked', projects:[]} : {projects:await withMemory(false, listApprovedProjects)}
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
    case 'checkApproved': {
      if (service !== 'claude' || !grant.capture || !grant.share || conversationId === 'new' ||
          !validId(m.projectId) || !Number.isSafeInteger(m.option) || !Number.isSafeInteger(m.version)) return {ok:false}
      const projectId = m.projectId
      return withMemory(false, state => {
        const result = lookupContext(state, {service, conversationId, projectId, query:'최신안을 보여줘'})
        return {ok:result.status === 'found' && result.projectId === projectId &&
          result.option === m.option && result.version === m.version && result.sourceService === 'chatgpt'}
      })
    }
    case 'captureLocal':
    case 'capture':
    case 'captureBatch': {
      if (!grant.capture || conversationId === 'new') break
      const turns = parseCaptureMessage(m, service, conversationId)
      if (!turns) return {ok:false}
      await withMemory(true, state => applyCaptureBatch(state, turns))
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
    if (['checkActiveCapture', 'reviewJournalTurn', 'approveJournalTurn', 'retireJournalCondition'].includes(m?.type) &&
        sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html')) {
      return activeCaptureAction(m).catch(() => ({status:'storage-error'}))
    }
    if (m?.type === 'compareActiveReply' && sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html')) {
      return compareActiveReply().catch(() => ({status:'unverified'}))
    }
    if ((m?.type === 'lookup' || m?.type === 'checkApproved') && sender.id === chrome.runtime.id && sender.frameId === 0 &&
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
    return withMemory(false, state => readGrantedContext(state, request))
  })
})
