import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { startBroker } from './broker.js';
import { openDesktopRoute } from './desktop-route.js';
import { equivalentKeys } from './memory-keys.js';
import { identifier, proposalSchema } from './model.js';
import { privateDirectory, readPrivateJSON } from './secure-files.js';
import { VaultSession } from './vault.js';
import { desktopProviderForCallback } from './web-client.js';

const id = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const op = <T extends string>(name: T) => z.object({ id, op: z.literal(name) }).strict();
const password = z.string().min(12).max(1024);
const selectedFile = z.string().max(32767).refine(p => isAbsolute(p) && !p.includes('\0'));
const backupOwner = z.object({ ownerId: identifier });
const request = z.discriminatedUnion('op', [
  op('status'), op('create').extend({ password }), op('unlock').extend({ password }), op('lock'),
  op('addProject').extend({ name: z.string().trim().min(1).max(200) }),
  op('addPreference').extend({
    projectId: identifier.nullable(), key: proposalSchema.shape.key, value: proposalSchema.shape.value,
    supersedesId: identifier.optional(),
  }),
  op('backup').extend({ file: selectedFile }),
  op('issueRecovery').extend({ file: selectedFile, password }),
  op('restore').extend({ backupFile: selectedFile, password }),
  op('recover').extend({ backupFile: selectedFile, recoveryFile: selectedFile, password }),
  op('startWeb'), op('stopWeb'),
  op('approve').extend({ requestId: identifier, projectId: identifier.nullable() }),
  op('deny').extend({ requestId: identifier }),
  op('revoke').extend({ connectionId: identifier }),
]);

const routeErrors = new Set(['ROUTE_UNAVAILABLE', 'ROUTE_OFFLINE', 'ROUTE_CERTIFICATE', 'ROUTE_POLICY_BLOCKED', 'ROUTE_CANCELLED']);
const errors = new Set([
  'VAULT_LOCKED', 'VAULT_EXISTS', 'VAULT_ALREADY_OPEN_OR_STALE_LOCK', 'VAULT_ALREADY_OPEN', 'VAULT_NOT_FOUND',
  'INVALID_INPUT', 'UNLOCK_FAILED', 'INVALID_VAULT_FILE', 'PASSPHRASE_LENGTH', 'PRIVATE_DIRECTORY_REQUIRED',
  'UNSAFE_WINDOWS_PATH', 'PROJECT_LIMIT', 'PROJECT_NOT_FOUND', 'MEMORY_LIMIT', 'VAULT_SIZE_LIMIT', 'COMMIT_UNCERTAIN', 'STALE_SUPERSESSION',
  'RESTORE_TARGET_EXISTS', 'BACKUP_DESTINATION_EXISTS', 'RESTORE_INPUT_INVALID', 'PRIVATE_FILE_UNAVAILABLE',
  'INVALID_RECOVERY_FILE', 'KEEP_RECOVERY_SEPARATE', 'RECOVERY_NOT_ENABLED', 'RECOVERY_IN_REPOSITORY',
  'WINDOWS_PRIVATE_STORAGE_REQUIRED', 'INVALID_SUPERSESSION', 'MULTIPLE_SUPERSESSIONS_REQUIRED', 'CONNECTION_REQUEST_NOT_FOUND', 'UNSUPPORTED_CALLBACK',
  'CONNECTION_LIMIT', 'CONNECTION_NOT_FOUND', 'LOCAL_CONNECTION_UNAVAILABLE', ...routeErrors,
]);
class ReplacementRequired extends Error {
  constructor(readonly previous: { id: string; key: string; value: string }) {
    super('EXPLICIT_SUPERSESSION_REQUIRED');
  }
}

type Route = Awaited<ReturnType<typeof openDesktopRoute>>;
type WebState = 'off' | 'starting' | 'ready' | 'unavailable';
type RouteAttempt = { abort: AbortController; finished?: Promise<void>; signInUrl: string | null };

export class DesktopController {
  private vault?: VaultSession;
  private broker?: Awaited<ReturnType<typeof startBroker>>;
  private route?: Route;
  private attempt?: RouteAttempt;
  private routeError?: string;

  constructor(private directory: string, private openRoute = openDesktopRoute) {}

  private async vaultExists() {
    try {
      const s = await lstat(join(this.directory, 'vault.json'));
      if (!s.isFile() || s.isSymbolicLink()) throw Error('INVALID_VAULT_FILE');
      return true;
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return false;
      throw e;
    }
  }

  private async openVault(password: string, create: boolean) {
    if (this.vault) throw Error('VAULT_ALREADY_OPEN');
    const exists = await this.vaultExists();
    if (create && exists) throw Error('VAULT_EXISTS');
    if (!create && !exists) throw Error('VAULT_NOT_FOUND');
    await privateDirectory(this.directory);
    const ownerId = create ? randomUUID() :
      z.object({ ownerId: identifier }).parse(await readPrivateJSON(join(this.directory, 'vault.json'))).ownerId;
    const vault = await VaultSession.open(this.directory, ownerId, password, create);
    try {
      this.broker = await startBroker(vault, this.directory);
    } catch {
      await vault.close();
      throw Error('LOCAL_CONNECTION_UNAVAILABLE');
    }
    this.vault = vault;
  }

  private async restore(input: Extract<z.infer<typeof request>, { op: 'restore' | 'recover' }>) {
    // Recovery is only offered on a fresh profile. Preserve even an empty or unrecognized
    // existing directory. The storage engine also creates this target exclusively at commit.
    if (this.vault) throw Error('RESTORE_TARGET_EXISTS');
    try {
      await lstat(this.directory);
      throw Error('RESTORE_TARGET_EXISTS');
    } catch (e) {
      if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
    }
    const header = backupOwner.safeParse(await readPrivateJSON(input.backupFile, 16 * 1024 * 1024));
    if (!header.success) throw Error('RESTORE_INPUT_INVALID');
    const { ownerId } = header.data;
    const restored = input.op === 'recover'
      ? await VaultSession.recover(input.backupFile, this.directory, ownerId, input.recoveryFile, input.password)
      : await VaultSession.restore(input.backupFile, this.directory, ownerId, input.password);
    // Do not restart capture, IPC, or remote reads until the user explicitly opens the restored vault.
    await restored.close();
  }

  private requireVault() {
    if (!this.vault) throw Error('VAULT_LOCKED');
    this.vault.assertUnlocked();
    return this.vault;
  }

  private async startWeb() {
    const vault = this.requireVault();
    if (this.attempt || (this.route && this.route.status?.() !== 'unavailable')) return;
    await this.stopWeb();
    const attempt: RouteAttempt = { abort: new AbortController(), signInUrl: null };
    this.attempt = attempt;
    // Setup may need interactive provider sign-in. Keep local lock/stop available throughout.
    const setup = async () => {
      try {
        const route = await this.openRoute(vault, dirname(this.directory), link => {
          if (this.attempt !== attempt) return;
          const url = new URL(link);
          const signIn = /^\/a\/[a-zA-Z0-9_-]+$/.test(url.pathname) && !url.search;
          const enableFunnel = url.pathname === '/f/funnel' && /^\?node=[a-zA-Z0-9_-]+$/.test(url.search);
          if (url.origin === 'https://login.tailscale.com' && !url.username && !url.password &&
              !url.hash && (signIn || enableFunnel)) attempt.signInUrl = url.href;
        }, attempt.abort.signal);
        if (this.attempt === attempt) this.route = route;
        else await route.close();
      } catch (e) {
        if (this.attempt === attempt) this.routeError = e instanceof Error && routeErrors.has(e.message) ? e.message : 'ROUTE_UNAVAILABLE';
      } finally {
        if (this.attempt === attempt) this.attempt = undefined;
      }
    };
    attempt.finished = setup();
  }

  private async stopWeb() {
    const attempt = this.attempt, route = this.route;
    this.attempt = undefined;
    this.route = undefined;
    this.routeError = undefined;
    attempt?.abort.abort();
    await Promise.all([attempt?.finished, route?.close()]);
  }

  async close() {
    const vault = this.vault, broker = this.broker;
    this.vault = undefined;
    this.broker = undefined;
    // Both listeners reject new work as soon as close starts. Keep the writer lock
    // until the old IPC descriptor is gone so a relaunch cannot overwrite it.
    try {
      const results = await Promise.allSettled([this.stopWeb(), broker?.close()]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally {
      await vault?.close();
    }
  }

  private async status() {
    const route = this.route;
    let state: WebState = 'off';
    if (this.attempt) state = 'starting';
    else if (this.routeError) state = 'unavailable';
    else if (route) state = route.status?.() ?? 'ready';
    const active = state === 'ready' ? route : undefined;
    return {
      exists: this.vault ? true : await this.vaultExists(),
      unlocked: !!this.vault,
      projects: this.vault?.listProjects() ?? [],
      web: {
        state, url: active?.url ?? null,
        error: this.routeError ?? (state === 'unavailable' ? (route?.error?.() ?? 'ROUTE_OFFLINE') : null),
        signInUrl: this.attempt?.signInUrl ?? null,
        requests: active?.auth.requests().map(r => ({ ...r, provider: desktopProviderForCallback(r.redirectUri) })) ?? [],
        connections: active?.auth.connections().map(c => ({ ...c, provider: desktopProviderForCallback(c.redirectUri) })) ?? [],
        audit: active?.audit() ?? [],
      },
    };
  }

  private async savePreference(input: Extract<z.infer<typeof request>, { op: 'addPreference' }>) {
    const { projectId, key, value, supersedesId } = input;
    await this.requireVault().mutate(engine => {
      // Recheck against the live state inside the serialized write. A concurrent approval
      // between the preview and the user's confirmation must not replace a different record.
      const prior = engine.snapshot().memories.find(m => m.status === 'active' && !m.applicability &&
        equivalentKeys(m.key, key) && (m.scope.type === 'global' ? projectId === null : m.scope.projectId === projectId));
      if (supersedesId && supersedesId !== prior?.id) throw Error('STALE_SUPERSESSION');
      if (prior && !supersedesId) throw new ReplacementRequired({ id: prior.id, key: prior.key, value: prior.value });
      const candidate = engine.propose({
        scope: projectId === null ? { type: 'global' } : { type: 'project', projectId },
        kind: projectId === null ? 'preference' : 'decision', key, value, supersedesId,
        source: { kind: 'user', reference: 'desktop:explicit-entry', excerpt: value },
        reason: '사용자가 기기에서 이 범위와 값을 확인하고 저장했습니다.',
      });
      engine.review(candidate.id, 'approve');
    });
  }

  async handle(raw: unknown) {
    const parsed = request.safeParse(raw);
    const inputId = z.object({ id }).safeParse(raw);
    const replyId = inputId.success ? inputId.data.id : null;
    if (!parsed.success) return { id: replyId, ok: false, error: 'INVALID_INPUT' };
    const input = parsed.data;
    try {
      switch (input.op) {
        case 'status': break;
        case 'create': case 'unlock': await this.openVault(input.password, input.op === 'create'); break;
        case 'lock': await this.close(); break;
        case 'backup': await this.requireVault().exportBackup(input.file); break;
        case 'issueRecovery': await this.requireVault().issueRecovery(input.password, input.file); break;
        case 'restore': case 'recover': await this.restore(input); break;
        case 'addProject': await this.requireVault().mutate(e => e.addProject(input.name)); break;
        case 'addPreference': await this.savePreference(input); break;
        case 'startWeb': await this.startWeb(); break;
        case 'stopWeb': await this.stopWeb(); break;
        case 'approve': {
          const pending = this.route?.auth.requests().find(r => r.id === input.requestId);
          if (!pending || !this.route) throw Error('CONNECTION_REQUEST_NOT_FOUND');
          if (!desktopProviderForCallback(pending.redirectUri)) throw Error('UNSUPPORTED_CALLBACK');
          this.route.auth.approve(input.requestId, input.projectId);
          break;
        }
        case 'deny':
          if (!this.route) throw Error('CONNECTION_REQUEST_NOT_FOUND');
          this.route.auth.deny(input.requestId);
          break;
        case 'revoke':
          if (!this.route?.auth.connections().some(c => c.id === input.connectionId)) throw Error('CONNECTION_NOT_FOUND');
          this.route.auth.revoke(input.connectionId);
          break;
      }
      return { id: input.id, ok: true, result: await this.status() };
    } catch (e) {
      if (e instanceof Error && 'code' in e) {
        if (e.code === 'EEXIST' && (input.op === 'backup' || input.op === 'issueRecovery'))
          return { id: input.id, ok: false, error: 'BACKUP_DESTINATION_EXISTS' };
        if (input.op === 'restore' || input.op === 'recover') {
          if (e.code === 'EEXIST') return { id: input.id, ok: false, error: 'RESTORE_TARGET_EXISTS' };
          if (e.code === 'ENOENT') return { id: input.id, ok: false, error: 'PRIVATE_FILE_UNAVAILABLE' };
        }
      }
      if (e instanceof ReplacementRequired) return { id: input.id, ok: false, error: e.message, previous: e.previous };
      return { id: input.id, ok: false, error: e instanceof Error && errors.has(e.message) ? e.message : 'OPERATION_FAILED' };
    }
  }
}

function dataDirectory() {
  if (process.platform !== 'win32') return join(homedir(), '.local', 'share', 'growth-brain');
  const local = process.env.LOCALAPPDATA;
  if (!local || !isAbsolute(local)) throw Error('LOCAL_APP_DATA_REQUIRED');
  return join(local, 'GrowthBrain', 'vault');
}

async function main() {
  if (process.stdin.isTTY || process.stdout.isTTY || process.argv.length !== 2) throw Error('DESKTOP_REQUIRED');
  const controller = new DesktopController(dataDirectory());
  // Only a parent-held pipe speaks this local user protocol. Do not expose it over the network or native/MCP APIs.
  process.stdout.on('error', () => process.stdin.destroy());
  let line = Buffer.alloc(0);
  try {
    for await (const chunk of process.stdin) {
      const bytes: Buffer = chunk;
      let start = 0;
      while (start < bytes.length) {
        const newline = bytes.indexOf(10, start);
        const part = bytes.subarray(start, newline < 0 ? bytes.length : newline);
        if (line.length + part.length > 65536) throw Error('REQUEST_TOO_LARGE');
        line = Buffer.concat([line, part]);
        if (newline === -1) break;
        let input: unknown;
        try { input = JSON.parse(line.toString('utf8')); } catch { input = null; }
        line.fill(0);
        line = Buffer.alloc(0);
        const reply = await controller.handle(input);
        await new Promise<void>((resolve, reject) =>
          process.stdout.write(JSON.stringify(reply) + '\n', error => error ? reject(error) : resolve()));
        start = newline + 1;
      }
    }
  } finally {
    line.fill(0);
    await controller.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { process.exitCode = 1; });
}
