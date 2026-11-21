import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopProviderForCallback } from '../dist/web-client.js';

test('Windows identifies the two supported services from the exact OAuth callback', () => {
  assert.equal(desktopProviderForCallback('https://claude.ai/api/mcp/auth_callback'), 'claude');
  assert.equal(desktopProviderForCallback('https://chatgpt.com/connector/oauth/a_b-12'), 'chatgpt');
  assert.equal(desktopProviderForCallback('https://chatgpt.com/connector_platform_oauth_redirect'), 'chatgpt');
  for (const uri of ['https://claude.ai.example.org/api/mcp/auth_callback',
    'https://chatgpt.com/connector/oauth/../external', 'https://chatgpt.com/connector/oauth/id?target=external',
    'https://chatgpt.com@external.example/connector/oauth/id', 'http://claude.ai/api/mcp/auth_callback']) {
    assert.equal(desktopProviderForCallback(uri), null);
  }
});
