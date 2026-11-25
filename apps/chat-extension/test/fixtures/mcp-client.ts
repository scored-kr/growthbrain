import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { startRelay } from '../../server/relay.ts';
type Service = 'chatgpt' | 'claude';
const secret = () => randomBytes(32).toString('base64url');
const callback = {
  claude: 'https://claude.ai/api/mcp/auth_callback',
  chatgpt: 'https://chatgpt.com/connector/oauth/demo-123',
};

export async function connectTestClient(
  relay: Awaited<ReturnType<typeof startRelay>>,
  service: Service,
  project: string,
) {
  const origin = new URL(relay.url).origin;
  const form = (params: Record<string, string>) =>
    fetch(origin + '/token', { method: 'POST', body: new URLSearchParams(params) });
  const registration = (redirect: string) =>
    fetch(origin + '/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [redirect],
        client_name: 'Synthetic OAuth client',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });

  const registered = await registration(callback[service]);
  assert.equal(registered.status, 201);
  const { client_id } = await registered.json();
  const verifier = secret();
  const state = secret();
  const authorize = new URL('/authorize', origin);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: callback[service],
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    scope: 'memory:read',
    resource: relay.url,
    state,
  }).toString();
  const redirect = await fetch(authorize, { redirect: 'manual' });
  assert.equal(redirect.status, 303);
  const consent = new URL(redirect.headers.get('location')!, origin);
  const cookie = redirect.headers.getSetCookie()[0]!.split(';')[0]!;
  assert.equal((await fetch(consent)).status, 400);
  relay.auth.approve(consent.searchParams.get('request')!, project);
  const resp = await fetch(consent, { redirect: 'manual', headers: { Cookie: cookie } });
  assert.equal(resp.status, 303);
  const callbackUrl = new URL(resp.headers.get('location')!);
  assert.equal(callbackUrl.origin + callbackUrl.pathname, callback[service]);
  assert.equal(callbackUrl.searchParams.get('state'), state);
  const exchange = {
    grant_type: 'authorization_code',
    client_id,
    code: callbackUrl.searchParams.get('code')!,
    redirect_uri: callback[service],
    resource: relay.url,
  };
  assert.equal((await form({ ...exchange, code_verifier: secret() })).status, 400);
  const tokens = await form({ ...exchange, code_verifier: verifier });
  assert.equal(tokens.status, 200);
  const auth = await tokens.json();
  assert.equal((await form({ ...exchange, code_verifier: verifier })).status, 400);
  const client = new Client({ name: 'official-sdk-test', version: '1.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(relay.url), {
      requestInit: { headers: { Authorization: 'Bearer ' + auth.access_token } },
    }),
  );
  return client;
}
