import { randomBytes } from 'node:crypto';
import { connect as connectPipe, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import { connect, createServer, type SecureContextOptions } from 'node:tls';
import { z } from 'zod';
import { readPrivateJSON, writePrivateJSON } from './secure-files.js';

// The private vault directory is the only channel used to distribute a session
// key. A pipe name or a successful TCP-like connect is never authentication.
const descriptor = z.object({
  format: z.literal('growth-brain-native-v1'),
  session: z.string().regex(/^[a-f0-9]{48}$/),
  key: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
type Descriptor = z.infer<typeof descriptor>;

const pskOptions: SecureContextOptions = {
  minVersion: 'TLSv1.2',
  maxVersion: 'TLSv1.2',
  ciphers: 'PSK-AES256-GCM-SHA384',
};
const identity = 'growth-brain-native';
function namedPipe(session: string) {
  return '\\\\.\\pipe\\growth-brain-' + session;
}

export function authenticatedServer(key: Buffer, accept: (socket: Socket) => void) {
  return createServer({
    ...pskOptions,
    handshakeTimeout: 3000,
    pskIdentityHint: identity,
    pskCallback: (_, peer) => peer === identity ? key : null,
  }, accept);
}

export function authenticatedClient(path: string, key: Buffer) {
  return connect({
    ...pskOptions,
    path,
    // The only negotiated cipher authenticates possession of the session PSK.
    // PSK peers do not send an X.509 certificate or a hostname.
    checkServerIdentity: () => undefined,
    pskCallback: hint => hint === identity ? { identity, psk: key } : null,
  });
}

async function readDescriptor(file: string): Promise<Descriptor> {
  return descriptor.parse(await readPrivateJSON(file, 1024));
}

async function removeOwnedDescriptor(file: string, session: string) {
  const current = await readDescriptor(file);
  if (current.session !== session) throw Error('NATIVE_REGISTRATION_CHANGED');
  await unlink(file);
}

async function pipeAbsent(path: string) {
  return new Promise<boolean>(resolve => {
    const socket = connectPipe(path);
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ENOENT'));
  });
}

export async function listenWindowsNative(file: string, accept: (socket: Socket) => void) {
  // The caller already holds the vault writer lock. A crash may have left this
  // specific owned record behind. Never replace a live endpoint or other file.
  let previous;
  try { previous = await readDescriptor(file); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (previous) {
    if (!await pipeAbsent(namedPipe(previous.session))) throw Error('NATIVE_ALREADY_CONNECTED');
    await removeOwnedDescriptor(file, previous.session);
  }

  const session = randomBytes(24).toString('hex');
  const key = randomBytes(32);
  const server = authenticatedServer(key, accept);
  const pending = new Set<Socket>();
  server.maxConnections = 64;
  server.on('connection', socket => {
    pending.add(socket);
    socket.once('close', () => pending.delete(socket));
  });
  const stop = () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    for (const socket of pending) socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(namedPipe(session), resolve);
    });
    await writePrivateJSON(file, { format: 'growth-brain-native-v1', session, key: key.toString('hex') }, true, 1024);
  } catch (error) {
    if (server.listening) await stop();
    key.fill(0);
    throw error;
  }
  return async () => {
    try { await stop(); } finally { key.fill(0); }
    await removeOwnedDescriptor(file, session);
  };
}

export async function openWindowsNative(file: string) {
  const { session, key: encodedKey } = await readDescriptor(file);
  const key = Buffer.from(encodedKey, 'hex');
  const socket = authenticatedClient(namedPipe(session), key);
  socket.once('close', () => key.fill(0));
  return socket;
}
