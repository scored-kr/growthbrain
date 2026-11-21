import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DesktopAccount, accountOrigin } from '../dist/desktop-account.js';

const key = 'sb_publishable_' + 'x'.repeat(32);
const email = 'person@example.test';
const password = 'Synthetic-Here-Only-MeF3!';

function fixture(factorType) {
  const id = randomUUID();
  let user = { id, aud: 'authenticated', email, role: 'authenticated', email_confirmed_at: new Date().toISOString() };
  const factorId = randomUUID();
  const challengeId = randomUUID();
  if (factorType) user.factors = [{ id:factorId, status:'verified', factor_type:factorType }];
  let holdRefresh;
  let authPassword;
  let refresh;
  let leaked = false;
  const requests = [];
  const session = (aal='aal1') => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    const b64 = object => Buffer.from(JSON.stringify(object)).toString('base64url');
    refresh = randomUUID();
    return { user, access_token: [b64({typ:'JWT',alg:'HS256'}), b64({sub:id,exp,role:'authenticated',aal}), b64('synthetic')].join('.'),
      refresh_token: refresh, expires_in: 900, expires_at: exp, token_type: 'bearer' };
  };
  const fetcher = async (url, init) => {
    assert.equal(url.origin, accountOrigin);
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('apikey'), key);
    const body = init.body ? JSON.parse(init.body) : {};
    leaked ||= (init.body || '').includes(password);
    const action = url.pathname.replace('/auth/v1/', '');
    requests.push(action);
    const response = data => Response.json(data);
    const deny = () => Response.json({msg:'INVALID_CREDENTIALS'}, {status:400});
    switch (action) {
      case 'signup': authPassword = body.password; return response({ user });
      case 'token':
        if (url.searchParams.get('grant_type') === 'password' ? body.password !== authPassword : body.refresh_token !== refresh) return deny();
        if (url.searchParams.get('grant_type') === 'refresh_token' && holdRefresh) {
          holdRefresh.started.resolve();
          await holdRefresh.response.promise;
        }
        return response(session());
      case 'factors/'+factorId+'/challenge':
        return response({id:challengeId,type:'totp',expires_at:Math.floor(Date.now()/1000)+60});
      case 'factors/'+factorId+'/verify':
        return body.challenge_id === challengeId && body.code === '352164' ? response(session('aal2')) : deny();
      case 'verify': return body.token === '123456' ? response(session()) : deny();
      case 'user':
        if (init.method === 'PUT') authPassword = body.password;
        return response(user);
      case 'logout': return response({});
      case 'recover': return response({});
      default: assert.fail('Unexpected mock auth request');
    }
  };
  return { id, fetcher, requests, holdRefresh:()=>(holdRefresh={started:Promise.withResolvers(),response:Promise.withResolvers()}), leaked: () => leaked, proof: () => authPassword, changeUser: () => { user = { ...user, id: randomUUID() }; } };
}

test('same app login on a fresh device yields the same wrapping key; service sees only derived proof', async () => {
  const auth = fixture(), first = new DesktopAccount(key, auth.fetcher);
  await first.signup(email, password);
  assert.notEqual(auth.proof(), password);
  assert.equal(first.identity(), null);
  await first.confirmSignup(email, '123456');
  const opened = await first.login(email, password);
  assert.equal(opened.userId, auth.id);
  assert.deepEqual(Object.keys(first.identity()).sort(), ['email','expiresAt','userId']);
  const second = new DesktopAccount(key, auth.fetcher);
  const remoteOpened = await second.login(email.toUpperCase(), password);
  assert.deepEqual(remoteOpened.wrappingKey, opened.wrappingKey);
  assert.notEqual(opened.wrappingKey.toString('base64url'), auth.proof());
  const refresh = await second.exportRefreshToken();
  second.clear();
  await second.restore(refresh, auth.id);
  assert.equal(second.identity().userId, auth.id);
  assert.ok(auth.requests.includes('user'));
  auth.changeUser();
  await assert.rejects(second.requireVerifiedUser(), /IDENTITY_MISMATCH/);
  assert.equal(second.identity(), null);
  assert.equal(auth.leaked(), false);
  await first.logout();
  assert.equal(first.identity(), null);
  opened.wrappingKey.fill(0); remoteOpened.wrappingKey.fill(0);
});

test('recovery must verify an email code and derives a different wrapping key', async () => {
  const auth = fixture(), app = new DesktopAccount(key, auth.fetcher);
  await app.signup(email, password);
  const old = await app.login(email, password);
  await app.requestReset(email);
  const newPassword = 'Another-Synthetic-Account-Only-X1!';
  const priorProof = auth.proof();
  await assert.rejects(app.reset(email,'000000',newPassword), /CODE_INVALID/);
  assert.equal(auth.proof(), priorProof);
  await app.reset(email,'123456',newPassword);
  assert.notEqual(auth.proof(), priorProof);
  assert.notEqual(auth.proof(), newPassword);
  assert.equal(app.identity(), null);
  await assert.rejects(app.login(email, password), /ACCOUNT_AUTH_FAILED/);
  const updated = await app.login(email, newPassword);
  assert.notDeepEqual(updated.wrappingKey, old.wrappingKey);
  old.wrappingKey.fill(0); updated.wrappingKey.fill(0);
});

test('unconfigured and privileged key formats fail closed without an auth request', async () => {
  for (const key of ['', 'sb_secret_' + 'x'.repeat(48), 'legacy.jwt.example']) {
    const app = new DesktopAccount(key, () => assert.fail());
    assert.equal(app.configured, false);
    assert.equal(app.contractVerified, false);
    await assert.rejects(app.login(email, password), /ACCOUNT_UNCONFIGURED/);
  }
});

test('verified TOTP requires the provider challenge and AAL2; trusted refresh cannot supply a downgraded session', async () => {
  const f = fixture('totp'), app = new DesktopAccount(key,f.fetcher);
  await app.signup(email,password);
  await assert.rejects(app.login(email,password),/ACCOUNT_MFA_REQUIRED/);
  await assert.rejects(app.login(email,password,'000000'),/ACCOUNT_MFA_INVALID/);
  assert.equal(app.identity(),null);
  const success = await app.login(email,password,'352164');
  success.wrappingKey.fill(0);
  const token = await app.exportRefreshToken();
  app.clear();
  // The fixture issues a downgraded AAL1 mimic on the refresh path.
  await assert.rejects(app.restore(token,f.id),/ACCOUNT_MFA_REQUIRED/);
  assert.equal(app.identity(),null);
  const phone = fixture('phone'), other = new DesktopAccount(key,phone.fetcher);
  await other.signup(email,password);
  await assert.rejects(other.login(email,password,'352164'),/ACCOUNT_MFA_UNSUPPORTED/);
});

test('simultaneous refreshes keep unexpired access, use the rotated token once, and cannot undo lock', async () => {
  const f = fixture(), app = new DesktopAccount(key,f.fetcher);
  await app.signup(email,password);
  (await app.login(email,password)).wrappingKey.fill(0);
  const hold = f.holdRefresh();
  const a=app.refresh(), b=app.refresh(), c=app.requireVerifiedUser();
  await hold.started.promise;
  assert.equal(app.identity().userId,f.id);
  assert.equal(f.requests.filter(path=>path==='token').length,2);
  hold.response.resolve();
  for (const identity of await Promise.all([a,b,c])) assert.equal(identity.userId,f.id);
  const holdAgain = f.holdRefresh();
  const refreshing = app.refresh();
  await holdAgain.started.promise;
  app.clear();
  holdAgain.response.resolve();
  await assert.rejects(refreshing,/ACCOUNT_SESSION_CHANGED/);
  assert.equal(app.identity(),null);
});
