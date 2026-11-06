import { homedir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { callBroker } from './broker.js';
import { createMemoryMcp } from './mcp-server.js';
const socket = process.env.GROWTH_BRAIN_SOCKET ?? join(homedir(), '.local', 'share', 'growth-brain', 'memory.sock');
await createMemoryMcp((method,params)=>callBroker(socket,method,params)).connect(new StdioServerTransport());
