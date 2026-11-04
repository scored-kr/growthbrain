import type { Capture, Proposal } from './model.js';
import { createHash } from 'node:crypto';
import { topicEntries, topicForLabel, type MemoryTopic } from './memory-topics.js';

// These contexts need a person, not a confident-looking inferred preference. Raw captures remain intact.
const uncertain=/만약|가능하면|아직.{0,12}(?:결정|확정)|(?:취소|철회|정정)(?:해|할|합|하|했)|(?:^|\s)아니[,.!\s]|\b(?:if|unless|maybe|hypothetically|not decided)\b/i;
const transient=/이번(?:에)?만|이번\s*(?:답변|응답|작업|메시지|에는)|지금만|한\s*번만|\b(?:this time|for (?:this|the next) (?:response|answer|task)|just once|only for now)\b/i;
const reported=/예시|예를\s*들|인용|가정|(?:라고|달라고)\s*(?:했|말)|라는\s*(?:문구|문장)|\b(?:example|quote|said|used to|translate|summari[sz]e)\b/i;
const separateException=/(?:^|[\r\n]|[.!?。;]\s+)\s*(?:단|다만|하지만|예외|except|however|but)(?:\s|[,.:：])/i;
const questioning=/[?？]|^(?:왜|어떤|얼마|언제|어떻게|what\b|why\b|when\b|how\b)|(?:할까|될까|좋을까|어떨까|인가요|일까요|인거야|지\s*알려|지\s*설명)|\b(?:can|could|would|should)\s+(?:you|we|i)\b/i;
const directive=/(?:해\s*줘|해\s*주세요|하지\s*마|하지\s*말|지\s*마|금지|제외해|유지해|정해|바꿔|선호해|진행하자|확정하자)|\b(?:please|prefer|keep|use|set|avoid|don't|do not)\b/i;
const reusable=/앞으로|항상|선호|유지|금지|하지\s*(?:마|말)|제외|대신|\b(?:don't|do not|prefer|always|instead|keep)\b/i;
const feedbackKey=(text:string)=>`feedback.${createHash('sha256').update(text).digest('hex').slice(0,16)}`;

function explicitTopic(text:string):MemoryTopic|undefined {
  const colon=text.match(/^([^:：]{1,32})[:：]\s*(\S[\s\S]*)$/u);
  if(colon)return topicForLabel(colon[1]!);
  if(!directive.test(text))return undefined;
  for(const [key,labels] of topicEntries)for(const label of labels) {
    // Require a topic subject; mere mentions in an unrelated request do not assign a canonical key.
    if(new RegExp(`^(?:앞으로\\s*)?${label}(?:은|는|을|를|:|\\s)`,'i').test(text))return key;
    if(/^[a-z]/.test(label)&&new RegExp(`^(?:please\\s+)?(?:keep|set|use|prefer|avoid|do not use|don't use)\\s+(?:the\\s+|an?\\s+)?(?:[a-z-]+\\s+){0,2}${label}\\b`,'i').test(text))return key;
  }
  return undefined;
}

/** Conservative local rules. No external model call and never a confirmed fact. */
export function classifyCapture(capture: Pick<Capture,'id'|'projectId'|'role'|'text'|'contentHash'>, referencePrefix='capture'): Proposal[] {
  if(capture.role!=='user')return [];
  const text=capture.text;
  if(uncertain.test(text)||transient.test(text)||reported.test(text)||separateException.test(text))return [];
  const plain=text.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,'');
  // A code/quote block can qualify surrounding prose. Do not save a detached partial rule.
  if(plain!==text)return [];
  const clauses=plain.split(/(?<=[.!?。;])\s+|\r?\n/u).filter(s=>s.trim());
  if(clauses.length>32)return [];
  const proposals:Proposal[]=[],seen=new Set<string>();let hasUntypedClause=false;
  for(const clause of clauses) {
    if(/^\s*(?:>|['"“‘`])|^ {4}/u.test(clause))return [];
    const excerpt=clause.trim(),statement=excerpt.replace(/^(?:[-*•]|\d+[.)])\s+/u,'');
    // Never truncate away a trailing negation or exception just to fit a memory field.
    if(excerpt.length>4000||questioning.test(statement))return [];
    let key:string|undefined=explicitTopic(statement),value=statement;
    const korean=statement.match(/^(?:앞으로\s*)?(한국어|영어)로\s*(?:답변|작성)(?:해\s*줘|해\s*주세요)[.!\s]*$/u);
    const english=statement.match(/^(?:from now on,?\s*)?(?:please\s*)?(?:answer|respond|write)\s+in\s+(Korean|English)[.!\s]*$/i);
    const language=korean?.[1]??english?.[1];
    if(language){key='language';value=/한국어|korean/i.test(language)?'한국어':'English';}
    if(!key) {
      hasUntypedClause=true;
      if(!directive.test(statement)||!reusable.test(statement))continue;
      key=feedbackKey(statement);
    }
    const identity=JSON.stringify([key,value]);if(seen.has(identity))continue;seen.add(identity);
    proposals.push({scope:{type:'project',projectId:capture.projectId},kind:['language','tone','format'].includes(key)?'preference':key.startsWith('feedback.')?'feedback':'constraint',key,value,
      source:{kind:'capture',reference:`${referencePrefix}:${capture.id}`,excerpt},
      reason:'Locally extracted explicit user statement. Full capture retained; scope, interpretation and any replacement require human review.'});
  }
  if(clauses.length>1&&hasUntypedClause&&proposals.length) {
    if(text.length>4000)return [];
    // No semantic model can prove which clause an untyped continuation qualifies here.
    // Keep one complete pending statement instead of promoting a partial typed condition.
    return [{scope:{type:'project',projectId:capture.projectId},kind:'feedback',key:feedbackKey(text),value:text,
      source:{kind:'capture',reference:`${referencePrefix}:${capture.id}`,excerpt:text},
      reason:'Multiple clauses include an unclassified continuation. Preserved together for human review; no typed condition or replacement inferred.'}];
  }
  // Bound review noise without silently dropping later conflicting clauses.
  return proposals.length<=8?proposals:[];
}
