import type { Service } from './memory.ts'
import type { CaptureStatus } from './capture-status.ts'

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = byId('status')
const send = (msg: object) => chrome.runtime.sendMessage(msg)
const captureOutput = byId('capture-result')
const relay = byId<HTMLDetailsElement>('relay')
const projectOutput = byId('projects')
let captureRequest = 0
let projectRequest = 0
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
  captureRequest++
  captureOutput.hidden = true
  captureOutput.textContent = ''
  delete captureOutput.dataset.status
  void refreshProjects()
  const settings = await send({type:'permissions'})
  byId('compare-result').textContent = ''
  delete byId('compare-result').dataset.status
  for (const service of ['chatgpt','claude'] as Service[]) {
    for (const field of ['capture','share'] as const) {
      const box = byId<HTMLInputElement>(service + '-' + field)
      box.checked = settings.grants[service][field]
      box.disabled = settings.locked
      box.onchange = async () => {
        const r = await send({type:'setGrant',service,field,value:box.checked})
        status.textContent = r?.ok ? '권한을 저장했습니다.' : '권한을 저장하지 못했습니다.'
        await refresh()
      }
    }
  }
  const lock = byId('lock')
  lock.textContent = settings.locked ? '이 프로필에서 잠금 해제' : '기억 일시 잠금'
  lock.onclick = async () => { await send({type:'lock',value:!settings.locked}); await refresh() }
  byId('unpair').hidden = !settings.paired
  const panel = byId('preference')
  panel.replaceChildren()
  if (!settings.locked && (await send({type:'preference'})).pending) {
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

const captureMessages = {
  'open-source': '원고를 확정한 ChatGPT 대화 탭에서 이 버튼을 눌러 주세요.',
  'locked': '이 프로필의 기억이 잠겨 있어요. 잠금을 해제한 뒤 다시 확인하세요.',
  'capture-off': 'ChatGPT 대화 수집이 꺼져 있어요. 수집을 켜고 원래 대화 탭에서 다시 확인하세요.',
  'reload': '이 ChatGPT 탭에 확장이 연결되지 않았어요. 탭을 새로고침한 뒤 다시 확인하세요.',
  'unverified': '이 탭의 수집과 저장을 확인하지 못했어요. 원래 대화가 열린 상태에서 다시 확인하세요.',
  'storage-error': '기기에 저장된 기록을 확인할 수 없어요. 확장의 저장 상태를 다시 확인하세요.',
  'no-turns': '이 대화에서는 읽어 온 메시지가 없어요. 원래 요청과 답변을 화면에 띄운 뒤 다시 확인하세요.',
  'no-project': '메시지는 읽었지만 상세페이지 원고를 요청한 부분을 찾지 못했어요.',
  'no-options': '원고 요청은 찾았지만 번호가 붙은 시안을 인식하지 못했어요.',
  'inactive': '이 대화의 채택 기록은 있지만 현재 사용할 수 있는 확정 원고가 아니에요.',
}
byId('check-capture').onclick = async () => {
  const request = ++captureRequest
  captureOutput.hidden = false
  captureOutput.textContent = '이 ChatGPT 대화의 저장 상태를 확인하고 있어요.'
  delete captureOutput.dataset.status
  const result: CaptureStatus | undefined = await send({type: 'checkActiveCapture'}).catch(() => undefined)
  if (request !== captureRequest) return
  captureOutput.dataset.status = result?.status ?? 'unverified'
  if (result?.status === 'approved') {
    captureOutput.textContent = `이 대화에서 확정한 ${result.option}안 v${result.version}이 저장되어 있어요.`
  } else if (result?.status === 'options') {
    const choices = result.options.map(option => `${option}안`).join(', ')
    captureOutput.textContent = `원고 ${choices}을 인식했어요. 이 대화에서 선택한 안의 확정 기록은 아직 없어요.`
  } else {
    captureOutput.textContent = captureMessages[result?.status ?? 'unverified'] ?? captureMessages.unverified
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
  if (area === 'local' && changes.locked) refreshSettings()
})
refreshSettings()
