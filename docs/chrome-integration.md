# Chrome 대화 수집 및 로컬 검토

확인 버전: Chromium 154.0.8037.57, Playwright 1.64.1. Manifest V3.
공식 자료: [Native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[선택 권한](https://developer.chrome.com/docs/extensions/reference/api/permissions),
[Playwright 확장 검사](https://playwright.dev/docs/chrome-extensions).

## 사용자 기기 설치

1. Linux/macOS에 Node.js 24+, Python 3, Chrome/Chromium을 준비하고 `npm ci && npm run build`.
2. 해당 브라우저의 확장 관리 화면에서 개발자 모드로 저장소 `extension/`을 압축 해제 확장으로 로드한다.
   조직 관리 정책이 차단하면 관리자 승인 없이는 진행하지 않는다.
3. 화면에 표시된 정확한 확장 ID로 아래 native host를 등록한다. Chrome은 등록된 ID만 허용한다.

```sh
python scripts/native-integration.py install --extension-id <확장-ID>
# Chromium 사용자는 --browser chromium 추가
npm run vault -- init
# 이후에는 npm run vault -- serve
```

4. 별도 로컬 터미널에서 비표시 잠금 해제 후 CONNECT를 입력한다. 터미널 `project`로 프로젝트를 만든다.
5. 확장 popup에서 사이트와 프로젝트를 선택하고 **이 사이트 수집에 동의하고 시작**을 누른다.
   최초에는 해당 사이트의 브라우저 권한 확인을 거친다. ChatGPT·Claude는 각각 동의한다.
6. 캡처된 사용자 피드백은 후보로 표시된다. 출처·원문·사유를 읽고 승인/기각한다.
   기존 조건과 충돌하면 교체할 조건을 명시적으로 선택한다. 승인 전에는 제품 MCP 조회에서 제외된다.
7. **수집 중지**는 브라우저를 즉시 정지시킨다. 금고가 잠겨 서버 측 동의 상태를 갱신하지 못하면
   그 사실을 표시한다. 브라우저의 일시적 중지는 전체 장치에 대한 영구 동의 철회가 아니다.

## 해제

수집을 중지한 후 확장을 제거하고 설치 때와 같은 ID/경로 옵션으로 실행한다.

```sh
python scripts/native-integration.py remove --extension-id <확장-ID>
```

직접 설치한 native manifest/launcher와 내용이 일치할 때만 삭제한다. 기존 사용자 수정,
다른 native host, MCP 설정, 금고 데이터는 보존한다. 전체 금고 삭제는 별도 터미널의
`delete-all` 확인 흐름이다. 해제만으로 이미 캡처된 데이터나 AI 서비스의 사본은 삭제되지 않는다.

## 경계와 검사

- 수집 연결은 Chrome native messaging → 사용자 전용 Unix socket → 암호화 금고이다.
  HTTP/클라우드에 원문을 전송하지 않는다. 본문·프로젝트 이름을 browser storage에 저장하지 않는다.
- popup만 동의/프로젝트/검토를 변경한다. content script는 캡처만 요청하며, background가
  sender의 사이트·현재 페이지 URL을 검증하고 선택 프로젝트를 붙인다. 엔진도 동의를 재검사한다.
- native 관리 API는 제품 MCP 도구에 등록하지 않는다. 비밀번호/복구 키는 native 메시지에도 없다.
- 어댑터는 ChatGPT의 author/message-id 속성, Claude의 user-message/assistant-message와
  안정된 message-id 또는 conversation-turn 식별자를 사용한다. 식별자가 없으면 수집하지 않는다.
  실제 사이트 DOM은 변할 수 있으며 로그인된 최신 서비스 페이지에서는 아직 검증하지 않았다.
- `npm test`: 실제 native 프레임·캡처·승인·결정 교체 및 브라우저 권한 로직 단위 검사.
- `npm run test:ui`: 실제 Chromium에서 합성 DOM과 mock Chrome API로 추출·중지·검토·HTML
  이스케이프를 검사. 설치된 확장 전체의 검증을 대체하지 않는다.
- `npm run test:browser`: 임시 브라우저 프로필에 확장을 실제 설치하고 native host까지 연결하는
  시험. 합성 호스트 권한은 테스트 복사본에 사전 부여되므로 실제 사용자 권한 확인 UI 검증은 별도다.

현재 관리 환경에는 `ExtensionInstallBlocklist: ["*"]` 정책이 있어 실제 확장 설치 검사는
차단됐다. 정책을 변경하거나 우회하지 않았다. 승인된 사용자 기기에서 이 시험을 실행해야 한다.
Windows native host, 실제 ChatGPT/Claude 로그인 사이트, 스토어 배포는 미검증/미지원이다.
