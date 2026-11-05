# 잠금·삭제 보안 검토 — 2026-11-04

OpenAI security-best-practices/security-threat-model과 Trail of Bits sharp-edges의
암호 API·인증·설정·JavaScript/Python 경계 검토를 적용했다. 적용 출처는 [public-skills.md](public-skills.md).
사용자가 이미 정한 기기 로컬 금고/서버 암호문/AI 전달 맥락 공개라는 경계를 따른다.
모든 재현은 임시 합성 금고와 로컬 프로세스에서 수행한다. 외부 감사나 무취약성 인증이 아니다.

## GB-SCOPE-01 — 재개한 옛 세션에 다른 프로젝트 조회를 안내

2026-11-05 Mem0 소스 검토 중 자체 흐름을 대조해 재현했다. 폴더를 A에서 B로 재바인딩한 뒤
A에서 수집한 세션을 재개하면 SessionStart가 B의 projectId를 MCP에 전달하라고 안내했다.
수집 엔진의 세션 격리와 달리 조회 안내에는 검사가 빠져 있었다. 실제 AI의 다른 프로젝트 기억
회수까지 실행한 것은 아니지만, 잘못된 자동 조회 안내를 실제 훅/IPC에서 확인했다.

내부 binding 조회에 sessionId를 필수화하고 기존 client/session의 workspace/project가 다르면
새 세션을 요청하며 안내를 중단한다. 기존 동의 세대 검사와 새 세션/중지 상태를 유지한다.
수정 전 회귀 실패→수정 후 Codex/Claude 훅 프로세스 및 전체 Node67/67 통과.
[상세 검토](mem0-source-review-2026-11-05.md). 상태 v4/envelope v1/v2 변경 없음.

## GB-LOCK-01 — 잠금 시작 후 기존 연결이 요청을 완료할 수 있음

- 위험: medium. 같은 OS 사용자로 이미 연결한 클라이언트가 필요하다. 원격 비인증 공격으로 분류하지 않는다.
  사용자가 잠금 명령을 내렸는데 데이터 접근이 계속되거나 연결이 종료를 지연시키는 개인정보·가용성 문제다.
- 근거: 이전 `src/cli.ts::close`는 broker 종료를 기다린 뒤 vault를 닫았다.
  `src/broker.ts::startBroker.close`의 `server.close`는 연결 중인 소켓이 끝나기를 기다렸고
  기존 소켓의 data 핸들러는 계속 요청을 처리했다. 5초 idle timeout은 주기적으로 보내는 peer를 제한하지 못한다.
- 수정 전 실제 Unix socket 회귀: 종료 시작 뒤 partial get_context를 완성하자 read 횟수 **1**, 기대값 **0**으로 실패했다.
  실제 PTY에서도 partial peer를 둔 `lock`이 2초 내 종료하지 못해 실패했다.
- 수정: vault가 먼저 새 조회/쓰기를 거절하도록 closing을 설정한다. broker는 closing을 확인하고
  모든 열린 소켓을 종료한다. 중복 close는 같은 Promise를 사용하며 두 정리 작업 모두 기다린다.
  이미 수락한 쓰기는 암호화 저장을 마친 뒤 키를 지운다. 응답을 받지 못한 쓰기를 자동 재전송하지 않는다.
- 검증: `test/broker.test.mjs` 실제 socket, `test/lock-terminal.py` 실제 PTY;
  전체 Node 검사 60/60. 연결 종료는 EOF 또는 미완성 프레임의 reset을 허용하되 맥락 응답을 허용하지 않는다.
- 남는 경계: 잠금 전 전달된 맥락은 회수할 수 없다. 같은 OS 사용자 악성 프로그램·root·디버거로부터
  열린 금고를 격리하지 않으며 JS 힙의 모든 과거 문자열 복사본을 안전 소거한다고 주장하지 않는다.

## GB-DELETE-01 — 로컬 삭제 후 앱이 만든 전환 백업 잔존

- 위험: medium. 삭제 전에 v1~v3 금고를 연 경우 전환 전 암호문이 같은 디렉터리에 생성된다.
  이전 `deleteAll`은 vault.json만 지워 이 자동 백업과 기존 비밀번호/복구 수단으로 과거 기억을 복원할 수 있었다.
  평문 유출이나 암호 파괴가 아니라 사용자가 의도한 앱 관리 데이터 삭제 범위의 결함이다.
- 수정 전 합성 v3 금고에서 실제 자동 백업을 생성하고 과거 프로젝트 복호화를 확인한 뒤 deleteAll을 호출했다.
  백업에 대한 ENOENT 기대가 실패해 잔존을 확인했다(`test/vault.test.mjs`).
- 수정: 관리 이름 패턴의 파일을 열거하고 **전체 파일을 먼저** 일반 파일/비공개 권한/OS 소유자/
  envelope 형식/owner ID로 검사한다. 전환 백업을 먼저, 현재 금고를 마지막에 지운다.
  현재 키로 오래된 백업을 복호화하지 않는다. 키 회전 후에도 예약 이름과 같은 소유자 헤더를 기준으로 관리하며
  이는 헤더의 암호학적 소유권 재인증이 아니다. 수동 export의 같은 디렉터리 예약 이름은 거절한다.
- 삭제 작업을 금고의 직렬 작업 큐에 포함해 동시 close/signal이 삭제 도중 프로세스 잠금을 먼저 풀지 않게 했다.
  사전검사 실패는 파일을 지우지 않고 잠금 종료, 파일 제거 중 실패는 일부 삭제 가능성을 알린다.
  CLI는 성공/불완료를 구분하며 실패 시 종료 코드1이다. 비밀 내용·원시 예외를 출력하지 않는다.
- 검증: 실제 생성된 v3 전환 백업 삭제; 동시 쓰기/close; 수동 백업/무관 파일 보존;
  symlink·다른 owner·공개 권한·손상 파일 사전 거절과 재개방; 실제 PTY 취소/성공/실패 출력 및 비밀번호 비노출.
- 남는 경계: 외부 백업·수동 export·개인 복구 파일·AI 보유 맥락·원격 회원 데이터는 별도다.
  파일 unlink는 디스크/SSD/스냅샷 안전 소거가 아니다. 같은 OS 사용자에 의한 파일 교체 경쟁을 격리하는 보안 경계가 아니다.

## 종합 검증과 제한

`npm run test:local` 통과: Node 66/66(사전검사 하위 사례4 포함), 고정 원문17/101,
ign8t 설정 설치, Codex 설정/스킬 설치, Codex·Claude 훅 설정 설치, native 설치,
실제 PTY 기본 흐름/잠금/삭제실패/복구, 실제 Chromium 합성 DOM+mock Chrome API.
Node 검사에는 실제 stdio MCP/native framing/훅 어댑터 subprocess·socket 통신이 포함된다.
`npm audit --json` 결과 알려진 취약점0건. 이는 의존성 advisory 범위이며 로직·공급망 무결성 전체를 보증하지 않는다.

실제 AI 개인화, 클라이언트가 승인된 훅을 자동 실행한 증거, 설치된 확장/로그인된 사이트,
Supabase 현재 스키마·RLS·원격 동기화/삭제는 이 검사로 증명되지 않는다. 앞선 실제 검증의
Codex 인증401, Chrome ExtensionInstallBlocklist ["*"], Claude Code 부재, 안전한 Supabase 연결 부재는
해결됐다고 표시하지 않았다. 이번 로컬 수정 때문에 이를 반복 시도하거나 정책을 우회하지 않았다.
위협별 잔여 위험과 검토 경로는 [growthbrain-threat-model.md](growthbrain-threat-model.md).
