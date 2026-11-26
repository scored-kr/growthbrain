# 새 기기에서 개발 이어받기

## 같은 PC의 일반 채팅 수집과 인계

Chrome 시험 확장 0.3.0은 동의한 ChatGPT·Claude 일반 대화에서 화면에 표시된 발화 본문을 현재 프로필에 암호화해 기록한다. 팝업에서 저장된 문장을 확인한 뒤 내 발언은 프로젝트 조건으로, AI 답변은 참고자료로 승인할 수 있다. 새 채팅의 `/gb`는 입력창에 제품 MCP의 `get_context` 호출 요청을 작성한다. 실제 조회에는 그 서비스와 프로젝트에 대한 MCP 연결·승인이 필요하다. 이 확장의 기록은 현재 Chrome 프로필에 있으며 아래 두 PC 계정 금고와 별개다. 설치·보관 범위·시험 명령은 [일반 채팅 확장 안내](../apps/chat-extension/README.md)에 있다.

이그넷은 구현과 회귀 검증을 `ff8e630a-f75b-4b20-b885-29962412cfcc`에서, 실제 로그인한 ChatGPT와 Claude가 새 일반 채팅에서 도구를 선택하고 허용된 조건으로 답하는 인수 시험을 `ead9b252-9bec-4eaf-9172-9b45aa710122`에서 추적한다.

## 두 PC 계정 로그인과 승인 기억 복원

현재 목표는 PC A를 끈 뒤, 새 PC B에서 같은 계정으로 로그인해 이전 공통 선호도와 프로젝트 결정을 이어 쓰는 것이다. 대상 이그넷 작업은 `8a37371d-bd71-49e0-bd90-d3df212a0e01`이다. 최신 이그넷 요구사항에 따라 유료 스펙 생성 없이 진행했다. 이전 챕터의 로컬 금고 생성·백업·복원 절차는 **기존 로컬 데이터 사용**을 따로 선택한 경우에 해당한다. [두 PC 시험 안내](windows-test-guide.md)

| 구현 | 검증과 제한 |
| --- | --- |
| 계정 비밀번호에서 로그인 자격과 복호화용 키를 별도로 파생하고, 검증한 계정과 무작위 금고 ID에 암호문을 결속 | 서로 다른 기기에서 파생값 재현, 계정 혼동·변조 거부, 제공자 측 비밀번호 재설정 후 원문 접근 거부. 비밀번호를 잃었을 때 원래 데이터를 읽으려면 원래 복호화 자격이 필요하다. [키와 보호 범위](account-vault-keys.md) |
| 계정별 동기화, 저장 한도, 조건부 쓰기와 삭제 세대, 새 기기에서 복원 | 격리된 PostgreSQL의 합성 회원으로 조회·수정·삭제 권한과 충돌·삭제 후 오래된 사본 차단 검사. 한 기기가 꺼져 있으면 그 기기의 로컬 파일을 즉시 지울 수 없다. |
| Windows 계정 로그인, 선택적 신뢰 기기, 관리형 웹 연결 | 기기 자격은 Windows 사용자 DPAPI로 보관하며 공유·잠금된 기기의 외부 읽기 접근을 차단한다. 웹 읽기 승인은 서비스·프로젝트별이다. 운영자가 준비한 계정별 시험 네트워크가 필요하다. [발급 서비스 준비](managed-route-pilot.md) |
| PC A 종료 후 B에서 양쪽 MCP 조회 | 독립 프로세스와 서로 다른 프로필, 대역 인증 API, PostgreSQL 및 실제 HTTPS·OAuth·MCP를 사용한다. `get_context`에 사용자의 문장만 보내고 허용된 공통 조건과 프로젝트 결정을 확인한다. 개인 계정의 실제 ChatGPT·Claude 일반 채팅이 차례로 도구를 선택하고 답변을 생성하는 실측은 별도로 기록한다. |

### 오프라인 편집과 재연결

로그인한 두 PC가 오프라인에서 따로 승인한 기억은 어느 쪽이 먼저 연결돼도 원래 ID를 유지해 합쳐진다. 같은 프로젝트에서 같은 결정을 서로 다르게 고친 경우 두 값이 검토 화면에 나온다. 충돌을 발견한 PC는 검토가 끝날 때까지 외부 읽기를 중지한다. 선택 뒤에는 선택한 값만 현재 결정으로 제공하고 양쪽 편집 이력을 보관한다. 검토 화면이 열린 뒤 다른 PC가 다시 수정하면 최신 두 값을 다시 비교해야 한다.

기기는 암호화한 공통 기준과 진행 중인 쓰기를 로컬에 기록한다. 서버 확정 전의 단절, 확정 응답 유실 후 추가 편집·재시작, 다운로드한 변경을 로컬에 적용하는 도중의 중단을 시험했다. 아직 유효한 로그인 세션에서 오프라인 편집할 수 있다. 새 기기 로그인과 세션 만료 후 재인증에는 연결이 필요하다. 구형 사본의 공통 기준을 입증할 수 없거나 적용 범위가 일부만 겹쳐 값 하나를 고르면 다른 지시까지 사라지는 경우에는 양쪽을 보존하고 자동 병합을 중지한다.

격리된 GoTrue·PostgREST·PostgreSQL에서도 A 프로세스를 종료하고 프로필을 지운 뒤 새 B가 인증해 복원했다. ChatGPT·Claude 콜백을 재현한 두 클라이언트가 각각 서비스·프로젝트별 승인을 받아 제품 HTTPS MCP에 **지난번 정한 조건대로 다음 작업을 진행해줘** 한 문장을 전달했다. 반환값은 **한국어로 답변**, **뉴스레터 사용** 두 개였고 타 프로젝트 결정·대체 이력·미승인 후보는 빠졌다. 별도 계정으로 전환한 뒤 이전 토큰도 거부됐다. 서버에는 저장 직후의 암호문과 재시도 후의 암호문이 바이트 단위로 같았다. 이 검사는 저장소의 후보 스키마로 재현하며, 실제 일반 채팅의 도구 선택과 답변 생성은 Windows 안내의 실사용 절차에서 확인한다. [격리 환경 재현](../test/local-supabase/README.md) · [두 PC 시험 절차](windows-test-guide.md)

로컬 Supabase PostgreSQL 15.8과 PostgreSQL 17.12에서 각각 회원 격리·조건부 쓰기·삭제·한도·읽기 전용 카탈로그를 포함한 19개 검사를 통과했다. 사용한 GoTrue 버전은 2.197.0, PostgREST는 14.18이다. 두 데이터베이스에서 얻은 카탈로그 지문은 저장소의 후보 지문과 일치했다. 실사용 프로젝트의 기존 스키마와 권한을 확인하는 단계는 아래의 대시보드 보고서를 기다린다.

### Windows 설치 시험 보류

Windows 시험본 안내를 보류했다. 보호 기능을 켠 Windows 표준 사용자 환경에서 다운로드·설치 결과를 확인해야 재개할 수 있다. 소스 `504fa1d06ebf59dd28d64a810d8d46fb093cb015`에서 만든 설치 파일로 Windows Server 2025 설치·업데이트·제거, 시작 메뉴, 충돌 검토 화면, 패키지에 포함된 런타임의 오프라인 재연결과 두 서비스용 HTTPS MCP 조회를 통과했다. 시험본의 계정 연결은 기본 미설정 상태다. 실제 Windows 11 두 대에서 개인 ChatGPT·Claude 일반 채팅이 도구를 선택한 결과는 아직 없다. [Windows 검사](https://github.com/scored-kr/growthbrain/actions/runs/44909840537/job/136863363276) · [Linux 검사](https://github.com/scored-kr/growthbrain/actions/runs/44909840535) · [현재 상태와 사용자 절차](windows-test-guide.md)

### 이전 Windows 시험 파일

패키지 소스는 `0d87f9f14082a1aa9ba4b37572ef2e8b05053660`이고 EXE의 SHA-256은 `84c991bdb839ba142422b76e341f0d0ba52bf1c8472935eb8f84b2bd785ee7dd`다. Windows Server 2025에서 설치·업데이트·시작 메뉴·제거, 실제 사용자 DPAPI, 패키지의 두 독립 프로세스에서 계정 복원 및 서비스별 OAuth/MCP 호출을 확인했다. 두 클라이언트가 ‘지난번 정한 조건대로 다음 작업을 진행해줘’만 조회문으로 전달했을 때 각각 ‘답변은 한국어로’와 ‘캠페인 채널은 뉴스레터’를 읽었다. 다른 계정으로 전환한 뒤 이전 토큰은 거부됐다. [Windows 실행 기록](https://github.com/scored-kr/growthbrain/actions/runs/44893763327/job/136815186607) · [Linux 실행 기록](https://github.com/scored-kr/growthbrain/actions/runs/44893763303)

이 파일은 운영 연결 정보가 없는 시험본이다. 검사 대상은 합성 계정과 기기 프로필이며, 실제 두 PC 및 두 일반 웹 채팅에서의 모델 답변은 아직 측정하지 않았다. 기존 Supabase 스키마 점검은 현재 환경에서 직접 연결 자격을 확인하지 못해 프로젝트 대시보드의 읽기 전용 보고서를 기다린다. 데이터 초기화와 프로덕션 배포는 수행하지 않았다.

### 기존 Supabase를 확인하는 순서

1. [Growth brain SQL Editor](https://supabase.com/dashboard/project/kcvjsvbwinlhzgmnfsji/sql/new)에서 [대시보드 점검문](../scripts/inspect-supabase-dashboard.sql)을 실행하고 `report` 한 칸을 확인한다. 회원 행·기억·복호화 키를 조회하지 않는다. 결과의 `qualifiedForWrites`는 이 인벤토리 단계에서는 항상 false다.
2. 기존 RPC와 테이블·정책을 대조한다. 운영 프로젝트에 이 브랜치의 후보 SQL을 자동 적용하는 경로는 없다. 기존 구현이 다르면 실제 스키마를 기준으로 호환 또는 변경 계획을 검토한다. [읽기 전용 검사](supabase-readonly-inspection.md)
3. 호환되는 환경에서 실제 두 시험 계정의 격리 증거를 확보한 뒤 공개 키와 검토 결과를 넣어 설치 파일을 만든다. 현재 기본 CI 시험본은 이 설정이 없을 경우 계정 연결 미준비를 표시한다. [계정 빌드 설정](account-build-configuration.md)
4. 최종 실사용 합격에는 A 전원 종료 시각, B에서의 조작, 각 웹 서비스의 실제 도구 호출과 한국어 뉴스레터 작업 답변, 타 계정·타 프로젝트 격리 증거가 필요하다. 시험본 생성과 프로덕션 배포는 별개다.

## 챕터 46 — 사용자 배포 파일 구성

확장 ZIP과 Windows 설치 파일에는 지정한 확장 파일만 포함한다. 제품 소스 압축은 설치·빌드에 필요한 소스와 고지, 사용자용 안내를 담고 내부 사업 문서와 개발 스킬은 제외한다. Windows 공개 연결에 쓰이는 하위 패키지의 저작권 고지도 보존한다. GitHub에 기존 공개된 파일과 커밋의 공개 범위는 이번 패키징 변경과 별개다. [산출물 검사](release-preparation.md).

## 챕터 45 — 기억 조회 시 출처 원문 보호

Windows 시험본 이후 제품 MCP의 두 조회 도구와 관리 탭 미리보기에 같은 공개 필드 규칙을 적용했다. 출처, 참조, 수정·교체 사유는 기기의 검토 이력에 남는다. 승인한 값과 인계의 완료 근거는 전달된다. 이 수정은 이전 Windows 설치 EXE 이후에 반영됐다. 기존 금고는 그대로 읽는다. [조회 계약](mcp-contract.md) · [Windows 시험 절차](windows-test-guide.md).

## Windows 설치형 시험판 — 2026-11-21

사용자가 유료 스펙 생성 없이 상세 완료 기준으로 진행을 허용했다. 작업
`8e1cf5a3-d0d4-41e6-8ade-3708d6a969c3`을 `in_progress`로 전환했다.
사용자용 시작점은 [Windows 11 설치 및 양쪽 서비스 시험 절차](windows-test-guide.md)다.

| 챕터 | 구현 | 커밋 |
| --- | --- | --- |
| 40 | 서비스 콜백 확인, 로컬 승인·OAuth 인증·연결별 조회 구분 | `0713d77` |
| 41 | 사용자 프로필 NTFS 금고, 크래시 시 잠금 해제, 인증된 native pipe와 Chrome 등록 | `2423eb4` |
| 42 | Windows GUI, 금고·검토·범위 승인, 기기 TLS와 Tailscale 연결 | `d1cb99e` |
| 43 | x64 설치 파일, 전체 페이로드와 Windows 패키지 검사 | `fd14064`, `e4c02c4` |
| 44 | 암호화 백업과 새 프로필 복원, 갱신 실패 안내 | `4bb9337` |

Tailscale 계정 승인과 Funnel을 허용하는 네트워크에서 사용할 시험 빌드다. TLS는 사용자 기기에서
종료되며 기기에서 인증서를 준비·갱신한다. 인증서의 공개 호스트 이름과 연결 메타데이터는
외부에 알려진다. 검사에는 합성 금고를 사용했다. 실제 계정의 Funnel 발급·갱신과 양쪽 새 채팅의
자연어 호출·결과 반영은 사용자 기기에서 확인해야 한다. Windows UI는 기존 비밀번호 또는 복구 파일로 새 프로필에만 복원한다.

Linux에서 전체 `test:local` 통과(Node 126 통과, Windows 전용 4건 건너뜀). Windows Server
2025 러너에서 실제 패키지를 추출하여 앱 UI의 금고 생성·잠금·재시작·열기, native 실행 파일,
NTFS 접근 거부·잠금 복구를 확인했다. [Windows CI 실행 기록](https://github.com/scored-kr/growthbrain/actions/runs/44886850892).
최종 패키지 소스 `b149ef1b3a062db0192f3a4c2141d8b3947fde01`에서 Windows Server 2025의
일반 설치 대화상자 → 시작 메뉴 → 업데이트 → 제거와 금고 보존까지 통과했다. 합성 금고의 복구 파일로
새 프로필에 복원하고 새 비밀번호로 열었으며 NTFS/native 검사 6개가 모두 통과했다.
[최종 Windows 검사](https://github.com/scored-kr/growthbrain/actions/runs/44888013210)와
[최종 Linux 검사](https://github.com/scored-kr/growthbrain/actions/runs/44888013235). 실제 Windows 11
표준 사용자와 양쪽 웹 AI 개인화는 사용자가 시험하기 전까지 보드에서 완료로 처리하지 않는다.

당시 Windows 워크플로는 커밋별 EXE와 체크섬을 보관했다. 프로덕션 배포·공개 릴리스 없음.

## Windows 일반 사용자 작업 재개 당시 기록 — 2026-11-21

원격 `66a0b69d06330621ff4dbd48694b8dc9d66465d0`까지 기존 로컬 변경 없이 fast-forward 복원했다.
보드 작업 `8e1cf5a3-d0d4-41e6-8ade-3708d6a969c3`의 상세 요구와 완료 기준을 조회했다.
일반 사용자에게 개발 도구·터미널·인증서/DNS 설정을 요구하지 않는 Windows 설치형 흐름이 목표다.
[구현 전 조사·검증 계획](windows-onboarding-plan.md)에 코드 차이와 순서를 기록했다.
당시 정식 스펙 상태는 `missing`이었다. 이후 위 절과 같이 사용자가 상세 완료 기준으로 진행을 허용했다.
제품 코드·실제 Windows 설치·양쪽 웹 AI 개인화 구현 완료를 뜻하지 않는다. 프로덕션 배포 없음.

이 환경의 `npm run doctor:ign8t`는 `IGN8T_CONNECTION_FAILED`로 종료했다. 기존에 설치된
`@ign8t/mcp` 실행 파일을 Node stdio로 연결한 별도 클라이언트에서는 get_project →
get_documents(master_spec) → get_next_task → get_task_context가 모두 성공했다.
키는 안전한 환경 바인딩으로 전달하고 저장소에 기록하지 않았다. npx 진단 실패 원인은 미확정이다.

## 차단10개 후속 — 챕터37~39 (2026-11-06)

최신 구현 커밋은 `532437f37b418a8b16e2a10afab8343d3643ea9c`다. 아래 챕터36 기록은 당시 상태다.
[후속 결과](blocked-followup-2026-11-06.md)에10개 전체의 최신 상태와 실제 남은 조건을 기록했다.
이번에는 native팝업 구현 항목46bcfff4를 완료하고 나머지9개는 차단을 유지한다. 보드전체는36done/9blocked/1review다.

- 챕터37: 복원 이력의 중간 superseded 노드까지 검증해 사용 중지한 조건의 옛 조상 재등장을 차단.
- 챕터38: 팝업 사이트 권한 철회·오프라인 철회·native 재연결·빈 상태·출처 시각·잠금 시 개인내용/늦은 응답 제거.
- 챕터39: [기존 Supabase 읽기 전용 점검기](supabase-readonly-inspection.md), 고정 대상·TLS·비밀 미출력·READ ONLY 강제.
- 전체 test:local Node119/119, 점검기 Python4/4, PostgreSQL WASM 실제 SQL/쓰기 거부 포함. 실제 Supabase 검증은 아니다.
- 이전 마지막 문서 커밋cc427c5의 GitHub CI42149896314 성공도 확인했다. 이번 최종 원격SHA/CI는 완료보고를 따른다.

Codex401/get_context0회, Chrome 설치정책, Supabase 안전한DB바인딩 부재는 현재 재실행에서도 그대로다.
원격 쿼터·회원전체삭제·동기화는 현재 스키마 확인 후 후속 구현/검증이 필요하다. 사용자 환경에 실제연결이
준비되지 않았는데 완료로 처리하거나, 과거 키를 복사하거나, 새로운 원격 평문 스키마를 초기화하지 않는다.
현재 내부v9/envelope1·2/분할형식1 유지. 실제 사용자금고를 개발클라우드에서 열지 않는다.

## 최신 재개 지점 — 2026-11-06

챕터28~35 구현 커밋 `236c3d114b0006b06a7ca8417960c0031d45357f`까지 push/원격 SHA/새 GitHub 복제와 fsck를 확인했다.
새 복제에서 npm ci, 전체 test:local(Node114/114·스킬·설치/해제·PTY/복구·4종 Chromium UI),
확장 검사까지 통과했다. GitHub [CI 42149293048](https://github.com/scored-kr/growthbrain/actions/runs/42149293048)도 성공했다.
이 문서 뒤의 과거 챕터/상태 기록보다 이 절과 [대기 작업 결과](backlog-completion-2026-11-06.md)를 우선한다.

- 현재 내부 상태 **v9**, 이전 v1~v8 전환 전 암호문 보존. envelope1/2·분할 저장 형식1은 별개다.
- [웹 MCP](web-mcp.md): 기기 HTTPS/OAuth와 로컬 연결 승인, 공통 또는 한 프로젝트 읽기 권한.
- [맥락 인계](handoff.md)·[관리 화면](local-management.md): 검토/핀/작업 예외/인계/수집/미리보기.
- [별칭 색인](memory-keys.md): 제한 사전, 상충 별칭 제외, 명시 교체. 일반 의미 해결기가 아니다.
- [분할 저장](chunk-storage.md): 암호문 증분 파일·원자 교체·복구. 실제 원격 전송/삭제는 미연결.
- [선택적 로컬 모델](local-inference.md): 기본 꺼짐, 검토 조언만, 사용량 한도. 실제 모델 품질 미검증.
- [계정 폼](account-auth.md): 제공자 계약/테스트용 인증 검증. 제품 제공자는 미연결·입력 비활성.
- [CI/산출물](release-preparation.md): ZIP/소스/해시 생성, 프로덕션 배포나 스토어 게시 없음.

작업 시작 시 대기13개 중8개를 실제 스펙 범위에서 완료했다. 나머지5개는 외부 조건 때문에 blocked로
기록한다(양쪽 웹 AI 개인화, 실제 인계 재개, 개인화 결과 비교, 기존 Supabase 확인, 프로덕션 배포).
다음 담당자는 이들을 done으로 바꾸기 전에 실제 기기/연결/결과 증거를 확보해야 한다.
`npm run test:personalization`의13/13은 엔진 의무이며 실제 AI 결과0·대조군 미실행이다.

현재 환경 재확인: Codex 인증 HTTP401/get_context0회, Chrome ExtensionInstallBlocklist=["*"],
Claude Code 실행 파일 없음, 안전한 Supabase 연결 부재. 정책 우회·과거 키 재사용·초기 SQL 실행 없음.
실제 ChatGPT/Claude 일반 채팅의 도구 호출+개인화 결과물은 아직 없으며 MVP 합격을 선언하지 않는다.

브랜치 복제에 개발 문서·17개 검토 스킬·ign8t 설치/진단 도구가 포함된다. 브랜치 전환만으로
개인 기기의 인증이나 전역 MCP 설정이 자동 생성되지는 않는다. 제품 MCP 설정과 개발 보드 설정은 별개다.

```sh
git clone --branch codex/growthbrain-recovery-20261103 https://github.com/scored-kr/growthbrain.git
cd growthbrain
npm ci
npm run build
npm run verify:skills
```

기존 체크아웃은 먼저 `git status`와 `git ls-remote origin refs/heads/codex/growthbrain-recovery-20261103`을
확인하고 로컬 변경을 보존한다. 실행 기준 Node 24+, Python 3.11+ (`python3` 명령), Unix socket/PTY를 지원하는 기기.
이번 전체 검증 기기는 Linux다. Windows native나 실제 macOS 클라이언트 성공을 주장하지 않는다.

```sh
npm run test:local
```

이 명령은 전체 Node 검사, 스킬 무결성, 설정 설치/해제, PTY/복구, 합성 Chromium UI를 수행한다.
UI는 `GROWTH_BRAIN_TEST_CHROMIUM`의 명시 경로, 기존 Linux Chromium, Playwright 설치 브라우저
순으로 선택한다. 브라우저가 없으면 사용자 기기에서 `npx playwright install chromium`으로 준비한다.
UI에는 확장을 설치하지 않으며, 별도 `test:browser`의 관리 정책 차단은 그대로 준수한다.
인증이 필요한 `doctor:ign8t`와 실제 모델/확장 검사는 이 로컬 합성 묶음에 포함하지 않는다.

ign8t를 쓸 클라이언트 프로세스에 안전한 `IGN8T_API_KEY` 바인딩을 제공한다. 키를 셸 명령 인자,
저장소 파일, 채팅에 붙여넣지 않는다. 설치 도구는 키 값을 읽거나 저장하지 않는다.

```sh
python3 scripts/ign8t-integration.py install
npm run doctor:ign8t
```

설치기는 Codex의 기존 config.toml을 보존해 소유한 ign8t 블록만 병합한다. `--config`로 테스트나
다른 Codex 경로를 지정할 수 있다. 기존 ign8t 항목/수정된 블록/심볼릭 링크는 덮어쓰지 않는다.
`remove`도 변경되지 않은 소유 블록만 제거한다. 환경변수 이름만 env_vars에 기록한다.
클라이언트를 재시작하고 실제 MCP 목록과 조회를 확인한다. 도구가 이미 연결된 환경은 재설치할 필요가 없다.

doctor는 `npx -y @ign8t/mcp@latest`와 실제 stdio로 연결해 get_project →
get_documents(master_spec) → get_next_task 순서를 수행한다. 세 조회의 성공/프로젝트/본문 존재를
확인하며 보드나 원문을 수정하지 않는다. 키와 서버 원문/오류 내용을 출력하지 않는다. 진단 성공은
셸의 환경 연결 증거이며 재시작한 Codex의 연결·실제 마스터 독해를 대신하지 않는다.
연결된 클라이언트로 마스터 **전문**을 읽고 최신 요구사항과 대조한다. stale 마스터의 평문 서버
검색/자동 입력/자동 확정 가정은 최신 로컬 암호화·명시 승인·제품 MCP 요구로 대체한다.

이후 작업을 in_progress로 기록하고 구현→검증→커밋→푸시→원격 SHA 확인, 완료는 done,
실제 외부 차단은 blocked로 기록한다. 전체 검사는 package.json을 참고한다. UI/PTY/프로토콜
검사와 실제 AI 개인화 검사는 구분한다. Supabase 초기 SQL 재실행/환경 재게시/프로덕션 배포는
이 절차에 포함되지 않는다. 실제 사용자 금고는 사용자 기기에서만 연다.

2026-11-04 후속: [제품 실사](product-diligence-2026-11-04.md),
[보안 수정 검증](security-lifecycle-review-2026-11-04.md), [위협 모델](growthbrain-threat-model.md)을 함께 읽는다.
사용자는 맥락 인계를 핵심 가치로 강조했다. 현재 조건 조회와 검증된 작업 상태 인계가 같다고 판단하지 않는다.
인터뷰4명은 실제 사용자 보고, 가상고객70/100은 합성 가설 자료다. 타깃·결제·반복 사용 검증은 남았다.
고정 스킬은 17개/101파일이며 원문 자동 실행이나 외부 서비스 연락을 허용하는 설정이 아니다.

2026-11-05 [BizForge 사업계획서 재검토](business-plan-review-2026-11-05.md)와
`.agents/startup-context.md`의 갱신도 읽는다. 사용자는 PDF의3초/70%/12개월/80%를 모두 목표·가정으로 확인했다.
문서의 확장 단독/원클릭 입력 방식은 현행 제품 MCP·기기 암호화 요구를 교체하라는 승인으로 해석하지 않는다.
가격·투자·파트너·매출 계획은 실제 성과와 구분한다. 경쟁 비교는 공식 자료로 갱신했고 실설치 우위는 미검증이다.

같은 날 후속 사용자 명확화: **선호도 기반 개인화가 최상위 목표**이며 맥락 인계는 그 결과를 이어 주는 수단이다.
[개인화 중심 비교](preference-personalization-review-2026-11-05.md), [평가안](personalization-evaluation.md),
startup-context의 최신 항목을 우선한다. 챕터26에서 명시적 업무5종 적용 조건을 구현했다. 일반 자연어
적용/예외, 다른 key의 의미 충돌, 교정 후 결과 측정은 후속이다. 고정 프로필/경쟁사 대조 및 실제 AI 결과는 미검증이다.
챕터24 검토 보드 `bdbc6f07-5d35-4f06-81e7-417621fc5f95`. 기존 인계 작업은 폐기하지 않는다.
선호도 적용/예외·교정 계약과 실제 결과 검증 후속 작업은 `b9133f0f-1c34-461d-927c-3a8cfc2532bc` (당시 todo; 최신 상태는 위 절)다.

챕터25 [Mem0 소스 검토](mem0-source-review-2026-11-05.md): 공개 core/관리형 API/플러그인 동작을
구분하고 선호도 설계에 활용할 아이디어를 기록했다. 옛 세션 재개 시 프로젝트 재바인딩을 확인하는
훅 경계도 보완했다. 내부 get_agent_binding은 sessionId가 필수다. Node67/67과 실제 훅/IPC로 검증했고
설치된 실제 AI 세션의 개인화 완료로 해석하지 않는다.

챕터25 SHA `b3394d395beba4ef22525e03b42954042fcf1963`은 push/원격SHA/새clone HEAD/fsck 확인을 마쳤다.
챕터26 [업무별 선호도](preference-applicability.md): writing/translation/campaign/analysis/coding의
명시 조건을 조회/검색/후보 수정/검토 UI/CLI/제품 스킬에 연결했다. 내부 상태는 v5이며 v1~v4
전환 전 암호문을 보존한다. envelope v1/v2와 별개이고 Git revert는 사용자 데이터를 되돌리지 않는다.
`npm run test:local` 전체 통과(Node72/72 포함). 2026-11-05 실제 test:codex는 인증 갱신401,
get_context0회/결과물 없음으로 재확인했다. 브라우저 정책·Claude 실제 실행·원격 검증은 미완료 유지.
챕터26 보드 `20c6e24f-bda7-43c9-ae90-f74f02763252`. 위 b913 후속 전체가 완료된 것은 아니다.

챕터27: **초기 MVP는 ChatGPT·Claude 일반 채팅 둘 다**라는 최신 사용자 결정을 우선한다.
코딩 CLI 지원은 보조이며 한 서비스만 선택하라고 다시 묻지 않는다.
[기존 채팅 가져오기](chat-history-import.md): 양쪽 내보내기 JSON을 확장 탭에서 선택/미리보기/동의하고
로컬 암호문·프로젝트 후보로 가져온다. Claude 분기 미확인 파일은 별도 확인과 출처 표시를 유지한다.
챕터27 당시 내부 상태는v6, 전환백업 pre-state-v6, envelope1/2는 별개다. 과거v5설명은 챕터26 당시 기록이다.
실제 일반 웹 채팅의 인증된 MCP 연결/결과 검증은 후속이며 로컬 파일 가져오기 성공으로 대체하지 않는다.
보드 작업 9ae6ae91-2c02-456e-8050-11fdc97b857b는 최초 ChatGPT 제목으로 만들어졌지만
최종 범위는 사용자 답변에 따라 **ChatGPT+Claude**로 확장했고 상태 기록에 반영했다.
양쪽 일반 웹 채팅의 실제 연결·선호도 개인화 후속 보드: `ead9b252-9bec-4eaf-9172-9b45aa710122` (당시 todo; 최신 상태는 위 절).
