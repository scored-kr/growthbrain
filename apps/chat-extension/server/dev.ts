import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { startRelay } from './relay.ts';
import { serviceForCallback } from './services.ts';

const token = process.env.GB_DEVICE_TOKEN;
if (!token) throw Error('GB_DEVICE_TOKEN must be a per-run 32-byte base64url secret.');
const relay = await startRelay({
  token,
  deviceOrigin: process.env.GB_DEVICE_ORIGIN || undefined,
  publicOrigin: process.env.GB_PUBLIC_ORIGIN || undefined,
  httpPort: process.env.GB_MCP_PORT ? Number(process.env.GB_MCP_PORT) : undefined,
});
stdout.write(
  'Growth Brain MCP ' +
    relay.url +
    '\n로컬 개발 명령: requests, reads, approve <요청 번호> <프로젝트 ID>, deny <요청 번호>, quit\n',
);
const cli = createInterface({ input: stdin, output: stdout });
cli.on('line', (line) => {
  const [cmd, id, projectId] = line.trim().split(/\s+/u);
  try {
    if (cmd === 'requests') {
      for (const req of relay.auth.requests())
        stdout.write(req.id + ' ' + serviceForCallback(req.redirectUri) + ' ' + req.redirectUri + '\n');
    } else if (cmd === 'reads') {
      // HTTP response completion, scoped to the service. It does not identify a chat tab.
      for (const read of relay.reads())
        stdout.write(
          [
            read.at,
            read.service,
            read.projectId,
            read.version === undefined ? '확인된 제목 취향' : read.option + '안 v' + read.version,
          ].join(' ') + '\n',
        );
    } else if (cmd === 'approve' && id && projectId) {
      relay.auth.approve(id, projectId);
      stdout.write('승인했습니다.\n');
    } else if (cmd === 'deny' && id) {
      relay.auth.deny(id);
    } else if (cmd === 'quit') cli.close();
  } catch {
    stdout.write('장치 연결, 요청 번호와 프로젝트를 확인하세요.\n');
  }
});
cli.on('close', () => {
  void relay.close();
});
