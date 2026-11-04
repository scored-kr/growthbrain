import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProject, projectId } from '../scripts/ign8t-doctor.mjs';

test('ign8t doctor verifies ordered real-result contracts and prints no remote text', async () => {
  const calls = [];
  const outputs = [{ success: true, project: { id: projectId } }, { success: true, documents: [{ project_id: projectId, document_type: 'master_spec', content_text: 'PRIVATE_REMOTE_TEXT', is_stale: true }] }, { success: true }];
  const result = await checkProject({ callTool: async request => { calls.push(request); return { content: [{ type: 'text', text: JSON.stringify(outputs[calls.length - 1]) }] }; } });
  assert.deepEqual(calls.map(c => c.name), ['get_project', 'get_documents', 'get_next_task']);
  assert.equal(calls[1].arguments.document_type, 'master_spec');
  assert.equal(result.connected, true); assert.equal(result.staleMaster, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE_REMOTE_TEXT'));
});

test('ign8t doctor stops on wrong project, remote error or missing master', async () => {
  for (const broken of [{ isError: true, content: [{ type: 'text', text: 'PRIVATE_KEY' }] }, { content: [{ type: 'text', text: '{"success":false,"error":"PRIVATE_KEY"}' }] }, { content: [{ type: 'text', text: '{"success":true,"project":{"id":"wrong"}}' }] }]) {
    let count = 0;
    await assert.rejects(checkProject({ callTool: async () => { count++; return broken; } }), error => !error.message.includes('PRIVATE_KEY'));
    assert.equal(count, 1);
  }
  let count = 0;
  await assert.rejects(checkProject({ callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify(++count === 1 ? { success: true, project: { id: projectId } } : { success: true, documents: [] }) }] }) }), /IGN8T_MASTER_MISSING/);
  assert.equal(count, 2);
});
