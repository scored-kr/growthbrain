import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DesktopAccount,projectRef,accountOrigin } from '../dist/desktop-account.js';
import { verifyIsolation } from '../scripts/verify-sync-isolation.mjs';
import { accountServer } from './support/synthetic-supabase.mjs';

test('operator isolation runner requires both known accounts and a bounded quota; produces evidence after actual database RPCs', async t => {
  const base = await mkdtemp(join(tmpdir(),'gb-disposable-'));
  t.after(() => rm(base,{recursive:true,force:true}));
  const service = await accountServer();
  t.after(() => service.close());
  const key = 'sb_publishable_'+'a'.repeat(32);
  const fetcher = (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin,accountOrigin);
    return fetch(service.origin+url.pathname+url.search,options);
  };
  const password = 'Disposable!'+randomUUID();
  const credentials = [];
  for (const email of ['a@example.test','b@example.test']) {
    const client = new DesktopAccount(key,fetcher);
    await client.signup(email,password);
    await client.confirmSignup(email,service.emailCode);
    const user = await client.login(email,password);
    user.wrappingKey.fill(0);
    credentials.push({email,password,id:user.userId});
    await client.logout();
  }
  const catalogPath = join(base,'catalog.json');
  const sql = await readFile(new URL('../scripts/proposed/account-sync-v1.sql', import.meta.url));
  const pin = (await readFile(new URL('../scripts/proposed/account-sync-catalog.sha256',import.meta.url),'utf8')).trim();
  await writeFile(catalogPath,JSON.stringify({projectRef,contract:'growthbrain.sync.v1',kind:'growthbrain-sync-catalog',
    catalogVerified:true,readOnlyVerified:true,applicationRowsRead:false,contractSha256:createHash('sha256').update(sql).digest('hex'),catalogSha256:pin}));
  const options = {credentials,publicKey:key,catalogPath,fetcher};
  await assert.rejects(verifyIsolation({...options,destination:join(base,'refused')}),/BOUNDED_TEST_QUOTA_REQUIRED/);
  await assert.rejects(access(join(base,'refused','isolation-review.json')));
  assert.deepEqual(await service.inspect(), []);
  await service.setFixtureQuota(credentials[1].id, 4096);
  const destination = join(base,'passed');
  await verifyIsolation({...options,destination});
  const review = JSON.parse(await readFile(join(destination,'isolation-review.json')));
  const evidence = await readFile(join(destination,'run-evidence.json'),'utf8');
  assert.ok(Object.values(review.checks).every(value=>value===true));
  assert.equal(Object.keys(review.checks).length,8);
  assert.equal(createHash('sha256').update(evidence).digest('hex'),review.runEvidenceSha256);
  for (const secret of [password, credentials[0].id, credentials[0].email]) assert.ok(!evidence.includes(secret));
  const records = await service.inspect();
  assert.equal(records.length,1);
  assert.equal(records[0].payload,null);
});
