/** Explicit compatibility vocabulary, not general semantic equivalence. Keep the
 * stored key and provenance intact; aliases only affect lookup and review. */
const groups: readonly (readonly string[])[] = [
  ['language','response_language','output_language'],
  ['tone','response_tone','output_tone'],
  ['format','response_format','output_format'],
  ['code_style','coding_convention'],
];
const aliases=new Map(groups.flatMap(group=>group.map(key=>[key,group] as const)));
export const canonicalKey=(key:string)=>aliases.get(key)?.[0]??key;
export const equivalentKeys=(a:string,b:string)=>canonicalKey(a)===canonicalKey(b);
export const keySearchTerms=(key:string)=>(aliases.get(key)??[key]).join(' ').replace(/[_.-]/g,' ');

export function canonicalRequestConditions(input:Record<string,string>):Record<string,string> {
  if(Object.keys(input).length>50)throw new Error('REQUEST_CONDITION_LIMIT');
  const result:Record<string,string>=Object.create(null);
  for(const [raw,value] of Object.entries(input)){
    const key=canonicalKey(raw);
    if(Object.hasOwn(result,key)&&result[key]!==value)throw new Error('AMBIGUOUS_REQUEST_CONDITIONS');
    result[key]=value;
  }
  return result;
}
