import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { VaultSession } from './vault.js';
import { startBroker } from './broker.js';

// This separate, user-operated terminal is the only unlock/review surface.
// No --password option, environment secret, MCP approval tool, or HTTP unlock endpoint.
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Open this command yourself in a local interactive terminal. Secrets cannot be piped or passed by an AI client.');
  process.exit(1);
}
const [command, pathArg, ...extra] = process.argv.slice(2);
if (!['init', 'serve'].includes(command ?? '') || extra.length) {
  console.error('Usage: npm run vault -- init|serve [private-directory]'); process.exit(1);
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
let input: ReturnType<typeof createInterface> | undefined;
async function close() { input?.close(); await broker?.close(); await vault?.close(); }
try {
  const ownerId = command === 'init' ? randomUUID() : JSON.parse(await readFile(join(directory, 'vault.json'), 'utf8')).ownerId;
  let password = await hidden('Local vault passphrase (at least 12 characters; never send this to an AI): ');
  if (command === 'init' && password !== await hidden('Confirm passphrase: ')) throw new Error('PASSPHRASES_DIFFER');
  vault = await VaultSession.open(directory, ownerId, password, command === 'init'); password = '';
  input = createInterface({ input: process.stdin, output: process.stdout });
  console.log('Selected memories will be readable by the connected AI service. Other local programs running as your OS user can access this unlocked socket. Closing this terminal locks the vault.');
  const consent = await input.question('Type CONNECT to enable the local MCP connection, or press Enter to close: ');
  if (consent !== 'CONNECT') { await close(); process.exit(0); }
  broker = await startBroker(vault, directory);
  console.log('Connected locally. Commands: projects, project, memories, propose, candidates, review, delete-all, lock');
  const end = () => { void close().finally(() => process.exit(0)); };
  process.once('SIGTERM', end); process.once('SIGINT', end);
  while (true) {
    const action = (await input.question('growth-brain> ')).trim();
    if (action === 'lock') break;
    try {
      if (action === 'projects') console.log(JSON.stringify(vault.read(e => e.snapshot().projects), null, 2));
      else if (action === 'memories') console.log(JSON.stringify(vault.read(e => e.snapshot().memories), null, 2));
      else if (action === 'project') {
        const name = await input.question('Project name: ');
        console.log(await vault.mutate(e => e.addProject(name)));
      } else if (action === 'candidates') console.log(JSON.stringify(vault.read(e => e.snapshot().memories.filter(m => m.status === 'candidate')), null, 2));
      else if (action === 'propose') {
        const projectId = await input.question('Project UUID, or GLOBAL for an explicit cross-project preference: ');
        const key = await input.question('Condition key (e.g. language, tone): ');
        const value = await input.question('Value: ');
        const prior = await input.question('Active memory UUID to replace, or Enter: ');
        console.log(await vault.mutate(e => e.propose({ scope: projectId === 'GLOBAL' ? {type:'global'} : {type:'project',projectId}, kind: projectId === 'GLOBAL' ? 'preference' : 'constraint', key, value, source:{kind:'user',reference:'local:user-input',excerpt:value}, reason:'Explicit local user proposal', ...(prior ? {supersedesId:prior} : {}) })));
      } else if (action === 'review') {
        const id = await input.question('Candidate UUID: ');
        const candidate = vault.read(e => e.snapshot().memories.find(m => m.id === id && m.status === 'candidate'));
        if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
        console.log(JSON.stringify(candidate, null, 2));
        if (candidate.supersedesId) console.log('Replaces:', JSON.stringify(vault.read(e => e.snapshot().memories.find(m => m.id === candidate.supersedesId)),null,2));
        const choice = await input.question('Type APPROVE or REJECT; Enter cancels: ');
        if (choice === 'APPROVE' || choice === 'REJECT') console.log(await vault.mutate(e => e.review(id, choice === 'APPROVE' ? 'approve' : 'reject')));
      } else if (action === 'delete-all') {
        if (await input.question('Deletes this device’s vault only; external backups and AI-held context remain. Type DELETE to confirm: ') === 'DELETE') {
          await broker?.close(); broker = undefined; await vault.deleteAll(); break;
        }
      } else console.log('Commands: projects, project, memories, propose, candidates, review, delete-all, lock');
    } catch { console.log('Action failed. Check the project/candidate ID, explicit replacement, and field limits. No approval was assumed.'); }
  }
  await close();
} catch {
  await close().catch(() => {});
  console.error('Vault could not open or the local session ended. Check the passphrase, private directory and existing session. No secret was logged.');
  process.exitCode = 1;
}
