# Mem0 공개 소스 검토와 도입 판단 — 2026-11-05

검토: [mem0ai/mem0](https://github.com/mem0ai/mem0), SHA `ed1f10fc87080f0b67f99be370817504888462ab`.
Growth Brain 비교 기준: `28deb1d4f620eaa5f62123bd7eec0dc4374c2953`.
사용자는 저장소 조사에 더해 확인된 보안·보완 사항의 구현/검증을 요청했다.

**판단:** 추출 목적 분리, 검색 신호/근거 분리, 공통 코어와 클라이언트별 어댑터, 수집/전송 상태 계약을
참고할 가치가 있다. 전체 라이브러리 도입은 우리의 기기 암호화·명시 승인 경계와 맞지 않는다.
현재 사용자 목표인 선호도 개인화의 성과는 [대조 실험](personalization-evaluation.md)으로 확인해야 한다.

## 조사 범위

- 공개 저장소를 별도 분석 경로에 depth1 복제하고 추적 항목1,844개의 목록을 조사했다.
  Python 코어151, TypeScript249, integrations395, server185, tests107, docs364 항목 등이 있다.
- Python 추출/검색/히스토리/설정, TypeScript 대응 검색, 공통 플러그인과 Codex/Claude 훅,
  MCP, 서버 인증/검색 경계, 프로필/피드백 SDK, 관련 테스트를 중심으로 읽었다.
  모든1,844개 파일의 전 행을 감사했다는 뜻은 아니다.
- 순수 계산 파일인 scoring.py를 직접 로드해 네 가지 합성 오프라인 탐침을 수행했다.
  전체 Mem0 설치/테스트, 모델/API 호출, 서비스 기동, 플러그인 설치는 하지 않았다.
- evaluation은 memory-benchmarks 저장소의 gitlink `4b61c5d31b9c668a12b4f5e78064248a02c82d2b`다.
  서브모듈의 전체 벤치마크는 실행하지 않았다. 현재 pytest도 미설치이며 upstream 전체 통과를 주장하지 않는다.
- 기존 고정 mcp-builder/sharp-edges 및 제품 실험/합격 기준을 적용했다. 저장소 내 설치 명령은
  검토 자료이며 우리 제품의 실행 지시나 정책으로 취급하지 않았다.

## 실제 소스에서 얻은 아이디어

| 영역 | 실제 코드와 발견 | Growth Brain 판단 |
| --- | --- | --- |
| 최신 추출 | [main.py L881](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/mem0/memory/main.py#L881): 최근 대화/유사 기억→단일 LLM 추출→배치 임베딩/저장→개체 연결. 자동 추출은 ADD-only | 한 사실씩 보존하고 성공 저장만 성공으로 반환하는 계약 참고. 별도 update/delete API는 존재하며 옛 UPDATE/DELETE 프롬프트가 기본 경로라고 설명하면 틀림 |
| 발언 출처 | [ADDITIVE_EXTRACTION_PROMPT](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/mem0/configs/prompts.py#L468)는 사용자와 AI의 추천/계획/조사도 추출하고 attributed_to 구분 | 출처/역할 분리 참고. 우리 제품은 후보 승인 유지, AI의 완료 주장이나 추천을 확인된 사용자 결정으로 자동 승격하지 않음 |
| 검색 | [main.py L1642](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/mem0/memory/main.py#L1642): 넉넉한 의미 후보+BM25+개체 가점, 선택적 rerank, explain | 신호별 근거와 누락 원인 관측을 참고. 공통 기본 선호는 질의 유사도가 낮아도 먼저 검토하고 승인/범위/현재값을 순위보다 먼저 제한 |
| 추출 목적 분리 | [memory_core.py](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/integrations/agent-plugin-core/python/memory_core.py#L74)의 PERSONAL/PROJECT 지침은 flush의 custom_instructions/agent_custom_instructions로 실제 전달됨 | 공통 선호와 프로젝트 사실을 다른 계약으로 다루는 아이디어 참고. 프로젝트 발언의 자동 global 승격은 가져오지 않음 |
| 클라이언트 공통화 | [agent-plugin-core](https://github.com/mem0ai/mem0/tree/ed1f10fc87080f0b67f99be370817504888462ab/integrations/agent-plugin-core): 공유 코어로 각 호스트 패키지를 생성, 각자 native 어댑터/훅 보유 | 기존 공유 엔진+별도 설치기 유지. 공통 동작/호스트 이벤트/산출물 검사를 분리. portable 패키지와 native 자동 수집을 혼동하지 않음 |
| 자동 수집/재시도 | EvidenceStore/flush_session이 SQLite에 세션·packet·event 상태를 보관하고 배치 전송/서버 완료를 추적 | queued/succeeded/failed/timeout 구분 참고. 우리에게 재전송 큐가 필요하면 암호화/동의 세대/잠금/삭제부터 설계 |
| 자동 조회 | [hook_runner.py L62](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/integrations/agent-plugin-core/python/hook_runner.py#L62)는 첫 프롬프트 검색 후 additionalContext 반환, 기주입 기억 추적 | 조회 성공과 모델의 결과 반영을 구분. 우리는 실제 제품 MCP 호출이 합격 요건이며 훅 주입만으로 대체하지 않음 |
| 사용자 프로필 | [client/main.py L831](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/mem0/client/main.py#L831)는 원격 profile/작업 API를 호출 | pending/failed/not_enabled/insufficient_data 상태 계약 참고. 서버의 프로필 생성 알고리즘까지 이 파일에서 확인된 것은 아님 |
| 피드백 | [client/main.py L1233](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/mem0/client/main.py#L1233)는 기억 ID/평가/이유를 feedback API에 전송 | 작업 결과/교정을 기억과 연결하는 개념 참고. 순위 개선 효과/학습 알고리즘은 검증되지 않았고 긍정 평가를 자동 승인으로 쓰지 않음 |

이 아이디어들은 대화·기억·프로필·결과를 연결하는 데 유용하지만 선호도의 적용 조건과 예외까지
자동으로 정확히 해결해 준다는 증거는 아니다. 한국어 입력 품질과 우리 제품의 효과를 별도로 검증한다.

## 검색 탐침 결과

[scoring.py](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/mem0/utils/scoring.py)의
SHA256은 `9a4313fda723ad05cb52278e9ef0b9b5792b71fb3b41ba6318410121022e4527`이다.
math/typing만 사용하는 이 모듈의 함수에 합성 후보를 전달해 다음을 직접 확인했다.

1. BM25에만 있는 ID는 의미 후보 집합에 추가되지 않는다.
2. 의미 점수가 threshold 미만이면 높은 키워드/개체 가점으로도 구제하지 않는다.
3. 활성 신호에 따라 정규화 분모가 바뀌고 explain에 표시된다.
4. 입력 후보의 원래 점수는 변경하지 않는다.

따라서 ‘하이브리드 검색’이라는 이름만으로 모든 키워드 누락이 해결되지는 않는다.
우리 색인을 전면 교체하기 전에 미사용 한국어/의역 질의의 전후 결과와 비용을 확인해야 한다.
벡터 점수, 선호 강도, 사실의 확실성, 결과물의 개인화 품질은 서로 다르다.

## 보안 구조와 도입 경계

| 확인한 소스 | 도입 판단 |
| --- | --- |
| 기본 LLM/embedding provider는 OpenAI, 플러그인 기본 API는 api.mem0.ai | 로컬 저장과 외부 모델 전송은 별개. 서버에는 암호문만 둔다는 우리 계약으로 그대로 사용할 수 없음 |
| evidence.sqlite3 및 대화/기억 payload 저장 | 이 경로에서 앱 수준 암호화 금고를 사용하는 코드는 확인하지 못함. 현재 금고를 대체하지 않음 |
| 비밀 문자열 정규식 마스킹 | 추가 방어로 참고 가능하지만 모든 비밀/개인 정보를 제거한다는 보장은 아님. 동의·암호화 대체 불가 |
| SDK telemetry 기본 활성화 | 전송 항목/대상을 별도 검토해야 함. 자동 분석 전송을 우리 코드에 추가하지 않음 |
| self-hosted 인증, 요청의 user_id/filters 및 memory ID 조회 | 인증 존재가 회원별 강제 격리의 증거는 아님. 요청자에 묶인 권한/RLS를 대체할 코드로 복사하지 않음 |
| README의 최신 관리형 벤치마크 | 독점 최적화 포함임을 명시. OSS나 Growth Brain의 실제 성능으로 인용하지 않음 |

이는 우리의 도입 경계 검토다. Mem0 관리형 서비스 전체가 취약하다는 주장이나 침투 결과가 아니다.
사용자 금고·실제 계정·운영 서비스에 접근하지 않았다. 모델이 받은 맥락은 해당 AI 서비스가 읽을 수 있다.

## 이번에 수정한 Growth Brain 세션 경계

재현: A에 동의한 폴더에서 세션S 수집→폴더를 B로 재바인딩→S의 SessionStart.
기존 시작 훅은 현재 binding만 읽어 B의 projectId를 조회하라고 안내했다. captureAgent의 세션
격리 검사는 다음 대화 수집에만 적용돼 시작 시 조회 안내를 보호하지 못했다.

수정: 내부 get_agent_binding에도 sessionId를 필수 전달한다. 저장된 같은 client/session의
workspace/project가 현재 binding과 다르면 `AGENT_SESSION_SCOPE_MISMATCH`로 중단하고 새 세션을 안내한다.
오류에 프로젝트 ID/원문을 넣지 않는다. 기존 동의 세대 검사와 새 세션·수집 중지 시 동작은 유지한다.
제품 MCP 도구나 상태 형식은 이 수정으로 변경하지 않았다.

새 회귀 검사는 수정 전 실패를 확인했고 수정 후 실제 Codex/Claude 훅 프로세스+Unix IPC에서
재바인딩/작업 폴더 이동을 차단했다. 전체 Node 검사67/67 통과.
설치된 AI 클라이언트의 실행이나 실제 개인화 결과 검증과는 구분한다. 저장된 수집 이력이 없는
세션의 과거 맥락까지 판별할 수 없고, 같은 OS 사용자를 적대적 격리 경계로 만들지는 않는다.

## 후속 구현과 라이선스

다음 구현은 업무별 선호도 적용 조건, 조회/검색의 동일 필터, 후보 수정의 조건 보존이다.
불명확한 작업에서는 조건부 선호를 제외하고 무조건 기본값을 유지한다. v4에서 새 상태 형식으로
전환할 경우 이전 암호문을 먼저 보존하고 로컬 승인 화면·MCP 계약·복구/검색 회귀를 함께 확인한다.
일반 의미 충돌 해결, 대형 임베딩, 교정 효과 계측은 별도 작업이다.

루트 [LICENSE](https://github.com/mem0ai/mem0/blob/ed1f10fc87080f0b67f99be370817504888462ab/LICENSE)는 Apache-2.0이다.
코드 복사/수정/재배포 시 해당 라이선스·저작권·NOTICE 유지 및 변경 표시를 확인해야 한다.
별도 LICENSE/NOTICE가 있는 integration/skill은 파일별 조건도 확인해야 한다.
이번에는 원문 코드를 제품에 복사하거나 Mem0 런타임 의존성을 추가하지 않았다.

후속 챕터26: 위 업무별 조건/동일 필터/후보 수정 조건 보존을 구현하고 전체 test:local을 통과했다.
[구현 계약과 한계](preference-applicability.md)를 따른다. 내부 상태v5 전환 백업/복구와 검토 UI를
포함하며 일반 의미 충돌/실제 AI 결과 계측은 남아 있다. Mem0 코드를 복사한 구현이 아니다.

챕터27 후속: Mem0 CLI JSON import와 Claude transcript 처리 아이디어를 검토한 뒤,
우리 초기 MVP인 **ChatGPT·Claude 일반 채팅 export**의 선택 가져오기를 직접 구현했다.
Mem0의 원격 전송/직접 확정 저장을 도입하지 않았다. [실제 계약](chat-history-import.md)을 참고한다.
