import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { portableState } from './account-envelope.js';
import { conflictingApplicability, sameApplicability } from './memory-applicability.js';
import { canonicalKey } from './memory-keys.js';
import type { Memory, State } from './model.js';

export type PortableConflict = {id:string; key:string; projectId:string|null; localValue:string; remoteValue:string};
export type ConflictChoices = Readonly<Record<string,'local'|'remote'>>;
type DecisionPair = { review:PortableConflict; local:Memory; remote:Memory };

function conflict():never { throw Error('SYNC_CONFLICT'); }

/** Preserve order within each device's additions (corrections reference earlier records).
 * A UUID tie-break gives both devices the same order where neither observed the other. */
function orderedAdditions(local:string[],remote:string[]):string[] {
  const successors = new Map<string,Set<string>>();
  const incoming = new Map<string,number>();
  for (const branch of [local,remote]) {
    let previous:string|undefined;
    for (const id of branch) {
      if (!incoming.has(id)) incoming.set(id,0);
      if (previous !== undefined) {
        const next = successors.get(previous) ?? new Set<string>();
        if (!next.has(id)) {
          next.add(id);
          successors.set(previous,next);
          incoming.set(id,incoming.get(id)!+1);
        }
      }
      previous = id;
    }
  }
  const ready = new Set([...incoming].filter(([,count])=>count===0).map(([id])=>id));
  const result:string[] = [];
  // At most two nodes are ready at once: the head of each device's sequence.
  while (ready.size) {
    const id = [...ready].sort()[0]!;
    ready.delete(id);
    result.push(id);
    for (const next of successors.get(id) ?? []) {
      const count = incoming.get(next)!-1;
      incoming.set(next,count);
      if (count===0) ready.add(next);
    }
  }
  if (result.length!==incoming.size) conflict();
  return result;
}

function mergeRows<T>(base:T[],local:T[],remote:T[],id:(row:T)=>string,options:{
  allowRemoval?:boolean; reconcile?:(base:T|undefined,left:T,right:T)=>T;
}={}):T[] {
  const index = (rows:T[])=>new Map(rows.map(row=>[id(row),row]));
  const original = index(base), left = index(local), right = index(remote);
  const additions = (rows:T[])=>rows.map(id).filter(key=>!original.has(key));
  const keys = [...original.keys(), ...orderedAdditions(additions(local),additions(remote))];
  const merged:T[] = [];
  for (const key of keys) {
    const before = original.get(key), a = left.get(key), b = right.get(key);
    if (before!==undefined && (a===undefined || b===undefined) && !options.allowRemoval) conflict();
    let row:T|undefined;
    if (isDeepStrictEqual(a,b) || isDeepStrictEqual(before,b)) row=a;
    else if (isDeepStrictEqual(before,a)) row=b;
    else if (options.reconcile && a!==undefined && b!==undefined) row=options.reconcile(before,a,b);
    else conflict();
    if (row!==undefined) merged.push(row);
  }
  return merged;
}

function reconcileAncestor(before:Memory|undefined,a:Memory,b:Memory):Memory {
  if (before?.status==='active' && a.status==='superseded' && b.status==='superseded') {
    const retired = {...before,status:'superseded' as const};
    if (isDeepStrictEqual({...a,reviewedAt:before.reviewedAt}, retired) &&
        isDeepStrictEqual({...b,reviewedAt:before.reviewedAt}, retired)) return retired;
  }
  return conflict();
}

function decisionPairs(vaultId:string,memories:Memory[],left:Memory[],right:Memory[]):DecisionPair[] {
  const activeIds = (rows:Memory[])=>new Set(rows.filter(m=>m.status==='active').map(m=>m.id));
  const leftIds=activeIds(left), rightIds=activeIds(right);
  const groups=new Map<string,Memory[]>(), paired=new Set<string>(), pairs:DecisionPair[]=[];
  for (const memory of memories) {
    if (memory.status!=='active') continue;
    const key=canonicalKey(memory.key), projectId=memory.scope.type==='project'?memory.scope.projectId:null;
    const group=JSON.stringify([projectId,key]), seen=groups.get(group)??[];
    for (const other of seen) {
      if (!conflictingApplicability(memory,other)) continue;
      // A legacy snapshot can already contain ambiguous aliases. Keep its original
      // records and lookup rules; only a collision newly introduced by the union is ours.
      if ((leftIds.has(memory.id) && leftIds.has(other.id)) ||
          (rightIds.has(memory.id) && rightIds.has(other.id))) continue;
      if (!sameApplicability(memory,other) || paired.has(memory.id) || paired.has(other.id)) conflict();
      const [local,remote]=leftIds.has(memory.id)?[memory,other]:[other,memory];
      if (!leftIds.has(local.id) || !rightIds.has(remote.id)) conflict();
      const id=createHash('sha256').update(JSON.stringify(['account-decision-v1',vaultId,local,remote])).digest('hex');
      pairs.push({local,remote,review:{id,key,projectId,localValue:local.value,remoteValue:remote.value}});
      paired.add(local.id);
      paired.add(remote.id);
    }
    seen.push(memory);
    groups.set(group,seen);
  }
  return pairs;
}

function planMerge(base:State,local:State,remote:State) {
  if (base.ownerId!==local.ownerId || base.ownerId!==remote.ownerId) conflict();
  const original=portableState(base), left=portableState(local), right=portableState(remote);
  const byId=(row:{id:string})=>row.id;
  const state:State={...original,
    projects:mergeRows(original.projects,left.projects,right.projects,byId),
    memories:mergeRows(original.memories,left.memories,right.memories,byId,{reconcile:reconcileAncestor}),
    handoffs:mergeRows(original.handoffs,left.handoffs,right.handoffs,byId),
    projectTriggers:mergeRows(original.projectTriggers,left.projectTriggers,right.projectTriggers,
      row=>row.projectId,{allowRemoval:true}),
  };
  return {state,pairs:decisionPairs(state.ownerId,state.memories,left.memories,right.memories)};
}

function applyChoices(plan:ReturnType<typeof planMerge>, choices:ConflictChoices, resolvedAt:string) {
  const {state,pairs}=plan;
  if (Object.keys(choices).length!==pairs.length) conflict();
  const retirements=new Map<string,string>();
  for (const {local,remote,review} of pairs) {
    if (!Object.hasOwn(choices,review.id)) conflict();
    const choice=choices[review.id];
    if (choice==='local') retirements.set(remote.id,local.id);
    else if (choice==='remote') retirements.set(local.id,remote.id);
    else conflict();
  }
  const memories=state.memories.map(memory=>{
    const winner=retirements.get(memory.id);
    if (!winner) return memory;
    return {...memory,status:'retired' as const,retiredAt:resolvedAt,
      retirementReason:`동기화 충돌 검토에서 기억 ${winner}을 선택했습니다.`};
  });
  // Validate the complete graph and size limits again after composing both branches.
  return portableState({...state,memories});
}

export function mergePortableState(base:State,local:State,remote:State,choices:ConflictChoices={},
    resolvedAt=new Date().toISOString()):State {
  try { return applyChoices(planMerge(base,local,remote),choices,resolvedAt); }
  catch { return conflict(); }
}

export function describePortableConflicts(base:State,local:State,remote:State):PortableConflict[] {
  try {
    const plan=planMerge(base,local,remote);
    // Offer decisions only if their resolution can produce a complete, valid graph.
    const choices:Record<string,'local'>={};
    for (const pair of plan.pairs) choices[pair.review.id]='local';
    applyChoices(plan,choices,'1970-01-01T00:00:00.000Z');
    return plan.pairs.map(pair=>pair.review);
  } catch { return []; }
}
