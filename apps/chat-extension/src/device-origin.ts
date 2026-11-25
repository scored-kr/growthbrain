const loopback = 'ws://127.0.0.1:43127';

// Values are build-time deployment settings. An end user never supplies an endpoint.
export function deviceOrigin(value?: string): string {
  if (!value || value === loopback) return loopback;
  const url = new URL(value);
  if (
    url.protocol !== 'wss:' ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !/^[a-z0-9.-]+$/i.test(url.hostname)
  )
    throw Error('An exact WSS origin on port 443 is required');
  return url.origin;
}
