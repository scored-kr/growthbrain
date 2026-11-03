import type { Capture, Proposal } from './model.js';

/** Conservative local rules. No external model call and never a confirmed fact. */
export function classifyCapture(capture: Pick<Capture,'id'|'projectId'|'role'|'text'|'contentHash'>, referencePrefix='capture'): Proposal[] {
  if(capture.role!=='user')return [];
  const text=capture.text;
  if(!/(해줘|해주세요|하지 마|하지 말|금지|대신|변경|바꿔|선호|제외|유지|please|prefer|don't|do not|instead)/i.test(text))return [];
  let key=`feedback.${capture.contentHash.slice(0,16)}`;
  let value=text.slice(0,4000);
  if(/^(?:앞으로\s*)?한국어로\s*(?:답변|작성)(?:해줘|해주세요)[.!\s]*$/.test(text)){key='language';value='한국어';}
  else if(/^(?:앞으로\s*)?영어로\s*(?:답변|작성)(?:해줘|해주세요)[.!\s]*$/.test(text)){key='language';value='English';}
  return [{scope:{type:'project',projectId:capture.projectId},kind:key==='language'?'preference':'feedback',key,value,
    source:{kind:'capture',reference:`${referencePrefix}:${capture.id}`,excerpt:text.slice(0,4000)},
    reason:'Captured explicit user feedback. Scope and interpretation require local human review.'}];
}
