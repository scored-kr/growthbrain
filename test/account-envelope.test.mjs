import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {canonicalAccountEmail,deriveAccountKeys,requireSignupStrength} from '../dist/account-keys.js';
import {createPortableKeys,unwrapPortableKeys,sealPortable,openPortable,localVaultPassword} from '../dist/account-envelope.js';
import {MemoryEngine} from '../dist/engine.js';

const issuer='https://test-auth.example', email='pilot@example.test';
test('same account login on a fresh device opens an encrypted snapshot without the first device or a vault password', async () => {
  const account=randomUUID(), password=randomBytes(32).toString('base64url');
  const a=await deriveAccountKeys(email,password,issuer);
  requireSignupStrength(password);
  const keys=createPortableKeys(account,a.wrappingKey);
  assert.notEqual(keys.vaultId,account);
  const engine=MemoryEngine.empty(keys.vaultId);
  const project=engine.addProject('Synthetic confidential project');
  const original=engine.snapshot();
  original.captureSettings.push({site:'claude.ai',projectId:project.id,enabled:true});
  const payload=sealPortable(keys,account,{sequence:1,parentRevision:null,state:original});
  assert.ok(!JSON.stringify(payload).includes(project.name));
  assert.ok(!JSON.stringify(payload).includes(password));
  const localA=localVaultPassword(keys);
  keys.secret.fill(0);
  a.wrappingKey.fill(0);

  const b=await deriveAccountKeys('  PILOT@example.test ',password,issuer+'/');
  assert.equal(b.authPassword,a.authPassword);
  const restored=unwrapPortableKeys(account,b.wrappingKey,JSON.parse(JSON.stringify(payload)));
  assert.equal(localVaultPassword(restored),localA);
  const data=openPortable(restored,account,payload);
  assert.equal(data.state.projects[0].name,project.name);
  assert.deepEqual(data.state.captureSettings,[]);
  assert.equal(original.captureSettings.length,1);
  assert.equal(data.sequence,1);
  const reset=await deriveAccountKeys(email,randomBytes(24).toString('hex'),issuer);
  assert.throws(()=>unwrapPortableKeys(account,reset.wrappingKey,payload));
  assert.throws(()=>unwrapPortableKeys(randomUUID(),b.wrappingKey,payload));
  assert.throws(()=>unwrapPortableKeys(account,Buffer.from(b.authPassword.slice(4),'base64url'),payload));
  assert.notEqual(localVaultPassword(restored),restored.secret.toString('base64url'));
  const otherIssuer=await deriveAccountKeys(email,password,'https://other.example');
  assert.notEqual(otherIssuer.authPassword,a.authPassword);
  assert.notDeepEqual(otherIssuer.wrappingKey,b.wrappingKey);
  [reset.wrappingKey,otherIssuer.wrappingKey,b.wrappingKey,restored.secret].forEach(k=>k.fill(0));
});

test('sequence, predecessor, wrapped key and vault UUID are authenticated with the encrypted state',()=>{
  const account=randomUUID(), kek=randomBytes(32), keys=createPortableKeys(account,kek);
  const env=sealPortable(keys,account,{sequence:2,parentRevision:randomUUID(),state:MemoryEngine.empty(keys.vaultId).snapshot()});
  for(const patch of [{sequence:1},{parentRevision:null},{vaultId:randomUUID()},{vaultId:account},{wrapped:{...env.wrapped,iv:randomBytes(12).toString('base64')}},{body:{...env.body,tag:randomBytes(16).toString('base64')}},{extra:'unrecognized'}]){
    assert.throws(()=>openPortable(keys,account,{...env,...patch}));
  }
  assert.throws(()=>sealPortable(keys,account,{sequence:1,parentRevision:null,state:MemoryEngine.empty(account).snapshot()}));
  keys.secret.fill(0);kek.fill(0);
});

test('creation rejects weak credentials and the native derivation rejects invalid issuer and ambiguous Unicode input',async()=>{
  assert.throws(()=>requireSignupStrength('abc'));
  assert.throws(()=>requireSignupStrength('12345678901234567890'));
  assert.throws(()=>requireSignupStrength('PasswordPassword123456'));
  assert.throws(()=>canonicalAccountEmail('a@b\n.example'));
  await assert.rejects(()=>deriveAccountKeys(email,'valid passphrase for test','http://outside.example'));
  await assert.rejects(()=>deriveAccountKeys(email,'bad\ud800password',issuer));
});


test('v1 password derivation stays compatible with the independent scrypt/HKDF vector',async()=>{
  const result=await deriveAccountKeys(email,'SYNTHETIC account test vector 01',issuer);
  try {
    const hash=value=>createHash('sha256').update(value).digest('hex');
    assert.equal(hash(result.authPassword),'84a7621d5dd965393923d61669b91a10878ba6eb678c0dfc47ad57dfbcb6d058');
    assert.equal(hash(result.wrappingKey),'484b2c4e68516e34b98563888be6d69f6669debecb5cebda56b71ff5e6927ec9');
  } finally { result.wrappingKey.fill(0); }
});
