# Codex · Claude Code 자동 대화 수집

사용자 기기의 로컬 CLI에서 동작하는 명령 훅이다. 설치/동의/클라이언트 신뢰 검토 후에는
매 턴 별도 저장 명령 없이 사용자 입력과 최종 assistant 답변을 금고로 보낸다. Claude Code와
Codex는 같은 기억 엔진을 사용하지만 이벤트 어댑터는 분리한다.

| 클라이언트 | 입력 이벤트 | 답변 이벤트 | 턴 식별 |
| --- | --- | --- | --- |
| Codex CLI | `UserPromptSubmit.prompt` | `Stop.last_assistant_message` | `turn_id` |
| Claude Code | `UserPromptSubmit.prompt` | `Stop.last_assistant_message` | `prompt_id` |

확인 자료: [Codex 공식 훅](https://learn.chatgpt.com/docs/hooks),
[Claude Code 공식 훅](https://code.claude.com/docs/en/hooks). 설치된 Codex는 0.163.0이며
`features.hooks`가 stable/true다. 현재 클라우드에 Claude Code는 설치돼 있지 않다. Claude
어댑터는 공식 `prompt_id`를 제공하는 버전을 요구하며, 없는 버전에서 턴 ID를 추측하지 않는다.
이 문서는 local CLI 지원이다. cloud orchestration은 로컬 명령 훅을 지원하지 않을 수 있다.

## 사용자 기기 설정

`npm ci && npm run build` 후 필요한 클라이언트의 MCP·스킬과 훅을 각각 등록한다.

```sh
python scripts/codex-integration.py install
python scripts/agent-hooks.py install --client codex

# Claude Code 사용 시
python scripts/claude-integration.py install
python scripts/agent-hooks.py install --client claude-code
```

알려진 이전 스킬 배포본은 해당 설치기의 `upgrade`를 사용한다. Codex와 Claude 모두 지원하며
사용자 편집본은 덮어쓰지 않는다.
다른 금고를 사용할 때에는 각 명령에 같은 `--socket /absolute/vault/memory.sock`을 전달한다.
훅 설치기는 Codex `~/.codex/hooks.json`, Claude `~/.claude/settings.json`에 소유 항목만
병합한다. 사용자 편집/알 수 없는 소유 항목은 덮어쓰지 않는다. `--config`로 명시 경로를
선택할 수 있다. Claude MCP는 `~/.claude.json`의 다른 설정을 보존하며 제품 항목만 추가한다.

1. 별도 사용자 터미널에서 `npm run vault -- serve`로 금고를 열고 `CONNECT`에 동의한다.
2. `agent-bind`에서 클라이언트, **정확한 작업 디렉터리**, 프로젝트 UUID를 선택하고 `CAPTURE`한다.
3. 클라이언트를 재시작하고 지원되는 훅 검토 UI를 거친다. Codex는 `/hooks`에서 확인한다.
   등록만으로 신뢰가 부여되지 않는다. 설치기는 신뢰 파일, 승인 정책, 관리 설정을 바꾸지 않는다.
4. 해당 디렉터리의 새 세션에서 작업한다. 프로젝트를 바꾸면 새 세션을 시작한다.
5. `agent-status`로 동의를 확인하고 `agent-stop`에서 `STOP`으로 중지한다.

폴더명에서 프로젝트를 추측하지 않는다. 하위 폴더도 자동 상속하지 않으며 별도 연결이 필요하다.
`SessionStart`와 입력 훅은 공통을 먼저 읽는 MCP 조회를 지시하며, 연결된 프로젝트가 있으면
해당 UUID를 전달하도록 한다. 미연결 폴더는 대화를 수집하지 않고 공통 조회/명시 트리거 안내만 한다.
[공통·프로젝트 색인](memory-index.md)의 선택 규칙을 따른다. 이 안내는 확정 기억 본문을
주입하지 않으며, AI가 실제 `get_context`를 호출하고 적용하는지는 별도 검증 대상이다.

## 수집과 보호 범위

- 원문은 stdin → 로컬 Unix socket → 사용자 기기의 암호화 금고로 간다. 명령 인자·stdout·로그에
  원문/키를 출력하지 않고 transcript, 인증 파일, 도구 출력, 추론, 첨부 파일은 읽지 않는다.
- 메시지는 클라이언트/세션/턴/역할로 식별한다. 재전송은 중복 제거하고 본문 변경은 revision으로
  연결한다. 입력만 후보를 만들 수 있으며 assistant 답변은 자동으로 확정 기억이 되지 않는다.
- 동의 세대가 바뀌면 이전 요청을 거부한다. 같은 세션을 다른 프로젝트로 재분류하지 않는다.
  입력이 수집되지 않은 턴의 답변도 거부하여 잠금·중지·재연결 중 혼입을 막는다.
- 금고가 잠겼거나 크기 제한/지원 이벤트 검증이 실패하면 경고하고 저장하지 않는다.
  평문 재시도 파일이나 과거 대화 자동 스캔은 없으므로 이 구간의 누락은 소급 복구하지 않는다.
  메시지 본문은 12,000자, 웹/에이전트 캡처 합계 5,000개, 암호문 전체 16MiB 제한이다.
- 내부 상태는 v4다. v1~v3의 인증·불변식 검증 후 메모리에서 변환하며, 기존 금고를 열 때
  쓰기 전에 원래 암호문을 `pre-state-v4-<random>.enc`로 보존한다. 이 백업은 이전 비밀번호/
  복구 권한을 그대로 사용한다. 외부/별도 백업처럼 현재 금고 삭제나 Git revert로 지워지지 않는다.
  복원은 새 디렉터리에서 한다. 암호문 envelope v1/v2 형식과 별개다.

해제는 위 설치 명령의 `install`을 `remove`로 바꾸고 동일 옵션을 사용한다. 금고와 다른 훅은
남긴다. 이미 저장한 대화와 AI 서비스의 사본을 삭제하는 명령은 아니다.

## 현재 검증

`npm test`는 두 이벤트 형식의 실제 훅 하위 프로세스 → 실제 로컬 IPC → 암호문 재시작 →
새 stdio MCP 조회를 합성 데이터로 검사한다. 후보 승인·동의·중복·프로젝트 변경·잠금을 포함한다.
`test:agent-install`은 실제 파일 병합/해제와 사용자 설정 보존, `test:terminal`은 실제 PTY 동의를 검사한다.

`test:hooks:codex`는 실제 Codex 실행 시험이다. 현재 실제 모델 경로는 인증 401로 실패했다.
로컬 합성 모델을 사용한 별도 실행도 훅 수집 0회였다. 실제 app-server `hooks/list`로
sessionFlags 훅이 `enabled:true, trustStatus:untrusted`인 것을 확인했다. 검토를 우회하지 않았다.
따라서 구현된 훅 어댑터의 프로토콜 검증과 사용자 기기에서 승인한 실제 자동 실행 성공을 구분한다.
Claude Code 실제 런타임, 실제 사용자 대화, 실제 모델 개인화는 아직 검증되지 않았다.
