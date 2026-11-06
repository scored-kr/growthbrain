# 새 기기에서 개발 이어받기

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
