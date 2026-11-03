import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { classifyCapture } from '../dist/classifier.js';
const corpus=JSON.parse(await readFile(new URL('./fixtures/extraction-quality.json',import.meta.url),'utf8'));
const capture=text=>({id:randomUUID(),projectId:randomUUID(),role:'user',text,contentHash:createHash('sha256').update(text).digest('hex')});
let typedCorrect=0,valueCorrect=0;const misses=[],falsePositives=[];
for(const item of corpus.positive){
  const found=classifyCapture(capture(item.text));
  const keys=found.map(m=>m.key);
  if(JSON.stringify(keys)===JSON.stringify(item.keys))typedCorrect++;else misses.push({text:item.text,keys});
  const expected=item.values??item.text.split(/(?<=[.!?。;])\s+|\r?\n/u).filter(Boolean);
  if(JSON.stringify(found.map(m=>m.value))===JSON.stringify(expected))valueCorrect++;
}
for(const text of corpus.negative)if(classifyCapture(capture(text)).length)falsePositives.push(text);
console.log(JSON.stringify({kind:corpus.description,positive:corpus.positive.length,typedCorrect,valueCorrect,negative:corpus.negative.length,falsePositiveCount:falsePositives.length,misses,falsePositives},null,2));
