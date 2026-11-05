import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { callBroker, safeError } from './broker.js';

const id=process.env.GROWTH_BRAIN_EXTENSION_ID;
if(!id || !/^[a-p]{32}$/.test(id) || process.argv[2]!==`chrome-extension://${id}/`)process.exit(1);
const path=process.env.GROWTH_BRAIN_SOCKET??join(homedir(),'.local/share/growth-brain/memory.sock');
const request=z.object({id:z.string().max(100),method:z.enum(['import_chat','create_project','list_projects','configure_capture','capture','list_memories','review_memory','correct_candidate','retire_memory']),params:z.record(z.string(),z.unknown())}).strict();
const MAX=1024*1024;
let buffer=Buffer.alloc(0),queue:Promise<void>=Promise.resolve();
function reply(value:unknown) {
  const payload=Buffer.from(JSON.stringify(value));
  const header=Buffer.alloc(4);header.writeUInt32LE(payload.length);
  process.stdout.write(Buffer.concat([header,payload]));
}
process.stdin.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=4) {
    const length=buffer.readUInt32LE(0);
    if(length>MAX || length===0){reply({id:null,error:'INVALID_FRAME'});process.exit(1);}
    if(buffer.length<length+4)break;
    const message=buffer.subarray(4,length+4).toString('utf8');buffer=buffer.subarray(length+4);
    queue=queue.then(async()=>{
      let parsed:z.infer<typeof request>;
      try{parsed=request.parse(JSON.parse(message));}catch{reply({id:null,error:'INVALID_REQUEST'});return;}
      try{reply({id:parsed.id,result:await callBroker(path,parsed.method,parsed.params)});}
      catch(e){reply({id:parsed.id,error:safeError(e)});}
    });
  }
});
process.stdin.on('end',()=>{void queue.then(()=>{if(buffer.length)reply({id:null,error:'TRUNCATED_FRAME'});});});
process.stdin.on('error',()=>{process.exitCode=1;});
process.stdout.on('error',()=>process.exit(1));
