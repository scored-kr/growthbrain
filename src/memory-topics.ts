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
