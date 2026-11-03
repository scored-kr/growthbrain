(() => {
  if(globalThis.__growthBrainCapture)return;
  globalThis.__growthBrainCapture=true;
  let timer,stopped=false,inFlight=false;const delivered=new Map();
  async function collect(){
    if(stopped||inFlight)return;inFlight=true;
    try{
      const messages=globalThis.GrowthBrainAdapters.collect(document,location.hostname);
      for(const message of messages){
        if(message.text.length>12000||message.messageId.length>160)continue;
        const key=`${location.pathname}|${message.messageId}|${message.role}`;
        if(delivered.get(key)===message.text)continue;
        const response=await chrome.runtime.sendMessage({type:'CAPTURE',url:location.href,message});
        if(response?.ok){delivered.set(key,message.text);if(delivered.size>1000)delivered.delete(delivered.keys().next().value);}
        else if(response?.error==='PAUSED'){stopped=true;break;}
        else break; // Locked/missing native host: no plaintext disk queue.
      }
    }catch{}finally{inFlight=false;}
  }
  const schedule=()=>{clearTimeout(timer);timer=setTimeout(collect,1000)};
  const observer=new MutationObserver(schedule);observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});
  chrome.runtime.onMessage.addListener(message=>{
    if(message.type==='GB_STOP'){stopped=true;clearTimeout(timer);delivered.clear();}
    if(message.type==='GB_START'){stopped=false;delivered.clear();schedule();}
  });
  window.addEventListener('pagehide',()=>{observer.disconnect();clearTimeout(timer);delivered.clear();});
  window.addEventListener('pageshow',event=>{if(event.persisted){observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true});schedule();}});
  schedule();
})();
