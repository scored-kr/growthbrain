# 기존 Supabase 읽기 전용 점검

대상은 기존 프로젝트 kcvjsvbwinlhzgmnfsji와 과거 보고된 마이그레이션20261102050000이다.
이 문서는 실제 원격 스키마를 확인했다는 기록이 아니다. 현재 실행기에는 안전한 DB 연결 바인딩과
psql 클라이언트가 없어 원격 검증은 차단 상태다. 과거 채팅 키나 관리 토큰을 사용하지 않는다.

## 사용자 기기 또는 승인된 점검 환경에서 실행

안전한 비밀 바인딩으로 GROWTH_BRAIN_SUPABASE_DB_URL을 제공한다. URL을 채팅·명령 인자·로그·
저장소에 넣지 않는다. 지원 대상은 db.kcvjsvbwinlhzgmnfsji.supabase.co의5432포트, postgres DB인
직접 PostgreSQL 연결이다. postgres/postgresql URI와 감사용 사용자·암호만 사용하며 쿼리 파라미터,
다른 프로젝트/호스트/DB/포트, pooler 주소는 자동 수용하지 않는다. 불필요한 service-role API 키를 요구하지 않는다.

신뢰한 psql과 DB 서버 인증서의 CA 번들이 필요하다. 기본 CA 경로는 Linux의
/etc/ssl/certs/ca-certificates.crt이며 다른 기기는 GROWTH_BRAIN_DB_CA_FILE로 절대 경로를 지정한다.
TLS 인증서·호스트명 검증을 끄지 않는다. 해당 환경의 승인된 TCP 경로가 필요하며 네트워크 정책을
우회하거나 자동으로 방화벽을 변경하지 않는다.

```sh
npm run inspect:supabase
```

없거나 잘못된 설정이면 JSON 차단 사유와 종료코드1을 반환한다. 자격 증명은 자식 psql의 환경에만
전달하고 명령 인자에는 넣지 않는다. 원래 PGOPTIONS/PGSERVICE/PGHOSTADDR 등은 상속하지 않으며,
-X로 사용자 psql 시작 스크립트를 배제하고 -w로 비밀번호 입력 프롬프트를 막는다.
같은 OS 사용자나 관리자에게 환경 변수 값을 숨긴다는 보장은 아니다.

## 조회 범위와 판정

default_transaction_read_only=on과 REPEATABLE READ READ ONLY 트랜잭션을 함께 적용한다.
고정된 메타데이터 SQL만 stdin으로 보내고 종료 시 ROLLBACK한다. 연결5초·문장10초·전체25초 제한이다.
오류 출력은 연결 입력을 포함할 수 있어 그대로 표시하지 않는다.

조회하는 것은 public 테이블/컬럼/RLS·정책/인덱스/제약/트리거 정의와 정확한 마이그레이션 버전의
존재 여부다. 사용자 프로젝트·기억·인증 계정 행이나 암호문 객체의 내용은 조회하지 않는다.
표100개/컬럼100개/정책·인덱스·제약·트리거 각20개/정의2000문자와 응답2MiB 한도를 둔다.
잘림이나 빈 스키마, RLS·정책 누락, 버전 미확인, 읽기 전용 미확인은 차단으로 보고한다.

기본 검사가 맞아도 결과는 review_required이고 readyToReuse=false다. RLS 플래그만으로 서로 다른
회원의 격리가 증명되지 않으며, 테이블 이름/컬럼 형식만으로 암호문 전용 저장도 증명되지 않는다.
후속 검토에서 실제 정책·암호문 구조 및 두 계정의 읽기/쓰기/삭제 격리를 확인해야 한다.
보고서가 마이그레이션 실행이나 쓰기를 자동 허용하지 않는다. 오래된 task spec의 평문 테이블 목록과
"버전+RLS 일치 시 Ready to reuse" 문구보다 현재 보안 요구를 우선한다.

## 수행한 검증

- Python4개: 바인딩/클라이언트 누락, 타 프로젝트·TLS 우회 파라미터 거부, psql 프로세스의
  인자/환경/고정 SQL, 민감한 오류 미출력, 응답 한도·불완전 스키마 차단. 여기서 psql은 격리된 테스트 대역이다.
- PostgreSQL WASM(PGlite)2개: 실제 SQL 카탈로그 조회, RLS 전후·정책·정확한 마이그레이션 유무,
  사용자 행 비노출, READ ONLY 상태에서 INSERT/DROP 거부·기존 데이터 보존.
- PGlite0.5.15는 검증 전용 devDependency이며 제품의 데이터베이스나 Supabase 연결을 대체하지 않는다.
  실제 psql/libpq를 통한 Supabase TLS·원격 스키마·두 사용자 RLS 시험은 아직 수행하지 못했다.
