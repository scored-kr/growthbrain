// A loopback-only relay for one disposable product device. The upstream services
// authenticate and store the requests. Only network availability and reply delivery are controlled here.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

export async function deviceNetwork(emailDomain) {
  const endpoint = process.env.GB_TEST_SUPABASE_ORIGIN;
  const container = process.env.GB_TEST_SUPABASE_DATABASE_CONTAINER ?? '';
  if (!/^gb-sb-[a-f0-9]+-db$/.test(container) || !/^[0-9a-f]{8}\.example\.test$/.test(emailDomain))
    throw Error('Run with test/local-supabase/run.py and an isolated test email domain');
  const upstream = new URL(endpoint);
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.origin !== endpoint)
    throw Error('Expected the disposable loopback gateway');

  const accountCalls = [];
  const committedWrites = [];
  let online = true;
  let nextCut = null;
  let lastCut = null;
  function disconnect(phase, response) {
    nextCut = null;
    lastCut = phase;
    online = false;
    response.destroy();
  }
  const relay = createServer(async (req, res) => {
    try {
      if (!online) { res.writeHead(503).end(); return; }
      const target = new URL(req.url, upstream);
      if (target.origin !== upstream.origin || !/^\/(auth\/v1\/|rest\/v1\/rpc\/growthbrain_sync_v1_)/.test(target.pathname))
        throw Error('Unexpected backend path');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) throw Error('Large fixture request');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (target.pathname.startsWith('/auth/v1/') && body.length) {
        const { password } = JSON.parse(body);
        if (typeof password === 'string') accountCalls.push({passwordDigest: createHash('sha256').update(password).digest('hex')});
      }
      const write = req.method === 'POST' && target.pathname === '/rest/v1/rpc/growthbrain_sync_v1_write';
      if (write && nextCut === 'before') { disconnect('before', res); return; }
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      if (req.headers.apikey) headers.apikey = req.headers.apikey;
      const reply = await fetch(target, {method:req.method, headers, body:body.length ? body : undefined,
        redirect:'error', signal:AbortSignal.timeout(10000)});
      const bytes = Buffer.from(await reply.arrayBuffer());
      if (write && reply.ok) {
        const receipt = JSON.parse(bytes);
        committedWrites.push({revision:receipt.revision, bytes:receipt.bytes});
        if (nextCut === 'after') { disconnect('after', res); return; }
      }
      res.writeHead(reply.status, {'Content-Type':reply.headers.get('Content-Type') ?? 'application/json'}).end(bytes);
    } catch { res.writeHead(502).end(); }
  });
  await new Promise((resolve,reject) => { relay.once('error', reject); relay.listen(0,'127.0.0.1',resolve); });
  return {
    origin: 'http://127.0.0.1:' + relay.address().port,
    accountCalls, committedWrites,
    setOnline(value) { online = value; },
    cutNextWrite(phase) { nextCut = phase; lastCut = null; },
    get lastCut() { return lastCut; },
    inspect() {
      // Inspect only the rows created by this scenario. Container name and domain were validated above.
      const sql = `begin read only;
        select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
        from growthbrain_sync_v1_private.snapshots s join auth.users u on u.id=s.owner_id
        where split_part(u.email,'@',2)='${emailDomain}';
        commit;`;
      const result = spawnSync('docker',['exec','-i',container,'psql','-qAt','-X','-v','ON_ERROR_STOP=1',
        '-U','supabase_admin','-d','postgres'],{input:sql,encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});
      if (result.status !== 0) throw Error('Could not inspect the disposable database');
      return JSON.parse(result.stdout);
    },
    close() { return new Promise(resolve => { relay.close(resolve); relay.closeAllConnections(); }); },
  };
}
