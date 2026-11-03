(() => {
  if(globalThis.GrowthBrainAdapters)return;
  const adapters={
    'chatgpt.com':document=>[...document.querySelectorAll('[data-message-author-role][data-message-id]')].map(el=>({
      messageId:el.getAttribute('data-message-id'),role:el.getAttribute('data-message-author-role'),text:el.querySelector('.markdown')?.innerText??el.innerText,
    })),
    'claude.ai':document=>[...document.querySelectorAll('[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-response')].flatMap(el=>{
      const holder=el.closest('[data-message-id], [data-testid^="conversation-turn-"]');
      const messageId=el.getAttribute('data-message-id')??holder?.getAttribute('data-message-id')??holder?.getAttribute('data-testid');
      // Without a stable ID fail closed; never scrape the entire page as a fallback.
      return messageId?[{messageId,role:el.getAttribute('data-testid')==='user-message'?'user':'assistant',text:el.innerText}]:[];
    }),
  };
  globalThis.GrowthBrainAdapters={collect(document,host){return(adapters[host]?.(document)??[]).filter(m=>m.messageId&&['user','assistant'].includes(m.role)&&m.text?.trim()).map(m=>({...m,text:m.text.trim()}));}};
})();
