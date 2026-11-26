import type { Service } from './memory.ts'
import type { CapturePreview } from './capture-status.ts'

const summary = document.getElementById('capture-summary')!
const enable = document.getElementById('enable-capture') as HTMLButtonElement
const openJournal = document.getElementById('check-capture') as HTMLButtonElement
const names = {chatgpt:'ChatGPT', claude:'Claude'} as const
const restrictions = {
  'open-source':'ChatGPT나 Claude의 일반 대화를 열고 그 탭에서 확장 아이콘을 누르세요.',
  locked:'이 Chrome 프로필의 기억이 잠겨 있어요. 저장 상태를 보려면 아래의 ‘이 프로필에서 잠금 해제’를 누르세요.',
  stale:'확인하는 동안 탭이나 수집 권한이 바뀌었어요. 확인할 대화 탭에서 확장 아이콘을 다시 누르세요.',
  'storage-error':'이 Chrome 프로필의 저장 기록을 읽을 수 없어요. 확장 아이콘을 다시 눌러 확인하세요.',
  unverified:'이 탭의 저장 상태를 확인할 수 없어요. 대화 탭을 새로고침한 뒤 확장 아이콘을 다시 누르세요.',
}
const healthMessages = {
  pending:'현재 화면의 메시지를 확인하고 있어요.',
  reload:'지금 이 탭에서는 확장이 응답하지 않아요. 대화 탭을 새로고침하세요.',
  'route-unverified':'대화 주소가 바뀌어서 화면의 메시지가 어느 대화에 속하는지 확인할 수 없어요. 이 대화 탭을 새로고침하세요.',
  unverified:'화면에 보이는 메시지의 수집 상태를 확인할 수 없어요. 대화 탭을 새로고침한 뒤 확인하세요.',
}
type Overview = {
  status:string
  service?:Service
  savedCount?:number
  observed?:number
  readable?:number
  health?:keyof typeof healthMessages
  trimmedCount?:number
  identityLimitReached?:boolean
}
let generation = 0
let timer: number | undefined
let offeredService: Service | undefined

export function clearCaptureSummary() {
  generation++
  window.clearTimeout(timer)
  offeredService = undefined
  enable.hidden = true
  enable.disabled = true
  enable.textContent = ''
  openJournal.disabled = false
  summary.textContent = '현재 탭의 저장 기록을 확인하고 있어요.'
  delete summary.dataset.status
  delete summary.dataset.health
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function render(result: Overview): boolean {
  const {service, health, observed, readable, savedCount} = result
  const name = service === 'chatgpt' || service === 'claude' ? names[service] : undefined
  summary.dataset.status = result.status
  openJournal.disabled = ['capture-off','new-chat','locked','open-source'].includes(result.status)
  delete summary.dataset.health
  if (result.status === 'capture-off' && service && name) {
    offeredService = service
    summary.textContent = name + ' 대화 수집이 꺼져 있어요. 켜면 이 사이트에서 여는 일반 대화의 메시지를 이 Chrome 프로필에 암호화해 저장합니다.'
    enable.textContent = name + ' 대화 수집 켜기'
    enable.disabled = false
    enable.hidden = false
    return false
  }
  if (result.status === 'new-chat' && name) {
    summary.textContent = name + ' 대화 수집이 켜져 있어요. 새 대화에 첫 메시지를 보내면 저장 건수를 확인할 수 있어요.'
    return false
  }
  if (result.status !== 'summary' || !name || !count(savedCount)) {
    summary.textContent = restrictions[result.status as keyof typeof restrictions] ?? restrictions.unverified
    return false
  }
  const lines = [name + ' · 이 대화에 ' + savedCount + '건 저장.']
  if (health && health in healthMessages) {
    lines.push(healthMessages[health])
    summary.dataset.health = health
  } else if (savedCount === 0 && count(observed) && count(readable)) {
    if (observed === 0) lines.push('현재 화면에서 대화 메시지 영역을 찾지 못했어요.')
    else if (readable === 0) lines.push('메시지 영역 ' + observed + '개를 찾았지만 발화자와 본문을 읽을 수 없어요.')
    else lines.push('화면에서 ' + readable + '건을 읽었고, 아직 저장 완료는 확인되지 않았어요.')
  }
  if (count(result.trimmedCount) && result.trimmedCount) lines.push('보관 한도로 이전 메시지 ' + result.trimmedCount + '건의 본문을 정리했어요.')
  if (result.identityLimitReached) lines.push('프로필의 보관 한도에 도달해 새 메시지가 누락될 수 있어요.')
  summary.textContent = lines.join(' ')
  return health === 'pending' || (!health && savedCount === 0 && count(readable) && readable > 0)
}

export function refreshCaptureSummary() {
  clearCaptureSummary()
  const request = generation
  const delays = [300, 800, 1600]
  async function read(attempt: number) {
    const result: Overview | undefined = await chrome.runtime.sendMessage({type:'summarizeActiveCapture'}).catch(() => undefined)
    if (request !== generation) return
    const pending = render(result && typeof result.status === 'string' ? result : {status:'unverified'})
    if (pending && attempt < delays.length) timer = window.setTimeout(() => void read(attempt+1), delays[attempt])
    else if (pending) summary.append(' 잠시 뒤 확장 아이콘을 다시 눌러 저장 상태를 확인하세요.')
  }
  void read(0)
}

export function showVerifiedSummary(page: CapturePreview) {
  clearCaptureSummary()
  render({status:'summary', service:page.source.service, savedCount:page.savedCount, observed:page.observed,
    readable:page.readable, trimmedCount:page.trimmedCount, identityLimitReached:page.identityLimitReached})
}

export async function enableOfferedCapture(): Promise<boolean | undefined> {
  const service = offeredService
  if (!service || enable.disabled) return
  clearCaptureSummary()
  const response = await chrome.runtime.sendMessage({type:'enableActiveCapture', service}).catch(() => undefined)
  return response?.ok === true
}
