import { randomUUID } from 'node:crypto';
import { MemoryEngine } from '../dist/engine.js';
export function fixture() {
  const engine=MemoryEngine.empty(randomUUID());
  const project=engine.addProject('Synthetic content campaign');
  const other=engine.addProject('Synthetic separate client');
  return {engine,project,other};
}
export function proposal(scope,key,value,extra={}) {
  return {scope,kind:scope.type==='global'?'preference':'constraint',key,value,source:{kind:'user',reference:'synthetic:feedback:1',excerpt:value},reason:'Synthetic explicit feedback',...extra};
}
export function approve(engine,input) { const c=engine.propose(input);engine.review(c.id,'approve');return c.id; }
