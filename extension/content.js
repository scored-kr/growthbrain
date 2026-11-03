(() => {
  if(globalThis.__growthBrainCapture)return;
  globalThis.__growthBrainCapture=true;
  let timer,stopped=false,suspended=false,inFlight=false,dirty=false,generation=0,retryDelay=1000;
  const delivered=new Map(),transient=new Set(['VAULT_LOCKED','LOCAL_VAULT_UNAVAILABLE']);
  const pageUrl=()=>{const url=new URL(location.href);url.search='';url.hash='';return url.href};
  function schedule(delay=1000){
    if(stopped||suspended)return;
    clearTimeout(timer);timer=setTimeout(()=>{timer=undefined;void collect()},delay);
  }
  async function collect(){
    if(stopped||suspended)return;
    if(inFlight){dirty=true;return;}
    inFlight=true;dirty=false;
    const token=generation,url=pageUrl();let retry=false;
    const current=()=>!stopped&&!suspended&&generation===token&&pageUrl()===url;
    try{
      // Bind this batch to its original conversation, even if navigation happens during IPC.
      const messages=globalThis.GrowthBrainAdapters.collect(document,location.hostname);
      for(const message of messages){
        if(!current()){dirty=true;break;}
        if(message.text.length>12000||message.messageId.length>160)continue;
        const key=`${url}|${message.messageId}|${message.role}`;
        if(delivered.get(key)===message.text)continue;
        const response=await chrome.runtime.sendMessage({type:'CAPTURE',url,message});
        if(!current()){dirty=true;break;}
        if(response?.ok){
          delivered.set(key,message.text);retryDelay=1000;
          if(delivered.size>1000)delivered.delete(delivered.keys().next().value);
        }else{
          if(['PAUSED','CAPTURE_NOT_CONSENTED'].includes(response?.error)){stopped=true;delivered.clear();clearTimeout(timer);}
          else retry=transient.has(response?.error);
          break; // Capacity/schema failures wait for a user action or a new DOM event.
        }
      }
    }catch{retry=true}
    finally{
      inFlight=false;
      if(!stopped&&!suspended){
        if(dirty)schedule();
        else if(retry){schedule(retryDelay);retryDelay=Math.min(retryDelay*2,30000);}
      }
    }
  }
  const changed=()=>{dirty=true;schedule()};
  const observer=new MutationObserver(changed);
  observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  chrome.runtime.onMessage.addListener(message=>{
    if(message.type==='GB_STOP'){generation++;stopped=true;dirty=false;clearTimeout(timer);delivered.clear();}
    if(message.type==='GB_START'){generation++;stopped=false;dirty=true;retryDelay=1000;delivered.clear();schedule();}
  });
  window.addEventListener('popstate',changed);
  window.addEventListener('pagehide',()=>{generation++;suspended=true;observer.disconnect();clearTimeout(timer);delivered.clear();});
  window.addEventListener('pageshow',event=>{if(event.persisted){generation++;suspended=false;observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});changed();}});
  schedule();
})();
