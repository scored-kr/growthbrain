# Windows 시험본 계정과 암호문 동기화 설정

이 절차는 기존 Supabase 프로젝트 `kcvjsvbwinlhzgmnfsji`용 설치 파일을 만드는 담당자가 수행한다. 최종 사용자는 앱에서 이메일과 Growth Brain 전용 비밀번호를 입력한다. 테스트나 운영에서 기존 서비스와 함께 사용한 비밀번호를 재사용하지 않는다. 공식 Supabase Auth SDK는 기기에서 파생한 서비스 인증값을 고정 프로젝트의 HTTPS 인증 API로 전송한다. 앱은 별도로 파생한 포장 키를 기기에 보관한다. 가입 확인과 계정 비밀번호 재설정 화면은 6~10자리 이메일 코드를 사용한다. 발신자 설정과 가입/복구 메일 템플릿에 Supabase의 일회용 코드(Go 템플릿 `{{ .Token }}`)가 표시되는지 확인한다. 비밀번호 재설정 후 예전 암호문에는 원래 키의 복구가 필요하다.

패키지 빌드 환경의 `GROWTH_BRAIN_SUPABASE_PUBLISHABLE_KEY`에 기존 프로젝트의 공개 `sb_publishable_…` 키를 바인딩한다. 사용자의 로그인 계정, 비밀번호, 토큰, DB 관리 키를 이 설정에 쓰지 않는다. 키가 없으면 계정 연동이 준비되지 않은 설치 파일이 생성된다. 공개 키만 있으면 로그인할 수 있고 동기화는 비활성 상태다.

동기화까지 활성화하려면 아래 두 입력을 빌드 담당자가 검토해 제공한다. 빌드 도구가 보고서와 계약의 일치를 확인한 후 파일에는 자격 검토 해시와 공개 키만 포함한다. 설치 후 RPC 응답에서도 계약 이름과 응답 구조를 검사한다.

1. `GROWTH_BRAIN_SYNC_CATALOG_REPORT`는 기존 프로젝트에서 `python3 scripts/qualify-sync-catalog.py`가 출력한 JSON 파일의 경로다. 읽기 전용 스키마·함수·정책·권한 지문이 저장소의 기준값과 일치해야 한다.
2. `GROWTH_BRAIN_SYNC_ISOLATION_REVIEW`는 두 독립된 합성 계정으로 수행한 승인된 검증 결과를 검토한 담당자의 JSON 파일 경로다. 실제 프로젝트에서 익명 접근 거부, 교차 계정 읽기·쓰기·삭제 거부, 낡은 revision 거부, 용량 제한, 삭제 뒤 과거 기기의 재업로드 거부를 확인하고 근거 파일을 보관한다. 이 파일은 검토자의 확인 기록이므로 신뢰하는 빌드 환경에서만 지정한다. 기존 검사 결과가 없으면 입력을 생략한다. 검토에 필요한 원격 쓰기는 별도 승인된 시험 절차에서만 수행한다.

두 번째 파일의 필드 계약은 다음과 같다. `projectRef`, `contract`, `contractSha256`, `catalogSha256`은 첫 번째 파일의 값과 일치해야 한다. `kind`는 `growthbrain-sync-isolation-review-v1`, `catalogReportSha256`은 첫 파일 원본 바이트의 SHA-256, `runEvidenceSha256`은 비밀을 제거한 실제 시험 기록 파일의 SHA-256이다. `checks`에는 각 검사를 확인한 경우에만 `true`를 기록한다.

- `verifiedDistinctAccounts`, `anonymousDenied`
- `crossAccountReadDenied`, `crossAccountWriteDenied`, `crossAccountPurgeDenied`
- `staleRevisionRejected`, `quotaEnforced`, `purgePreventsStaleUpload`

환경 변수를 설정하고 기존 Windows 설치 파일 빌드 절차를 실행한다. 보고서 하나만 있거나 스키마 지문·계약 SQL 해시·검토 결과가 어긋나면 빌드는 중단된다. PGlite 또는 테스트 더블 결과를 배포 대상의 검토 증거로 쓰지 않는다. 기존 프로젝트에 대한 배포나 스키마 변경은 이 빌드 절차에 포함되지 않는다.
