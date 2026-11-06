import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { VaultSession } from './vault.js';
import { startBroker } from './broker.js';
import { startWebMcp } from './web-mcp.js';

// This separate, user-operated terminal is the only unlock/review surface.
// No --password option, environment secret, MCP approval tool, or HTTP unlock endpoint.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Open this command yourself in a local interactive terminal. Secrets cannot be piped or passed by an AI client.');
  process.exit(1);
}
const [command, pathArg, ...extra] = process.argv.slice(2);
const restoring = command === 'restore' || command === 'recover';
if (!['init', 'serve', 'restore', 'recovery', 'recover'].includes(command ?? '') || (restoring ? !pathArg || extra.length!==1 : extra.length!==0)) {
  console.error('Usage: npm run vault -- init|serve|recovery [private-directory], or restore|recover <new-directory> <encrypted-backup>'); process.exit(1);
}
const directory = resolve(pathArg ?? join(homedir(), '.local', 'share', 'growth-brain'));
async function hidden(question: string): Promise<string> {
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8');
  // Disable terminal echo before displaying a prompt that invites secret entry.
  process.stdout.write(question);
  return await new Promise((resolveAnswer, reject) => {
    let answer = '';
    const done = () => { process.stdin.off('data', receive); process.stdin.setRawMode(false); process.stdout.write('\n'); };
    const receive = (chunk: string) => {
      for (const c of chunk) {
        if (c === '\u0003') { done(); reject(new Error('CANCELLED')); return; }
        if (c === '\r' || c === '\n') { done(); resolveAnswer(answer); return; }
        if (c === '\u007f' || c === '\b') answer = [...answer].slice(0,-1).join('');
        else if (c >= ' ' && answer.length < 1024) answer += c;
      }
    };
    process.stdin.on('data', receive);
  });
}
let vault: VaultSession | undefined;
let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
let web:Awaited<ReturnType<typeof startWebMcp>>|undefined;
let input: ReturnType<typeof createInterface> | undefined;
let closePromise: Promise<void> | undefined;
function close() {
  if (closePromise) return closePromise;
  input?.close();
  // Mark the vault closed to new reads/writes synchronously, then drain accepted writes
  // and disconnect peers. Always finish both cleanups, including on an error/signal.
  closePromise = Promise.allSettled([vault?.close(), broker?.close(),web?.close()]).then(results => {
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  });
  return closePromise;
}
try {
  const ownerId = command === 'init' ? randomUUID() : JSON.parse(await readFile(restoring?resolve(extra[0]!):join(directory, 'vault.json'), 'utf8')).ownerId;
  let recoveryFile = '';
  if (command === 'recover') {
    input = createInterface({ input: process.stdin, output: process.stdout });
    recoveryFile = await input.question('Private recovery file path (file contents stay on this device): ');
    input.close(); input = undefined;
  }
  let password = await hidden(`${command === 'recover' ? 'New local' : 'Local'} vault passphrase (at least 12 characters; never send this to an AI): `);
  if ((command === 'init' || command === 'recover') && password !== await hidden('Confirm passphrase: ')) throw new Error('PASSPHRASES_DIFFER');
  vault = command === 'recover' ? await VaultSession.recover(extra[0]!, directory, ownerId, recoveryFile, password) :
    command === 'restore' ? await VaultSession.restore(extra[0]!,directory,ownerId,password) : await VaultSession.open(directory, ownerId, password, command === 'init');
  if (command === 'recovery') {
    input = createInterface({ input: process.stdin, output: process.stdout });
    console.log('The recovery file unlocks matching encrypted backups. Keep it offline, separate from backups and repositories. Issuing again replaces recovery for future backups; old backups retain their old key.');
    if (await input.question('Type ISSUE to create or replace recovery access; Enter cancels: ') === 'ISSUE') {
      const destination = await input.question('New recovery file path in a separate private directory: ');
      console.log(await vault.issueRecovery(password, destination));
      console.log('Recovery file saved without displaying its contents. Export a NEW encrypted backup now; earlier backups are unchanged.');
    }
    password = ''; await close(); process.exit(0);
  }
  password = '';
  if (command === 'recover') console.log('Recovered into a new vault with a new data key. Recovery access is disabled here until you issue a new recovery file. The original backup remains unchanged.');
  input = createInterface({ input: process.stdin, output: process.stdout });
  console.log('Selected memories will be readable by the connected AI service. Other local programs running as your OS user can access this unlocked socket. Closing this terminal locks the vault.');
  const consent = await input.question('Type CONNECT to enable the local MCP connection, or press Enter to close: ');
  if (consent !== 'CONNECT') { await close(); process.exit(0); }
  broker = await startBroker(vault, directory);
  console.log('Connected locally. Commands: projects, project, memories, propose, propose-task, candidates, review, correct, retire, agent-bind, agent-stop, agent-status, route-set, route-clear, routes, backup, web-start, web-requests, web-approve, web-deny, web-connections, web-revoke, web-audit, web-stop, delete-all, lock');
  const end = () => { void close().finally(() => process.exit(0)); };
  process.once('SIGTERM', end); process.once('SIGINT', end);
  while (true) {
    const action = (await input.question('growth-brain> ')).trim();
    if (action === 'lock') break;
    try {
      if(action==='web-start'){
        if(web)throw Error('WEB_ALREADY_RUNNING');
        const config=JSON.parse(await readFile(resolve(await input.question('HTTPS config file path (origin, certificateFile, privateKeyFile; see docs/web-mcp.md): ')),'utf8'));
        console.log('TLS must terminate on this device. Only use a direct connection or TCP passthrough; do not upload TLS/vault keys to a relay. Each OAuth connection needs separate local project approval.');
        if(await input.question('Type WEB to enable this HTTPS listener, or Enter to cancel: ')==='WEB'){web=await startWebMcp(vault,config);console.log(`Device MCP listening: ${web.url}`)}
      }else if(action==='web-requests')console.log(JSON.stringify(web?.auth.requests()??[],null,2));
      else if(action==='web-connections')console.log(JSON.stringify(web?.auth.connections()??[],null,2));
      else if(action==='web-audit')console.log(JSON.stringify(web?.audit()??[],null,2));
      else if(action==='web-approve'||action==='web-deny'){
        if(!web)throw Error('WEB_NOT_RUNNING');
        const id=await input.question('Connection request UUID: '),request=web.auth.requests().find(r=>r.id===id);
        if(!request)throw Error('CONNECTION_REQUEST_NOT_FOUND');
        console.log(JSON.stringify(request,null,2));console.log('Client name is unverified. Check the exact callback and the request number shown in your browser.');
        if(action==='web-deny')web.auth.deny(id);
        else{const project=await input.question('Allow common preferences only: COMMON, or one selected project UUID: ');
          if(await input.question('Selected context is visible to the AI. Read-only access expires within 24 hours. Type ALLOW: ')==='ALLOW')console.log(web.auth.approve(id,project==='COMMON'?null:project));}
      }else if(action==='web-revoke'){
        const id=await input.question('Connection UUID to revoke: ');if(await input.question('Type REVOKE: ')==='REVOKE')web?.auth.revoke(id);
      }else if(action==='web-stop'){await web?.close();web=undefined;console.log('Web connections closed and credentials revoked.')}
      else if (action === 'projects') console.log(JSON.stringify(vault.read(e => e.snapshot().projects), null, 2));
      else if (action === 'memories') console.log(JSON.stringify(vault.read(e => e.snapshot().memories), null, 2));
      else if (action === 'project') {
        const name = await input.question('Project name: ');
        console.log(await vault.mutate(e => e.addProject(name)));
      } else if (action === 'candidates') console.log(JSON.stringify(vault.read(e => e.snapshot().memories.filter(m => m.status === 'candidate')), null, 2));
      else if (action === 'propose' || action === 'propose-task') {
        const projectId = await input.question('Project UUID, or GLOBAL for an explicit cross-project preference: ');
        const key = await input.question('Condition key (e.g. language, tone): ');
        const value = await input.question('Value: ');
        const tasks=action==='propose-task'?await input.question('Apply only to tasks (writing, translation, campaign, analysis, coding; comma-separated): '):undefined;
        const prior = await input.question('Active memory UUID to replace, or Enter: ');
        console.log(await vault.mutate(e => e.propose({ scope: projectId === 'GLOBAL' ? {type:'global'} : {type:'project',projectId}, kind: projectId === 'GLOBAL' ? 'preference' : 'constraint', key, value, source:{kind:'user',reference:'local:user-input',excerpt:value}, reason:'Explicit local user proposal', ...(prior ? {supersedesId:prior} : {}),...(tasks!==undefined?{applicability:{taskTypes:tasks.split(',').map(x=>x.trim())}}:{}) })));
      } else if (action === 'review') {
        const id = await input.question('Candidate UUID: ');
        const candidate = vault.read(e => e.snapshot().memories.find(m => m.id === id && m.status === 'candidate'));
        if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
        console.log(JSON.stringify(candidate, null, 2));
        if (candidate.supersedesId) console.log('Replaces:', JSON.stringify(vault.read(e => e.snapshot().memories.find(m => m.id === candidate.supersedesId)),null,2));
        const choice = await input.question('Type APPROVE or REJECT; Enter cancels: ');
        if (choice === 'APPROVE' || choice === 'REJECT') console.log(await vault.mutate(e => e.review(id, choice === 'APPROVE' ? 'approve' : 'reject')));
      } else if (action === 'correct' || action === 'retire') {
        const projectId = await input.question('Selected project UUID: ');
        const id = await input.question(action === 'correct' ? 'Candidate UUID: ' : 'Active memory UUID: ');
        const memory = vault.read(e=>e.snapshot().memories.find(m=>m.id===id&&(m.scope.type==='global'||m.scope.projectId===projectId)));
        if (!memory) throw new Error('MEMORY_NOT_FOUND');
        console.log(JSON.stringify(memory, null, 2));
        if (memory.scope.type === 'global') console.log('This is a common preference shared by all projects.');
        if (action === 'correct') {
          const value = await input.question('Corrected value (remains pending): ');
          const reason = await input.question('Correction reason: ');
          if (await input.question('Type SAVE to create a new pending candidate; Enter cancels: ') === 'SAVE') console.log(await vault.mutate(e=>e.correctCandidate(projectId,id,value,reason)));
        } else {
          const reason = await input.question('Retirement reason: ');
          if (await input.question('History remains; common defaults may apply. Type RETIRE to stop using this memory: ') === 'RETIRE') console.log(await vault.mutate(e=>e.retireMemory(projectId,id,reason)));
        }
      } else if (action === 'routes') {
        console.log(JSON.stringify(vault.read(e=>e.snapshot().projectTriggers),null,2));
      } else if (action === 'route-set' || action === 'route-clear') {
        const projectId=await input.question('Selected project UUID: ');
        const keywords=action==='route-set'?(await input.question('Explicit trigger keywords, separated by commas: ')).split(',').map(s=>s.trim()):[];
        if(await input.question('Common memory is always read first. Type ROUTE to save, or Enter to cancel: ')==='ROUTE')console.log(await vault.mutate(e=>e.configureProjectTriggers(projectId,keywords)));
      } else if (action === 'agent-status') {
        console.log(JSON.stringify(vault.read(e=>e.snapshot().agentBindings),null,2));
      } else if (action === 'agent-bind' || action === 'agent-stop') {
        const client=await input.question('Client (codex or claude-code): ');
        const workspace=await realpath(resolve(await input.question('Exact workspace directory: ')));
        const projectId=await input.question('Selected project UUID: ');
        console.log('Capture covers user prompts and final assistant text in this exact directory. Raw text stays encrypted locally; extracted memories require review. Changing project requires a new AI session. No history-file scan or plaintext retry queue.');
        if(await input.question(action==='agent-bind'?'Type CAPTURE to enable, or Enter to cancel: ':'Type STOP to pause, or Enter to cancel: ')===(action==='agent-bind'?'CAPTURE':'STOP'))console.log(await vault.mutate(e=>e.configureAgentCapture({client,workspace,projectId,enabled:action==='agent-bind'})));
      } else if (action === 'backup') {
        const path=await input.question('New encrypted backup path in a private directory: ');
        console.log(await vault.exportBackup(path));
      } else if (action === 'delete-all') {
        if (await input.question('Deletes this vault and its managed migration backups. Your exported backups, recovery files, remote account data and AI-held context remain. Type DELETE to confirm: ') === 'DELETE') {
          try {
            await web?.close();web=undefined;await broker?.close(); broker = undefined; await vault.deleteAll();
            console.log('Local vault and managed migration backups deleted. Exported backups, recovery files, remote account data and AI-held context remain.');
          } catch {
            console.error('Local deletion incomplete. Session locked; remaining files were not declared deleted. Check the private vault directory and managed backup ownership/permissions before retrying.');
            process.exitCode = 1;
          }
          break;
        }
      } else console.log('Commands: projects, project, memories, propose, propose-task, candidates, review, correct, retire, agent-bind, agent-stop, agent-status, route-set, route-clear, routes, backup, web-start, web-requests, web-approve, web-deny, web-connections, web-revoke, web-audit, web-stop, delete-all, lock');
    } catch { console.log('Action failed. Check the project/candidate ID, explicit replacement, and field limits. No approval was assumed.'); }
  }
  await close();
} catch {
  await close().catch(() => {});
  console.error('Vault could not open or the local session ended. Check the passphrase, private directory and existing session. No secret was logged.');
  process.exitCode = 1;
}
