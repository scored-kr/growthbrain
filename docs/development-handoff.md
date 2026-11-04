# 새 기기에서 개발 이어받기

브랜치 복제에 개발 문서·9개 검토 스킬·ign8t 설치/진단 도구가 포함된다. 브랜치 전환만으로
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
