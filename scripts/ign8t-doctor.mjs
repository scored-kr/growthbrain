import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pathToFileURL } from 'node:url';

export const projectId = 'b84c9058-644c-4dc0-a0cd-5a2eb9d017f9';
function resultValue(result) {
  if (result.isError) throw Error('IGN8T_TOOL_FAILED');
  let value;
  try { value = JSON.parse(result.content.find(item => item.type === 'text').text); }
  catch { throw Error('IGN8T_INVALID_RESPONSE'); }
  if (value?.success !== true) throw Error('IGN8T_TOOL_FAILED');
  return value;
}
export async function checkProject(client) {
  const call = async (name, args) => resultValue(await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 }));
  const project = await call('get_project', { project_id: projectId });
  if (project.project?.id !== projectId) throw Error('IGN8T_PROJECT_MISMATCH');
  const master = await call('get_documents', { project_id: projectId, document_type: 'master_spec' });
  const documents = master.documents?.filter(d => d.document_type === 'master_spec' && d.project_id === projectId && typeof d.content_text === 'string' && d.content_text.trim());
  if (!documents?.length) throw Error('IGN8T_MASTER_MISSING');
  await call('get_next_task', { project_id: projectId });
  // Do not log remote text, task titles, tool errors, environment or credentials.
  return { connected: true, projectId, readSequence: ['get_project', 'get_documents:master_spec', 'get_next_task'], masterCount: documents.length, staleMaster: documents.some(d => d.is_stale === true), nextAction: 'Read the complete master with the MCP client and compare with docs/requirements-2026-11-03.md before implementation. Board status alone is not implementation evidence.' };
}
async function main() {
  if (process.argv.length !== 2) throw Error('NO_ARGUMENTS_ALLOWED');
  if (!process.env.IGN8T_API_KEY) throw Error('IGN8T_API_KEY_MISSING');
  const env = { ...getDefaultEnvironment(), NODE_USE_ENV_PROXY: '1' };
  for (const name of ['IGN8T_API_KEY', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) if (process.env[name]) env[name] = process.env[name];
  const client = new Client({ name: 'growthbrain-development-doctor', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: 'npx', args: ['-y', '@ign8t/mcp@latest'], env, stderr: 'ignore' });
  const timer = setTimeout(() => { console.error('IGN8T_TIMEOUT: no connection verified'); process.exit(1); }, 110000);
  try {
    await client.connect(transport);
    console.log(JSON.stringify(await checkProject(client)));
  } finally { clearTimeout(timer); await client.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const known = ['NO_ARGUMENTS_ALLOWED', 'IGN8T_API_KEY_MISSING', 'IGN8T_TOOL_FAILED', 'IGN8T_INVALID_RESPONSE', 'IGN8T_PROJECT_MISMATCH', 'IGN8T_MASTER_MISSING'];
    console.error(known.includes(error.message) ? error.message : 'IGN8T_CONNECTION_FAILED');
    process.exitCode = 1;
  });
}
