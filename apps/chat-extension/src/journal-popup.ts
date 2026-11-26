import type { CapturePreview, CaptureStatus, TurnReference } from './capture-status.ts'
import { maxDecisionLength, maxProjectDecisions, maxProjectReferences, maxReferenceLength } from './approval-state.ts'
import { refreshCaptureSummary, showVerifiedSummary } from './capture-overview.ts'
import { chatRoute } from './adapters.ts'

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const send = (message: object) => chrome.runtime.sendMessage(message).catch(() => undefined)
const journal = el('journal')
const list = el('journal-list')
const output = el('capture-result')
const review = el('journal-review')
const reviewText = el('review-text')
const projects = el<HTMLSelectElement>('approval-project')
const existing = el<HTMLSelectElement>('existing-condition')
const newName = el<HTMLInputElement>('new-project-name')
const replaceConsent = el<HTMLInputElement>('allow-replacement')
const approve = el<HTMLButtonElement>('approve-message')
const retire = el<HTMLButtonElement>('retire-condition')
const approval = el('approval-result')
let page: CapturePreview | undefined
let selected: TurnReference | undefined
let priorNotes: {id:string,text:string}[] = []
let captureRequest = 0
let reviewRequest = 0
let pendingDecision = false

function clearReview() {
  reviewRequest++
  selected = undefined
  priorNotes = []
  pendingDecision = false
  review.hidden = true
  reviewText.textContent = ''
  el('prior-condition').textContent = ''
  approval.textContent = ''
  delete approval.dataset.status
  projects.replaceChildren()
  existing.replaceChildren()
  newName.value = ''
  replaceConsent.checked = false
}

export function clearCapturePreview() {
  captureRequest++
  clearReview()
  page = undefined
  list.replaceChildren()
  journal.hidden = true
  output.hidden = true
  output.textContent = ''
  delete output.dataset.status
}

export function refreshActiveCapture() {
  clearCapturePreview()
  refreshCaptureSummary()
}

const captureMessages = {
  'open-source': '확인할 ChatGPT 또는 Claude 일반 대화 탭에서 열어 주세요.',
  'locked': '기억이 잠겨 있어요. 이 프로필에서 잠금을 해제한 뒤 확인하세요.',
  'capture-off': '이 사이트의 대화 수집이 꺼져 있어요. 수집을 켜면 현재 대화를 저장할 수 있어요.',
  'reload': '이 탭에서 현재 확장의 응답이 없어요. 대화 탭을 새로고침한 뒤 다시 확인하세요.',
  'route-unverified': '대화 주소가 바뀌어 지금 보이는 메시지가 이 대화의 것인지 확인할 수 없어요. 이 대화 탭을 새로고침한 뒤 저장 기록을 확인하세요.',
  'unverified': '이 탭의 수집과 저장을 확인하지 못했어요. 저장한 메시지 수는 확인되지 않았어요.',
  'storage-error': '이 프로필의 로컬 기록을 읽거나 저장하지 못했어요.',
  'stale': '탭이나 기록이 변경됐어요. 현재 대화의 저장 상태를 다시 확인하세요.',
}

async function loadPage(older = false) {
  const before = older ? page?.nextBefore : undefined
  const expected = older ? page?.source : undefined
  if (older && (!before || !expected)) return
  clearCapturePreview()
  const request = captureRequest
  output.hidden = false
  output.textContent = '현재 대화의 저장 기록을 읽고 있어요.'
  const result = await send({type:'checkActiveCapture',preview:true, before, source:expected}) as
    (CaptureStatus & Partial<CapturePreview>) | undefined
  if (request !== captureRequest) return
  output.dataset.status = result?.status ?? 'unverified'
  if (!result?.source || !Array.isArray(result.entries)) {
    output.textContent = captureMessages[result?.status as keyof typeof captureMessages] ?? captureMessages.unverified
    refreshCaptureSummary()
    return
  }
  page = result as CapturePreview
  showVerifiedSummary(page)
  const lines = [`이 대화에 ${page.savedCount}건 저장.`]
  if (!page.observed) lines.push('현재 화면에서는 인식할 수 있는 메시지 영역을 찾지 못했어요.')
  else if (!page.readable) lines.push(`메시지 영역 ${page.observed}개를 찾았지만 발화자와 본문을 확인할 수 없어요.`)
  else lines.push(`현재 화면의 메시지 영역 ${page.observed}개 중 ${page.readable}개를 읽었어요.`)
  if (result.status === 'approved') lines.push(`이 대화에서 확정한 ${result.option}안 v${result.version}이 저장되어 있어요.`)
  if (result.status === 'options') lines.push(`원고 ${result.options.map(n => n+'안').join(', ')}을 인식했어요. 아직 확정한 안은 없어요.`)
  if (result.status === 'inactive') lines.push('이 대화에서 채택했던 원고는 현재 사용이 중지됐어요.')
  if (page.trimmedCount) lines.push(`보관 한도로 이 대화의 이전 메시지 ${page.trimmedCount}건의 본문을 정리했어요.`)
  if (page.identityLimitReached) lines.push('프로필의 메시지 식별자 한도에 도달해 새로운 메시지가 누락될 수 있어요.')
  output.textContent = lines.join(' ')
  journal.hidden = page.entries.length === 0
  for (const item of page.entries) {
    const row = document.createElement('li')
    row.dataset.role = item.role
    const label = document.createElement('strong')
    label.textContent = item.role === 'user' ? '내 메시지' : 'AI 답변'
    const excerpt = document.createElement('p')
    excerpt.textContent = item.preview
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = '메시지 검토'
    button.onclick = () => openReview(item)
    row.append(label, excerpt, button)
    list.append(row)
  }
  el('journal-older').hidden = page.nextBefore === null
}

function option(value: string, text: string) {
  return new Option(text, value)
}

function itemKind() { return selected?.role === 'assistant' ? '참고자료' : '조건' }

function updateApprovalControls() {
  const choice = projects.value
  const prior = priorNotes.find(note => note.id === existing.value)
  el('new-project-label').hidden = choice !== 'new'
  el('existing-condition-label').hidden = !priorNotes.length
  el('condition-review').hidden = !prior
  el('prior-condition').textContent = prior?.text ?? ''
  approve.disabled = pendingDecision || !choice || (choice === 'new' && !newName.value.trim()) || (!!prior && !replaceConsent.checked)
  approve.textContent = prior ? '이 메시지로 교체 승인' : selected?.role === 'assistant' ? '참고자료로 승인' : '이 메시지 승인'
  retire.textContent = '기존 ' + itemKind() + ' 사용 중지'
  retire.disabled = pendingDecision || !prior || !replaceConsent.checked
}

function clearConditionChoice() {
  priorNotes = []
  existing.replaceChildren(option('', '새 ' + itemKind() + ' 추가'))
  replaceConsent.checked = false
  updateApprovalControls()
}

async function readSelection(ref: TurnReference, projectId?: string) {
  return send({type:'reviewJournalTurn',source:page?.source,turn:ref,projectId})
}

function stopPreview(status = 'stale') {
  refreshActiveCapture()
  output.hidden = false
  output.dataset.status = status
  output.textContent = captureMessages[status as keyof typeof captureMessages] ?? captureMessages.stale
}

async function openReview(item: TurnReference) {
  clearReview()
  const request = reviewRequest
  const {id,role,sequence,revision} = item
  const ref = {id,role,sequence,revision}
  const result = await readSelection(ref)
  if (request !== reviewRequest) return
  if (result?.status !== 'review') { stopPreview(result?.status); return }
  selected = ref
  review.hidden = false
  reviewText.textContent = result.text
  const limit = role === 'user' ? maxDecisionLength : maxReferenceLength
  const eligible = result.text.length <= limit
  el('approval-controls').hidden = !eligible
  el('local-copy-notice').hidden = result.identity !== 'local'
  const kind = itemKind()
  el('item-kind').textContent = '프로젝트 ' + kind
  el('prior-label').textContent = '선택한 기존 ' + kind
  el('approval-purpose').textContent = role === 'user'
    ? '승인하면 연결된 AI가 내 메시지 전체를 이 프로젝트의 조건으로 읽을 수 있습니다.'
    : '승인하면 연결된 AI가 이 답변 전체를 프로젝트 참고자료로 읽을 수 있습니다.'
  if (!eligible) {
    approval.textContent = '프로젝트 ' + kind + '로 승인할 수 있는 길이는 ' + limit.toLocaleString('ko-KR') + '자까지예요.'
    return
  }
  projects.replaceChildren(option('', '프로젝트 선택'), ...result.projects.map((p:{id:string,title:string}) => option(p.id, p.title)), option('new', '새 프로젝트'))
  clearConditionChoice()
}

projects.onchange = async () => {
  const ref = selected
  const choice = projects.value
  const request = ++reviewRequest
  pendingDecision = Boolean(ref && choice && choice !== 'new')
  clearConditionChoice()
  approval.textContent = ''
  if (!ref || !choice || choice === 'new') return
  approve.disabled = true
  const result = await readSelection(ref,choice)
  if (request !== reviewRequest) return
  if (result?.status !== 'review' || result.text !== reviewText.textContent) { stopPreview(result?.status); return }
  pendingDecision = false
  priorNotes = result.priorItems
  existing.append(...priorNotes.map((note,i) => option(note.id, `기존 ${itemKind()} ${i+1} · ${note.text.slice(0,30)}`)))
  updateApprovalControls()
}
existing.onchange = () => { replaceConsent.checked = false; updateApprovalControls() }
replaceConsent.onchange = updateApprovalControls
newName.oninput = updateApprovalControls

async function applyDecision(retiring: boolean) {
  if (!page || !selected || approve.disabled || (retiring && retire.disabled)) return
  const request = ++reviewRequest
  const prior = priorNotes.find(item => item.id === existing.value)
  if ((retiring || prior) && !replaceConsent.checked) return
  const choice = projects.value
  pendingDecision = true
  updateApprovalControls()
  const result = await send({type:retiring ? 'retireJournalCondition' : 'approveJournalTurn',
    source:page.source, turn:selected, expectedConditionId:prior?.id ?? null,
    ...(choice === 'new' ? {newProjectTitle:newName.value.trim()} : {projectId:choice})})
  if (request !== reviewRequest) return
  if (result?.status === 'approved' || result?.status === 'retired') {
    el('approval-controls').hidden = true
    approval.dataset.status = result.status
    approval.textContent = retiring ? '선택한 항목을 사용 중지했어요.' : '선택한 프로젝트의 ' + itemKind() + ' 승인을 저장했어요.'
    return
  }
  if (!['limit', 'conflict', 'invalid'].includes(result?.status)) {
    stopPreview(result?.status ?? 'unverified')
    return
  }
  pendingDecision = false
  const messages: Record<string,string> = {
    'limit': selected.role === 'assistant'
      ? `이 프로젝트의 참고자료가 ${maxProjectReferences}개예요. 교체할 항목을 선택하세요.`
      : `이 프로젝트의 조건이 ${maxProjectDecisions}개예요. 교체할 항목을 선택하세요.`,
    'conflict':'같은 이름의 프로젝트가 있거나 기존 항목이 바뀌었어요. 프로젝트를 다시 선택하세요.',
    'invalid':'프로젝트 이름과 승인할 메시지를 확인하세요.',
  }
  approval.textContent = messages[result?.status] ?? '저장 결과를 확인하지 못했어요. 현재 대화의 저장 기록을 다시 확인하세요.'
  approval.dataset.status = result?.status ?? 'unverified'
  if (result?.status === 'conflict') {
    projects.value = ''
    clearConditionChoice()
  }
  updateApprovalControls()
}

el('check-capture').onclick = () => loadPage()
el('journal-older').onclick = () => loadPage(true)
el('close-journal-review').onclick = clearReview
approve.onclick = () => applyDecision(false)
retire.onclick = () => applyDecision(true)
chrome.tabs.onActivated?.addListener(refreshActiveCapture)
chrome.tabs.onRemoved?.addListener(tabId => { if (tabId === page?.source.tabId) refreshActiveCapture() })
chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
  if ((!tab.active && tabId !== page?.source.tabId) || (!change.url && !change.status)) return
  const source = page?.source
  const rawUrl = change.url || tab.url
  if (source && tabId === source.tabId && rawUrl && (change.url || change.status === 'complete')) {
    const url = new URL(rawUrl)
    const origin = source.service === 'chatgpt' ? 'https://chatgpt.com' : 'https://claude.ai'
    if (url.origin === origin && chatRoute(source.service,url.pathname) === source.conversationId) {
      refreshCaptureSummary()
      return
    }
  }
  refreshActiveCapture()
})
