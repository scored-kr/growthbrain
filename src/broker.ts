import { createServer, createConnection, type Socket } from 'node:net';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { agentCaptureInputSchema, agentClientSchema, workspaceSchema, captureInputSchema, consentSchema, contextSchema, identifier, proposalSchema, searchSchema } from './model.js';
import { privateDirectory, type VaultSession } from './vault.js';
import { chatImportInputSchema, handoffProposalSchema } from './model.js';

const requestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('get_context'), params: contextSchema }).strict(),
  z.object({ method: z.literal('search_memory'), params: searchSchema }).strict(),
  z.object({ method: z.literal('propose_memory'), params: proposalSchema }).strict(),
  z.object({method:z.literal('propose_handoff'),params:handoffProposalSchema}).strict(),
  z.object({method:z.literal('list_handoffs'),params:z.object({projectId:identifier,offset:z.number().int().min(0).max(1000).default(0)}).strict()}).strict(),
  z.object({method:z.literal('review_handoff'),params:z.object({projectId:identifier,id:identifier,decision:z.enum(['approve','reject']),supersedesId:identifier.optional()}).strict()}).strict(),
  z.object({method:z.literal('retire_handoff'),params:z.object({projectId:identifier,id:identifier}).strict()}).strict(),
  z.object({method:z.literal('pin_memory'),params:z.object({projectId:identifier,id:identifier,pinned:z.boolean()}).strict()}).strict(),
  z.object({method:z.literal('dashboard'),params:z.object({projectId:identifier}).strict()}).strict(),
  z.object({method:z.literal('list_captures'),params:z.object({projectId:identifier,offset:z.number().int().min(0).max(5000).default(0)}).strict()}).strict(),
  // Local native-messaging/UI operations; these are never registered as MCP tools.
  z.object({method:z.literal('import_chat'),params:chatImportInputSchema}).strict(),
  z.object({method:z.literal('create_project'),params:z.object({name:z.string().trim().min(1).max(200)}).strict()}).strict(),
  z.object({method:z.literal('get_agent_binding'),params:z.object({client:agentClientSchema,workspace:workspaceSchema,sessionId:agentCaptureInputSchema.shape.sessionId}).strict()}).strict(),
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
const MAX_RESPONSE = 256 * 1024;
const safeErrors = new Set(['PROJECT_NOT_FOUND','MEMORY_LIMIT','INVALID_SUPERSESSION','VAULT_LOCKED','REQUEST_CONDITION_LIMIT','VAULT_SIZE_LIMIT','CAPTURE_NOT_CONSENTED','CAPTURE_LIMIT','CAPTURE_URL_MISMATCH','EXPLICIT_SUPERSESSION_REQUIRED','STALE_SUPERSESSION','CANDIDATE_NOT_FOUND','ACTIVE_MEMORY_NOT_FOUND','AGENT_CAPTURE_NOT_CONSENTED','STALE_AGENT_CONSENT','AGENT_SESSION_SCOPE_MISMATCH','AGENT_TURN_NOT_CAPTURED']);
export const safeError = (e: unknown) => e instanceof Error && safeErrors.has(e.message) ? e.message : 'REQUEST_FAILED';
for (const code of ['INVALID_REQUEST', 'INVALID_RESPONSE', 'REQUEST_TOO_LARGE', 'RESPONSE_TOO_LARGE']) safeErrors.add(code);
safeErrors.add('IMPORT_PROJECT_MISMATCH');
safeErrors.add('PROJECT_ACCESS_DENIED');
for(const code of ['MULTIPLE_SUPERSESSIONS_REQUIRED','HANDOFF_LIMIT','INVALID_HANDOFF_TIME'])safeErrors.add(code);

export function errorNextAction(code: string): string {
  if(code==='PROJECT_ACCESS_DENIED')return 'This connection is restricted to the locally approved project or common preferences. Ask the user to review its scope in the local terminal; do not try other project IDs.';
  if (code === 'REQUEST_TOO_LARGE' || code === 'REQUEST_CONDITION_LIMIT') return 'Reduce the number or length of explicit request conditions and retry. Do not split a write into automatic duplicate proposals.';
  if (code === 'RESPONSE_TOO_LARGE') return 'Request fewer records or a narrower query. Do not repeat a write automatically; inspect its status in the local terminal.';
  if (code === 'PROJECT_NOT_FOUND') return 'Ask the user to select an existing project in the local Growth Brain terminal. Do not guess a different project.';
  if (code === 'INVALID_REQUEST') return 'Check the tool input schema and retry with valid arguments.';
  if (code === 'VAULT_LOCKED') return 'Open and unlock the local Growth Brain user terminal. Never supply a password or recovery key in chat or MCP arguments.';
  return 'Inspect the local Growth Brain terminal for the operation status. Do not repeat a write automatically. Never supply a password or recovery key in chat or MCP arguments.';
}

export async function startBroker(vault: VaultSession, directory: string) {
  await privateDirectory(directory);
  const path = join(directory, 'memory.sock');
  const sockets = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer(socket => {
    if (closing) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0); let handled = false;
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled || closing) return;
      if (buffer.length + chunk.length > MAX_REQUEST) { handled = true; socket.end(JSON.stringify({ error: 'REQUEST_TOO_LARGE' }) + '\n'); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      handled = true;
      void (async () => {
        let input: unknown;
        try { input = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
        catch { socket.end(JSON.stringify({ error: 'INVALID_REQUEST' }) + '\n'); return; }
        const parsed = requestSchema.safeParse(input);
        if (!parsed.success) { socket.end(JSON.stringify({ error: 'INVALID_REQUEST' }) + '\n'); return; }
        const { method, params } = parsed.data;
        let result: unknown;
        if (method === 'get_context') result = vault.getContext(params);
        else if (method === 'search_memory') result = vault.search(params.projectId, params.query, params.limit, params.requestConditions,params.taskType);
        else if(method==='propose_memory')result = await vault.mutate(e => e.propose(params));
        else if(method==='propose_handoff')result=await vault.mutate(e=>e.proposeHandoff(params));
        else if(method==='list_handoffs')result=vault.read(e=>e.listHandoffs(params.projectId,params.offset));
        else if(method==='review_handoff')result=await vault.mutate(e=>e.reviewHandoff(params.projectId,params.id,params.decision,params.supersedesId));
        else if(method==='retire_handoff')result=await vault.mutate(e=>e.retireHandoff(params.projectId,params.id));
        else if(method==='pin_memory')result=await vault.mutate(e=>e.pinMemory(params.projectId,params.id,params.pinned));
        else if(method==='dashboard')result=vault.read(e=>e.dashboard(params.projectId));
        else if(method==='list_captures')result=vault.read(e=>e.listCaptures(params.projectId,params.offset));
        else if(method==='list_projects')result=vault.read(e=>({projects:e.snapshot().projects,settings:e.snapshot().captureSettings}));
        else if(method==='configure_capture')result=await vault.mutate(e=>e.configureCapture(params));
        else if(method==='capture')result=await vault.mutate(e=>e.capture(params));
        else if(method==='import_chat')result=await vault.mutate(e=>e.importChat(params));
        else if(method==='create_project')result=await vault.mutate(e=>e.addProject(params.name));
        else if(method==='get_agent_binding')result=vault.read(e=>e.getAgentBinding(params.client,params.workspace,params.sessionId));
        else if(method==='capture_agent')result=await vault.mutate(e=>e.captureAgent(params));
        else if(method==='list_memories')result=vault.read(e=>e.listMemories(params.projectId,params.status,params.offset,params.limit));
        else if(method==='review_memory')result=await vault.mutate(e=>e.reviewScoped(params.projectId,params.id,params.decision,params.supersedesId));
        else if(method==='correct_candidate')result=await vault.mutate(e=>e.correctCandidate(params.projectId,params.id,params.value,params.reason));
        else result=await vault.mutate(e=>e.retireMemory(params.projectId,params.id,params.reason));
        const response = JSON.stringify({ result }) + '\n';
        socket.end(Buffer.byteLength(response) > MAX_RESPONSE ? JSON.stringify({ error: 'RESPONSE_TOO_LARGE' }) + '\n' : response);
      })().catch(e => socket.end(JSON.stringify({ error: safeError(e) }) + '\n'));
    });
  });
  // Never unlink an existing endpoint: it may belong to another running session.
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  await chmod(path, 0o600);
  return {
    path,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise<void>((resolve, reject) => {
        server.close(e => e ? reject(e) : resolve());
        // Idle/partial peers must not prolong an unlocked session or complete a late request.
        for (const socket of sockets) socket.destroy();
      }).then(async () => { await unlink(path).catch(e => { if (e.code !== 'ENOENT') throw e; }); });
      return closePromise;
    },
  };
}

/** The stdio adapter has no keys and no approval route. Only a same-user socket is accepted. */
export async function callBroker(path: string, method: string, params: unknown): Promise<unknown> {
  let request: string;
  try { request = JSON.stringify({ method, params }) + '\n'; }
  catch { throw new Error('INVALID_REQUEST'); }
  if (Buffer.byteLength(request) > MAX_REQUEST) throw new Error('REQUEST_TOO_LARGE');
  try {
    const stat = await lstat(path);
    if (!stat.isSocket() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('UNSAFE_SOCKET');
  } catch { throw new Error('VAULT_LOCKED'); }
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path); let buffer = Buffer.alloc(0);
    const fail = () => { socket.destroy(); reject(new Error('VAULT_LOCKED')); };
    socket.setTimeout(5000, fail);
    socket.once('error', fail);
    socket.once('connect', () => socket.write(request));
    socket.on('data', chunk => {
      if (buffer.length + chunk.length > MAX_RESPONSE) { socket.destroy(); reject(new Error('RESPONSE_TOO_LARGE')); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10); if (end < 0) return;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.subarray(0,end).toString('utf8'));
        if (!response || typeof response !== 'object' || Array.isArray(response) || Object.keys(response).length !== 1) throw new Error('INVALID_RESPONSE');
        if (Object.hasOwn(response, 'error') && typeof response.error === 'string') reject(new Error(safeError(new Error(response.error))));
        else if (Object.hasOwn(response, 'result')) resolve(response.result);
        else throw new Error('INVALID_RESPONSE');
      } catch { reject(new Error('INVALID_RESPONSE')); }
    });
    socket.once('end', () => { if (buffer.indexOf(10) < 0) reject(new Error(buffer.length ? 'INVALID_RESPONSE' : 'VAULT_LOCKED')); });
  });
}
