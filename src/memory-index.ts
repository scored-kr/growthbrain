import type { Memory } from './model.js';

export const normalizeText=(text:string)=>text.normalize('NFKC').toLocaleLowerCase('en-US');
const stopWords=new Set(['the','a','an','is','are','please','what','how','for','of','to','and','지난번','이번','이번에는','어떤','어떻게','알려줘','알려주세요','해줘','해주세요','관련','대한','추천']);
const labels:Record<string,string>={language:'언어 language',tone:'말투 어조 톤 tone',brand:'브랜드 brand',cta:'행동유도 전환 cta',format:'형식 포맷 format',audience:'대상 독자 audience',budget:'예산 budget',deadline:'마감 일정 deadline'};
const words=(text:string)=>normalizeText(text).match(/[\p{L}\p{N}]+/gu)??[];
const stem=(word:string)=>{
  if(/^[a-z]{4,}$/.test(word))return word.replace(/ies$/,'y').replace(/(?<!s)s$/,'');
  // Limited particle normalization, not a Korean morphological/semantic model.
  return word.replace(/^([가-힣]{2,})(으로|에서|에게|까지|부터|처럼|보다|을|를|은|는|의|에)$/u,'$1');
};
const hangul=(word:string)=>/^[가-힣]+$/.test(word);
const grams=(word:string)=>word.length===1?[`c:${word}`]:Array.from({length:word.length-1},(_,i)=>`g:${word.slice(i,i+2)}`);

function documentTerms(memory:Memory) {
  const frequency=new Map<string,number>();
  const add=(term:string,weight:number)=>frequency.set(term,(frequency.get(term)??0)+weight);
  // Provenance may quote an obsolete/rejected value; it is evidence, not a current retrieval field.
  for(const [text,weight] of [[memory.key.replace(/[_.-]/g,' '),2],[labels[memory.key.split(/[_.-]/).at(-1)!]??'',2],[memory.value,1]] as const) {
    for(const word of words(text)) {
      if(stopWords.has(word))continue;
      add(`w:${stem(word)}`,weight);
      if(hangul(word)) {
        for(const gram of grams(word))add(gram,weight);
        for(const char of new Set(word))add(`c:${char}`,weight);
      }
    }
  }
  return frequency;
}

type Group={word:string;exact:string;grams:string[]};
function queryGroups(query:string):Group[] {
  return [...new Set(words(query).filter(w=>!stopWords.has(w)))].map(word=>({word,exact:`w:${stem(word)}`,grams:hangul(word)?[...new Set(grams(stem(word)))]:[]}));
}

class ScopeIndex {
  readonly byKey=new Map<string,Memory>();
  private docs=new Map<string,Memory>();
  private postings=new Map<string,Map<string,number>>();
  private lengths=new Map<string,number>();
  private totalLength=0;
  add(memory:Memory) {
    this.docs.set(memory.id,memory);this.byKey.set(memory.key,memory);
    const terms=documentTerms(memory);let length=0;
    for(const [term,count] of terms) {
      let posting=this.postings.get(term);if(!posting)this.postings.set(term,posting=new Map());
      posting.set(memory.id,count);length+=count;
    }
    this.lengths.set(memory.id,length);this.totalLength+=length;
  }
  private score(term:string,id:string) {
    const posting=this.postings.get(term),tf=posting?.get(id)??0;if(!tf)return 0;
    const n=this.docs.size,df=posting!.size,average=this.totalLength/Math.max(1,n),length=this.lengths.get(id)??0;
    return Math.log(1+(n-df+0.5)/(df+0.5))*(tf*2.2)/(tf+1.2*(0.25+0.75*length/Math.max(1,average)));
  }
  search(groups:Group[],effective:Map<string,Memory>) {
    const candidates=new Set<string>();
    for(const group of groups)for(const term of [group.exact,...group.grams])for(const id of this.postings.get(term)?.keys()??[])candidates.add(id);
    const ranked=[];
    for(const id of candidates) {
      const memory=this.docs.get(id)!;
      if(effective.get(memory.key)?.id!==id)continue;
      let score=0;const matchedTerms:string[]=[];
      for(const group of groups) {
        const exact=this.score(group.exact,id);
        if(exact){score+=exact*2;matchedTerms.push(group.word);continue;}
        const matches=group.grams.map(g=>this.score(g,id)).filter(Boolean);
        // Do not retrieve a Korean word on a lone shared grammatical ending.
        if(group.grams.length&&matches.length/group.grams.length>=0.67){score+=matches.reduce((a,b)=>a+b,0)/group.grams.length;matchedTerms.push(group.word);}
      }
      if(matchedTerms.length)ranked.push({memory,score:score*(matchedTerms.length/groups.length)**2,matchedTerms});
    }
    return ranked;
  }
}

/** Derived immutable indexes. Owned by an unlocked vault; never serialized or sent to a server. */
export class MemoryIndexes {
  private common=new ScopeIndex();
  private projects=new Map<string,ScopeIndex>();
  constructor(memories:Memory[]) {
    for(const original of memories)if(original.status==='active') {
      const memory=structuredClone(original);
      if(memory.scope.type==='global')this.common.add(memory);
      else {
        let index=this.projects.get(memory.scope.projectId);
        if(!index)this.projects.set(memory.scope.projectId,index=new ScopeIndex());
        index.add(memory);
      }
    }
  }
  effective(projectId?:string,requestConditions:Record<string,string>={}) {
    // The common store is always the root; exactly one selected project may overlay it.
    const effective=new Map(this.common.byKey);
    if(projectId)for(const [key,memory] of this.projects.get(projectId)?.byKey??[])effective.set(key,memory);
    for(const key of Object.keys(requestConditions))effective.delete(key);
    return effective;
  }
  search(query:string,projectId:string|undefined,requestConditions:Record<string,string>) {
    const groups=queryGroups(query),effective=this.effective(projectId,requestConditions);
    const common=this.common.search(groups,effective);
    const project=projectId?this.projects.get(projectId)?.search(groups,effective)??[]:[];
    return [...common,...project].sort((a,b)=>b.score-a.score||a.memory.key.localeCompare(b.memory.key));
  }
}

export function matchesTrigger(query:string,keyword:string) {
  query=normalizeText(query);keyword=normalizeText(keyword);
  if(/^[a-z0-9 ]+$/.test(keyword)) {
    const escaped=keyword.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`,'u').test(query);
  }
  return query.includes(keyword);
}
