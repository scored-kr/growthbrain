import {readChatExport,selectChatConversation,MAX_EXPORT_BYTES,importBatches} from './chat-import.js';
const $=id=>document.getElementById(id);
let entries=[],selection=null,generation=0,busy=false,stopped=false,previewOffset=0;
const messages={AMBIGUOUS_CHAT_BRANCH:'현재 대화 분기를 확인할 수 없습니다. 분기 정보가 완전한 파일을 선택하세요. 임의의 답변을 고르지 않았습니다.',TRUNCATED_CHAT_MESSAGE:'이미 잘린 메시지가 있어 이 대화를 가져오지 않았습니다. 완전한 원문 파일을 선택하세요.',INVALID_CHAT_EXPORT:'선택한 서비스의 지원 대화 JSON 형식이 아닙니다. 대화 분기나 메시지 식별자를 확인할 수 없어 가져오지 않았습니다.',EXPORT_TOO_LARGE:'20 MiB 이하의 대화 JSON을 선택하세요. ZIP 파일은 먼저 기기에서 풀어주세요.',IMPORT_MESSAGE_TOO_LONG:'12,000자를 넘는 메시지가 있어 이 대화를 가져올 수 없습니다. 내용을 잘라 저장하지 않았습니다.',IMPORT_MESSAGE_TOO_LARGE:'한 메시지의 전송 크기가 제한을 넘습니다. 이 대화를 가져오지 않았습니다.',VAULT_LOCKED:'금고가 잠겨 있습니다. 별도 로컬 터미널에서 연 뒤 연결을 새로고침하세요.',LOCAL_VAULT_UNAVAILABLE:'로컬 연결 프로그램을 설치하고 금고를 연 뒤 연결을 새로고침하세요.',IMPORT_PROJECT_MISMATCH:'이미 다른 프로젝트에 가져온 대화입니다. 원래 프로젝트를 선택하세요.',CAPTURE_LIMIT:'금고의 대화 저장 한도에 도달했습니다.',MEMORY_LIMIT:'금고의 기억 저장 한도에 도달했습니다.',VAULT_SIZE_LIMIT:'금고의 파일 크기 한도에 도달했습니다.'};
const status=s=>{$('import-status').textContent=s};
const errorText=e=>messages[e.message]??'요청을 완료하지 못했습니다. 금고 연결과 선택한 파일을 확인하세요.';
async function send(message){const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw Error(r?.error??'REQUEST_FAILED');return r.result}
function ready(){$('start-import').disabled=busy||!selection?.messages.length||!$('import-project').value||!$('import-consent').checked||(selection.branchMode==='unverified-flat'&&!$('unverified-consent').checked);}
function changed(){$('import-consent').checked=false;$('unverified-consent').checked=false;$('branch-warning').hidden=selection?.branchMode!=='unverified-flat';ready();}
function clear(resetFile=true){generation++;entries=[];selection=null;if(resetFile)$('export-file').value='';$('conversation').replaceChildren(new Option('파일을 선택하세요',''));$('import-preview').replaceChildren();$('preview-more').hidden=true;$('import-summary').textContent='아직 선택한 대화가 없습니다.';changed();}
function preview(){
  if(!selection)return;
  for(const m of selection.messages.slice(previewOffset,previewOffset+10)){
    const row=document.createElement('details'),heading=document.createElement('summary'),text=document.createElement('pre');
    heading.textContent=`${m.role==='user'?'사용자':'AI'} · ${m.createdAt??'시각 미상'}`;text.textContent=m.text;row.append(heading,text);$('import-preview').append(row);
  }
  previewOffset+=10;$('preview-more').hidden=previewOffset>=selection.messages.length;
}
async function projects(selected=''){
  const r=await send({type:'IMPORT_PROJECTS'});$('import-project').replaceChildren(new Option('선택하세요',''));
  for(const p of r.projects)$('import-project').append(new Option(p.name,p.id));
  $('import-project').value=selected;changed();status(r.projects.length?'로컬 금고 연결됨. 파일과 대화를 선택하세요.':'로컬 금고 연결됨. 먼저 프로젝트를 만드세요.');
}
$('reload-projects').onclick=()=>projects($('import-project').value).catch(e=>status(errorText(e)));
$('create-project').onclick=async()=>{
  const name=$('new-project-name').value.trim();if(!name){status('프로젝트 이름을 입력하세요.');return}
  $('create-project').disabled=true;
  try{const p=await send({type:'IMPORT_CREATE_PROJECT',name});$('new-project-name').value='';await projects(p.id)}catch(e){status(errorText(e))}finally{$('create-project').disabled=false}
};
$('export-file').onchange=async()=>{
  const file=$('export-file').files[0];clear(false);if(!file)return;
  const token=generation;status('기기에서 파일을 읽는 중…');
  try{
    if(!file.name.toLowerCase().endsWith('.json'))throw Error('INVALID_CHAT_EXPORT');
    if(file.size>MAX_EXPORT_BYTES)throw Error('EXPORT_TOO_LARGE');
    const text=await file.text();if(token!==generation)return;
    entries=readChatExport(text,$('import-provider').value);$('conversation').replaceChildren(new Option('대화를 선택하세요',''));
    entries.forEach((entry,index)=>$('conversation').append(new Option(entry.title,String(index))));
    status(`${entries.length}개 대화가 있습니다. 가져올 대화 하나를 선택하세요. 아직 저장하지 않았습니다.`);
  }catch(e){if(token===generation)status(errorText(e))}
};
$('conversation').onchange=()=>{
  selection=null;$('import-preview').replaceChildren();$('preview-more').hidden=true;previewOffset=0;changed();
  if($('conversation').value===''){$('import-summary').textContent='대화를 선택하세요.';return}
  try{
    selection=selectChatConversation(entries[Number($('conversation').value)]);
    const skipped=Object.values(selection.skipped).reduce((a,b)=>a+b,0);
    $('import-summary').textContent=`${selection.title} · 가져올 메시지 ${selection.messages.length}개 · 지원하지 않거나 숨긴/빈 메시지 ${skipped}개 제외 · ${selection.branchMode==='current'?`다른 분기 노드 ${selection.excludedBranchNodes}개 제외`:'현재 분기 미확인'} · 첨부/비텍스트 블록 ${selection.unsupportedParts??0}개 제외`;
    preview();status(selection.messages.length?'미리보기와 프로젝트를 확인한 뒤 가져오기에 동의하세요.':'가져올 일반 텍스트 메시지가 없습니다.');changed();
  }catch(e){$('import-summary').textContent='이 대화는 가져올 수 없습니다.';status(errorText(e))}
};
$('start-import').onclick=async()=>{
  if(busy||!selection?.messages.length||!$('import-project').value||!$('import-consent').checked||(selection.branchMode==='unverified-flat'&&!$('unverified-consent').checked))return;
  const chosen=selection,projectId=$('import-project').value;let imported=0,duplicates=0,candidates=0,acknowledged=0;
  busy=true;stopped=false;$('selection').disabled=true;$('import-consent').disabled=true;$('unverified-consent').disabled=true;$('stop-import').hidden=false;ready();
  try{
    const batches=importBatches(chosen,projectId);
    for(const params of batches){
      if(stopped)break;
      status(`가져오는 중 · 확인된 메시지 ${acknowledged}/${chosen.messages.length}개`);
      const r=await send({type:'IMPORT_CHAT',params});imported+=r.imported;duplicates+=r.duplicates;candidates+=r.candidateIds.length;acknowledged+=params.messages.length;
    }
    status(`${stopped?'중단했습니다':'가져오기 완료'} · 새 메시지 ${imported}개 · 중복 ${duplicates}개 · 승인 대기 후보 ${candidates}개 · 확인 ${acknowledged}/${chosen.messages.length}개. 후보는 별도 검토하세요.`);
  }catch(e){status(`${errorText(e)} 확인된 새 메시지 ${imported}개·중복 ${duplicates}개는 유지됩니다. 마지막 요청의 저장 여부가 불명확할 수 있습니다. 같은 파일/대화를 다시 선택해 확인하면 중복은 제외합니다.`)}
  finally{busy=false;$('selection').disabled=false;$('import-consent').disabled=false;$('unverified-consent').disabled=false;$('stop-import').hidden=true;changed();}
};
$('stop-import').onclick=()=>{stopped=true;status('현재 요청의 결과를 확인한 뒤 중단합니다. 이미 저장한 메시지는 유지됩니다.')};
$('clear-file').onclick=()=>{clear();status('파일 선택을 지웠습니다. 이미 금고에 가져온 내용은 유지됩니다.')};
$('import-project').onchange=changed;$('import-consent').onchange=ready;$('preview-more').onclick=preview;
$('unverified-consent').onchange=ready;$('import-provider').onchange=()=>{clear();status('선택한 서비스의 내보내기 파일을 골라주세요.')};
window.addEventListener('beforeunload',event=>{if(busy)event.preventDefault()});
projects().catch(e=>status(errorText(e)));
