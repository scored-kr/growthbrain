// Only the trusted desktop controller imports this provider. Its token and key
// methods must never be exposed as an IPC command, MCP tool, or UI state field.
import { readFile } from 'node:fs/promises';
import { AuthClient, type Session } from '@supabase/auth-js';
import { z } from 'zod';
import { deriveAccountKeys, requireSignupStrength } from './account-keys.js';

export const projectRef = 'kcvjsvbwinlhzgmnfsji';
export const accountOrigin = `https://${projectRef}.supabase.co`;
const publishable = /^sb_publishable_[A-Za-z0-9_-]{18,180}$/;
type Client = InstanceType<typeof AuthClient>;
const baseConfig = z.object({
  projectRef: z.literal(projectRef),
  publishableKey: z.string().regex(publishable),
});
const configuration = z.discriminatedUnion('contractVerified', [
  baseConfig.extend({ contractVerified: z.literal(false) }).strict(),
  baseConfig.extend({ contractVerified: z.literal(true), reviewSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
]);
const emailInput = z.string().trim().toLowerCase().email().max(254);
const otpInput = z.string().regex(/^[0-9]{6,10}$/);
export type DesktopIdentity = {userId: string; email: string; expiresAt: number};

function emailAddress(value: string) {
  const result = emailInput.safeParse(value);
  if (!result.success) throw Error('ACCOUNT_EMAIL_INVALID');
  return result.data;
}
function emailCode(value: string) {
  if (!otpInput.safeParse(value).success) throw Error('ACCOUNT_CODE_INVALID');
  return value;
}
function rejectAuth(error: {code?: string} | null, fallback: string) {
  if (error) throw Error(error.code === 'email_not_confirmed' ? 'ACCOUNT_EMAIL_UNCONFIRMED' : fallback);
}

export class DesktopAccount {
  readonly configured: boolean;
  private client?: Client;
  private verified?: DesktopIdentity;
  private session?: Session;
  private generation = 0;

  constructor(readonly publishableKey: string, private fetcher: typeof fetch = fetch, readonly contractVerified = false) {
    this.configured = publishable.test(publishableKey);
  }

  private createClient() {
    if (!this.configured) throw Error('ACCOUNT_UNCONFIGURED');
    return new AuthClient({
      url: accountOrigin + '/auth/v1',
      headers: { apikey: this.publishableKey },
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
      debug: false,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.origin !== accountOrigin || !url.pathname.startsWith('/auth/v1/')) throw Error('ACCOUNT_ORIGIN_INVALID');
        const deadline = AbortSignal.timeout(10000);
        const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
        // Refuse redirects, including ones that could replay a credential-bearing POST.
        try { return await this.fetcher(url, { ...init, signal, redirect: 'error' }); }
        catch { throw Error('ACCOUNT_NETWORK_UNAVAILABLE'); }
      },
    });
  }

  identity(): DesktopIdentity | null {
    return this.verified && this.verified.expiresAt > Date.now() ? { ...this.verified } : null;
  }

  clear() {
    ++this.generation;
    this.session = undefined;
    this.verified = undefined;
    this.client = undefined;
  }

  private async verify(client: Client, session: Session, expected: {email?: string; userId?: string}) {
    const { data, error } = await client.getUser(session.access_token);
    rejectAuth(error, 'ACCOUNT_AUTH_FAILED');
    const user = data.user;
    const expiresAt = (session.expires_at ?? 0) * 1000;
    if (!user || !z.string().uuid().safeParse(user.id).success || !user.email_confirmed_at ||
        !user.email || !session.access_token || !session.refresh_token ||
        !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw Error('ACCOUNT_AUTH_FAILED');
    const email = emailAddress(user.email);
    if ((expected.userId && expected.userId !== user.id) || (expected.email && expected.email !== email)) {
      throw Error('ACCOUNT_IDENTITY_MISMATCH');
    }
    return { userId: user.id, email, expiresAt };
  }

  private remember(generation: number, client: Client, session: Session, verified: DesktopIdentity) {
    if (this.generation !== generation) throw Error('ACCOUNT_SESSION_CHANGED');
    this.client = client;
    this.session = session;
    this.verified = verified;
    return { ...verified };
  }

  async login(email: string, password: string) {
    this.clear();
    const generation = this.generation;
    const client = this.createClient();
    const keys = await deriveAccountKeys(emailAddress(email), password, accountOrigin);
    try {
      const { data, error } = await client.signInWithPassword({ email: keys.email, password: keys.authPassword });
      rejectAuth(error, 'ACCOUNT_AUTH_FAILED');
      if (!data.session) throw Error('ACCOUNT_AUTH_FAILED');
      const identity = await this.verify(client, data.session, { email: keys.email });
      this.remember(generation, client, data.session, identity);
      return { ...identity, wrappingKey: keys.wrappingKey };
    } catch (error) {
      keys.wrappingKey.fill(0);
      throw error;
    }
  }

  async signup(email: string, password: string) {
    this.clear();
    const client = this.createClient();
    requireSignupStrength(password);
    const keys = await deriveAccountKeys(emailAddress(email), password, accountOrigin);
    try {
      const { data, error } = await client.signUp({ email: keys.email, password: keys.authPassword });
      rejectAuth(error, 'ACCOUNT_SIGNUP_FAILED');
      if (data.session) {
        const { error } = await client.signOut({ scope: 'local' });
        rejectAuth(error, 'ACCOUNT_LOGOUT_FAILED');
      }
    } finally { keys.wrappingKey.fill(0); }
  }

  async confirmSignup(email: string, code: string) {
    const client = this.createClient();
    const { data, error } = await client.verifyOtp({ email: emailAddress(email), token: emailCode(code), type: 'signup' });
    rejectAuth(error, 'ACCOUNT_CODE_INVALID');
    // Email confirmation does not unlock the vault or enroll the device.
    if (data.session) rejectAuth((await client.signOut({ scope: 'local' })).error, 'ACCOUNT_LOGOUT_FAILED');
  }

  async requestReset(email: string) {
    const { error } = await this.createClient().resetPasswordForEmail(emailAddress(email));
    rejectAuth(error, 'ACCOUNT_RESET_FAILED');
  }

  async reset(email: string, code: string, newPassword: string) {
    this.clear();
    const client = this.createClient();
    requireSignupStrength(newPassword);
    const keys = await deriveAccountKeys(emailAddress(email), newPassword, accountOrigin);
    try {
      const { data, error } = await client.verifyOtp({ email: keys.email, token: emailCode(code), type: 'recovery' });
      rejectAuth(error, 'ACCOUNT_CODE_INVALID');
      if (!data.session) throw Error('ACCOUNT_RESET_FAILED');
      await this.verify(client, data.session, { email: keys.email });
      rejectAuth((await client.updateUser({ password: keys.authPassword })).error, 'ACCOUNT_RESET_FAILED');
    } finally {
      keys.wrappingKey.fill(0);
      // Revoke the temporary recovery session. Never replace or rewrap old ciphertext here.
      const { error } = await client.signOut({ scope: 'local' });
      if (error && error.name !== 'AuthSessionMissingError') throw Error('ACCOUNT_LOGOUT_FAILED');
    }
  }

  async restore(refreshToken: string, expectedUserId: string) {
    this.clear();
    if (!refreshToken || !z.string().uuid().safeParse(expectedUserId).success) throw Error('ACCOUNT_AUTH_FAILED');
    const generation = this.generation;
    const client = this.createClient();
    const { data, error } = await client.refreshSession({ refresh_token: refreshToken });
    rejectAuth(error, 'ACCOUNT_SESSION_EXPIRED');
    if (!data.session) throw Error('ACCOUNT_SESSION_EXPIRED');
    const verified = await this.verify(client, data.session, { userId: expectedUserId });
    return this.remember(generation, client, data.session, verified);
  }

  async refresh() {
    const session = this.session, user = this.verified;
    if (!session || !user) throw Error('ACCOUNT_SESSION_EXPIRED');
    return this.restore(session.refresh_token, user.userId);
  }

  async requireVerifiedUser() {
    const session = this.session, verified = this.verified, client = this.client;
    if (!session || !verified || !client) throw Error('ACCOUNT_SESSION_EXPIRED');
    if (verified.expiresAt - Date.now() < 30000) return this.refresh();
    const generation = this.generation;
    try {
      const identity = await this.verify(client, session, { userId: verified.userId, email: verified.email });
      return this.remember(generation, client, session, identity);
    } catch (error) {
      if (this.generation === generation) this.clear();
      throw error;
    }
  }

  async accessToken() {
    if (!this.verified || !this.session) throw Error('ACCOUNT_SESSION_EXPIRED');
    if (this.verified.expiresAt - Date.now() < 30000) await this.refresh();
    if (!this.session) throw Error('ACCOUNT_SESSION_EXPIRED');
    return this.session.access_token;
  }

  async exportRefreshToken() {
    if (!this.session || !this.identity()) throw Error('ACCOUNT_SESSION_EXPIRED');
    return this.session.refresh_token;
  }

  async logout() {
    const client = this.client;
    this.clear();
    if (client) rejectAuth((await client.signOut({ scope: 'local' })).error, 'ACCOUNT_LOGOUT_FAILED');
  }
}

export async function loadDesktopAccount() {
  try {
    const file = await readFile(new URL('./account-service.json', import.meta.url));
    const parsed = configuration.safeParse(JSON.parse(file.toString('utf8')));
    if (!parsed.success) throw Error('ACCOUNT_CONFIGURATION_INVALID');
    return new DesktopAccount(parsed.data.publishableKey, fetch, parsed.data.contractVerified);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new DesktopAccount('');
    throw Error('ACCOUNT_CONFIGURATION_INVALID');
  }
}
