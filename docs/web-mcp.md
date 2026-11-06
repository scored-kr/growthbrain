# 일반 웹 채팅 연결 — 사용자 기기 HTTPS MCP

ChatGPT와 Claude 일반 채팅 모두가 초기 MVP다. 이번 구현은 실제 HTTPS/OAuth/MCP 전송 경로이며
로그인한 서비스에서 자연어 요청의 자동 호출·개인화 결과까지 검증한 것은 아니다.

## 기기에서 실행

기존 `npm run vault -- serve`로 사용자 기기에서 금고를 연다. 개발 클라우드로 사용자 금고를 보내지 않는다.
사용자 기기에서 신뢰할 수 있는 인증서와 해당 개인키를 준비하고 아래 설정을 저장한다.
이 예시는 설정 형식이며 공개 주소·인증서 발급·방화벽 변경을 자동 수행하지 않는다.

```json
{
  "origin": "https://memory.example.com:8443",
  "certificateFile": "/absolute/device-certificate.pem",
  "privateKeyFile": "/absolute/private/device-key.pem",
  "host": "127.0.0.1",
  "port": 8443
}
```

TLS는 이 기기의 서버에서 종료한다. 직접 연결 또는 암호문 바이트만 전달하는 TCP passthrough를
사용한다. TLS를 해제하는 일반 HTTPS 프록시나 키를 업로드하는 중계 서비스를 이 보안 모델의
동등한 대체로 취급하지 않는다. 외부 주소와 실제 TCP 경로·인증서 신뢰는 별도 설치 검증이 필요하다.
기본 bind는 loopback이며 직접 외부 연결이 필요하면 사용자가 `host: "0.0.0.0"`을 명시한다.
평문 HTTP listener, `trust proxy`, 임의 Forwarded 헤더나 인증 없는 기억 API는 없다.

1. 로컬 금고 터미널에서 `web-start` → 설정 파일 경로 → `WEB` 확인.
2. 지원되는 ChatGPT/Claude 커넥터에 `https://memory.example.com:8443/mcp`를 등록하고 OAuth 인증한다.
3. 브라우저에 연결 요청 번호가 나온다. 로컬 터미널 `web-requests`로 요청을 확인한다.
4. `web-approve`에서 동일 요청 번호·정확한 callback 주소를 확인하고 `COMMON` 또는 프로젝트 UUID
   하나를 선택한 뒤 `ALLOW`. 클라이언트 이름은 외부 입력이며 검증된 서비스 이름이 아니다.
5. 브라우저가 원래 서비스로 돌아가서 코드 교환을 완료한다. 비밀번호·복구 키를 입력하지 않는다.
6. `web-connections`, `web-audit`로 상태를 확인한다. `web-revoke`는 연결 하나를 철회하고,
   `web-stop`/금고 `lock`/종료는 웹 연결을 닫는다. 승인·철회는 MCP/HTTP에 노출하지 않는다.

OAuth discovery, 동적 클라이언트 등록(DCR), S256 PKCE, 정확한 callback/resource 연결,
15분 access token과 회전형 refresh token, 최대24시간의 로컬 연결 동의를 지원한다.
사용한 refresh token 재전송은 해당 연결 전체를 철회한다. 재시작 시 클라이언트 등록/동의/토큰은
사라지므로 다시 등록·인증한다. 토큰은 RAM에서 해시로 관리하고 등록용 client secret은 RAM에만 둔다.
실제 플랫폼의 DCR·client 인증 방식·계정/워크스페이스 허용 여부는 별도 확인해야 한다.
CIMD 원격 메타데이터 fetch나 계정 비밀번호 로그인은 이 모듈에 넣지 않았다.

## 조회 계약

웹 연결은 `get_context`/`search_memory` 읽기만 노출한다. stdio의 기존 세 도구는 유지한다.
웹의 후보 수집/승인은 확장·로컬 화면을 사용한다. 공통 전용 연결은 query의 프로젝트 트리거도
허용하지 않고 공통만 반환한다. 프로젝트 연결은 사용자가 승인한 하나를 기본값으로 고정하며,
다른 UUID를 요청하면 `PROJECT_ACCESS_DENIED`다. 프로젝트를 바꾸려면 연결 범위를 다시 승인한다.
현재 요청 > 프로젝트 > 공통, 업무 적용 조건, 미승인/기각/대체/사용 중지 제외는 기존 엔진과 같다.

MCP 초기화의 instructions에 개인화·이전 결정에 의존하는 답변 전 get_context 호출을 안내한다.
상세 검색은 같은 프로젝트/업무/현재 요청 조건으로 수행한다. 지침은 클라이언트의 호출을 강제하는
훅이 아니며 모든 턴 자동 호출을 보장하지 않는다. 조회 실패를 개인화 성공으로 표시하지 않는다.
`web-audit`는 최근200개의 도구 이름·시각·성공 여부만 RAM에 기록하고 종료 시 지운다.
원문/질의/프로젝트 이름/기억 값/토큰을 로그로 남기지 않는다. 실제 답변에 반영됐다는 증거는 별도다.

## 검증과 남은 조건

`test/web-mcp.test.mjs`는 합성 금고·테스트 인증서를 사용해 실제 TLS와 HTTP OAuth 코드 교환,
SDK Streamable HTTP MCP 초기화/도구 호출, 범위·현재 요청·PKCE·브라우저 binding·철회·만료·
refresh replay·잠금·Origin/Host 거부를 검사한다. 테스트는 지정한 자체 CA만 신뢰하며 TLS 검증을
전역으로 끄지 않는다. 새 의존성 Express는 기존 MCP SDK가 사용하던 버전을 직접 고정했다.

실제 사용자 기기, 공인 인증서와 네트워크 경로, ChatGPT/Claude 계정·권한, 자연어 자동 호출과
결과물은 미검증이다. 사용자 기기가 꺼져 있거나 금고가 잠기면 조회할 수 없다. AI로 전달한 기억은
AI 서비스가 읽고 보유할 수 있으며 로컬 철회/삭제가 이미 전달한 내용까지 회수하지는 않는다.

공식 연결 참고: [ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server),
[Claude](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
생성 task spec의 localhost 직접 접근/Custom Actions/옛 packages 경로와 달리 현재 실제 SDK·src
구조와 웹 MCP/OAuth를 따른다. active 신규 결정의 supersedesId는 정당한 이력이므로 일괄 제외하지 않는다.
