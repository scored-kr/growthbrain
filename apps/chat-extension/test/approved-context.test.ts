import assert from 'node:assert/strict'
import test from 'node:test'
import { approveStoredCondition, listApprovalProjects, readGrantedContext, resumePrompt, retireStoredCondition, type ApprovalInput } from '../src/approved-context.ts'
import { getJournalTurn, recordLocalChatTurn } from '../src/journal.ts'
import { captureTurn, emptyMemory, listApprovedProjects, type MemoryState, type Service } from '../src/memory.ts'

const service: Service = 'chatgpt'
const conversationId = 'source-private'
const resume = '지난번 정한 조건대로 다음 작업을 진행해줘.'
function recorded(state: MemoryState, id: string, text: string): Pick<ApprovalInput, 'service'|'conversationId'|'id'|'revision'|'sequence'> {
  captureTurn(state, {service, conversationId, id, role:'user', text})
  const {revision, sequence} = getJournalTurn(state, service, conversationId, id, 'user')!
  return {service, conversationId, id, revision, sequence}
}
function accepted(state: MemoryState, input: ApprovalInput) {
  const result = approveStoredCondition(state, input)
  assert.equal(result.status, 'approved')
  return result.projectId
}
const ask = (state: MemoryState, projectId: string, query = resume) =>
  readGrantedContext(state, {service:'claude', projectId, query})

test('explicitly approved exact text is the only project content in a resume response', () => {
  const state = emptyMemory()
  const source = recorded(state, 'msg-one', '  명시적으로 고른 조건입니다.\n문장 부호와 여백 보존.  ')
  const privateTurn = recorded(state, 'msg-private', '개인적인 잡담은 포함하지 않습니다.')
  captureTurn(state, {service, conversationId, id:'msg-ai', role:'assistant', text:'승인하지 않은 제안'})
  assert.deepEqual(listApprovedProjects(state), [])
  assert.equal(approveStoredCondition(state, {...source, id:'msg-ai', newProjectTitle:'작성 업무', expectedConditionId:null}).status, 'stale')
  const projectId = accepted(state, {...source, newProjectTitle:'작성 업무', expectedConditionId:null})
  const other = accepted(state, {...privateTurn, newProjectTitle:'다른 업무', expectedConditionId:null})
  assert.deepEqual(listApprovedProjects(state).map(p => p.projectId), [projectId,other])
  const expected = {status:'resume',projectId,decisions:['  명시적으로 고른 조건입니다.\n문장 부호와 여백 보존.  ']}
  assert.deepEqual(ask(state, projectId), expected)
  assert.deepEqual(ask(state, projectId, resumePrompt + '\n\n다음 글을 써 줘'), expected)
  assert.equal(ask(state, projectId, '다른 업무에서 ' + resume).status, 'missing')
  assert.equal(ask(state, projectId, resumePrompt + '\n\n다른 업무 조건을 적용').status, 'missing')
  assert.equal(ask(state, 'no-project').status, 'missing')
  assert.equal(ask(state, projectId, '다음 글을 써 줘').status, 'missing')
  state.preferences = {status:'pending'}
  assert.deepEqual(ask(state, projectId), expected)
  state.preferences = {status:'accepted'}
  assert.deepEqual(ask(state, projectId), {...expected, preference:'별도 요청이 없으면 제목은 짧게 씁니다.'})
  assert.deepEqual(ask(state, projectId, resume + ' 이번에는 제목을 길게 써 줘.'), expected)
  assert.deepEqual(ask(state, projectId, resumePrompt + '\n\n제목을 정확히 여섯 단어로 써 줘.'), expected)
  assert.equal(ask(state, projectId, '지난번 정한 조건대로 하지 말고 새로 시작하자.').status, 'missing')
  assert.deepEqual(ask(state, 'no-project'), {status:'missing'})
})

test('per-project count and length limits require an explicit replacement and never truncate approved text', () => {
  const state = emptyMemory()
  const tooLong = recorded(state, 'large', '가'.repeat(2001))
  assert.equal(approveStoredCondition(state, {...tooLong, newProjectTitle:'문서', expectedConditionId:null}).status,'invalid')
  assert.equal(state.projects.length,0)
  const first = recorded(state, 'limit', '가'.repeat(2000))
  const projectId = accepted(state, {...first, newProjectTitle:'문서', expectedConditionId:null})
  for (let i = 1; i < 8; i++) {
    const next = recorded(state, 'decision-' + i, '조건 ' + i)
    accepted(state, {...next, projectId, expectedConditionId:null})
  }
  const ninth = recorded(state, 'last', '직접 검토한 추가 조건')
  assert.equal(approveStoredCondition(state, {...ninth, projectId, expectedConditionId:null}).status,'limit')
  assert.equal(listApprovalProjects(state)[0].approvedConditions[0].text, '가'.repeat(2000))
  const oldId = listApprovalProjects(state)[0].approvedConditions[0].id
  accepted(state, {...ninth, projectId, expectedConditionId:oldId})
  const approved = listApprovalProjects(state)[0].approvedConditions
  assert.equal(approved.length,8)
  assert.equal(approved.at(-1)?.text,'직접 검토한 추가 조건')
  assert.ok(approved.every(record => record.id !== oldId))
})

test('a user can manually save an exact local copy when the provider supplies no stable message ID', () => {
  const state = emptyMemory()
  const service = 'claude'
  const conversationId = 'private-claude-chat'
  const original = {service, conversationId, role:'user', id:'local:original', text:'검토한 초안 사본'} as const
  recordLocalChatTurn(state, original)
  assert.deepEqual(listApprovedProjects(state), [])
  const source = getJournalTurn(state, service, conversationId, original.id, 'user')!
  const result = approveStoredCondition(state, {service, conversationId, id:source.id,
    sequence:source.sequence, revision:source.revision, newProjectTitle:'직접 고른 업무', expectedConditionId:null})
  assert.equal(result.status, 'approved')
  recordLocalChatTurn(state, {...original, id:'local:new', text:'별도 로컬 사본'})
  assert.deepEqual(ask(state,result.projectId), {status:'resume',projectId:result.projectId,decisions:[original.text]})
  assert.equal(retireStoredCondition(state,result.projectId,listApprovalProjects(state)[0].approvedConditions[0].id),true)
  assert.equal(ask(state,result.projectId).status,'missing')
})

test('reviewed assistant writing is a scoped reference, separately capped, replaced and retired', () => {
  const state = emptyMemory()
  const review = (id: string, text: string) => {
    const role = 'assistant'
    captureTurn(state, {service, conversationId, id, role, text})
    const {sequence, revision} = getJournalTurn(state,service,conversationId,id,role)!
    return {service, conversationId, id, role, sequence, revision} as const
  }
  const first = review('assistant-work', '  실제로 검토한 참고 원고입니다.\n이후 문단.  ')
  const tooLong = review('large-ref','가'.repeat(8001))
  assert.equal(approveStoredCondition(state,{...tooLong,newProjectTitle:'원고',expectedConditionId:null}).status,'invalid')
  assert.deepEqual(listApprovedProjects(state), [])
  const projectId = accepted(state,{...first,newProjectTitle:'원고',expectedConditionId:null})
  const expectedRef = '  실제로 검토한 참고 원고입니다.\n이후 문단.  '
  assert.deepEqual(ask(state,projectId), {status:'resume',projectId,decisions:[],references:[expectedRef]})
  const firstRefId = listApprovalProjects(state)[0].approvedReferences[0].id
  const instruction = recorded(state,'assistant-work','독자에게 직접 제안해 주세요.')
  assert.equal(approveStoredCondition(state,{...instruction,projectId,expectedConditionId:firstRefId}).status,'conflict')
  accepted(state,{...instruction,projectId,expectedConditionId:null})
  const condition = listApprovalProjects(state)[0].approvedConditions[0]
  assert.equal(approveStoredCondition(state,{...first,projectId,expectedConditionId:condition.id}).status,'conflict')
  assert.equal(retireStoredCondition(state,projectId,firstRefId),false)
  const four = [expectedRef]
  for (let i = 1; i < 4; i++) {
    four.push(String(i).repeat(8000))
    accepted(state,{...review('ref-' + i, four[i]),projectId,expectedConditionId:null})
  }
  const extra = review('ref-five','교체할 예시')
  assert.equal(approveStoredCondition(state,{...extra,projectId,expectedConditionId:null}).status,'limit')
  assert.deepEqual(ask(state,projectId), {status:'resume',projectId,decisions:[condition.text],references:four})
  accepted(state,{...extra,projectId,expectedConditionId:firstRefId})
  review('ref-five','원문에서 바꾼 예시')
  assert.deepEqual(ask(state,projectId), {status:'resume',projectId,decisions:[condition.text],references:four.slice(1)})
  assert.equal(approveStoredCondition(state,{...extra,projectId,expectedConditionId:null}).status,'stale')
  for (const active of listApprovalProjects(state)[0].approvedReferences)
    assert.equal(retireStoredCondition(state,projectId,active.id,'assistant'),true)
  assert.deepEqual(ask(state,projectId),{status:'resume',projectId,decisions:[condition.text]})
})

test('independent conditions coexist; replacements, source edits and retirement never revive older text', () => {
  const state = emptyMemory()
  const first = recorded(state, 'first', '기존 예산')
  const projectId = accepted(state, {...first,newProjectTitle:'업무',expectedConditionId:null})
  const source = recorded(state, 'second', '기간은 이틀')
  accepted(state, {...source,projectId,expectedConditionId:null})
  const firstId = listApprovalProjects(state)[0].approvedConditions[0].id
  const replacement = recorded(state, 'third', '예산은 100원')
  accepted(state, {...replacement,projectId,expectedConditionId:firstId})
  assert.deepEqual(ask(state, projectId), {status:'resume',projectId,decisions:['기간은 이틀','예산은 100원']})
  assert.equal(approveStoredCondition(state, {...first,projectId,expectedConditionId:firstId}).status, 'conflict')
  const changed = recorded(state, 'third', '예산은 200원')
  assert.equal(approveStoredCondition(state, {...replacement,projectId,expectedConditionId:null}).status, 'stale')
  assert.deepEqual(ask(state,projectId), {status:'resume',projectId,decisions:['기간은 이틀']})
  assert.equal(retireStoredCondition(state,projectId,listApprovalProjects(state)[0].approvedConditions[0].id),true)
  assert.equal(ask(state,projectId).status,'missing')
  assert.equal(approveStoredCondition(state,{...changed,newProjectTitle:' 업무 ',expectedConditionId:null}).status,'conflict')
  assert.deepEqual(listApprovedProjects(state),[])
})
