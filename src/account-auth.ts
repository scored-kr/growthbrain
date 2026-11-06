/** Account identity is separate from vault access. Providers own credentials and
 * tokens; neither this state nor any MCP/broker interface contains them. */
export interface AccountIdentity {userId:string;email:string;emailVerified:true;expiresAt:number}
export interface AccountProvider {
 signUp(email:string,password:string):Promise<void>;
 verifyEmail(code:string):Promise<void>;
 signIn(email:string,password:string):Promise<AccountIdentity>;
 refresh():Promise<AccountIdentity>;
 signOut():Promise<void>;
 requestPasswordReset(email:string):Promise<void>;
 confirmPasswordReset(code:string,newPassword:string):Promise<void>;
}
export type AccountStatus='unconfigured'|'signed_out'|'verification_pending'|'authenticated'|'reset_requested';
export interface AccountState {status:AccountStatus;busy:boolean;identity:AccountIdentity|null;error:'invalid_input'|'verification_required'|'auth_failed'|'request_failed'|'expired'|null}
const emailValid=(value:string)=>value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const passwordValid=(value:string)=>value.length>=12&&value.length<=1024;
const codeValid=(value:string)=>value.length>=6&&value.length<=2048&&!/\s/.test(value);
export class AccountAuth {
 private state:AccountState;
 private queue:Promise<void>=Promise.resolve();private revision=0;
 private listeners=new Set<(state:AccountState)=>void>();
 constructor(private provider?:AccountProvider,private now=()=>Date.now()){this.state={status:provider?'signed_out':'unconfigured',busy:false,identity:null,error:null}}
 snapshot(){if(this.state.identity&&this.state.identity.expiresAt<=this.now())this.state={status:'signed_out',identity:null,busy:this.state.busy,error:'expired'};return structuredClone(this.state)}
 subscribe(listener:(state:AccountState)=>void){this.listeners.add(listener);listener(this.snapshot());return ()=>{this.listeners.delete(listener)}}
 private publish(next:AccountState){this.state=next;for(const listener of this.listeners)listener(this.snapshot())}
 private identity(value:AccountIdentity):AccountIdentity {
  if(!value||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.userId)||!emailValid(value.email)||value.emailVerified!==true||!Number.isFinite(value.expiresAt)||value.expiresAt<=this.now())throw Error('INVALID_IDENTITY');
  return {userId:value.userId,email:value.email,emailVerified:true,expiresAt:value.expiresAt};
 }
 private run(valid:boolean,action:(provider:AccountProvider)=>Promise<{status:AccountStatus;identity?:AccountIdentity}>,clear=false){
  if(!this.provider)return Promise.resolve();
  if(!valid){this.publish({...this.snapshot(),error:'invalid_input'});return Promise.resolve()}
  const provider=this.provider,revision=++this.revision;this.publish({status:clear?'signed_out':this.snapshot().status,busy:true,identity:clear?null:this.snapshot().identity,error:null});
  const run=this.queue.then(async()=>{
   try{const result=await action(provider);if(revision===this.revision)this.publish({status:result.status,busy:false,identity:result.identity??null,error:null})}
   catch(error){if(revision===this.revision){const unverified=typeof error==='object'&&error!==null&&'code' in error&&error.code==='EMAIL_NOT_VERIFIED';this.publish({status:unverified?'verification_pending':'signed_out',busy:false,identity:null,error:unverified?'verification_required':'request_failed'})}}
  });this.queue=run;return run;
 }
 signUp(email:string,password:string){return this.run(emailValid(email)&&passwordValid(password),async p=>{await p.signUp(email.trim(),password);return {status:'verification_pending'}},true)}
 verifyEmail(code:string){return this.run(codeValid(code),async p=>{await p.verifyEmail(code);return {status:'signed_out'}},true)}
 signIn(email:string,password:string){return this.run(emailValid(email)&&passwordValid(password),async p=>({status:'authenticated',identity:this.identity(await p.signIn(email.trim(),password))}),true)}
 refresh(){return this.run(this.snapshot().status==='authenticated',async p=>({status:'authenticated',identity:this.identity(await p.refresh())}))}
 signOut(){return this.run(true,async p=>{await p.signOut();return {status:'signed_out'}},true)}
 requestPasswordReset(email:string){return this.run(emailValid(email),async p=>{await p.requestPasswordReset(email.trim());return {status:'reset_requested'}},true)}
 confirmPasswordReset(code:string,password:string){return this.run(codeValid(code)&&passwordValid(password),async p=>{await p.confirmPasswordReset(code,password);await p.signOut();return {status:'signed_out'}},true)}
}
