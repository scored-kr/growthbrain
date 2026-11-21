// A separate OS process per device. Only the network route and the provider hostname
// are redirected to the disposable loopback fixtures. Device operations use the product controller.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopController } from '../../dist/desktop-controller.js';
import { DesktopAccount } from '../../dist/desktop-account.js';
import { SupabaseRemoteVault } from '../../dist/sync-remote.js';
import { startDesktopWebMcp } from '../../dist/web-mcp.js';

const [profile, backend, tls] = process.argv.slice(2);
const pinnedOrigin = 'https://kcvjsvbwinlhzgmnfsji.supabase.co';
const key = 'sb_publishable_' + 'fixture'.repeat(6);
async function fixtureFetch(input, options) {
  const outgoing = new Request(input, options);
  const url = new URL(outgoing.url);
  if (url.origin !== pinnedOrigin || !/^\/(?:auth\/v1|rest\/v1\/rpc)\//.test(url.pathname)) {
    throw Error('Unexpected provider destination');
  }
  const local = new URL(backend);
  if (local.origin !== backend || local.hostname !== '127.0.0.1') throw Error('Loopback fixture required');
  const init = {method:outgoing.method, headers:outgoing.headers, redirect:'error'};
  if (outgoing.body) init.body = await outgoing.arrayBuffer();
  return fetch(new URL(url.pathname + url.search, local), init);
}
const auth = new DesktopAccount(key, fixtureFetch, true);
const remote = new SupabaseRemoteVault({
  publishableKey:key, contractVerified:true, fetch:fixtureFetch,
  getAccessToken:() => auth.accessToken(),
});
async function openRoute(vault) {
  const origin = new URL('https://localhost');
  const cert = await readFile(join(tls, 'cert.pem'));
  const key = await readFile(join(tls, 'key.pem'));
  const web = await startDesktopWebMcp(vault, origin, {cert,key});
  key.fill(0);
  process.send({port:web.port});
  return web;
}
const controller = new DesktopController(profile, undefined, {auth,remote,openAccountRoute:openRoute});
process.on('message', async msg => {
  if (msg.end) {
    await controller.close();
    process.disconnect();
    return;
  }
  const response = await controller.handle(msg);
  process.send({response});
});
