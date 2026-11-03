const sites=['chatgpt.com','claude.ai'];
const popupUrl=chrome.runtime.getURL('popup.html');
const host='com.growthbrain.local';
const controls=new Map(),revisions=new Map();let storageQueue=Promise.resolve();
const revision=site=>{const next=(revisions.get(site)??0)+1;revisions.set(site,next);return next};
function enqueue(site,action){const run=(controls.get(site)??Promise.resolve()).then(action);controls.set(site,run.catch(()=>{}));return run}
const origin=site=>`https://${site}/*`;
const canonical=value=>{const u=new URL(value);u.search='';u.hash='';return u.href};
async function native(method,params){
  let response;
  try{response=await chrome.runtime.sendNativeMessage(host,{id:crypto.randomUUID(),method,params})}catch{throw Error('LOCAL_VAULT_UNAVAILABLE')}
  if(response.error)throw Error(response.error);return response.result;
}
async function settings(){return(await chrome.storage.local.get('sites')).sites??{}}
function setSite(site,value){const run=storageQueue.then(async()=>{const current=await settings();current[site]=value;await chrome.storage.local.set({sites:current})});storageQueue=run.catch(()=>{});return run}
async function notifyTabs(site,type){for(const tab of await chrome.tabs.query({url:origin(site)})){if(tab.id)await chrome.tabs.sendMessage(tab.id,{type}).catch(()=>{})}}
async function register(site){
  const id=`growth-brain-${site.replace('.','-')}`;
  await chrome.scripting.unregisterContentScripts({ids:[id]}).catch(()=>{});
  await chrome.scripting.registerContentScripts([{id,matches:[origin(site)],js:['adapters.js','content.js'],runAt:'document_idle',persistAcrossSessions:true}]);
  for(const tab of await chrome.tabs.query({url:origin(site)}))if(tab.id)await chrome.scripting.executeScript({target:{tabId:tab.id},files:['adapters.js','content.js']}).catch(()=>{});
  await notifyTabs(site,'GB_START');
}
async function stop(site){
  revision(site);
  const pause=(async()=>{const current=(await settings())[site];await setSite(site,{...current,enabled:false});await notifyTabs(site,'GB_STOP')})();
  const finish=enqueue(site,async()=>{
    await pause;const current=(await settings())[site];
    await chrome.scripting.unregisterContentScripts({ids:[`growth-brain-${site.replace('.','-')}`]}).catch(()=>{});
    if(current?.projectId)await native('configure_capture',{site,projectId:current.projectId,enabled:false});
  });
  return await finish;
}
export async function dispatch(message,sender){
  if(message.type==='CAPTURE'){
    const url=new URL(sender.tab?.url??'https://invalid.example');const site=url.hostname;
    if(sender.id!==chrome.runtime.id||!sites.includes(site)||url.protocol!=='https:'||canonical(message.url)!==canonical(url.href))throw Error('UNTRUSTED_PAGE');
    const state=(await settings())[site];
    if(!state?.enabled||!await chrome.permissions.contains({origins:[origin(site)]}))throw Error('PAUSED');
    const m=message.message;
    return await native('capture',{site,projectId:state.projectId,url:canonical(url.href),messageId:m.messageId,role:m.role,text:m.text});
  }
  if(sender.id!==chrome.runtime.id||sender.url!==popupUrl)throw Error('POPUP_REQUIRED');
  if(message.type==='PROJECTS'){
    const remote=await native('list_projects',{}),local=await settings();let reconciled=false;
    for(const site of sites){
      const selected=local[site],consent=remote.settings?.find(c=>c.site===site);
      if(selected?.enabled&&(!consent?.enabled||consent.projectId!==selected.projectId)){
        // Pause only this browser; never overwrite another device's explicit project selection.
        revision(site);await setSite(site,{...selected,enabled:false});await notifyTabs(site,'GB_STOP');
        await chrome.scripting.unregisterContentScripts({ids:[`growth-brain-${site.replace('.','-')}`]}).catch(()=>{});reconciled=true;
      }
    }
    return {...remote,local:await settings(),reconciled};
  }
  if(message.type==='ENABLE'){
    if(!sites.includes(message.site))throw Error('INVALID_SITE');
    const token=revision(message.site);
    if(!sites.includes(message.site)||!await chrome.permissions.contains({origins:[origin(message.site)]}))throw Error('SITE_PERMISSION_REQUIRED');
    return await enqueue(message.site,async()=>{
      if(revisions.get(message.site)!==token)return{enabled:false};
      // Keep local capture paused until the engine has acknowledged consent.
      await setSite(message.site,{enabled:false,projectId:message.projectId});
      await native('configure_capture',{site:message.site,projectId:message.projectId,enabled:true});
      if(revisions.get(message.site)!==token)return{enabled:false};
      await setSite(message.site,{enabled:true,projectId:message.projectId});
      await register(message.site);return {enabled:revisions.get(message.site)===token};
    });
  }
  if(message.type==='STOP'){
    if(!sites.includes(message.site))throw Error('INVALID_SITE');
    try{await stop(message.site);return{enabled:false}}catch{return{enabled:false,vaultUpdatePending:true}}
  }
  if(message.type==='MEMORIES')return await native('list_memories',{projectId:message.projectId,status:message.status??'candidate',offset:message.offset??0,limit:20});
  if(message.type==='REVIEW')return await native('review_memory',{projectId:message.projectId,id:message.id,decision:message.decision,...(message.supersedesId?{supersedesId:message.supersedesId}:{})});
  throw Error('INVALID_REQUEST');
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  dispatch(message,sender).then(result=>respond({ok:true,result})).catch(error=>respond({ok:false,error:error.message}));return true;
});
chrome.permissions.onRemoved.addListener(async permissions=>{for(const site of sites)if(permissions.origins?.includes(origin(site)))await stop(site).catch(()=>{})});
