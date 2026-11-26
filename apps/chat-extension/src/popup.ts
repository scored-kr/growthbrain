import type { Service } from './memory.ts'
import { clearCapturePreview } from './journal-popup.ts'

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = byId('status')
const send = (msg: object) => chrome.runtime.sendMessage(msg)
const relay = byId<HTMLDetailsElement>('relay')
const projectOutput = byId('projects')
let projectRequest = 0
let settingsRequest = 0
async function refreshProjects() {
  const request = ++projectRequest
  projectOutput.textContent = ''
  if (!relay.open) return
  const result = await send({type:'projects'}).catch(() => undefined)
  if (request !== projectRequest || !relay.open) return
  if (result?.status === 'locked') {
    projectOutput.textContent = '기억이 잠겨 있어요. 이 프로필에서 잠금을 해제하면 확정한 프로젝트를 볼 수 있어요.'
  } else if (!Array.isArray(result?.projects)) {
    projectOutput.textContent = '저장된 프로젝트 목록을 읽지 못했어요.'
  } else {
    projectOutput.textContent = result.projects.length
      ? '연결 승인에 쓸 프로젝트 ID\n' + result.projects.map((p:{title:string,projectId:string}) => p.title + ' · ' + p.projectId).join('\n')
      : '확정한 프로젝트가 없습니다.'
  }
}
async function refresh() {
  const request = ++settingsRequest
  clearCapturePreview()
  void refreshProjects()
  const settings = await send({type:'permissions'})
  if (request !== settingsRequest) return
  byId('compare-result').textContent = ''
  delete byId('compare-result').dataset.status
  for (const service of ['chatgpt','claude'] as Service[]) {
    for (const field of ['capture','share'] as const) {
      const box = byId<HTMLInputElement>(service + '-' + field)
      box.checked = settings.grants[service][field]
      box.disabled = settings.locked
      box.onchange = async () => {
        clearCapturePreview()
        box.disabled = true
        const r = await send({type:'setGrant',service,field,value:box.checked}).catch(() => undefined)
        status.textContent = r?.ok ? '권한을 저장했습니다.' : '권한을 저장하지 못했습니다.'
        refreshSettings()
      }
    }
  }
  const lock = byId<HTMLButtonElement>('lock')
  lock.disabled = false
  lock.textContent = settings.locked ? '이 프로필에서 잠금 해제' : '기억 일시 잠금'
  lock.onclick = async () => {
    clearCapturePreview()
    lock.disabled = true
    const updated = await send({type:'lock',value:!settings.locked}).catch(() => undefined)
    if (!updated?.ok) status.textContent = '잠금 상태를 변경하지 못했습니다.'
    refreshSettings()
  }
  byId('unpair').hidden = !settings.paired
  const panel = byId('preference')
  panel.replaceChildren()
  if (!settings.locked && (await send({type:'preference'})).pending && request === settingsRequest) {
    const question = document.createElement('p')
    question.textContent = '다른 상품에서도 짧은 헤드라인을 기본으로 할까요?'
    panel.append(question)
    for (const [label, value] of [['기본으로 사용','accepted'], ['기본값으로 사용 안 함','declined']]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.onclick = async () => {
        await send({type:'decidePreference',value})
        await refresh()
      }
      panel.append(button)
    }
  }
}

byId('compare-reply').onclick = async () => {
  const output = byId('compare-result')
  delete output.dataset.status
  output.textContent = '현재 Claude 답변을 대조하고 있습니다.'
  const result = await send({type:'compareActiveReply'}).catch(() => undefined)
  const state = result?.status
  if (state === 'match') {
    output.textContent = `${result.option}안 v${result.version}과 대조했습니다. 첫 문장이 바뀌었고 이후 원문이 일치합니다.`
  } else if (state === 'changed') {
    output.textContent = `${result.option}안 v${result.version}과 대조했습니다. 답변이 첫 문장만 바뀐 원고와 일치하지 않습니다.`
  } else {
    output.textContent = '대조할 답변을 확인할 수 없습니다. 첫 문장 수정을 요청한 Claude 탭에서 전체 원고 답변이 끝난 뒤 확인하세요.'
  }
  output.dataset.status = state === 'match' || state === 'changed' ? state : 'unverified'
}
relay.ontoggle = refreshProjects
byId('pair').onclick = async () => {
  const input = byId<HTMLInputElement>('token')
  const r = await send({type:'pair',token:input.value.trim()})
  input.value = ''
  status.textContent = r?.ok ? '기기 연결 키를 저장했습니다.' : '연결 키 형식을 확인하세요.'
  await refresh()
}
byId('unpair').onclick = async () => {
  await send({type:'pair',token:''})
  status.textContent = '연결을 해제했습니다.'
  await refresh()
}
function refreshSettings() {
  void refresh().catch(() => {status.textContent = '확장 서비스 워커에 연결하지 못했습니다.'})
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.locked || changes.grants)) refreshSettings()
})
refreshSettings()
