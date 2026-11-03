# Growth Brain

사용자의 공통 선호도와 프로젝트 기억을 AI가 직접 조회하는 제품입니다.
제품의 핵심은 사용자 기기에서 해독·검색하는 **Growth Brain MCP**입니다.
**ign8t MCP**는 개발 명세와 작업 보드를 관리하며 제품 MCP와 역할이 다릅니다.

현재 로컬 암호화 금고, 공통/프로젝트 기억 엔진, stdio 제품 MCP를 복구했습니다.
MVP 전체 완료를 의미하지 않습니다. 실제 클라이언트·동기화·확장 검증 상태는 아래 기록을 확인하세요.

- [최신 요구사항 및 합격 기준](docs/requirements-2026-11-03.md)
- [복구 상태 및 다음 작업](docs/recovery-status.md)
- [아키텍처 차이와 적용 결정](docs/architecture-alignment.md)
- [로컬 실행 및 보호 범위](docs/local-development.md)
- [Codex 설치·해제](docs/codex-integration.md)
- [실제 검증 범위와 남은 제한](docs/validation-2026-11-03.md)

Node.js 24 이상에서 `npm ci`, `npm test`로 설치·검증합니다.

API 키, 복구 키, 실제 사용자 기억, 개인 MCP 설정을 이 저장소에 넣지 마세요.
