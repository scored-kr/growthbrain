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
- popup에서 사이트 수집 동의/프로젝트 선택/기억 검토를 변경한다. 별도 import 페이지의 프로젝트 생성·가져오기는 아래 계약을 따른다. content script는 캡처만 요청하며, background가
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

## 수집 재개와 상태 확인

금고가 잠긴 동안에는 원문을 브라우저 디스크에 쌓지 않는다. 열린 탭에서 현재 DOM을 최대
30초 간격으로 다시 시도하므로 잠금 해제 후 페이지를 수정하지 않아도 재개한다. 탭을 닫거나
사이트가 원문을 제거하면 해당 내용은 수집되지 않을 수 있다. 용량 초과는 자동 반복하지 않으므로
로컬 금고 상태를 확인하고 수집을 다시 시작한다.

popup의 “수집 허용”은 동의 상태다. “마지막 전송 확인”은 로컬 엔진 응답을 받은 결과이며,
새로고침으로 갱신한다. 워커 재시작 후에는 “아직 확인된 전송 없음”으로 돌아갈 수 있다.
검토 프로젝트를 바꿔도 수집 저장 대상은 별도 시작 동의를 누르기 전까지 유지된다.
페이지 이동·중지·재개 중 이전 배치의 메시지/응답을 새로운 대화·동의 세대와 섞지 않는다.

## 기억 수정과 사용 중지

후보의 **후보 수정**에서 값과 사유를 입력한 뒤 **수정안 저장**을 누른다. 원래 후보와 출처는
이력으로 남고 새 승인 대기 후보가 생긴다. 저장만으로 AI에 적용되지 않는다. 다시 검토하고
승인해야 하며, 기존 조건이 있으면 교체 대상을 명시한다.

기억 카드와 기존 교체 대상에 [적용 업무](preference-applicability.md)를 표시한다. 제한 없는 기억은
‘모든 업무의 기본값’으로 표시한다. 후보 값을 수정해도 기존 업무 조건은 그대로 보존되며,
조건을 변경하려면 새 제안을 명시적으로 만들고 검토한다. popup은 조건을 자동 추론하지 않는다.

확정 기억의 **사용 중지**에서 사유를 입력하고 **사용 중지 확인**을 누르면 조회·검색에서 제외된다.
대체되었던 과거 결정은 부활하지 않는다. 프로젝트 조건 중지 후 공통 기본값이 적용될 수 있으며,
공통 기억 중지는 모든 프로젝트에 영향을 준다. **전체 상태**에서 수정/중지 이력을 확인한다.
이 동작은 물리 삭제가 아니다. 전체 로컬 삭제는 사용자 터미널의 `delete-all`로 별도 확인한다.

## 기존 일반 채팅 가져오기

확장 아이콘의 **기존 채팅 대화 가져오기**에서 ChatGPT/Claude 내보내기 JSON을 기기에서 선택한다.
별도 탭의 미리보기·프로젝트 선택/생성·명시 동의를 거쳐 후보를 만든다.
Claude 분기 미확인 export는 추가 확인과 출처 표시를 유지한다. 사이트 수집 동의는 자동으로 켜지지 않는다.
이 import 페이지에는 가져오기·프로젝트 생성만 추가 허용하고 content script에는 허용하지 않는다.
[형식/한도/검토/중단/검증 안내](chat-history-import.md)를 따른다.
