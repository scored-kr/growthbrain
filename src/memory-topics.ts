/** Bounded topic vocabulary shared by local extraction and retrieval. Not learned semantics. */
export const memoryTopics={
  language:['언어','답변 언어','작성 언어','language'],
  tone:['말투','어조','톤','tone'],
  format:['출력 형식','답변 형식','형식','포맷','format'],
  audience:['대상 독자','타깃 고객','대상','독자','타깃','audience','target audience'],
  budget:['예산','비용 한도','budget','spending limit'],
  deadline:['마감일','마감','일정','기한','deadline','due date'],
  brand:['브랜드명','브랜드','brand','brand name'],
  cta:['행동 유도 문구','행동유도','전환 문구','cta','call to action'],
} as const;
export type MemoryTopic=keyof typeof memoryTopics;
export const normalized=(text:string)=>text.normalize('NFKC').toLocaleLowerCase('en-US');
export const topicEntries=Object.entries(memoryTopics) as [MemoryTopic,readonly string[]][];

export function topicForLabel(label:string):MemoryTopic|undefined {
  const text=normalized(label).trim();
  return topicEntries.find(([,labels])=>labels.some(label=>label===text))?.[0];
}

export function topicForKey(key:string):MemoryTopic|undefined {
  const last=key.split(/[_.-]/).at(-1)!;
  return Object.hasOwn(memoryTopics,last)?last as MemoryTopic:undefined;
}

const phrases:Record<MemoryTopic,RegExp[]>={
  language:[/(?:답변|응답|작성)\s*언어/u,/\b(?:reply|response|answer|writing)\s+language\b/u],
  tone:[/(?:글|문장|답변).{0,16}(?:느낌|분위기)/u,/\bwriting voice\b/u,/\bhow\b.{0,32}\b(?:sound|worded)\b/u,/\bformal\s+or\s+casual\b/u],
  format:[/(?:답변|결과|출력).{0,16}(?:형태|구조|모양)/u,/\b(?:answer|output|response)\s+(?:structure|layout)\b/u,/\bbullets?\b.{0,16}\btable\b/u],
  audience:[/누구.{0,16}(?:위한|읽|쓰|작성|대상)/u,/\bwho\b.{0,32}\b(?:for|read)\b/u,/\b(?:reader profile|intended readers?)\b/u],
  budget:[/(?:돈|비용|지출|금액).{0,16}(?:얼마|한도|상한|제한)/u,/얼마.{0,16}(?:쓸|써|쓰|지출|사용)/u,/\bhow much\b.{0,24}\b(?:spend|cost|allocate)\b/u,/\b(?:spend|spending|cost)\s+(?:cap|ceiling|limit)\b/u],
  deadline:[/언제까지/u,/(?:^|\s)(?:납기|제출일)(?:[은는이가을를]?)(?=$|\s|[?？])/u,/\bwhen\b.{0,24}\b(?:due|finish|deliver|submit)\b/u,/\bby when\b/u],
  brand:[/(?:제품|서비스|회사)\s*(?:이름|명칭)/u,/\b(?:product|company|service)\s+(?:name|called)\b/u],
  cta:[/(?:행동|전환).{0,16}(?:유도|문구)/u,/(?:독자|고객|방문자).{0,16}(?:행동|해야|누르)/u,/\b(?:reader|visitor|customer)\b.{0,24}\b(?:do next|take action)\b/u],
};
const topicQueries=topicEntries.map(([key,labels])=>({key,patterns:[...phrases[key],...labels.map(label=>{
  const escaped=label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/ /g,'[\\s-]+');
  const suffix=/[가-힣]/u.test(label)?'(?:으로|에서|에게|까지|부터|처럼|보다|을|를|은|는|이|가|의|에|도|만|로)?':'';
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}${suffix}(?=$|[^\\p{L}\\p{N}])`,'u');
})]}));

/** Narrow, explainable topic cues; never infer a project or a stored value from a query. */
export function queryTopics(query:string):Set<MemoryTopic> {
  const text=normalized(query);
  return new Set(topicQueries.filter(({patterns})=>patterns.some(pattern=>pattern.test(text))).map(({key})=>key));
}
