# 공개 스킬 선정과 사용 기록

2026-11-04, GitHub 원본 API의 커밋·트리·파일·라이선스를 확인해 4개 저장소에서 9개 스킬,
관련 원문 72파일을 `vendor/skills`에 보존했다. 제품에 관련된 검증 범위를 선정한 것으로 공개
GitHub의 모든 스킬을 전수 조사했다는 뜻은 아니다. 전역 자동 설치나 원문 스크립트 실행은 하지 않는다.

| 출처 / 고정 커밋 | 선정 스킬 | 라이선스 / 적용 |
| --- | --- | --- |
| [openai/skills](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431) | security-best-practices, security-threat-model | 각 폴더 LICENSE.txt, Apache-2.0. 사용자 기기 금고/IPC/개발 도구 경계 |
| [anthropics/skills](https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5) | mcp-builder, webapp-testing | 각 폴더 LICENSE.txt, Apache-2.0. 실제 도구 계약/오류/렌더링 검사 |
| [trailofbits/skills](https://github.com/trailofbits/skills/tree/711af095215ad4ecde5b90cd1d0124b3f1c4ca9e) | property-based-testing, differential-review | 원본 LICENSE, CC-BY-SA-4.0. 원문 출처와 동일 라이선스 보존, 변경하지 않음. 제품 코드 전체의 재라이선스 선언이 아님 |
| [product-on-purpose/pm-skills](https://github.com/product-on-purpose/pm-skills/tree/9b920db418c5bf641edea9afb4915a286e1d42ea) | deliver-acceptance-criteria, deliver-edge-cases, measure-experiment-design | 원본 LICENSE, Apache-2.0. 합격 조건/경계 사례/실사용 평가 설계 |

원문 위치와 commit/blob SHA는 `vendor/skills/sources.json`에 있다. 경로는
`vendor/skills/<owner>/<repo>/<upstream path>`. `npm run verify:skills`는 파일 목록/크기와
Git blob 해시(EOF 개행 포함), 스킬 엔트리와 라이선스 존재를 검사한다. 이는 고정 원문과의
일치 검사이며 내용의 무해함이나 향후 upstream 변경의 승인을 보장하지 않는다.

후보 `deanpeters/Product-Manager-Skills`는 CC-BY-NC-SA-4.0의 비상업 조건을 확인하고
이 제품용 번들에서 제외했다. MIT인 다른 PM 저장소도 비교했으나 이번 범위와 중복되는 자료를
모두 넣지는 않았다. 커밋을 고정했으므로 최신 버전 추종은 자동으로 일어나지 않는다.

적용 시 최신 사용자 요구와 AGENTS.md가 우선한다. 기존 SDK v1을 v2로 바꾸거나 신규 테스트
프레임워크를 추가하라는 요구로 해석하지 않는다. 현재 승인된 수정 범위는 다시 승인받을 필요가
없다. 로컬 금고/서버 암호문/사용자 기기라는 이미 확정된 경계는 가정 질문으로 반복하지 않는다.
각 스킬의 필요한 참고 문서를 읽고 기존 Node test/Playwright 검사에 방법을 적용한다.

5회 검토·수정·재검증 결과는 [skill-review-loops.md](skill-review-loops.md)에 기록한다.
