import { answerChallenge, importPairingKey } from './pairing.ts';
import type { Service } from './memory.ts';

declare const __GB_DEVICE_ORIGIN__: string;

type Request = { service: Service; projectId: string; query: string };
export type DeviceContext =
  | { status: 'missing' }
  | { status: 'found'; projectId: string; option: number; version: number; text: string }
  | { status: 'resume'; projectId: string; decisions: string[]; references?: string[]; preference?: '별도 요청이 없으면 제목은 짧게 씁니다.' }
  | { status: 'preference'; projectId: string; preference: '별도 요청이 없으면 제목은 짧게 씁니다.' };
let lookup: (request: Request) => Promise<DeviceContext>;
let active: WebSocket | undefined;
let generation = 0;
const alarmName = 'growth-brain-device';
async function connect() {
  const epoch = generation;
  const { pairToken } = await chrome.storage.session.get('pairToken');
  if (typeof pairToken !== 'string' || !pairToken || active || epoch !== generation) return;
  const ws = new WebSocket(__GB_DEVICE_ORIGIN__ + '/device');
  active = ws;
  let phase: 'hello' | 'challenge' | 'proof' | 'ready' = 'hello';
  const nonce = crypto.randomUUID();
  const key = importPairingKey(pairToken);
  const deadline = setTimeout(() => {
    if (phase !== 'ready') ws.close();
  }, 5_000);
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN && phase === 'ready') ws.send(JSON.stringify({ type: 'ping' }));
  }, 20_000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', nonce }));
  ws.onclose = () => {
    clearInterval(timer);
    clearTimeout(deadline);
    if (active === ws) active = undefined;
  };
  ws.onerror = () => ws.close();
  ws.onmessage = async (e) => {
    if (active !== ws || typeof e.data !== 'string' || e.data.length > 64_000) return;
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'challenge' && phase === 'hello') {
        phase = 'challenge';
        const proof = await answerChallenge(await key, nonce, m);
        if (!proof) {
          ws.close();
          return;
        }
        if (active !== ws || ws.readyState !== WebSocket.OPEN) return;
        phase = 'proof';
        ws.send(JSON.stringify({ type: 'pair', proof }));
        return;
      }
      if (m.type === 'ready' && phase === 'proof') {
        phase = 'ready';
        clearTimeout(deadline);
        return;
      }
      if (
        phase !== 'ready' ||
        m.type !== 'get_context' ||
        typeof m.id !== 'string' ||
        m.id.length > 128 ||
        (m.service !== 'chatgpt' && m.service !== 'claude') ||
        typeof m.projectId !== 'string' ||
        m.projectId.length > 180 ||
        typeof m.query !== 'string' ||
        m.query.length > 32_000
      )
        return;
      const context = await lookup(m).catch(() => ({ status: 'missing' }));
      if (active === ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'result', id: m.id, context }));
    } catch {
      ws.close();
    }
  };
}

export async function reconnectRelay() {
  generation++;
  active?.close();
  active = undefined;
  await chrome.alarms.clear(alarmName);
  if ((await chrome.storage.session.get('pairToken')).pairToken) {
    await chrome.alarms.create(alarmName, { periodInMinutes: 0.5 });
    await connect();
  }
}

export function startRelay(read: typeof lookup) {
  lookup = read;
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === alarmName) void connect();
  });
  void connect();
}
