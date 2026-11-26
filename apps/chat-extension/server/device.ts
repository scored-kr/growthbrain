import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { z } from 'zod';
import { maxDecisionLength, maxProjectDecisions, maxProjectReferences, maxReferenceLength } from '../src/approval-state.ts';
import { deviceOrigin } from '../src/device-origin.ts';
import { isNonce, pairingTranscript } from '../src/pairing.ts';

const manuscript = z
  .object({
    status: z.literal('found'),
    projectId: z.string().min(1).max(256),
    option: z.number().int().positive(),
    version: z.number().int().positive(),
    text: z.string().min(1).max(128_000),
  })
  .strict();
const preference = z
  .object({
    status: z.literal('preference'),
    projectId: z.string().min(1).max(256),
    preference: z.literal('별도 요청이 없으면 제목은 짧게 씁니다.'),
  })
  .strict();
const resume = z.object({
  status: z.literal('resume'),
  projectId: z.uuid(),
  decisions: z.array(z.string().min(1).max(maxDecisionLength)).max(maxProjectDecisions),
  references: z.array(z.string().min(1).max(maxReferenceLength)).min(1).max(maxProjectReferences).optional(),
  preference: preference.shape.preference.optional(),
}).strict().refine(value => value.decisions.length > 0 || Boolean(value.references?.length));
export const context = z.discriminatedUnion('status', [manuscript, preference, resume]);
type Context = z.infer<typeof context>;
export type Service = 'chatgpt' | 'claude';
type Waiting = {
  projectId: string;
  settle: (value?: Context) => void;
};

const reply = z.object({ type: z.literal('result'), id: z.uuid(), context }).strict();

// This private listener is separate from the connector HTTP ingress. The sole paired
// device represents one browser profile. Nothing is queued for an offline device.
export async function openDevice(token: string, port = 43127, requestedOrigin?: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error('INVALID_DEVICE_TOKEN');
  const expectedHost = requestedOrigin ? new URL(deviceOrigin(requestedOrigin)).host : undefined;
  const mac = (side: 'relay' | 'device', client: string, server: string) =>
    createHmac('sha256', token)
      .update(pairingTranscript(side, client, server))
      .digest();
  const pending = new Map<string, Waiting>();
  const http = createServer((_req, res) => res.writeHead(404).end());
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 768_000, perMessageDeflate: false });
  let device: WebSocket | undefined;
  http.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin;
    if (
      req.url !== '/device' ||
      req.headers.host !== (expectedHost ?? '127.0.0.1:' + (http.address() as AddressInfo).port) ||
      (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) ||
      sockets.clients.size >= 8
    ) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (peer) => sockets.emit('connection', peer));
  });
  sockets.on('connection', (peer) => {
    let expected: Buffer | undefined;
    const cutoff = setTimeout(() => peer.terminate(), 4000);
    peer.on('error', () => peer.terminate());
    peer.on('close', () => {
      clearTimeout(cutoff);
      if (device === peer) {
        device = undefined;
        for (const item of pending.values()) item.settle();
      }
    });
    peer.on('message', (raw, binary) => {
      try {
        if (binary) throw Error();
        const data = JSON.parse(raw.toString());
        if (device !== peer) {
          if (device) throw Error();
          if (!expected && data.type === 'hello' && isNonce(data.nonce)) {
            const nonce = randomUUID();
            expected = mac('device', data.nonce, nonce);
            peer.send(
              JSON.stringify({ type: 'challenge', nonce, proof: mac('relay', data.nonce, nonce).toString('hex') }),
            );
            return;
          }
          if (
            !expected ||
            data.type !== 'pair' ||
            typeof data.proof !== 'string' ||
            !/^[a-f0-9]{64}$/.test(data.proof) ||
            !timingSafeEqual(expected, Buffer.from(data.proof, 'hex'))
          )
            throw Error();
          expected = undefined;
          clearTimeout(cutoff);
          device = peer;
          peer.send(JSON.stringify({ type: 'ready' }));
          return;
        }
        if (data.type === 'ping') {
          peer.send(JSON.stringify({ type: 'pong' }));
          return;
        }
        if (data.type !== 'result' || typeof data.id !== 'string') return;
        const item = pending.get(data.id);
        if (!item) return;
        const valid = reply.safeParse(data);
        item.settle(
          valid.success && valid.data.context.projectId === item.projectId ? valid.data.context : undefined,
        );
      } catch {
        peer.close(1008);
      }
    });
  });
  await new Promise<void>((ok, fail) => {
    http.once('error', fail);
    http.listen(port, '127.0.0.1', ok);
  });
  return {
    port: (http.address() as AddressInfo).port,
    online: () => device?.readyState === WebSocket.OPEN,
    read(service: Service, projectId: string, query: string): Promise<Context> {
      const peer = device;
      if (peer?.readyState !== WebSocket.OPEN || pending.size >= 16)
        return Promise.reject(Error('CONTEXT_UNAVAILABLE'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const settle = (context?: Context) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          if (context) resolve(context);
          else reject(Error('CONTEXT_UNAVAILABLE'));
        };
        const timer = setTimeout(settle, 5000);
        pending.set(id, { projectId, settle });
        peer.send(JSON.stringify({ type: 'get_context', id, service, projectId, query }), (err) => {
          if (err) settle();
        });
      });
    },
    async close() {
      for (const peer of sockets.clients) peer.terminate();
      for (const item of pending.values()) item.settle();
      sockets.close();
      await new Promise<void>((done) => http.close(() => done()));
    },
  };
}
