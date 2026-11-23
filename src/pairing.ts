// A random challenge in each direction authenticates the local listener before
// the extension accepts a read request. The pairing token never crosses the socket.
export const isNonce = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);

export function pairingTranscript(side: 'relay' | 'device', client: string, server: string) {
  return new TextEncoder().encode(['growth-brain-pair-v1', side, client, server].join('\n'));
}

export function importPairingKey(token: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(token),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function answerChallenge(
  key: CryptoKey,
  client: string,
  message: { nonce: unknown; proof: unknown },
) {
  if (!isNonce(message.nonce) || typeof message.proof !== 'string' || !/^[a-f0-9]{64}$/.test(message.proof))
    return;
  const sig = Uint8Array.from(message.proof.match(/../g)!, (byte) => parseInt(byte, 16));
  if (!(await crypto.subtle.verify('HMAC', key, sig, pairingTranscript('relay', client, message.nonce)))) return;
  const proof = await crypto.subtle.sign('HMAC', key, pairingTranscript('device', client, message.nonce));
  return Array.from(new Uint8Array(proof), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
