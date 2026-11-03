# Codex 연동과 실제 검증의 경계

최신 자동 대화 수집/명령 훅은 [agent-capture.md](agent-capture.md)를 따른다. 아래의
초기 MCP+스킬 검증 기록과 구분한다. 챕터 11부터 별도 훅 설치기를 제공하며 클라이언트 신뢰
검토를 통과한 사용자 기기에서 활성화한다.

2026-11-03 확인한 클라이언트: Codex CLI 0.163.0.
확인한 공식 문서:

- https://developers.openai.com/codex/mcp — stdio, command/args/env/env_vars, 클라이언트 재시작.
- https://developers.openai.com/codex/skills — 사용자 `~/.agents/skills`, 명시/암묵 호출.
- https://raw.githubusercontent.com/openai/codex/main/docs/config.md — 관리 훅 정책.

공식 문서에 따르면 로컬 스킬은 암묵 선택될 수 있지만 매번 자동 호출을 보장하지 않는다.
클라우드 호스트의 명령 훅과 로컬 CLI 훅은 동일하지 않다. 이번 경로는 MCP + 스킬이며
초기 경로에는 훅·팝업이 없었다. 현재 자동 수집 훅은 위 별도 문서의 경로를 사용한다.
잠금 해제와 승인 UI는 별도 로컬 터미널이다.

## 설치·해제

사용자 기기에 checkout과 빌드가 있어야 한다. Node.js 24+, Python 3, Codex CLI가 필요하다.

```sh
npm ci
npm run build
python scripts/codex-integration.py install
# 사용자 로컬 터미널에서 별도로 잠금 해제
npm run vault -- serve
```

installer는 기존 Codex 설정에 `growth_brain` 항목만 추가하고 사용자 스킬 폴더에
`growth-brain/SKILL.md`만 설치한다. 같은 이름의 다른 설정/수정된 스킬이 있으면 중단한다.
기존 ign8t, 다른 MCP, 훅과 스킬을 덮어쓰지 않는다. 등록 후 필요하면 Codex를 다시 시작한다.
별도 금고 사용 시 `--socket /absolute/private-directory/memory.sock`을 지정한다.

기존 설치를 새 소스/빌드에 맞춰 갱신할 때는 설치 때와 같은 옵션으로 명시적으로 실행한다.

```sh
python scripts/codex-integration.py upgrade
```

`upgrade`는 현재 스킬 또는 확인된 이전 배포본(`8bf573d`)의 정확한 바이트만 허용한다.
새 파일을 완전히 쓴 뒤 원자적으로 교체하며, 이전 스킬을 사용자가 편집했거나 별도 파일을
추가했다면 중단한다. `install`은 이전 스킬을 조용히 덮어쓰지 않고 `upgrade`를 안내한다.
업그레이드에는 기존 제품 MCP와 스킬이 모두 있어야 하며 MCP 설정 자체는 변경하지 않는다.
실행 후 Codex를 다시 시작해 새 스킬을 읽도록 한다. 등록/갱신 성공은 실제 개인화 성공이 아니다.

```sh
python scripts/codex-integration.py remove
```

등록 때와 같은 옵션으로 해제한다. 직접 설치한 항목과 현재/확인된 이전 스킬 내용이 일치할 때만
지우며 금고 데이터는 삭제하지 않는다. MCP의 추가 환경변수, `env_vars`, `cwd`, 도구 제한,
타임아웃, 비활성화, 알 수 없는 필드도 사용자 변경으로 보고 모든 동작을 중단한다.
이 검사는 Codex CLI 0.163.0의 JSON 형식을 기준으로 하므로 향후 새 필드는 별도 확인이 필요하다.
저장소를 이동했다면 기존 항목을 점검하고 임의 덮어쓰지 않는다.

새 세션에서 프로젝트 UUID와 “지난번 정한 조건대로 다음 작업을 진행해줘”를 요청한다.
스킬은 `get_context`를 먼저 호출하고 유효 조건을 결과물에 적용하도록 안내한다.
스킬이 선택되지 않으면 `$growth-brain`으로 명시 호출할 수 있지만 이 폴백을
암묵 호출 성공으로 기록하지 않는다. 최초 프로젝트 선택은 사용자에게 확인한다.
현재 요청 조건을 `get_context`에 전달했다면 추가 `search_memory`에도 같은 조건을 전달한다.
각 호출은 독립적이며, 검색이 덮어쓴 저장 조건을 다시 현재 조건으로 반환하지 않도록 한다.

## 재현 가능한 실제 세션 시험

```sh
GROWTH_BRAIN_TEST_OUTPUT=/absolute/private-output-directory npm run test:codex
```

합성 금고와 임시 스킬 디렉터리만 사용한다. 잠금 비밀번호는 임의 생성하고 어떤 모델이나
도구에도 전달하지 않는다. 기존 설정을 바꾸지 않는 invocation override로 새 Codex를 실행한다.
테스트 프롬프트에는 기억 내용을 넣지 않고, MCP에서만 알 수 있는 무작위 브랜드명과 최신 CTA가
결과에 나타나는지, 실제 `get_context` 완료 이벤트가 있는지 검사한다.
테스트 로그도 합성 자료이며 저장소에 커밋하지 않는다. 모델 사용 비용이 발생할 수 있다.

**현재 결과:** 실제 CLI를 실행했지만 모델 인증 갱신이 HTTP 401로 실패했다.
`Your access token could not be refreshed ... Please sign in again.`
`get_context` 호출 0회, 결과물 없음. 따라서 실제 AI 개인화는 미검증이다.
제품 MCP의 별도 stdio 통합 테스트 성공과 이 실패를 구분한다.
현재 안전한 Codex 로그인 세션을 복구한 뒤 동일 시험을 재실행해야 한다. 인증 토큰을
채팅·MCP·저장소에 넣거나 기존 인증 파일 내용을 추출하지 않는다.

Claude Code는 챕터 11에서 공식 이벤트 어댑터와 보존형 MCP·훅 설치를 구현했으며 실검증은 남아 있다. Chrome 수집 연결은 후속 챕터에서 구현했고
native 프로토콜·합성 DOM/UI를 검사했으나 관리 정책 때문에 실제 확장 설치 검증은 차단됐다.
실제 ChatGPT/Claude 로그인 사이트도 미검증이다. [챕터 기록](chapter-progress.md)을 참고한다.
첫 지원 AI 클라이언트의 전체 흐름을 통과한 후 Claude Code 지원을 확장한다.

## 재개 환경 재확인 — 2026-11-03

Codex CLI 0.163.0의 `exec --help`와 공식 MCP/스킬 문서를 다시 확인했다. stdio 설정의
`command/args/env/env_vars`, `.agents/skills` 발견 경로를 사용한다. 공식 URL은 현재
[MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)와
[스킬 문서](https://learn.chatgpt.com/docs/build-skills)로 이동한다.
[Claude Code 훅](https://code.claude.com/docs/en/hooks)과
[MCP 문서](https://code.claude.com/docs/en/mcp)는 별도 설정/승인 경로를 설명한다.
현재 실행기에는 Claude Code가 설치돼 있지 않으며 설치 버전이나 실제 지원을 추정하지 않는다.

이번 `test:codex`도 실제 CLI 인증 갱신 HTTP 401, `contextCalls: 0`, 결과물 없음으로 실패했다.
로그인 파일을 추출하거나 다른 자격 증명으로 바꾸지 않았다. 이 환경의 인증 복구는 사용자 측
정상 로그인 절차가 필요하며, 합성 stdio 프로토콜 검사 성공을 개인화 성공으로 간주하지 않는다.
