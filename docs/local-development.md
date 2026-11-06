# 로컬 개발과 제품 MCP

## 설치와 실행

필수: Linux/macOS, Node.js 24 이상. Windows Unix socket·터미널 지원은 검증하지 않았다.
이 클라우드에서 합성 데이터로 개발하더라도 실제 사용자의 금고는 사용자 기기에서 실행한다.

```sh
npm ci
npm test
# 아래 명령은 사용자가 자신의 로컬 터미널에서 실행한다.
npm run vault -- init
# 이후 세션
npm run vault -- serve
```

별도 로컬 터미널에서 비밀번호를 비표시 입력하고 `CONNECT`로 AI 전달 범위를 확인한다.
비밀번호를 명령줄·환경 변수·MCP·채팅에 넣지 않는다. 비밀번호 기반 잠금 해제와 선택형 로컬 복구 파일을 지원한다.
[복구 키 발급·분실 복구](recovery-keys.md)는 별도 사용자 터미널에서 진행한다.
실제 사용자 데이터는 베타 보안·복구 검증 전 사용하지 않는다.

터미널 명령:

- `project`: 프로젝트를 생성하고 UUID를 표시한다.
- `projects`: 현재 금고의 프로젝트 목록.
- `memories`: 상태·범위·출처·변경 사유와 함께 전체 기억을 확인한다.
- `backup`: 새 파일 경로에 암호문 백업을 저장한다. 기존 파일을 덮어쓰지 않는다.
- `propose`: 명시적으로 공통 또는 프로젝트 범위를 선택해 기억 후보를 만든다.
- `propose-task`: 적용할 업무 종류까지 명시한 후보를 만든다. [업무별 조건](preference-applicability.md)을 따른다.
- `candidates`, `review`: 후보·출처·변경 대상을 보고 APPROVE 또는 REJECT를 입력한다.
- `correct`: 값과 사유를 확인하고 SAVE로 새 승인 대기 후보를 만든다. 원래 후보와 출처는 보존한다.
- `retire`: 확정 기억을 RETIRE로 사용 중지한다. 이력은 보존하고 조회·검색에서 제외한다.
- `route-set`, `route-clear`, `routes`: 사용자 지정 프로젝트 트리거를 등록·해제·확인한다.
- `lock`: 소켓을 종료하고 메모리상의 키 버퍼를 지운다.
- `delete-all`: DELETE 확인 후 현재 금고와 앱 관리 전환 백업을 삭제한다. 수동 export·복구 파일·
  AI 서비스에 전달된 내용·원격 데이터는 별도다. 아래 보호 범위와 실패 처리를 확인한다.

같은 범위·키의 기존 결정을 바꾸려면 기존 기억 UUID를 `supersedesId`로 명시해야 한다.
확정된 이전 기억은 superseded로 전환된다. 모델의 제안만으로 승인되지 않는다.

백업은 다음 명령으로 **아직 존재하지 않는 새 디렉터리**에 복원한다. 사용자 터미널에서
원래 비밀번호를 비표시 입력하고 암호 인증/데이터 불변식을 통과해야 복원된다.
기존 금고는 변경하지 않는다. 비밀번호 분실 시에는 위 복구 문서의 `recover` 경로를 사용한다.

```sh
npm run vault -- restore /absolute/new-vault-directory /absolute/private-directory/backup.enc
```

## MCP 연결

일반 웹 채팅용 사용자 기기 HTTPS 연결은 [웹 MCP 안내](web-mcp.md)를 따른다. 열린 로컬 터미널의
`web-start`, `web-requests`, `web-approve`, `web-deny`, `web-connections`, `web-revoke`, `web-audit`,
`web-stop`으로 관리한다. 계정 비밀번호/복구 키를 AI나 HTTP로 전달하지 않는다.

Codex/Claude Code 자동 대화 수집은 [에이전트 훅 설치·동의](agent-capture.md)를 따른다.
터미널 `agent-bind`, `agent-stop`, `agent-status`로 정확한 작업 폴더/프로젝트의 동의를 관리한다.

제품 서버: `node /absolute/path/growthbrain/dist/mcp.js` (stdio).
기본 소켓: `~/.local/share/growth-brain/memory.sock`.
별도 금고 경로 사용 시 `GROWTH_BRAIN_SOCKET`에 해당 소켓 경로를 지정한다. 경로는 비밀값이 아니다.

- `get_context(projectId?, query?, taskType?, requestConditions?, maxCharacters?)`: 공통을 항상 먼저 읽으며
  명시 프로젝트 또는 단일 사용자 트리거에 해당하는 프로젝트를 추가 조회한다. 현재 명시 요청을
  일회성으로 우선 적용한다. 생략 시 `omittedCount`, 모호한 선택은 `routing`에 표시한다.
- `search_memory(projectId?, query, taskType?, limit?, requestConditions?)`: 공통/프로젝트별 로컬 역색인 검색.
  추가 검색마다 `get_context`와 같은 현재 명시 요청 조건을 전달한다. 그 조건으로 덮어쓴
  저장 기억은 제외하며 현재 요청을 확정 기억으로 저장하거나 검색 결과에 추가하지 않는다.
  `matches`, 관련도/일치어(`matchedTerms`)/조건(`matchedTopics`), `routing`, `searchedScopes`,
  크기/개수 제한의 `omittedCount`를 반환한다.
  확정된 프로젝트 UUID도 추가 검색에 전달한다. [색인 구조와 평가 한계](memory-index.md)를 참고한다.
- `propose_memory(scope, kind, key, value, source, reason, supersedesId?, applicability?)`: 후보만 저장.

`taskType`은 writing/translation/campaign/analysis/coding 중 현재 요청의 명확한 업무다.
`applicability.taskTypes`가 있는 기억은 일치하는 업무에만 적용하고, taskType 생략 시 제외한다.
후속 검색에도 동일한 업무를 전달한다. `taskExcludedCount`는 업무 때문에 제외한 active 기억 수다.
일반 자연어 적용 판단이나 권한 검사가 아니며 [계약·한계](preference-applicability.md)를 확인한다.

도구에 승인·비밀번호·복구 키·로그인 기능은 없다. 잠금 상태는 `VAULT_LOCKED`로 거부한다.
조회·검색은 앞선 호출의 일회성 조건을 기억하지 않는다. `requestConditions`는 최대 50개이며
생략하면 저장된 프로젝트/공통 조건만 적용한다. 이 규칙은 다른 세션으로 조건이 섞이는 것을 막는다.
AI가 조립한 현재 요청이나 기억의 의미를 암호화가 검증하지는 않는다. 범위·출처를 사용자가
검토하고, 후보 승인과 실제 결과물 적용을 구분한다.

## 보호 범위와 제약

- AES-256-GCM + scrypt(N=32768,r=8,p=1), 무작위 salt와 저장별 새 nonce를 사용한다.
- 프로젝트 이름, 기억, 선호도, 원문 발췌 및 출처를 함께 암호화한다. 버전·무작위 owner ID·salt·
  nonce·인증 태그·암호문 길이는 외부 메타데이터다.
- 소켓/금고 파일은 0600, 디렉터리는 0700이다. 단일 프로세스 쓰기 잠금과 원자적 파일 교체를 사용한다.
- 사용자 OS 계정 및 장치의 신뢰가 필요하다. 같은 OS 사용자로 실행되는 악성 프로그램이나
  셸 권한을 가진 AI로부터 열린 금고를 격리하는 샌드박스는 아니다. 로컬 검토 UI도 이 경계를 따른다.
- 잠금 시 키 버퍼는 지우지만 JS 런타임의 모든 과거 문자열·힙 복사본 완전 삭제는 보장하지 않는다.
- `lock`은 새 조회/쓰기를 즉시 막고 열린 IPC 연결을 끊는다. 이미 수락된 쓰기는 저장 완료를
  기다린 후 키를 지운다. 연결이 끊겨 응답을 받지 못한 쓰기를 자동 반복하지 않는다.
- `delete-all`은 별도 DELETE 확인 후 현재 금고와 같은 디렉터리의 앱 관리 전환 백업을 삭제한다.
  관리 백업 예약 이름은 `pre-state-v<양의 정수>-<24자리 소문자 hex>.enc`다. 현재/백업 파일의
  일반 파일 여부·OS 소유자·0600 권한·envelope 형식/owner ID를 모두 먼저 확인한다.
  이름/헤더 확인은 과거 암호문을 현재 키로 재인증한다는 뜻이 아니다(키가 회전했을 수 있다).
  수동 export는 그 디렉터리의 예약 이름을 사용할 수 없다. 해당 이름을 임의 파일에 쓰지 않는다.
- 사용자가 내보낸 백업은 같은 디렉터리에 있어도 자동 삭제하지 않는다. 별도 복구 파일, OS/클라우드
  파일 백업, 원격 회원 데이터, AI가 받은 맥락도 남는다. 확인되지 않은 파일을 재귀 삭제하지 않는다.
  파일 검사 실패 시 아무 관리 파일도 지우지 않고 잠근다. 실제 unlink 중 실패는 일부만 삭제될 수 있어
  완료로 표시하지 않고 종료 코드1을 반환한다. 남은 금고/백업을 확인한 뒤 재시도한다.
  파일 삭제는 저장 매체의 안전 소거가 아니며 원격 전체 삭제는 별도 기능/검증이다.
- 상태 전체를 암호화하며 최대 파일 16 MiB/기억 10,000개를 제한한다. 분할 저장·증분 동기화와
  서버 회원별 용량 정책은 별도 작업이다. 검색은 어휘+제한된 조건 개념 보조이며 임베딩 기반
  일반 의미 검색은 없다. [기억 품질 평가](memory-quality.md)에서 범위와 알려진 누락을 확인한다.
- 내부 상태는 업무별 적용 조건과 채팅 import 출처를 포함한 v6다. v1~v5는 인증 후 메모리에서 변환하며 다음 저장 때
  기록한다. 기존 금고를 열면 전환 전 암호문을 `pre-state-v6-<24자리 hex>.enc`로 보존한다.
  암호문 envelope v1/v2와 별개이며 Git revert로 사용자 데이터가 이전 상태로 돌아가지는 않는다.
- 캡처 설정은 사이트별 동의와 프로젝트 ID를 금고 안에 저장한다. 최대 5,000개 캡처, 동일
  메시지 재전송 중복 제거, 본문 편집 revision을 지원한다. 사용자 발언의 규칙 추출은 후보만 만든다.
- 잠금 파일이 남는 비정상 종료에서는 프로세스와 소켓의 종료를 먼저 확인한다. 자동으로 잠금 파일을
  삭제하거나 기존 소켓을 덮어쓰지 않는다.
- Supabase 인증·현재 스키마·RLS·계정 간 격리·원격 전체 삭제는 아직 실제 검증하지 않았다.
  로컬 owner ID 검증을 Supabase 로그인이나 원격 다중 사용자 보안 검증으로 간주하지 않는다.
- 테스트는 합성 데이터로 수행한다. AI 서비스에 반환한 맥락은 그 서비스가 읽는다.

## 검증 기준

`npm test`는 엔진/암호화 및 실제 별도 프로세스 stdio MCP 통신을 검사한다. 로컬 소켓 생성 권한이
필요하며 제한된 샌드박스에서 EPERM이면 해당 통합 테스트가 통과한 것이 아니다.
실제 Codex/Claude가 모델 응답에 기억을 적용하는 검증은 별도이며 프로토콜 통과로 대체하지 않는다.

일반 채팅의 기존 파일은 [ChatGPT·Claude 가져오기 화면](chat-history-import.md)에서 처리한다. 별도 동의와 후보 검토가 필요하며 사이트 수집/MCP 승인 기능과 구분한다.

프로젝트 진행 상태는 [handoff.md](handoff.md)의 `handoff-propose` → 로컬 검토 → `get_context.handoff`로 전달합니다. 내부 상태는 v8이며 이전 금고의 암호문 마이그레이션 백업을 보존합니다.

확장 팝업의 **기억 관리 열기**에서 [로컬 관리 화면](local-management.md)을 엽니다. `npm run test:ui`는 관리 화면의 실제 native/broker/합성 금고 연결도 검사합니다. 설치된 확장 검증과는 구분합니다.

선택적 기기 내 모델 분석: [local-inference.md](local-inference.md). `analysis-enable` / `analysis-stop`은 로컬 사용자 터미널 명령이며 MCP에 노출하지 않습니다.

분할 저장은 로컬 터미널의 `storage-upgrade`로 명시 전환합니다. 기존 전체 암호문과 복구 가능한 전체 백업을 보존합니다. 증분 파일 사용법과 현재 네트워크 동기화 미연결 범위는 [chunk-storage.md](chunk-storage.md)를 확인하세요.
