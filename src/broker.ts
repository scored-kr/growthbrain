import { createServer, createConnection, type Server } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentCaptureInputSchema, agentClientSchema, workspaceSchema, captureInputSchema, consentSchema, contextSchema, identifier, proposalSchema, searchSchema } from './model.js';
import { privateDirectory, type VaultSession } from './vault.js';

const requestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('get_context'), params: contextSchema }).strict(),
  z.object({ method: z.literal('search_memory'), params: searchSchema }).strict(),
  z.object({ method: z.literal('propose_memory'), params: proposalSchema }).strict(),
  // Local native-messaging/UI operations; these are never registered as MCP tools.
  z.object({method:z.literal('get_agent_binding'),params:z.object({client:agentClientSchema,workspace:workspaceSchema}).strict()}).strict(),
  z.object({method:z.literal('capture_agent'),params:agentCaptureInputSchema}).strict(),
  z.object({method:z.literal('list_projects'),params:z.object({}).strict()}).strict(),
  z.object({method:z.literal('configure_capture'),params:consentSchema}).strict(),
  z.object({method:z.literal('capture'),params:captureInputSchema}).strict(),
  z.object({method:z.literal('list_memories'),params:z.object({projectId:identifier,status:z.enum(['candidate','active','all']).default('candidate'),offset:z.number().int().min(0).max(10000).default(0),limit:z.number().int().min(1).max(50).default(20)}).strict()}).strict(),
  z.object({method:z.literal('review_memory'),params:z.object({projectId:identifier,id:identifier,decision:z.enum(['approve','reject']),supersedesId:identifier.optional()}).strict()}).strict(),
  z.object({method:z.literal('correct_candidate'),params:z.object({projectId:identifier,id:identifier,value:proposalSchema.shape.value,reason:proposalSchema.shape.reason}).strict()}).strict(),
  z.object({method:z.literal('retire_memory'),params:z.object({projectId:identifier,id:identifier,reason:proposalSchema.shape.reason}).strict()}).strict(),
]);
const MAX_REQUEST = 64 * 1024;
const safeErrors = new Set(['PROJECT_NOT_FOUND','MEMORY_LIMIT','INVALID_SUPERSESSION','VAULT_LOCKED','REQUEST_CONDITION_LIMIT','VAULT_SIZE_LIMIT','CAPTURE_NOT_CONSENTED','CAPTURE_LIMIT','CAPTURE_URL_MISMATCH','EXPLICIT_SUPERSESSION_REQUIRED','STALE_SUPERSESSION','CANDIDATE_NOT_FOUND','ACTIVE_MEMORY_NOT_FOUND','AGENT_CAPTURE_NOT_CONSENTED','STALE_AGENT_CONSENT','AGENT_SESSION_SCOPE_MISMATCH','AGENT_TURN_NOT_CAPTURED']);
export const safeError = (e: unknown) => e instanceof Error && safeErrors.has(e.message) ? e.message : 'REQUEST_FAILED';

export async function startBroker(vault: VaultSession, directory: string) {
  await privateDirectory(directory);
  const path = join(directory, 'memory.sock');
  const server = createServer(socket => {
    let buffer = Buffer.alloc(0); let handled = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST) { handled = true; socket.end(JSON.stringify({ error: 'REQUEST_TOO_LARGE' }) + '\n'); return; }
      const end = buffer.indexOf(10);
      if (end < 0) return;
      handled = true;
      void (async () => {
        const parsed = requestSchema.safeParse(JSON.parse(buffer.subarray(0, end).toString('utf8')));
        if (!parsed.success) { socket.end(JSON.stringify({ error: 'INVALID_REQUEST' }) + '\n'); return; }
        const { method, params } = parsed.data;
        let result: unknown;
        if (method === 'get_context') result = vault.read(e => e.getContext(params));
        else if (method === 'search_memory') result = vault.read(e => e.search(params.projectId, params.query, params.limit, params.requestConditions));
        else if(method==='propose_memory')result = await vault.mutate(e => e.propose(params));
        else if(method==='list_projects')result=vault.read(e=>({projects:e.snapshot().projects,settings:e.snapshot().captureSettings}));
        else if(method==='configure_capture')result=await vault.mutate(e=>e.configureCapture(params));
        else if(method==='capture')result=await vault.mutate(e=>e.capture(params));
        else if(method==='get_agent_binding')result=vault.read(e=>e.getAgentBinding(params.client,params.workspace));
        else if(method==='capture_agent')result=await vault.mutate(e=>e.captureAgent(params));
        else if(method==='list_memories')result=vault.read(e=>e.listMemories(params.projectId,params.status,params.offset,params.limit));
        else if(method==='review_memory')result=await vault.mutate(e=>e.reviewScoped(params.projectId,params.id,params.decision,params.supersedesId));
        else if(method==='correct_candidate')result=await vault.mutate(e=>e.correctCandidate(params.projectId,params.id,params.value,params.reason));
        else result=await vault.mutate(e=>e.retireMemory(params.projectId,params.id,params.reason));
        socket.end(JSON.stringify({ result }) + '\n');
      })().catch(e => socket.end(JSON.stringify({ error: safeError(e) }) + '\n'));
    });
  });
  // Never unlink an existing endpoint: it may belong to another running session.
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  return {
    path,
    async close() {
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; });
    },
  };
}

/** The stdio adapter has no keys and no approval route. Only a same-user socket is accepted. */
export async function callBroker(path: string, method: string, params: unknown): Promise<unknown> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('UNSAFE_SOCKET');
  } catch { throw new Error('VAULT_LOCKED'); }
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path); let buffer = Buffer.alloc(0);
    const fail = () => { socket.destroy(); reject(new Error('VAULT_LOCKED')); };
    socket.setTimeout(5000, fail);
    socket.once('error', fail);
    socket.once('connect', () => socket.write(JSON.stringify({ method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 256 * 1024) { socket.destroy(); reject(new Error('RESPONSE_TOO_LARGE')); return; }
      const end = buffer.indexOf(10); if (end < 0) return;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.subarray(0,end).toString('utf8'));
        if (response.error) reject(new Error(response.error)); else resolve(response.result);
      } catch { reject(new Error('INVALID_RESPONSE')); }
    });
    socket.once('end', () => { if (buffer.indexOf(10) < 0) reject(new Error('VAULT_LOCKED')); });
  });
}
