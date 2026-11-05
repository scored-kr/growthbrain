# Growth Brain

사용자의 공통 선호도와 프로젝트 기억을 AI가 직접 조회하는 제품입니다.
제품의 핵심은 사용자 기기에서 해독·검색하는 **Growth Brain MCP**입니다.
**ign8t MCP**는 개발 명세와 작업 보드를 관리하며 제품 MCP와 역할이 다릅니다.

초기 MVP 대상은 **ChatGPT·Claude 일반 웹 채팅 모두**입니다. Codex·Claude Code는 보조 연동입니다.
[기존 채팅 가져오기](docs/chat-history-import.md)는 확장 화면에서 두 서비스의 내보내기 JSON을
선택·검토해 로컬 금고에 넣는 기능입니다. 실제 웹 채팅의 MCP 호출·개인화 결과 검증은 남아 있습니다.

현재 로컬 암호화 금고·복구 키·백업/복원, 공통/프로젝트별 색인과 명시 트리거, 구조화된 stdio 제품 MCP,
동의 기반 Chrome 수집과 Codex/Claude 훅 어댑터, 후보 수정·확정 기억 사용 중지 구현이 있습니다.
실제 클라이언트 훅/모델 개인화 검증과 MVP 전체 완료를 의미하지 않습니다.
실제 AI 클라이언트·Supabase·설치된 확장 전체 검증의 차단 상태는 아래 기록을 확인하세요.

- [최신 요구사항 및 합격 기준](docs/requirements-2026-11-03.md)
- [복구 상태 및 다음 작업](docs/recovery-status.md)
- [아키텍처 차이와 적용 결정](docs/architecture-alignment.md)
- [로컬 실행 및 보호 범위](docs/local-development.md)
- [복구 키·비밀번호 분실 복구](docs/recovery-keys.md)
- [Codex 설치·해제](docs/codex-integration.md)
- [실제 검증 범위와 남은 제한](docs/validation-2026-11-03.md)
- [보드 기반 구현 스펙](docs/implementation-spec.md)
- [Chrome 수집·검토 설치](docs/chrome-integration.md)
- [챕터별 진행·커밋 기록](docs/chapter-progress.md)
- [커밋으로 되돌리는 방법](docs/commit-and-recovery.md)
- [새 기기 개발 재개·ign8t 연결](docs/development-handoff.md)
- [공개 스킬 9개와 5회 검토](docs/skill-review-loops.md)
- [제품 MCP 출력 계약](docs/mcp-contract.md)
- [실제 클라이언트 합격·효용 실험 설계](docs/product-validation.md)

Node.js 24 이상에서 `npm ci`, `npm test`로 설치·검증합니다.

API 키, 복구 키, 실제 사용자 기억, 개인 MCP 설정을 이 저장소에 넣지 마세요.
