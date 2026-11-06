import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {AccountAuth} from '../dist/account-auth.js';
import {MockAccountProvider} from './support/mock-account-provider.mjs';
import {fixture,proposal,approve} from './helpers.mjs';
const password=()=>randomBytes(24).toString('base64url');
test('account lifecycle verifies email, hides credentials, expires sessions and resets accounts without changing the vault',async()=>{
 let now=Date.now();const provider=new MockAccountProvider(()=>now),auth=new AccountAuth(provider,()=>now),pass=password(),nextPass=password(),email='synthetic@example.test';const {engine,project}=fixture();approve(engine,proposal({type:'global'},'language','unchanged private preference'));const vaultBefore=engine.snapshot();
 await auth.signUp(email,pass);assert.equal(auth.snapshot().status,'verification_pending');assert.equal(provider.accounts.get(email).hash.equals(Buffer.from(pass)),false);
 await auth.signIn(email,pass);assert.equal(auth.snapshot().error,'verification_required');const verify=provider.takeCode('verify');await auth.verifyEmail(verify);assert.equal(auth.snapshot().status,'signed_out');await auth.verifyEmail(verify);assert.equal(auth.snapshot().error,'request_failed');
 await auth.signIn(email,pass);assert.equal(auth.snapshot().status,'authenticated');assert.equal(auth.snapshot().identity.emailVerified,true);await auth.refresh();assert.equal(auth.snapshot().status,'authenticated');
 const snapshot=JSON.stringify(auth.snapshot());for(const secret of [pass,nextPass,verify,'refreshToken','accessToken'])assert.ok(!snapshot.includes(secret));now+=900001;assert.equal(auth.snapshot().status,'signed_out');assert.equal(auth.snapshot().error,'expired');
 await auth.requestPasswordReset('unknown@example.test');const unknown=auth.snapshot();await auth.requestPasswordReset(email);assert.deepEqual(auth.snapshot(),unknown);const reset=provider.takeCode('reset');await auth.confirmPasswordReset(reset,nextPass);assert.equal(auth.snapshot().status,'signed_out');assert.equal(provider.session,null);await auth.signIn(email,pass);assert.equal(auth.snapshot().status,'signed_out');await auth.signIn(email,nextPass);assert.equal(auth.snapshot().status,'authenticated');await auth.signOut();assert.equal(auth.snapshot().identity,null);
 await auth.confirmPasswordReset(reset,pass);assert.equal(auth.snapshot().error,'request_failed');assert.deepEqual(engine.snapshot(),vaultBefore);assert.equal(engine.getContext({projectId:project.id}).conditions[0].value,'unchanged private preference');
});
test('unconfigured services cannot issue synthetic sessions; expired/wrong-purpose codes and unsafe identities fail closed',async()=>{
 const unconfigured=new AccountAuth();await unconfigured.signIn('synthetic@example.test',password());assert.equal(unconfigured.snapshot().status,'unconfigured');
 let now=Date.now();const provider=new MockAccountProvider(()=>now),auth=new AccountAuth(provider,()=>now),email='synthetic@example.test';await auth.signUp(email,password());const code=provider.takeCode('verify');await auth.confirmPasswordReset(code,password());assert.equal(auth.snapshot().error,'request_failed');now+=600001;await auth.verifyEmail(code);assert.equal(auth.snapshot().error,'request_failed');
 const bad=new AccountAuth({...provider,signIn:async()=>({userId:'bad',email,emailVerified:false,expiresAt:now+1000})});await bad.signIn(email,password());assert.equal(bad.snapshot().status,'signed_out');assert.equal(bad.snapshot().identity,null);
});
test('late sign-in results cannot revive a session after sign-out, and provider errors never expose tokens',async()=>{
 let release,started;const began=new Promise(r=>started=r),provider=new MockAccountProvider(),email='synthetic@example.test',pass=password();await provider.signUp(email,pass);await provider.verifyEmail(provider.takeCode('verify'));
 const original=provider.signIn.bind(provider);provider.signIn=async(...args)=>{started();await new Promise(r=>release=r);return original(...args)};const auth=new AccountAuth(provider),login=auth.signIn(email,pass);await began;const logout=auth.signOut();assert.equal(auth.snapshot().identity,null);release();await Promise.all([login,logout]);assert.equal(auth.snapshot().status,'signed_out');assert.equal(provider.session,null);
 provider.signIn=async()=>{throw Error('PRIVATE_PROVIDER_TOKEN')};await auth.signIn(email,pass);assert.ok(!JSON.stringify(auth.snapshot()).includes('PRIVATE_PROVIDER_TOKEN'));
});
