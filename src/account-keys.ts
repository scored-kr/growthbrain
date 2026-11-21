import { createHash, hkdfSync, scrypt } from 'node:crypto';

const protocol = 'growth-brain/account-password/v1';

export function canonicalAccountEmail(email: string): string {
  const normalized = email.trim().normalize('NFC').toLowerCase();
  if (normalized.length > 254 || !/^[^\s@\p{C}]+@[^\s@\p{C}]+\.[^\s@\p{C}]+$/u.test(normalized)) {
    throw Error('INVALID_EMAIL');
  }
  return normalized;
}

/** Apply only at creation/reset. A changed strength policy must not strand an existing account. */
export function requireSignupStrength(password: string): void {
  const chars = Array.from(password);
  const compact = password.toLowerCase().replace(/[\W_]/gu, '');
  if (chars.length < 16 || password.length > 1024 || new Set(password.toLowerCase()).size < 6 ||
      /^(?:password|qwerty|letmein|iloveyou|admin|changeme|1234567890)+\d*$/.test(compact) ||
      /^(.{1,8})\1+$/su.test(password)) {
    throw Error('WEAK_ACCOUNT_PASSWORD');
  }
}

export type AccountKeys = { email: string; authPassword: string; wrappingKey: Buffer };

/** The native client is the password input surface. Only authPassword is sent to GoTrue. */
export async function deriveAccountKeys(email: string, password: string, issuer: string): Promise<AccountKeys> {
  const normalized = canonicalAccountEmail(email);
  if (!password || password.length > 1024 || /[\uD800-\uDFFF]/u.test(password)) throw Error('INVALID_ACCOUNT_PASSWORD');
  const url = new URL(issuer);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('INVALID_ACCOUNT_ISSUER');
  }
  // The salt must be reproducible on a fresh device before authentication.
  // Changing the issuer/email requires explicitly migrating the existing wrapper.
  const salt = createHash('sha256').update(JSON.stringify([protocol, url.origin, normalized])).digest();
  const input = Buffer.from(password, 'utf8');
  let root: Buffer | undefined;
  let credential: Buffer | undefined;
  try {
    root = await new Promise<Buffer>((resolve, reject) => {
      scrypt(input, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
        (error, result) => error ? reject(error) : resolve(result));
    });
    credential = Buffer.from(hkdfSync('sha256', root, salt, protocol + '/provider-login', 32));
    const wrappingKey = Buffer.from(hkdfSync('sha256', root, salt, protocol + '/vault-wrapping', 32));
    return { email: normalized, authPassword: 'Gb1!' + credential.toString('base64url'), wrappingKey };
  } finally {
    input.fill(0);
    root?.fill(0);
    credential?.fill(0);
  }
}
