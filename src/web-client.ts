// Only these documented OAuth callback URLs can be approved in the Windows app.
// A display name supplied by a dynamically registered client is not its identity.
export function desktopProviderForCallback(raw: string): 'chatgpt' | 'claude' | null {
  if (raw === 'https://claude.ai/api/mcp/auth_callback') return 'claude';
  if (raw === 'https://chatgpt.com/connector_platform_oauth_redirect' ||
      /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(raw)) return 'chatgpt';
  return null;
}
