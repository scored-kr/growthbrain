import {z} from 'zod';
import {portableEnvelopeSchema, type PortableEnvelope} from './account-envelope.js';
import {accountOrigin} from './desktop-account.js';

export interface RemoteHead {
  revision: string | null;
  bytes: number;
  quota: number;
}
export interface RemoteSnapshot {
  revision: string;
  payload: PortableEnvelope;
}
export interface RemoteVault {
  head(): Promise<RemoteHead>;
  pull(): Promise<RemoteSnapshot | null>;
  push(expectedRevision: string | null, payload: PortableEnvelope): Promise<RemoteHead>;
  purge(expectedRevision: string | null): Promise<RemoteHead>;
}

const revision = z.string().uuid().nullable();
const header = z.object({
  contract: z.literal('growthbrain.sync.v1'), revision,
  bytes: z.number().int().min(0).max(52428800),
  quota: z.number().int().min(0).max(52428800),
}).strict();
const snapshot = header.extend({payload: portableEnvelopeSchema.nullable()}).strict();

interface RemoteOptions {
  publishableKey: string;
  getAccessToken(): Promise<string>;
  contractVerified: boolean;
  fetch?: typeof fetch;
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw Error('SYNC_PROTOCOL');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw Error('SYNC_PROTOCOL');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    await reader.cancel().catch(() => {});
    throw Error('SYNC_PROTOCOL');
  } finally { reader.releaseLock(); }
}

function checkedHead(head: RemoteHead): RemoteHead {
  if (!head.revision && head.bytes !== 0) throw Error('SYNC_PROTOCOL');
  return {revision: head.revision, bytes: head.bytes, quota: head.quota};
}

/** Restricted to the reviewed project and the account represented by its access
 * token. No owner ID or URL comes from a UI request. The release config supplies
 * the operator verification flag after deployed isolation/CAS tests. */
export class SupabaseRemoteVault implements RemoteVault {
  constructor(private readonly options: RemoteOptions) {}

  private async verifiedToken() {
    if (this.options.contractVerified !== true || !/^sb_publishable_[A-Za-z0-9_-]{18,180}$/.test(this.options.publishableKey)) {
      throw Error('SYNC_UNCONFIGURED');
    }
    const token = await this.options.getAccessToken();
    if (!token || token.length > 16384 || /\s/.test(token)) throw Error('SYNC_AUTH_REQUIRED');
    return token;
  }

  private async call(method: 'status'|'read'|'write'|'purge', args: Record<string, unknown>, verifiedToken?: string) {
    const token = verifiedToken ?? await this.verifiedToken();
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(accountOrigin + '/rest/v1/rpc/growthbrain_sync_v1_' + method, {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        signal: AbortSignal.timeout(20000),
        headers: {apikey:this.options.publishableKey, authorization:'Bearer '+token, 'content-type':'application/json', accept:'application/json'},
        body: JSON.stringify(args),
      });
    } catch { throw Error('SYNC_UNAVAILABLE'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 409) throw Error('SYNC_CONFLICT');
      if (response.status === 413) throw Error('SYNC_QUOTA');
      if (response.status === 401 || response.status === 403) throw Error('SYNC_AUTH_REQUIRED');
      if (response.status === 404) throw Error('SYNC_UNCONFIGURED');
      throw Error('SYNC_UNAVAILABLE');
    }
    return boundedJson(response, method === 'read' ? 17 * 1024 * 1024 : 4096);
  }

  async head(): Promise<RemoteHead> {
    return this.probe();
  }

  private async probe(token?: string): Promise<RemoteHead> {
    const result = header.safeParse(await this.call('status', {}, token));
    if (!result.success) throw Error('SYNC_PROTOCOL');
    return checkedHead(result.data);
  }

  async pull(): Promise<RemoteSnapshot | null> {
    const result = snapshot.safeParse(await this.call('read', {}));
    if (!result.success) throw Error('SYNC_PROTOCOL');
    const data = result.data;
    checkedHead(data);
    if (!data.payload && data.bytes === 0) return null;
    if (!data.payload || !data.revision || data.bytes === 0) throw Error('SYNC_PROTOCOL');
    return {revision:data.revision, payload:data.payload};
  }

  private async change(method:'write'|'purge', prev:string|null, args:Record<string,unknown>) {
    if (!revision.safeParse(prev).success) throw Error('SYNC_INVALID_REVISION');
    // Verify the advertised contract on this credential before sending an
    // envelope. SQL repeats CAS under its transaction lock after this probe.
    const token = await this.verifiedToken();
    const head = await this.probe(token);
    if (head.revision !== prev) throw Error('SYNC_CONFLICT');
    const result = header.safeParse(await this.call(method, {expected_revision:prev, ...args}, token));
    if (!result.success || !result.data.revision || result.data.revision === prev ||
        (result.data.bytes === 0) !== (method === 'purge')) throw Error('SYNC_PROTOCOL');
    return checkedHead(result.data);
  }

  async push(prev:string|null, payload:PortableEnvelope) {
    const parsed = portableEnvelopeSchema.safeParse(payload);
    if (!parsed.success || parsed.data.parentRevision !== prev) throw Error('SYNC_INVALID_ENVELOPE');
    return this.change('write', prev, {payload:parsed.data});
  }

  async purge(prev:string|null) {
    return this.change('purge', prev, {});
  }
}
