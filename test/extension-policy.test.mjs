import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
async function harness(native=async()=>({result:{}})){
 const state={};const id='a'.repeat(32);const calls=[];
 globalThis.chrome={
  runtime:{id,getURL:path=>`chrome-extension://${id}/${path}`,onMessage:{addListener(){}},sendNativeMessage:async(_,request)=>{calls.push(request);return native(request)}},
  storage:{local:{get:async key=>({[key]:structuredClone(state[key])}),set:async values=>Object.assign(state,structuredClone(values))}},
  scripting:{unregisterContentScripts:async()=>{},registerContentScripts:async()=>{},executeScript:async()=>{}},
  tabs:{query:async()=>[],sendMessage:async()=>{}},permissions:{contains:async()=>true,onRemoved:{addListener(){}}},
 };
 const {dispatch}=await import(`../extension/background.js?test=${randomUUID()}`);
 const popup={id,url:`chrome-extension://${id}/popup.html`};
 const page={id,url:'https://chatgpt.com/c/test',tab:{url:'https://chatgpt.com/c/test'}};
 return {dispatch,state,calls,popup,page};
}
test('content scripts cannot manage consent/review and page capture cannot forge source or project',async()=>{
 const h=await harness();const project=randomUUID();
 await assert.rejects(h.dispatch({type:'REVIEW'},h.page),/POPUP_REQUIRED/);
 await assert.rejects(h.dispatch({type:'ENABLE',site:'chatgpt.com',projectId:project},h.page),/POPUP_REQUIRED/);
 await h.dispatch({type:'ENABLE',site:'chatgpt.com',projectId:project},h.popup);
 const capture={type:'CAPTURE',url:'https://chatgpt.com/c/test',projectId:randomUUID(),message:{messageId:'1',role:'user',text:'synthetic'}};
 await h.dispatch(capture,h.page);assert.equal(h.calls.at(-1).params.projectId,project);
 await assert.rejects(h.dispatch({...capture,url:'https://claude.ai/chat/other'},h.page),/UNTRUSTED_PAGE/);
 await h.dispatch({type:'STOP',site:'chatgpt.com'},h.popup);
 await assert.rejects(h.dispatch(capture,h.page),/PAUSED/);
});
test('stop wins over an in-flight enable and simultaneous site settings preserve each other',async()=>{
 let release,entered;const started=new Promise(r=>entered=r);
 const h=await harness(async request=>{
  if(request.method==='configure_capture'&&request.params.enabled&&request.params.site==='chatgpt.com'){entered();await new Promise(r=>release=r)}
  return {result:{}};
 });
 const enable=h.dispatch({type:'ENABLE',site:'chatgpt.com',projectId:randomUUID()},h.popup);
 await started;
 const stop=h.dispatch({type:'STOP',site:'chatgpt.com'},h.popup);
 const other=h.dispatch({type:'ENABLE',site:'claude.ai',projectId:randomUUID()},h.popup);
 release();await Promise.all([enable,stop,other]);
 assert.equal(h.state.sites['chatgpt.com'].enabled,false);assert.equal(h.state.sites['claude.ai'].enabled,true);
 const actions=h.calls.filter(c=>c.params.site==='chatgpt.com');assert.equal(actions.at(-1).params.enabled,false);
});
