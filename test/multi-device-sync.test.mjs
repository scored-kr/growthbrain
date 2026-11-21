import test from 'node:test';
import { accountServer } from './support/synthetic-supabase.mjs';
import { verifyFreshDeviceRecall } from './support/verify-synced-context.mjs';

test('fresh device serves approved latest memories to both web MCP clients after source exits',
  { timeout: process.platform === 'win32' ? 240000 : 120000 },
  t => verifyFreshDeviceRecall(t, accountServer));
