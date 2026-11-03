const $=id=>document.getElementById(id);let local={},capture={},projects=[],nextOffset=null;
function status(message){$('status').textContent=message}
async function send(message){const response=await chrome.runtime.sendMessage(message);if(!response?.ok)throw Error(response?.error??'연결 실패');return response.result}
const errors={VAULT_LOCKED:'금고가 잠겨 있습니다. 별도 로컬 터미널에서 잠금을 해제하세요.',LOCAL_VAULT_UNAVAILABLE:'로컬 연결 프로그램을 설치하고 금고를 열어주세요.',EXPLICIT_SUPERSESSION_REQUIRED:'같은 조건의 확정 기억이 있습니다. 교체할 기존 조건을 선택한 뒤 다시 승인하세요.'};
async function run(action){try{await action()}catch(e){status(errors[e.message]??e.message)}}
function state(){
  const site=$('site').value,s=local[site],last=capture[site];
  const name=projects.find(p=>p.id===s?.projectId)?.name??'선택 프로젝트';
  const detail=!last?'아직 확인된 전송 없음':last.state==='received'?`마지막 전송 확인 ${new Date(last.at).toLocaleTimeString()}${last.duplicate?' (중복 제외)':''}`:
    ['VAULT_LOCKED','LOCAL_VAULT_UNAVAILABLE'].includes(last.error)?'금고 연결 대기 — 열리면 재시도':`마지막 전송 실패 (${last.error})`;
  $('capture-state').textContent=s?.enabled?`수집 허용 · 저장 대상: ${name} · ${detail}`:'수집 중지됨';
}
async function loadProjects(){
  const result=await send({type:'PROJECTS'});local=result.local;capture=result.capture??{};projects=result.projects;const selected=$('project').value||local[$('site').value]?.projectId;
  $('project').replaceChildren(new Option('선택하세요',''));
  for(const p of result.projects)$('project').append(new Option(p.name,p.id));
  $('project').value=selected??'';state();status(result.reconciled?'금고의 동의/프로젝트 설정이 변경되어 이 브라우저 수집을 중지했습니다.':'로컬 금고 연결됨');await memories();
}
async function memories(offset=0){
  if(!offset)$('memories').replaceChildren();$('more').hidden=true;
  if(!$('project').value)return;
  const data=await send({type:'MEMORIES',projectId:$('project').value,status:$('filter').value,offset});
  for(const m of data.memories){
    const card=document.createElement('article');const heading=document.createElement('strong');heading.textContent=`${m.key} · ${m.status} · ${m.scope.type==='global'?'공통':'프로젝트'}`;
    const text=document.createElement('pre');text.textContent=m.value;
    const source=document.createElement('small');source.textContent=`출처: ${m.captureSource?.url??m.source.reference}\n원문: ${m.source.excerpt}\n이유: ${m.reason}`;
    card.append(heading,text,source);
    if(m.status==='candidate'){
      const replace=document.createElement('select');replace.setAttribute('aria-label','교체할 기억');replace.append(new Option('기존 조건 교체 안 함',''));
      if(m.conflict)replace.append(new Option(`이전 조건을 교체: ${m.conflict.value}`,m.conflict.id));
      for(const [label,decision] of [['승인','approve'],['기각','reject']]){const button=document.createElement('button');button.textContent=label;button.onclick=()=>run(async()=>{button.disabled=true;try{await send({type:'REVIEW',projectId:$('project').value,id:m.id,decision,...(replace.value.trim()?{supersedesId:replace.value.trim()}:{})});status(decision==='approve'?'승인 완료':'기각 완료');await memories()}finally{button.disabled=false}});card.append(button)}
      if(m.conflict)card.append(replace);
    }
    $('memories').append(card);
  }
  nextOffset=data.nextOffset;$('more').hidden=nextOffset===null;
}
$('enable').onclick=()=>run(async()=>{
  const site=$('site').value,projectId=$('project').value;if(!projectId)throw Error('프로젝트를 선택하세요.');
  if(!await chrome.permissions.request({origins:[`https://${site}/*`]}))throw Error('사이트 권한이 허용되지 않았습니다.');
  const result=await send({type:'ENABLE',site,projectId});local[site]={enabled:result.enabled,projectId};delete capture[site];state();status(result.enabled?'사이트 수집을 허용했습니다. 새로고침으로 실제 전송 상태를 확인하세요.':'수집 시작 요청이 중지되었습니다.');
});
$('stop').onclick=()=>run(async()=>{const site=$('site').value;const result=await send({type:'STOP',site});local[site]={...local[site],enabled:false};state();status(result.vaultUpdatePending?'이 브라우저 수집 중지됨. 금고 연결 후 중지 상태를 다시 확인하세요.':'수집 중지 완료')});
$('refresh').onclick=()=>run(loadProjects);
$('site').onchange=()=>{state();$('project').value=local[$('site').value]?.projectId??'';run(()=>memories())};
$('project').onchange=()=>run(()=>memories());$('filter').onchange=()=>run(()=>memories());$('more').onclick=()=>run(()=>memories(nextOffset));
run(loadProjects);
