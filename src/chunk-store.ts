import {createHash,randomUUID} from 'node:crypto';
import {readdir,unlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {MemoryEngine} from './engine.js';
import {identifier} from './model.js';
import {boxSchema,headerSchema,headerAAD,encryptBox,decryptBox,unlockHeader,type Header} from './envelope.js';
import {privateDirectory,readPrivateJSON,writePrivateJSON,syncDirectory,stagingFiles} from './secure-files.js';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const collections=['projects','memories','captures','captureSettings','agentBindings','agentCaptures','projectTriggers','handoffs'] as const;
const bucketSchema=z.string().regex(/^(projects|memories|captures|captureSettings|agentBindings|agentCaptures|projectTriggers|handoffs)\/[a-f0-9]{2}$/);
const entrySchema=z.object({bucket:bucketSchema,hash:digest,count:z.number().int().min(1).max(10000)}).strict();
const manifestSchema=z.object({revision:z.number().int().positive(),ancestors:z.array(digest).max(128),commitId:identifier,base:z.record(z.string(),z.unknown()),entries:z.array(entrySchema).max(2048)}).strict();
export const chunkHeadSchema=z.object({format:z.literal('growth-brain-chunks'),version:z.literal(1),ownerId:identifier,storeId:identifier,header:headerSchema,manifest:boxSchema}).strict();
const objectSchema=z.object({format:z.literal('growth-brain-object'),version:z.literal(1),ownerId:identifier,storeId:identifier,box:boxSchema}).strict();
const checkpointSchema=z.object({headHash:digest,objects:z.array(digest).max(2048)}).strict();
export const deltaSchema=z.object({format:z.literal('growth-brain-delta'),version:z.literal(1),ownerId:identifier,base:digest.nullable(),head:chunkHeadSchema,objects:z.record(digest,objectSchema)}).strict();
type Head=z.infer<typeof chunkHeadSchema>;type Manifest=z.infer<typeof manifestSchema>;type ChunkObject=z.infer<typeof objectSchema>;
type Cache=Map<string,{plainHash:string;entry:z.infer<typeof entrySchema>}>;
const MAX_STATE=11*1024*1024;
const headAAD=(head:Pick<Head,'ownerId'|'storeId'|'header'>)=>`growth-brain-chunks:1:${head.ownerId}:${head.storeId}:${headerAAD(head.header)}`;
const objectAAD=(head:Pick<Head,'ownerId'|'storeId'>,bucket:string)=>`growth-brain-object:1:${head.ownerId}:${head.storeId}:${bucket}`;
const encryptJSON=(data:unknown,key:Buffer,aad:string)=>{const bytes=Buffer.from(JSON.stringify(data));try{return encryptBox(bytes,key,aad)}finally{bytes.fill(0)}};
const decryptJSON=(data:z.infer<typeof boxSchema>,key:Buffer,aad:string)=>{const bytes=decryptBox(data,key,aad);try{return JSON.parse(bytes.toString('utf8')) as unknown}finally{bytes.fill(0)}};
function manifestOf(head:Head,key:Buffer){if(head.ownerId!==head.header.ownerId)throw Error('OWNER_MISMATCH');const m=manifestSchema.parse(decryptJSON(head.manifest,key,headAAD(head)));if(new Set(m.entries.map(e=>e.bucket)).size!==m.entries.length)throw Error('INVALID_CHUNK_MANIFEST');return m}
async function assemble(head:Head,key:Buffer,read:(id:string)=>Promise<unknown>){
 const manifest=manifestOf(head,key),base={...manifest.base},cache:Cache=new Map();let total=0;
 const records=new Map<string,Map<number,unknown>>(collections.map(c=>[c,new Map()]));
 for(const entry of manifest.entries){
  const object=objectSchema.parse(await read(entry.hash));if(hash(object)!==entry.hash||object.ownerId!==head.ownerId||object.storeId!==head.storeId)throw Error('INVALID_CHUNK_OBJECT');
  total+=Buffer.byteLength(object.box.ciphertext);if(total>MAX_STATE*1.5)throw Error('VAULT_SIZE_LIMIT');
  const raw=decryptJSON(object.box,key,objectAAD(head,entry.bucket));const rows=z.array(z.object({index:z.number().int().min(0).max(10000),row:z.record(z.string(),z.unknown())}).strict()).max(10000).parse(raw);
  if(rows.length!==entry.count)throw Error('INVALID_CHUNK_MANIFEST');const collection=entry.bucket.split('/')[0]!,target=records.get(collection)!;
  for(const row of rows){if(target.has(row.index))throw Error('INVALID_CHUNK_MANIFEST');target.set(row.index,row.row);}
  cache.set(entry.bucket,{plainHash:hash(rows),entry});
 }
 for(const collection of collections){const sorted=[...records.get(collection)!].sort((a,b)=>a[0]-b[0]);if(sorted.some(([i],n)=>i!==n))throw Error('INVALID_CHUNK_MANIFEST');base[collection]=sorted.map(([,row])=>row);}
 if(base.ownerId!==head.ownerId)throw Error('OWNER_MISMATCH');if(Buffer.byteLength(JSON.stringify(base))>MAX_STATE)throw Error('VAULT_SIZE_LIMIT');
 const engine=new MemoryEngine(base);return {engine,rawState:{...base,ownerId:head.ownerId},sourceStateVersion:Number(base.version),manifest,cache};
}
/** Immutable encrypted objects + authenticated encrypted manifest. The vault lock
 * serializes local writers; head hashes detect stale snapshots, not distributed CAS. */
export class ChunkStore {
 private objects:string;private file:string;
 private constructor(private directory:string,private key:Buffer,private head:Head|undefined,private expectedHash:string,private cache:Cache,private revision:number,private storeId:string,private ancestors:string[]=[]){this.objects=join(directory,'objects');this.file=join(directory,'vault.json')}
 static async open(directory:string,input:unknown,ownerId:string,password:string){
  const head=chunkHeadSchema.parse(input);if(head.ownerId!==ownerId)throw Error('OWNER_MISMATCH');const key=await unlockHeader(head.header,ownerId,password);
  try{await privateDirectory(join(directory,'objects'));const loaded=await assemble(head,key,id=>readPrivateJSON(join(directory,'objects',`${id}.json`),16*1024*1024));return {...loaded,key,header:head.header,store:new ChunkStore(directory,key,head,hash(head),loaded.cache,loaded.manifest.revision,head.storeId,loaded.manifest.ancestors)}}catch(e){key.fill(0);throw e}
 }
 static async upgrade(directory:string,engine:MemoryEngine,key:Buffer,header:Header){
  const store=new ChunkStore(directory,key,undefined,hash(await readPrivateJSON(join(directory,'vault.json'))),new Map(),0,randomUUID());await privateDirectory(store.objects);await store.commit(engine,key,header);return store;
 }
 async commit(engine:MemoryEngine,key:Buffer,header:Header){
  if(hash(await readPrivateJSON(this.file))!==this.expectedHash)throw Error('STORAGE_CONFLICT');
  const state=engine.snapshot();if(state.ownerId!==header.ownerId)throw Error('OWNER_MISMATCH');if(Buffer.byteLength(JSON.stringify(state))>MAX_STATE)throw Error('VAULT_SIZE_LIMIT');
  if((await readdir(this.objects)).length>50000)throw Error('STORAGE_PRUNE_REQUIRED');
  const base:Record<string,unknown>={...state},buckets=new Map<string,{index:number;row:unknown}[]>();
  for(const collection of collections){delete base[collection];state[collection].forEach((row,index)=>{const identity='id' in row?row.id:'site' in row?row.site:'projectId' in row?row.projectId:index;const bucket=`${collection}/${hash(identity).slice(0,2)}`;const rows=buckets.get(bucket)??[];rows.push({index,row});buckets.set(bucket,rows)});}
  const nextCache:Cache=new Map(),entries:z.infer<typeof entrySchema>[]=[];
  for(const [bucket,rows] of [...buckets].sort(([a],[b])=>a.localeCompare(b))){
   const plainHash=hash(rows),old=this.cache.get(bucket);let entry:z.infer<typeof entrySchema>;
   if(key===this.key&&old?.plainHash===plainHash)entry=old.entry;
   else{const object:ChunkObject={format:'growth-brain-object',version:1,ownerId:header.ownerId,storeId:this.storeId,box:encryptJSON(rows,key,objectAAD({ownerId:header.ownerId,storeId:this.storeId},bucket))};const id=hash(object);await writePrivateJSON(join(this.objects,`${id}.json`),object,true,16*1024*1024);entry={bucket,hash:id,count:rows.length};}
   entries.push(entry);nextCache.set(bucket,{plainHash,entry});
  }
  await syncDirectory(this.objects);
  const manifest:Manifest={revision:this.revision+1,ancestors:[this.expectedHash,...this.ancestors].slice(0,128),commitId:randomUUID(),base,entries};const metadata={ownerId:header.ownerId,storeId:this.storeId,header};
  const head:Head={format:'growth-brain-chunks',version:1,...metadata,manifest:encryptJSON(manifest,key,headAAD(metadata))};
  if(hash(await readPrivateJSON(this.file))!==this.expectedHash)throw Error('STORAGE_CONFLICT');
  await writePrivateJSON(this.file,head);this.head=head;this.expectedHash=hash(head);this.cache=nextCache;this.revision=manifest.revision;this.ancestors=manifest.ancestors;this.key=key;
 }
 checkpoint(){return {headHash:this.expectedHash,objects:[...this.cache.values()].map(v=>v.entry.hash).sort()}}
 async exportDelta(previous?:unknown){
  if(!this.head)throw Error('CHUNK_STORAGE_REQUIRED');if(hash(await readPrivateJSON(this.file))!==this.expectedHash)throw Error('STORAGE_CONFLICT');
  const checkpoint=previous===undefined?undefined:checkpointSchema.parse(previous),known=new Set(checkpoint?.objects??[]),objects:Record<string,ChunkObject>={};
  if(checkpoint&&checkpoint.headHash!==this.expectedHash&&!this.ancestors.includes(checkpoint.headHash))throw Error('STORAGE_CHECKPOINT_TOO_OLD');
  for(const id of this.checkpoint().objects)if(!known.has(id)){const object=objectSchema.parse(await readPrivateJSON(join(this.objects,`${id}.json`),16*1024*1024));if(hash(object)!==id)throw Error('INVALID_CHUNK_OBJECT');objects[id]=object;}
  return {format:'growth-brain-delta' as const,version:1 as const,ownerId:this.head.ownerId,base:checkpoint?.headHash??null,head:this.head,objects};
 }
 async applyDelta(input:unknown){
  if(!this.head)throw Error('CHUNK_STORAGE_REQUIRED');const delta=deltaSchema.parse(input);
  if(delta.base!==this.expectedHash||hash(await readPrivateJSON(this.file))!==this.expectedHash)throw Error('STORAGE_CONFLICT');
  if(delta.ownerId!==this.head.ownerId||delta.head.ownerId!==delta.ownerId||delta.head.storeId!==this.storeId)throw Error('OWNER_MISMATCH');
  const loaded=await assemble(delta.head,this.key,async id=>delta.objects[id]??await readPrivateJSON(join(this.objects,`${id}.json`),16*1024*1024));
  const unchanged=hash(delta.head)===this.expectedHash;
  if(!unchanged&&(loaded.manifest.revision<=this.revision||!loaded.manifest.ancestors.includes(this.expectedHash)))throw Error('STORAGE_CONFLICT');
  const required=new Set(loaded.manifest.entries.map(e=>e.hash));for(const [id,object] of Object.entries(delta.objects)){if(!required.has(id)||hash(object)!==id)throw Error('INVALID_CHUNK_OBJECT');}
  for(const [id,object] of Object.entries(delta.objects)){const file=join(this.objects,`${id}.json`);try{await writePrivateJSON(file,object,true,16*1024*1024)}catch(e){if(!(e instanceof Error&&'code' in e&&e.code==='EEXIST')||hash(await readPrivateJSON(file))!==id)throw e;}}
  if(hash(await readPrivateJSON(this.file))!==this.expectedHash)throw Error('STORAGE_CONFLICT');await writePrivateJSON(this.file,delta.head);this.head=delta.head;this.expectedHash=hash(delta.head);this.cache=loaded.cache;this.revision=loaded.manifest.revision;this.ancestors=loaded.manifest.ancestors;
  return {engine:loaded.engine,header:delta.head.header};
 }
 static async restore(input:unknown,directory:string,ownerId:string,password:string){
  const delta=deltaSchema.parse(input);if(delta.base!==null||delta.ownerId!==ownerId||delta.head.ownerId!==ownerId)throw Error('FULL_DELTA_REQUIRED');
  const key=await unlockHeader(delta.head.header,ownerId,password);
  try{
   const loaded=await assemble(delta.head,key,async id=>{if(!delta.objects[id])throw Error('MISSING_CHUNK_OBJECT');return delta.objects[id]});
   const required=new Set(loaded.manifest.entries.map(e=>e.hash));if(Object.keys(delta.objects).some(id=>!required.has(id)))throw Error('INVALID_CHUNK_OBJECT');
   await mkdir(directory,{mode:0o700});await privateDirectory(join(directory,'objects'));
   for(const [id,object] of Object.entries(delta.objects))await writePrivateJSON(join(directory,'objects',`${id}.json`),object,true,16*1024*1024);
   await writePrivateJSON(join(directory,'vault.json'),delta.head,true);
   return {...loaded,key,header:delta.head.header,store:new ChunkStore(directory,key,delta.head,hash(delta.head),loaded.cache,loaded.manifest.revision,delta.head.storeId,loaded.manifest.ancestors)};
  }catch(e){key.fill(0);throw e}
 }
 async managedObjects(){
  return await ownedChunkObjects(this.objects,this.head!.ownerId);
 }
 async prune(){if(hash(await readPrivateJSON(this.file))!==this.expectedHash)throw Error('STORAGE_CONFLICT');const required=new Set(this.checkpoint().objects.map(id=>join(this.objects,`${id}.json`))),files=await this.managedObjects();let removed=0;for(const file of files)if(!required.has(file)){await unlink(file);removed++}await syncDirectory(this.objects);return {removed}}
 clear(){this.cache.clear()}
}
export async function ownedChunkObjects(directory:string,ownerId:string){
  await privateDirectory(directory);const stages=await stagingFiles(directory),names=(await readdir(directory)).filter(n=>!/^\.save-[a-f0-9]{24}$/.test(n)),files=[...stages];
  for(const name of names){if(!/^[a-f0-9]{64}\.json$/.test(name))throw Error('INVALID_CHUNK_OBJECT');const file=join(directory,name),value=objectSchema.parse(await readPrivateJSON(file,16*1024*1024));if(hash(value)!==name.slice(0,-5)||value.ownerId!==ownerId)throw Error('INVALID_CHUNK_OBJECT');files.push(file)}return files;
 }
