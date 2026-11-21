# Windows 시험본 계정과 암호문 동기화 설정

이 절차는 기존 Supabase 프로젝트 `kcvjsvbwinlhzgmnfsji`용 설치 파일을 만드는 담당자가 수행한다. 최종 사용자는 앱에서 이메일과 Growth Brain 전용 비밀번호를 입력한다. 테스트나 운영에서 기존 서비스와 함께 사용한 비밀번호를 재사용하지 않는다. 공식 Supabase Auth SDK는 기기에서 파생한 서비스 인증값을 고정 프로젝트의 HTTPS 인증 API로 전송한다. 앱은 별도로 파생한 포장 키를 기기에 보관한다. 가입 확인과 계정 비밀번호 재설정 화면은 6~10자리 이메일 코드를 사용한다. 발신자 설정과 가입/복구 메일 템플릿에 Supabase의 일회용 코드(Go 템플릿 `{{ .Token }}`)가 표시되는지 확인한다. 비밀번호 재설정 후 예전 암호문에는 원래 키의 복구가 필요하다.

인증 앱(TOTP)을 이미 등록한 회원은 계정 로그인에 6자리 인증 앱 코드를 사용한다. 앱은 Supabase에 등록된 첫 번째 확인된 TOTP 인증 요소에 대해 challenge/verify를 수행하고 갱신된 세션을 검사한다. 여러 인증 앱을 쓰는 경우 첫 번째로 등록된 활성 앱의 코드를 사용한다. 신뢰 기기 세션을 재개할 때도 현재 인증 수준을 다시 확인한다. 지원되지 않는 인증 요소만 등록된 계정은 로그인 화면에서 지원 안내를 받는다. 이메일로 받는 가입·복구 코드와 인증 앱 코드는 별도다. 복구 코드는 한 번만 사용할 수 있으므로 MFA 사용자는 처음부터 인증 앱 코드도 입력한다.

패키지 빌드 환경의 `GROWTH_BRAIN_SUPABASE_PUBLISHABLE_KEY`에 기존 프로젝트의 공개 `sb_publishable_…` 키를 바인딩한다. 사용자의 로그인 계정, 비밀번호, 토큰, DB 관리 키를 이 설정에 쓰지 않는다. 키가 없으면 계정 연동이 준비되지 않은 설치 파일이 생성된다. 공개 키만 등록한 빌드에서 계정 인증 모듈을 시험할 수 있다. 설치형 앱의 로그인·금고 동기화 화면을 활성화하려면 아래 검증도 완료해야 한다.

동기화까지 활성화하려면 아래 두 입력을 빌드 담당자가 검토해 제공한다. 빌드 도구가 보고서와 계약의 일치를 확인한 후 파일에는 자격 검토 해시와 공개 키만 포함한다. 설치 후 RPC 응답에서도 계약 이름과 응답 구조를 검사한다.

1. `GROWTH_BRAIN_SYNC_CATALOG_REPORT`는 기존 프로젝트에서 `python3 scripts/qualify-sync-catalog.py`가 출력한 JSON 파일의 경로다. 읽기 전용 스키마·함수·정책·권한 지문이 저장소의 기준값과 일치해야 한다.
2. `GROWTH_BRAIN_SYNC_ISOLATION_REVIEW`는 두 독립된 합성 계정으로 수행한 승인된 검증 결과를 검토한 담당자의 JSON 파일 경로다. 실제 프로젝트에서 익명 접근 거부, 교차 계정 읽기·쓰기·삭제 거부, 낡은 revision 거부, 용량 제한, 삭제 뒤 과거 기기의 재업로드 거부를 확인하고 근거 파일을 보관한다. 이 파일은 검토자의 확인 기록이므로 신뢰하는 빌드 환경에서만 지정한다. 기존 검사 결과가 없으면 입력을 생략한다. 검토에 필요한 원격 쓰기는 별도 승인된 시험 절차에서만 수행한다.

검증 담당자는 두 시험 계정이 모두 비어 있고 B의 서버 할당량이 1 KiB~1 MiB인 승인된 시험 환경을 사용한다. 검증 도구가 계정을 만들거나 할당량을 조정하지 않는다. 일반 사용자의 계정이나 금고를 지정하지 않는다. 각 계정의 UUID와 이메일·앱 전용 비밀번호를 안전한 빌드 바인딩 `GB_TEST_ACCOUNT_A_ID`, `GB_TEST_ACCOUNT_A_EMAIL`, `GB_TEST_ACCOUNT_A_PASSWORD` 및 동일한 `GB_TEST_ACCOUNT_B_…` 이름에 제공한다. 계정 ID는 로그인 뒤 서비스에서 재확인한다.

제품을 빌드한 뒤 프로젝트 루트에서 `node scripts/verify-sync-isolation.mjs --disposable-accounts <새-근거-디렉터리>`를 실행한다. 같은 디렉터리에 `run-evidence.json`과 `isolation-review.json`이 생성된다. 도구는 표준 사용자의 실제 인증과 RPC를 통해 합성 암호문을 쓰고 서버의 거절 코드를 검사한다. 이번 실행에서 생성한 합성 암호문을 확인한 뒤 정리하며, A 계정에는 삭제 세대 표시가 남는다. 실패하면 통과 보고서를 생성하지 않는다. 시험 담당자는 근거를 검토하고 두 파일을 함께 보관한다. `GROWTH_BRAIN_SYNC_ISOLATION_REVIEW`에는 두 번째 파일 경로를 지정한다. 빌드 도구는 같은 디렉터리의 실행 근거 파일 해시와 상태도 확인한다.

두 번째 파일의 필드 계약은 다음과 같다. `projectRef`, `contract`, `contractSha256`, `catalogSha256`은 첫 번째 파일의 값과 일치해야 한다. `kind`는 `growthbrain-sync-isolation-review-v1`, `catalogReportSha256`은 첫 파일 원본 바이트의 SHA-256, `runEvidenceSha256`은 비밀을 제거한 실제 시험 기록 파일의 SHA-256이다. `checks`에는 각 검사를 확인한 경우에만 `true`를 기록한다.

- `verifiedDistinctAccounts`, `anonymousDenied`
- `crossAccountReadDenied`, `crossAccountWriteDenied`, `crossAccountPurgeDenied`
- `staleRevisionRejected`, `quotaEnforced`, `purgePreventsStaleUpload`

환경 변수를 설정하고 기존 Windows 설치 파일 빌드 절차를 실행한다. 보고서 하나만 있거나 스키마 지문·계약 SQL 해시·검토 결과가 어긋나면 빌드는 중단된다. PGlite 또는 테스트 더블 결과를 배포 대상의 검토 증거로 쓰지 않는다. 기존 프로젝트에 대한 배포나 스키마 변경은 이 빌드 절차에 포함되지 않는다.
