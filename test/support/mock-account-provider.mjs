// Test-only in-memory service. Never shipped as an account backend or email sender.
import {randomBytes,randomUUID,timingSafeEqual,scrypt as callbackScrypt} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(callbackScrypt);
const failure=code=>Object.assign(Error('Synthetic authentication failure'),{code});
export class MockAccountProvider {
 constructor(now=()=>Date.now()){this.now=now;this.accounts=new Map();this.codes=new Map();this.mailbox=[];this.session=null}
 async password(password,salt){return await scrypt(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024})}
 issue(email,purpose){const code=randomBytes(32).toString('base64url');this.codes.set(code,{email,purpose,expires:this.now()+600000});this.mailbox.push({email,purpose,code})}
 consume(code,purpose){const item=this.codes.get(code);if(!item||item.purpose!==purpose||item.expires<=this.now())throw failure('INVALID_CODE');this.codes.delete(code);return this.accounts.get(item.email)}
 async signUp(email,password){email=email.toLowerCase();if(!this.accounts.has(email)){const salt=randomBytes(16);this.accounts.set(email,{id:randomUUID(),email,salt,hash:await this.password(password,salt),verified:false});this.issue(email,'verify')}}
 async verifyEmail(code){this.consume(code,'verify').verified=true}
 async signIn(email,password){this.session=null;const account=this.accounts.get(email.toLowerCase());if(!account||!timingSafeEqual(account.hash,await this.password(password,account.salt)))throw failure('INVALID_LOGIN');if(!account.verified)throw failure('EMAIL_NOT_VERIFIED');this.session={account,refreshUntil:this.now()+86400000};return this.identity(account)}
 identity(a){return {userId:a.id,email:a.email,emailVerified:true,expiresAt:this.now()+900000}}
 async refresh(){if(!this.session||this.session.refreshUntil<=this.now())throw failure('INVALID_SESSION');return this.identity(this.session.account)}
 async signOut(){this.session=null}
 async requestPasswordReset(email){email=email.toLowerCase();if(this.accounts.has(email))this.issue(email,'reset')}
 async confirmPasswordReset(code,password){const account=this.consume(code,'reset'),salt=randomBytes(16);account.hash=await this.password(password,salt);account.salt=salt;this.session=null}
 takeCode(purpose){const i=this.mailbox.findIndex(m=>m.purpose===purpose);if(i<0)throw Error('Synthetic mailbox has no expected message');return this.mailbox.splice(i,1)[0].code}
}
