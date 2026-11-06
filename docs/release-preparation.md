# 로컬 검증과 배포 전 산출물

현재 저장소는 사용자 기기의 Node 금고/MCP와 Chrome 확장이다. 과거 `packages/*` Fastify/Next/Vercel 배포·Supabase 초기 마이그레이션을 실행하는 파이프라인은 사용하지 않는다.

`.github/workflows/ci.yml`은 Node 24 설치, lockfile 설치, Chromium 준비, `test:local`, 확장 정적 검사, 브라우저 생성 모듈 일치 검사, 패키징을 수행한다. 실패하면 이후 단계가 진행되지 않는다. GitHub 권한은 contents:read이며 인증키나 사용자 금고를 입력받지 않는다. Actions는 공식 저장소에서 확인한 v6 커밋으로 고정했다. 성공 시 Actions 아티팩트만 14일 보관하며 GitHub Release 생성·태그·스토어 업로드·서비스 배포·DB 변경을 하지 않는다.

```sh
npm ci
npm run test:local
npm run validate:extension
python3 scripts/package-release.py /절대/경로/새로운/출력폴더
```

패키징은 깨끗하게 커밋된 작업 트리에서만 가능하며 해당 커밋의 파일을 사용한다. 출력은 확장 ZIP, 소스 tar.gz, 파일별 SHA-256/커밋 manifest다. 동일 커밋을 두 번 생성해 바이트 일치 여부를 검증했다. 테스트용 계정 제공자와 실행 중 금고·기기 설정은 확장 ZIP에 넣지 않는다. 타입스크립트 계정 모듈은 build에서 갱신하며 Git의 생성 파일과 다르면 CI가 실패한다.

정적 검사는 Manifest V3, 현재 최소 권한·두 사이트의 선택 권한, 외부 연결/공개 리소스 미노출, 자기 출처 스크립트/CSP, 인라인 이벤트·동적 실행·원격 모듈의 일부 패턴, 알려진 비밀 형식, 생성 코드 일치를 확인한다. 완전한 보안 감사나 모든 비밀 형식을 탐지하는 검사는 아니다.

실제 출시 전에는 양쪽 일반 웹 채팅에서 자연스러운 요청 → 실제 get_context 호출 → 선호도/최신 프로젝트 조건을 적용한 결과물, 사용자 기기의 HTTPS/OAuth/TLS 운영, 설치된 확장/native, 실제 인증·기존 Supabase 스키마/RLS·암호문 동기화/원격 삭제를 확인해야 한다. 제품에 실제 고객 로그인이나 원격 삭제가 연결됐다고 표시하지 않는다. 프로덕션 배포 대상과 준비 상태를 확인하기 전에는 게시하지 않는다.

2026-11-06 구현 커밋236c3d1의 [GitHub CI](https://github.com/scored-kr/growthbrain/actions/runs/42149293048)가 성공했고,
새 GitHub 복제의 전체 검사도 통과했다. Actions 아티팩트는14일 후 만료될 수 있으므로 커밋에서
위 명령으로 재생성한다. 실제 프로덕션 배포 검증으로 간주하지 않는다.

같은 커밋의 GitHub 아티팩트를 커넥터로 내려받아 GitHub digest와 일치함을 확인했고, 내부 ZIP/소스/manifest는 로컬 산출물과 바이트 단위로 같았다.
