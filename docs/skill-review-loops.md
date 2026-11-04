# 공개 스킬 기반 5회 검토

기준 `16bbf196b53123457d1a52aafc6613489044fb91`, 2026-11-04.
독립된 검토→필요 수정→재검증을 5회 수행하며, 병렬 에이전트 5개를 실행했다는 의미가 아니다.
공개 스킬 출처와 라이선스는 [public-skills.md](public-skills.md).

## 회차 1 / 챕터 15 — 개발 재개

- Given 새 브랜치 복제와 안전한 환경 바인딩, When 개발자가 설치/진단을 실행,
  Then 기존 설정 보존과 실제 ign8t 세 조회 성공을 각각 확인할 수 있어야 한다.
- 발견: 이전 ign8t 도우미가 저장소 밖에만 있어 복제로 이어받을 수 없었다. 브랜치에
  개발 AGENTS/스킬 라우터, 소유 블록 병합 설치기, 읽기 전용 doctor를 추가했다.
- 원문 9스킬/72파일은 pinned Git blob과 바이트 단위 일치. 비상업 라이선스 후보 제외.
- 검증: build, 원문 무결성 9/72, 설정 설치 검사3개, doctor 계약 검사2개 통과. 임시 config를 실제 Codex CLI0.163.0으로 읽어 env_vars 전달을 확인했다. 새 doctor의 실제 ign8t 세 조회 성공, master 1개/stale=true. 실제 사용자 Codex 연결과 제품 모델 인증은 별도다.

## 회차 2 / 챕터 16 — 경계와 오류 계약

- Given 큰 요청·잘못된/잘린 socket 응답, When 제품 MCP/native가 호출, Then 안전한 고정 오류와 올바른 다음 행동이 필요하다.
- 두 실패 검사로 오류 뭉개짐·빈 응답 성공을 재현했다. 요청 사전 제한, 양방향 버퍼/응답 제한, 오류별 안내, 명시적 response 계약을 수정했다.
- 검증: `npm test`55/55 통과. 실제소켓/MCP/native/훅IPC이며 모델개인화는 아님. [보안 검토](security-review-2026-11-04.md)에 신뢰경계/호출자/이력/한계를 기록했다.

## 회차 3 / 챕터 17 — 조건 보존과 기억 불변식

- Given 분리된 부가 조건과 승인/대체/중지 이력, When 후보 추출·공통/프로젝트 검색, Then 조건 일부가 빠지거나 폐기 이력이 되살아나지 않아야 한다.
- 변경 전 세금/월 단위 조건 누락을 실패 검사로 재현했다. 애매한 다문장은 전체 feedback 후보로 보존하고 질문/인용/코드와 혼합된 부분 추출은 중지한다.
- 검증: npm test57/57. 부가조건 생성80개, 독립 의도장부 기반1920명령, 기존 추출22/22·음성0/22, 검색43/45·음성0/15 유지. 일반 의미검색/실사용 성공률로 해석하지 않는다.
- 회차1 원격 ae7115f093a68d261bd947cc63818e41805726a3은 재시도 후 push/ls-remote/새clone HEAD/fsck 확인.

## 회차 4 / 챕터 18 — MCP 계약과 UI

- Given MCP 도구 목록과 내부 응답, When 클라이언트가 결과를 읽을 때, Then 명시 출력schema와 구조화 결과를 제공하고 잘못된 성공은 거절해야 한다.
- 기존 text JSON만 있던 결과에 outputSchema/structuredContent를 추가했다. 기존 text 호환성을 보존하고 write 비멱등성을 명시했다. 설치된SDK1.32.2를 유지했다.
- 출력schema 부재를 먼저 실패 검사로 재현. 실제stdio 계약/값 검증과 비정상peer 내용 비노출 검사 통과. 실제Chromium의 복합조건 전체표시/다른프로젝트 선택 후 늦은응답 무시/기존 UI검사 통과. Chrome API는 mock이며 설치된 확장 아님.
- 회차2 fdc362e59989e58c9459d7eae4aca3cbc866e7a9와 회차3 219e4138c3fe1c0a2359965ea3d5effb9fac3972는 push/ls-remote 일치 확인. 각 새clone/fsck도 확인한다.
- 회차3의 생성 부가조건 수 표기100을 실제80(4×4×5)으로 정정했다. 검증 범위 변경 없음.

## 회차 5 / 챕터 19 — 재개와 최종 회귀

- Given 새 기기에서 복제한 브랜치, When 준비된 Node/Python/Chromium으로 검사,
  Then 이전 실행기의 개인 파일 없이 구현·스킬·설치·금고 흐름을 재검증할 수 있어야 한다.
- 발견/수정: 테스트의 `python` 별칭과 클라우드 고정 Chromium 경로 의존. Python3/현재 인터프리터를
  쓰고 합성UI만 명시 경로·기존 시스템·Playwright 브라우저를 선택한다. 설치확장 정책 검사 보존.
  `test:local`로 로컬 전체 검사를 묶었다. 다른 OS/실제 사용자 기기의 성공을 주장하지 않는다.
- 로컬 `test:local` 통과: Node58/58, 원문9/72, ign8t설치3, Codex설치8, agent설치2,
  native설치, 터미널/복구 실제PTY, Chromium154.0.8037.57 합성UI. 실제ign8t doctor 세 조회 성공은 별도 확인한다.
- 회차4 원격0184e8546d46110110515b529da18ffdbf366124의 새clone HEAD/fsck 확인.
  챕터19 최종 원격clone 설치/검사 결과는 후속 백업 기록에 남긴다.
- 실제 CodexCLI0.163.0도 재실행했으나 인증 갱신HTTP401, get_context0회/결과물없음.
  `test:browser`는 ExtensionInstallBlocklist["*"]로 명시 실패. ClaudeCode 미설치,
  Supabase 안전한 연결/도구 없음. 이 제한은 해결된 것으로 표시하지 않는다.
- PM experiment-design으로 [기술 합격·실사용 효용 평가](product-validation.md)를 구체화했다.
  파일럿/표본 가정/기간/측정/보호 기준을 분리했으며 실제 사용자 실험을 수행했다는 뜻이 아니다.
