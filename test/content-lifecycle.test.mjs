import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source=await readFile(new URL('../extension/content.js',import.meta.url),'utf8');
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
function fixture(){
 const timers=new Map(),events=new Map(),calls=[];let sequence=0,receiver,observer;
 const state={messages:[{messageId:'u1',role:'user',text:'original'}],reply:async()=>({ok:true})};
 const location={href:'https://chatgpt.com/c/first?private=omitted#part',hostname:'chatgpt.com'};
 const context={URL,Map,Set,location,document:{documentElement:{}},
  setTimeout:(fn,delay)=>{const id=++sequence;timers.set(id,{fn,delay});return id},clearTimeout:id=>timers.delete(id),
  MutationObserver:class{constructor(fn){observer=fn}observe(){}disconnect(){}},
  GrowthBrainAdapters:{collect:()=>structuredClone(state.messages)},
  chrome:{runtime:{onMessage:{addListener:fn=>receiver=fn},sendMessage:async message=>{calls.push(structuredClone(message));return await state.reply(message)}}},
  window:{addEventListener:(name,fn)=>events.set(name,fn)},
 };
 vm.runInNewContext(source,context);
 return {state,calls,timers,location,message:type=>receiver({type}),mutate:()=>observer(),event:(name,data={})=>events.get(name)?.(data),
  async next(){assert.ok(timers.size,'A retry/collection timer must exist');const [id,{fn,delay}]=timers.entries().next().value;timers.delete(id);fn();await turn();return delay}};
}

test('navigation during IPC never attaches old batch messages to a new conversation',async()=>{
 const f=fixture(),pending=deferred();f.state.messages.push({messageId:'u2',role:'user',text:'old second message'});
 f.state.reply=()=>pending.promise;await f.next();assert.equal(f.calls.length,1);
 f.location.href='https://chatgpt.com/c/second';f.state.messages=[{messageId:'new',role:'user',text:'new conversation'}];
 f.mutate();await f.next(); // Timer expires while the first message is in flight.
 f.state.reply=async()=>({ok:true});pending.resolve({ok:true});await turn();await f.next();
 assert.equal(f.calls.length,2);
 assert.equal(f.calls[0].url,'https://chatgpt.com/c/first');
 assert.equal(f.calls[1].url,'https://chatgpt.com/c/second');
 assert.equal(f.calls[1].message.text,'new conversation');
});

test('a final DOM update while IPC is pending is recollected, then deduplicated',async()=>{
 const f=fixture(),pending=deferred();f.state.reply=()=>pending.promise;await f.next();
 f.state.messages[0].text='final edited value';f.mutate();await f.next();
 f.state.reply=async()=>({ok:true});pending.resolve({ok:true});await turn();await f.next();
 assert.deepEqual(f.calls.map(c=>c.message.text),['original','final edited value']);
 f.mutate();await f.next();assert.equal(f.calls.length,2);
});

test('stop/start invalidates an old acknowledgment and stop never schedules retries',async()=>{
 const f=fixture(),pending=deferred();f.state.reply=()=>pending.promise;await f.next();
 f.message('GB_STOP');f.message('GB_START');await f.next();
 f.state.reply=async()=>({ok:true});pending.resolve({ok:true});await turn();await f.next();
 assert.equal(f.calls.length,2,'New consent generation must retry even if old capture succeeded');
 f.message('GB_STOP');f.mutate();assert.equal(f.timers.size,0);
 const g=fixture(),blocked=deferred();g.state.reply=()=>blocked.promise;await g.next();g.message('GB_STOP');
 blocked.resolve({ok:false,error:'VAULT_LOCKED'});await turn();assert.equal(g.timers.size,0);
});

test('locked vault retries with bounded backoff and resumes without DOM changes',async()=>{
 const f=fixture();f.state.reply=async()=>({ok:false,error:'VAULT_LOCKED'});
 const delays=[];for(let i=0;i<9;i++)delays.push(await f.next());
 assert.ok(Math.max(...delays)<=30000);assert.equal(delays.at(-1),30000);
 f.state.reply=async()=>({ok:true});await f.next();assert.equal(f.timers.size,0);
 const count=f.calls.length;f.mutate();await f.next();assert.equal(f.calls.length,count);
 const g=fixture();g.state.reply=async()=>({ok:false,error:'CAPTURE_LIMIT'});await g.next();assert.equal(g.timers.size,0);
 const h=fixture();h.state.reply=async()=>({ok:false,error:'CAPTURE_NOT_CONSENTED'});await h.next();h.mutate();assert.equal(h.timers.size,0);
});

test('pagehide suspends pending work and BFCache restoration recollects only after pageshow',async()=>{
 const f=fixture(),pending=deferred();f.state.reply=()=>pending.promise;await f.next();f.event('pagehide');
 pending.resolve({ok:true});await turn();assert.equal(f.timers.size,0);
 f.state.reply=async()=>({ok:true});f.event('pageshow',{persisted:true});await f.next();assert.equal(f.calls.length,2);
});
