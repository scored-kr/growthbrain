// Local export reader. No network, browser storage, HTML parsing or model calls.
export const MAX_EXPORT_BYTES=20*1024*1024;
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,160}$/.test(v);
const fail=()=>{throw Error('INVALID_CHAT_EXPORT')};
function parseArray(text){
  if(typeof text!=='string'||new TextEncoder().encode(text).length>MAX_EXPORT_BYTES)throw Error('EXPORT_TOO_LARGE');
  let data;try{data=JSON.parse(text)}catch{fail()}
  if(!Array.isArray(data)||!data.length||data.length>10000)fail();return data;
}
function conversationId(value){
  const id=value.id??value.conversation_id;
  if(!validId(id)||(value.id&&value.conversation_id&&value.id!==value.conversation_id))fail();
  return id;
}
export function readChatGPTExport(text){
  const data=parseArray(text);
  const seen=new Set();
  return data.map(value=>{
    if(!isObject(value))fail();const id=conversationId(value);
    if(seen.has(id)||typeof value.title!=='string'||!value.title.trim()||value.title.length>500||!isObject(value.mapping)||Object.hasOwn(value,'chat_messages'))fail();
    seen.add(id);
    return {provider:'chatgpt-export',id,title:value.title,record:value};
  });
}

export function readClaudeExport(text){
  const seen=new Set();
  return parseArray(text).map(record=>{
    if(!isObject(record)||!validId(record.uuid)||seen.has(record.uuid)||typeof record.name!=='string'||!record.name.trim()||record.name.length>500||!Array.isArray(record.chat_messages)||Object.hasOwn(record,'mapping'))fail();
    seen.add(record.uuid);return {provider:'claude-export',id:record.uuid,title:record.name,record};
  });
}
export function readChatExport(text,provider){
  if(provider==='chatgpt-export')return readChatGPTExport(text);
  if(provider==='claude-export')return readClaudeExport(text);
  fail();
}
export function selectChatConversation(entry){return entry.provider==='claude-export'?selectClaudeConversation(entry):selectChatGPTConversation(entry)}
function isoTime(value){
  if(value===null||value===undefined)return null;
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))fail();
  return new Date(value).toISOString();
}
export function selectClaudeConversation(entry){
  const all=entry.record.chat_messages;if(all.length>5000)fail();
  const byId=new Map();for(const m of all){if(!isObject(m)||!validId(m.uuid)||byId.has(m.uuid))fail();byId.set(m.uuid,m)}
  let chain=all,leaf=entry.record.current_leaf_message_uuid??null,branchMode='unverified-flat';
  const hasParents=all.some(m=>Object.hasOwn(m,'parent_message_uuid'));
  if(leaf!==null||hasParents){
    // Branch metadata must be complete. Never guess which regenerated answer is current.
    if(!validId(leaf)||!byId.has(leaf)||!all.every(m=>Object.hasOwn(m,'parent_message_uuid')))throw Error('AMBIGUOUS_CHAT_BRANCH');
    const seen=new Set();chain=[];let cursor=leaf;
    while(cursor!==null&&cursor!=='00000000-0000-4000-8000-000000000000'){
      if(!validId(cursor)||seen.has(cursor)||!byId.has(cursor))fail();
      seen.add(cursor);const m=byId.get(cursor);chain.push(m);cursor=m.parent_message_uuid;
    }
    chain.reverse();branchMode='current';
  }
  const messages=[],skipped={nonDialogue:0,hidden:0,nonText:0,empty:0};let unsupportedParts=0;
  for(const m of chain){
    if(!['human','assistant'].includes(m.sender)){skipped.nonDialogue++;continue}
    if(m.truncated===true)throw Error('TRUNCATED_CHAT_MESSAGE');
    let text='';
    if(Array.isArray(m.content)){
      const parts=[];for(const block of m.content){
        if(!isObject(block)||typeof block.type!=='string')fail();
        if(block.type==='text'){if(typeof block.text!=='string')fail();parts.push(block.text)}else unsupportedParts++;
      }
      text=parts.join('\n');if(!parts.length&&m.content.length){skipped.nonText++;continue}
    }else if(m.content===undefined||m.content===null){if(typeof m.text!=='string')fail();text=m.text}else fail();
    for(const field of ['attachments','files','files_v2'])if(Array.isArray(m[field]))unsupportedParts+=m[field].length;
    if(!text.trim()){skipped.empty++;continue}
    if(text.length>12000)throw Error('IMPORT_MESSAGE_TOO_LONG');
    messages.push({id:m.uuid,role:m.sender==='human'?'user':'assistant',text,createdAt:isoTime(m.created_at)});
  }
  return {provider:'claude-export',branchMode,conversationId:entry.id,title:entry.title,branchLeafId:leaf,messages,skipped,unsupportedParts,excludedBranchNodes:all.length-chain.length};
}
function timestamp(value){
  if(value===null||value===undefined)return null;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>253402300799)fail();
  return new Date(value*1000).toISOString();
}
export function selectChatGPTConversation(entry){
  const {record}=entry,{mapping}=record,leaf=record.current_node;
  if(!validId(leaf)||!Object.hasOwn(mapping,leaf)||Object.keys(mapping).length>20000)fail();
  const chain=[],seen=new Set();let cursor=leaf;
  while(cursor!==null){
    if(!validId(cursor)||seen.has(cursor)||!Object.hasOwn(mapping,cursor)||chain.length>=5000)fail();
    const node=mapping[cursor];
    if(!isObject(node)||node.id!==cursor||!(node.parent===null||validId(node.parent)))fail();
    seen.add(cursor);chain.push(node);cursor=node.parent;
  }
  chain.reverse();
  const messages=[],ids=new Set(),skipped={nonDialogue:0,hidden:0,nonText:0,empty:0};
  for(const node of chain){
    const m=node.message;if(m===null||m===undefined)continue;
    if(!isObject(m)||!isObject(m.author))fail();
    const role=m.author.role;
    if(!['user','assistant'].includes(role)){skipped.nonDialogue++;continue}
    if((m.channel!=null&&m.channel!=='final')||(m.recipient!=null&&m.recipient!=='all')||m.metadata?.is_visually_hidden_from_conversation===true){skipped.hidden++;continue}
    if(!validId(m.id)||ids.has(m.id))fail();ids.add(m.id);
    if(m.content?.content_type!=='text'||!Array.isArray(m.content.parts)||!m.content.parts.every(p=>typeof p==='string')){skipped.nonText++;continue}
    const text=m.content.parts.join('\n');
    if(!text.trim()){skipped.empty++;continue}
    // Never truncate a qualification or silently discard an oversized visible message.
    if(text.length>12000)throw Error('IMPORT_MESSAGE_TOO_LONG');
    messages.push({id:m.id,role,text,createdAt:timestamp(m.create_time)});
  }
  return {provider:'chatgpt-export',branchMode:'current',conversationId:entry.id,title:entry.title,branchLeafId:leaf,messages,skipped,excludedBranchNodes:Object.keys(mapping).length-chain.length};
}

export function importBatches(selection,projectId){
  const {provider,branchMode,conversationId,title,branchLeafId}=selection,base={projectId,confirmed:true,allowUnverifiedBranch:branchMode==='unverified-flat',provider,branchMode,conversationId,title,branchLeafId},batches=[];let chunk=[];
  const size=messages=>new TextEncoder().encode(JSON.stringify({method:'import_chat',params:{...base,messages}})+'\n').length;
  for(const message of selection.messages){
    if(size([message])>60000)throw Error('IMPORT_MESSAGE_TOO_LARGE');
    if(chunk.length===20||size([...chunk,message])>60000){batches.push({...base,messages:chunk});chunk=[];}
    chunk.push(message);
  }
  if(chunk.length)batches.push({...base,messages:chunk});return batches;
}
