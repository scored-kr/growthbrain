import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { probeRoute } from '../dist/desktop-route.js';

test('public probe requires trusted HTTPS, this device certificate, and matching resource metadata', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-route-probe-'));
  t.after(() => rm(dir, {recursive:true, force:true}));
  const keyPath = join(dir, 'key.pem'), certPath = join(dir, 'cert.pem');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1',
    '-keyout',keyPath,'-out',certPath,'-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'], {stdio:'ignore'});
  const cert = await readFile(certPath), key = await readFile(keyPath);
  const fingerprint = new X509Certificate(cert).fingerprint256;
  let resource = '';
  const server = new Server({cert,key}, (req,res) => {
    assert.equal(req.url,'/.well-known/oauth-protected-resource/mcp');
    assert.equal(req.headers.authorization,undefined);
    res.end(JSON.stringify({resource}));
  });
  key.fill(0);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = new URL('https://127.0.0.1:' + server.address().port);
  resource = new URL('/mcp',origin).href;
  const signal = new AbortController().signal;
  assert.equal(await probeRoute(origin,fingerprint,signal),false);
  const originalRoots=getCACertificates('default');
  setDefaultCACertificates([cert.toString()]);
  t.after(()=>setDefaultCACertificates(originalRoots));
  assert.equal(await probeRoute(origin,fingerprint,signal),true);
  assert.equal(await probeRoute(origin,'unrelated leaf',signal),false);
  resource = 'https://other.example/mcp';
  assert.equal(await probeRoute(origin,fingerprint,signal),false);
});
