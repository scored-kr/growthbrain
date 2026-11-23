/** Local domain state. Callers enforce collection and disclosure consent before invoking these rules. */
import {observeHeadlinePreference, type PreferenceState} from './preferences.ts'

export type Service = 'chatgpt' | 'claude'
export interface Turn {
  service: Service
  conversationId: string
  id: string
  role: 'user' | 'assistant'
  text: string
}
export interface ContextRequest {
  service: Service
  conversationId: string
  query: string
  projectId?: string
}
export type ContextResult =
  | {status: 'found', projectId: string, title: string, option: number, version: number, text: string}
  | {status: 'ambiguous', projects: {projectId: string, title: string}[]}
  | {status: 'missing'}

type Source = Pick<Turn, 'service' | 'conversationId' | 'id'>
type Revision = {option: number, version: number, text: string, source: Source}
type Decision = {option: number, version: number, status: 'adopted' | 'rejected' | 'held', source: Source, reason?: string, withdrawn?: boolean}
type Project = {
  id: string
  title: string
  revisions: Revision[]
  decisions: Decision[]
  feedback: {option: number, version: number, text: string, source: Source}[]
}
type Edit = {projectId: string, option: number, base: number, proposal?: number}
type Conversation = {
  service: Service
  id: string
  projectId?: string
  edit?: Edit
  presented?: Pick<Revision, 'option' | 'version'>[]
  seen: {id: string, role: Turn['role'], fingerprint: string}[]
}
export interface MemoryState {
  projects: Project[]
  conversations: Conversation[]
  preferences?: PreferenceState
}
export function emptyMemory(): MemoryState {
  return {projects: [], conversations: []}
}

function conversation(state: MemoryState, service: Service, id: string): Conversation {
  let chat = state.conversations.find(item => item.service === service && item.id === id)
  if (!chat) {
    chat = {service, id, seen: []}
    state.conversations.push(chat)
  }
  return chat
}

export function bindProject(state: MemoryState, service: Service, conversationId: string, projectId: string): void {
  if (!state.projects.some(project => project.id === projectId)) return
  const chat = conversation(state, service, conversationId)
  if (chat.projectId !== projectId) {
    delete chat.edit
    delete chat.presented
  }
  chat.projectId = projectId
}

const optionNumber = /([1-9]\d?)\s*안/u
const latest = /최신\s*(?:확정\s*)?(?:안|본|버전|원고|문구|문장)|(?:현재|마지막|최종|확정|채택)\s*(?:확정\s*)?(?:안|본|버전|원고|문구)/u
const historical = /탈락|기각|보류/u
const firstLineEdit = /첫\s*(?:번째\s*)?(?:문장|줄)[^\n]{0,24}(?:바꿔|바꾸|바꿀|고쳐|고치|수정|다듬|다시\s*써|변경)/u

export function needsContext(query: string): boolean {
  if (isNewBrief(query) || decisionFor(query) || confirmation.test(query.trim())) return false
  if (latest.test(query) || firstLineEdit.test(query) && /어제|고른|확정한|채택한|[1-9]\d?\s*안/u.test(query)) return true
  return optionNumber.test(query) && /어제|저번|지난|고른|선택한|확정한|채택한|탈락|보류한|원문|원고|다시\s*(?:열|보|불러)|불러\s*와|보여\s*줘/u.test(query)
}

function currentDecision(project: Project): Decision | undefined {
  const decision = project.decisions.findLast(item => !item.withdrawn && item.status === 'adopted')
  if (!decision) return
  // Explicitly retiring the current option leaves no active copy. Older selections stay historical.
  return project.decisions.findLast(item => !item.withdrawn && item.option === decision.option)?.status === 'adopted' ? decision : undefined
}

export function listApprovedProjects(state: MemoryState): {projectId: string, title: string}[] {
  return state.projects.filter(project => resolveVersion(project, '최신안')).map(project => ({projectId: project.id, title: project.title}))
}

function resolveVersion(project: Project, query: string): Revision | undefined {
  const option = Number(query.match(optionNumber)?.[1])
  const history = historical.test(query) && option > 0
  const decision = history
    ? project.decisions.findLast(item => !item.withdrawn && item.option === option && item.status === (/보류/u.test(query) ? 'held' : 'rejected'))
    : currentDecision(project)
  if (!decision || (option > 0 && option !== decision.option)) return
  const revision = project.revisions.find(item => item.option === decision.option && item.version === decision.version)
  // Also gate already-stored revisions captured by an earlier parser.
  return revision && !containsAside(revision.text) ? revision : undefined
}

export function lookupContext(state: MemoryState, request: ContextRequest): ContextResult {
  if (!needsContext(request.query)) return {status: 'missing'}
  const bound = state.conversations.find(chat => chat.service === request.service && chat.id === request.conversationId)?.projectId
  const named = state.projects.filter(project => request.query.includes(project.title))
  let candidates = state.projects
  if (request.projectId !== undefined) candidates = (named.length ? named : candidates).filter(project => project.id === request.projectId)
  else if (named.length) candidates = named
  else if (bound) candidates = candidates.filter(project => project.id === bound)
  const matches = candidates.flatMap(project => {
    const revision = resolveVersion(project, request.query)
    return revision ? [{project, revision}] : []
  })
  if (matches.length > 1) return {status: 'ambiguous', projects: matches.map(({project}) => ({projectId: project.id, title: project.title}))}
  const match = matches[0]
  if (!match) return {status: 'missing'}
  const {option, version, text} = match.revision
  return {status: 'found', projectId: match.project.id, title: match.project.title, option, version, text}
}

function source(turn: Turn): Source {
  return {service: turn.service, conversationId: turn.conversationId, id: turn.id}
}

// Keep only message identity and a local change detector for unrelated turns, never their content.
function fingerprint(text: string): string {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619)
  return text.length + '/' + hash
}

function briefTitle(text: string): string | undefined {
  // Derive a label from a product-name field or the short noun phrase immediately before 상세페이지.
  const label = text.match(/^(?:상품명|프로젝트명|프로젝트)\s*[:：]\s*([\p{L}\p{N} _-]{1,40})\s*$/mu)
  if (label) return label[1]!.trim()
  const name = text.match(/^([\p{L}\p{N} _-]{1,34}?)\s+상세\s*페이지/u)?.[1]?.trim()
  return name && !/[,.!?]|(?:사연|개인|남편|아내|친구|엄마|아빠|지난번)|(?:하던|하는|있던|위한|관련|번째|이번|새로운|새)$/u.test(name) ? name : undefined
}

function isNewBrief(text: string): boolean {
  return /상세\s*페이지/u.test(text) && /(?:세|3)\s*(?:개|가지|종)|세\s*안(?:을|으로)?\s*비교|1\s*안[^\n]{0,20}2\s*안[^\n]{0,20}3\s*안/u.test(text) &&
    /시안|초안|원고|문구|비교/u.test(text) && !firstLineEdit.test(text)
}

function registerBrief(state: MemoryState, chat: Conversation, text: string): void {
  if (!/상세\s*페이지/u.test(text) || !/시안|초안|원고|문구|비교|세\s*(?:개|가지)|3\s*(?:개|가지)/u.test(text)) return
  const name = briefTitle(text)
  const bound = state.projects.find(item => item.id === chat.projectId)
  if (bound && (!name || bound.title === name)) return
  const named = name ? state.projects.filter(item => item.title === name) : []
  if (named.length === 1) {
    bindProject(state, chat.service, chat.id, named[0]!.id)
    return
  }
  const project: Project = {
    id: crypto.randomUUID(), title: name || '상세페이지 ' + (state.projects.length + 1),
    revisions: [], decisions: [], feedback: []
  }
  state.projects.push(project)
  bindProject(state, chat.service, chat.id, project.id)
}

const manuscriptFence = /^`{3}(?:text|plaintext)?[ \t]*\r?\n([\s\S]*?)\r?\n`{3}[ \t]*(?:\r?\n|$)/u

function containsAside(text: string): boolean {
  // Match editorial labels or an explicit change of voice, not family or product vocabulary.
  const label = /(?:^|[\s(（【\[])[#> *_[\]-]*(?:참고(?:\s*(?:사항|메모))?|메모|주석|덧붙임|사족|작성자\s*주|추천|선택\s*이유|비교|평가|피드백|(?:개인(?:적(?:인)?)?|사적(?:인)?|비공개|내부)\s*(?:사연|메모|이야기|기록|참고)|note|aside)[*_\s]*(?:[:：]|[\]】])/iu
  const aside = /(?:^|[.!?。！？…\n]\s*)[\s>*_-]*(?:참고로|덧붙이자면|개인적인\s*(?:얘기|이야기)(?:인데|지만))[\s,，:：]/u
  return label.test(text) || aside.test(text)
}

function draftOptions(text: string): {option: number, text: string}[] | undefined {
  // Headers start on their own line or introduce body text with punctuation. Ordinary mentions do not split copy.
  const header = /^(?:#{1,6}[ \t]+)?(?:\*\*)?\[?(?:제?([1-9]\d?)[ \t]*안|(?:시안|안)[ \t]+([1-9]\d?))\]?(?:\*\*)?[ \t]*(?:[:：)）.\-–—][ \t]*(?:\*\*)?[ \t]*|\r?(?=\n|$))/gmu
  const headers = [...text.matchAll(header)]
  if (headers.length < 2) return
  if (headers.length > 12 || new Set(headers.map(h => Number(h[1] ?? h[2]))).size !== headers.length) return []
  return headers.flatMap((heading, i) => {
    let body = text.slice(heading.index! + heading[0].length, headers[i + 1]?.index)
    // Trim only the structural line breaks between a heading and its copy or the next heading.
    body = body.replace(/^(?:\r?\n)+|(?:\r?\n)+$/gu, '')
    const fenced = body.match(manuscriptFence)
    if (fenced) body = fenced[1]!
    else if (body.startsWith('```') || /\n[ \t]*\r?\n/u.test(body)) return []
    if (!body.trim() || body.length > 32000 || containsAside(body)) return []
    return [{option: Number(heading[1] ?? heading[2]), text: body}]
  })
}

function addRevision(project: Project, option: number, text: string, turn: Turn): Revision {
  const previous = project.revisions.findLast(item => item.option === option)
  if (previous?.text === text) return previous
  const revision = {option, version: (previous?.version ?? 0) + 1, text, source: source(turn)}
  project.revisions.push(revision)
  return revision
}

function firstSentenceEnd(text: string): number {
  const boundary = /(?:[.!?。！？…]+[”’"')」』]*(?=\s|$)|\r?\n)/u.exec(text)
  if (!boundary) return text.length
  return boundary.index + (/^\r?\n/u.test(boundary[0]) ? 0 : boundary[0].length)
}

function editedCopy(original: string, response: string): string | undefined {
  const labeled = response.trimStart().replace(/^(?:수정(?:한|된)?\s*)?첫\s*문장\s*[:：]\s*/u, '')
  const fenced = labeled.match(manuscriptFence)
  if (!fenced && labeled.startsWith('```')) return
  const candidate = fenced ? fenced[1]! : labeled
  if (!candidate.trim() || containsAside(candidate) || containsAside(original) ||
      /^(?:알겠습니다|물론입니다|원문을|원고를|어떤\s*문장|확인할\s*수)/u.test(candidate)) return
  const originalTail = original.slice(firstSentenceEnd(original))
  // Preserve final whitespace while comparing a full-copy answer, including DOM-rendered code blocks.
  const end = firstSentenceEnd(candidate)
  const remainder = candidate.slice(end)
  if (!end || (remainder.trim() && remainder !== originalTail)) return
  const updated = candidate.slice(0, end).trimEnd() + originalTail
  return updated !== original ? updated : undefined
}

const confirmation = /^(?:(?:좋아(?:요)?|네|응)[,.!\s]+)?(?:(?:그|이|수정한|바꾼|새|방금\s*바꾼)\s*(?:(?:첫\s*)?문장|문구|버전|원고|내용)(?:으로|을|로)?\s*|이대로\s*|그대로\s*)?(?:확정|채택)(?:해\s*(?:줘|주세요)|할게(?:요)?|하자|합니다|해요|이다|이야|해)?[.!\s]*$/u

function decisionFor(text: string): Pick<Decision, 'option' | 'status' | 'reason'> | undefined {
  // Reasons remain local. Take only a bounded, explicitly introduced reason after the decision.
  const reason = text.trim().match(/^([^\n.!?]+)[.!]\s*(?:이유는\s+|이유\s*[:：]\s*)([^\n.!?]{1,100})[.!]?$/u)
  const clause = reason ? reason[1]! : text.trim()
  const decision = clause.match(/^(?:(?:좋아(?:요)?|네|응)[,.!\s]+)?(?:최종(?:적으로)?\s*)?([1-9]\d?)\s*안(?:으로|을|로|은|는)?\s*(?:최종\s*)?(확정|채택|선택|결정|진행|택할게(?:요)?|갈게(?:요)?|가자|할게(?:요)?|하자|탈락|기각|보류)(?:해\s*(?:줘|주세요)|하자|할게(?:요)?|합니다|했어|할래|해요|해|이야)?[.!\s]*$/u)
  if (!decision) return
  const verb = decision[2]!
  return {option: Number(decision[1]), status: /탈락|기각/u.test(verb) ? 'rejected' : verb === '보류' ? 'held' : 'adopted', ...(reason ? {reason: reason[2]!.trim()} : {})}
}

export function captureTurn(state: MemoryState, turn: Turn): void {
  if (!turn.id || !turn.conversationId || !turn.text.trim() || turn.text.length > 128000) return
  const chat = conversation(state, turn.service, turn.conversationId)
  const seen = chat.seen.find(item => item.id === turn.id && item.role === turn.role)
  const signature = fingerprint(turn.text)
  if (seen?.fingerprint === signature) return
  if (seen) {
    seen.fingerprint = signature
    if (turn.role === 'user') {
      for (const project of state.projects) {
        for (const decision of project.decisions) {
          if (decision.source.service === turn.service && decision.source.conversationId === turn.conversationId &&
              decision.source.id === turn.id) decision.withdrawn = true
        }
      }
    }
  } else chat.seen.push({id: turn.id, role: turn.role, fingerprint: signature})

  if (turn.role === 'user' && needsContext(turn.text)) {
    const result = lookupContext(state, {service: turn.service, conversationId: turn.conversationId, query: turn.text})
    delete chat.edit
    if (result.status === 'found') {
      bindProject(state, turn.service, turn.conversationId, result.projectId)
      if (firstLineEdit.test(turn.text) && !historical.test(turn.text)) {
        chat.edit = {projectId: result.projectId, option: result.option, base: result.version}
      }
    }
    return
  }
  if (turn.role === 'user') registerBrief(state, chat, turn.text)
  const project = state.projects.find(item => item.id === chat.projectId)
  if (!project) return
  if (chat.edit) {
    const edit = chat.edit
    const original = project.revisions.find(item => item.option === edit.option && item.version === edit.base)
    if (turn.role === 'assistant') {
      delete edit.proposal
      const text = original && editedCopy(original.text, turn.text)
      if (text) edit.proposal = addRevision(project, edit.option, text, turn).version
      return
    }
    const decision = decisionFor(turn.text)
    if (confirmation.test(turn.text.trim()) || decision?.status === 'adopted' && decision.option === edit.option) {
      const current = currentDecision(project)
      if (edit.proposal && current?.option === edit.option && current.version === edit.base) {
        project.decisions.push({option: edit.option, version: edit.proposal, status: 'adopted', source: source(turn)})
      }
      delete chat.edit
      return
    }
    // An unrelated user turn ends the implicit reference to the assistant's last proposed sentence.
    delete chat.edit
  }

  const options = draftOptions(turn.text)
  if (options) {
    chat.presented = options.map(item => {
      const {option, version} = addRevision(project, item.option, item.text, turn)
      return {option, version}
    })
    return
  }
  if (turn.role !== 'user') return
  const decision = decisionFor(turn.text)
  if (decision) {
    // Only choose drafts presented in this conversation. Other chats must explicitly retrieve their base.
    const revision = chat.presented?.find(item => item.option === decision.option)
    if (revision) {
      project.decisions.push({...decision, version: revision.version, source: source(turn)})
      if (decision.status === 'adopted') {
        const reason = decision.reason ?? project.feedback.findLast(item => item.option === revision.option && item.version === revision.version)?.text
        if (reason) state.preferences = observeHeadlinePreference(state.preferences, project.id, reason)
      }
    }
    return
  }
  const feedback = turn.text.trim().match(/^([1-9]\d?)\s*안(?:은|는|이|의)?\s+([^\n]{0,100}(?:길어|짧아|어색해|좋아|아쉬워|부족해)(?:요)?)[.!]?$/u)
  if (feedback) {
    const revision = chat.presented?.find(item => item.option === Number(feedback[1]))
    if (revision) project.feedback.push({option: revision.option, version: revision.version, text: feedback[2]!, source: source(turn)})
  }
}
