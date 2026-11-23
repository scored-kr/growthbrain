import type { Service } from './memory.ts'

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const status = byId('status')
const send = (msg: object) => chrome.runtime.sendMessage(msg)
async function refresh() {
  const settings = await send({type:'permissions'})
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
const relay = byId<HTMLDetailsElement>('relay')
relay.ontoggle = async () => {
  if (!relay.open) return
  const {projects} = await send({type:'projects'})
  byId('projects').textContent = projects?.length
    ? '연결 승인에 쓸 프로젝트 ID\n' + projects.map((p:{title:string,projectId:string}) => p.title + ' · ' + p.projectId).join('\n')
    : '확정한 프로젝트가 없습니다.'
}
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
void refresh().catch(() => {status.textContent = '확장 서비스 워커에 연결하지 못했습니다.'})
