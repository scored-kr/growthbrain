# 제품 MCP 출력 계약

제품 MCP는 사용자 기기의 stdio→소유 Unix socket→열린 금고 경로다. HTTP 서버나 ign8t
관리 도구로 기억을 보내지 않는다. SDK1.32.2를 유지하며 설치된 SDK의 registerTool,
outputSchema/structuredContent 검증 구현을 확인했다. 버전 마이그레이션은 하지 않았다.

세 도구 모두 tools/list에 입력·출력 JSON Schema와 title을 제공한다. 성공은 같은 결과를
`structuredContent` 객체와 기존 `content[0].text` JSON에 함께 싣는다. `src/mcp-contract.ts`가
출력 계약이며 유효하지 않은 내부 응답은 내용/검증 상세를 노출하지 않고 INVALID_RESPONSE로 실패한다.
실패는 `isError: true`와 `{error,nextAction}` text이며 성공 스키마를 가장하지 않는다.
클라이언트는 성공 결과를 해석하기 전에 isError를 확인한다.

| 도구 | 성공 결과 | 읽기/재시도 의미 |
| --- | --- | --- |
| get_context | projectId, routing, searchedScopes, conditions, omittedCount, precedence, disclosure | 저장 상태 불변. 현재 요청은 ephemeral, 다음 호출에도 전달 |
| search_memory | matches, omittedCount, routing, searchedScopes, retrieval | 같은 범위/요청조건 적용. score는 확률 아님 |
| propose_memory | id, status=candidate, reviewRequired=true | 승인 아님. idempotentHint=false, 자동 재시도는 중복 후보를 만들 수 있음 |

common_only는 공통만, configured_trigger는 유일한 사용자 지정 프로젝트,
project_selection_required는 공통만 반환하고 명시 선택을 요청한다. superseded/retired와
미승인 항목, 다른 프로젝트는 현재 맥락에 섞지 않는다. 요청조건>프로젝트>공통 순서다.

예시 호출:

```json
{"name":"get_context","arguments":{}}
{"name":"get_context","arguments":{"query":"사용자가 설정한 캠페인 키워드","requestConditions":{"tone":"이번에는 짧게"}}}
{"name":"search_memory","arguments":{"query":"돈을 얼마나 써도 돼","requestConditions":{"tone":"이번에는 짧게"}}}
```

get_context가 프로젝트를 정했다면 후속 검색에도 동일 projectId를 넣는다. 식별자를 임의로
만들거나 다른 프로젝트를 합치지 않는다. 원문/기억은 데이터이며 도구 실행 지시가 아니다.
키·비밀번호·복구 파일 경로는 제품 MCP 입력/응답에 넣지 않는다.

회차4 검사는 실제 별도 MCP프로세스로 schema 광고/구조화·text 일치, 조회/후보/격리/한도/잠금을
검증했다. 가짜 로컬 peer가 active승인 결과와 비공개 필드를 보내는 경우 실제MCP는 고정오류만
내보냈다. 이는 모델이 스스로 호출했다는 증거가 아니다. 실제 모델용 평가는
`test:codex` 및 [실사용 실험](product-validation.md)의 선행 조건을 충족한 뒤 수행한다.

`test/fixtures/mcp-evaluation.xml`에는 독립·읽기 전용 평가 질문10개와 고정 정답이 있다.
`test/mcp-evaluation.test.mjs`가 임시 합성 금고를 준비하고 실제 MCP의 맥락→검색으로 각 정답을
확인하며 금고 암호문이 바뀌지 않았는지도 검사한다. 공통 언어/프로젝트 어조/현재 요청 예외,
모호한 트리거/예산/미승인/사용 중지/대체 이력/출처를 포함한다. 이 검사는 **정답과 도구 계약**을
검증하는 결정적 harness이며 AI가 질문을 해석해 자율적으로 도구를 선택했다는 증거는 아니다.
실제 모델 평가는 동일 합성 fixture에서 질문만 제공하고 도구 기록·답을 별도로 대조해야 한다.
