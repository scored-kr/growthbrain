# 공개 스킬 선정과 사용 기록

2026-11-04, GitHub 원본 API와 Git ref의 커밋·트리·파일·라이선스를 확인해 7개 저장소에서 17개 스킬,
관련 원문 101파일을 `vendor/skills`에 보존했다. 제품에 관련된 검증 범위를 선정한 것으로 공개
GitHub의 모든 스킬을 전수 조사했다는 뜻은 아니다. 전역 자동 설치나 원문 스크립트 실행은 하지 않는다.

| 출처 / 고정 커밋 | 선정 스킬 | 라이선스 / 적용 |
| --- | --- | --- |
| [openai/skills](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431) | security-best-practices, security-threat-model | 각 폴더 LICENSE.txt, Apache-2.0. 사용자 기기 금고/IPC/개발 도구 경계 |
| [anthropics/skills](https://github.com/anthropics/skills/tree/ca45fc496a3436251f191354091d557da31c15b5) | mcp-builder, webapp-testing | 각 폴더 LICENSE.txt, Apache-2.0. 실제 도구 계약/오류/렌더링 검사 |
| [trailofbits/skills](https://github.com/trailofbits/skills/tree/711af095215ad4ecde5b90cd1d0124b3f1c4ca9e) | property-based-testing, differential-review, sharp-edges | 원본 LICENSE, CC-BY-SA-4.0. 원문 출처와 동일 라이선스 보존, 변경하지 않음. 제품 코드 전체의 재라이선스 선언이 아님 |
| [product-on-purpose/pm-skills](https://github.com/product-on-purpose/pm-skills/tree/9b920db418c5bf641edea9afb4915a286e1d42ea) | deliver-acceptance-criteria, deliver-edge-cases, measure-experiment-design | 원본 LICENSE, Apache-2.0. 합격 조건/경계 사례/실사용 평가 설계 |
| [phuryn/pm-skills](https://github.com/phuryn/pm-skills/tree/2a12295a7717569baa7be181b4cfebe3ca38a6bb) | startup-canvas, strategy-red-team | 원본 LICENSE, MIT. 사업 가설·반론·중단 기준 |
| [shawnpang/startup-founder-skills](https://github.com/shawnpang/startup-founder-skills/tree/4ad31b43eef3ae3755cc57ec7e435dab4699ab44) | startup-context, accelerator-application, mvp-scoping | 원본 LICENSE, MIT. 근거 정리·AC 심사 관점·최초 가치 범위 |
| [mfwarren/entrepreneur-claude-skills](https://github.com/mfwarren/entrepreneur-claude-skills/tree/e5e8f4107f62913d7a1dd7a61237605112ca2d7c) | fundraising, unit-economics | 원본 LICENSE, MIT. 투자 준비 근거·가정 분리·지원 비용 민감도 |

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

추가 제품 실사는 [product-diligence-2026-11-04.md](product-diligence-2026-11-04.md)에 있다.
신규 8개 스킬(맥락 정리 1개 포함)은 원문과 참고 자료를 읽어 검토에 적용했다. 실제 VC·AC나
창업가의 자문, 외부 보안 인증, 실제 투자심사 통과를 뜻하지 않는다. accelerator-application의
프로그램별 투자 조건은 현재 조건으로 인용하지 않았고, fundraising의 투자 진행·연락 절차도
실행하지 않았다. 검토용 가정 때문에 추가 인터뷰나 승인 절차를 강제하지 않는다.

추가 비교한 garrytan/gstack의 office-hours는 전역 런타임·텔레메트리 연동 절차가 포함돼
이번 저장소 근거 검토에 도입하지 않았다. lool-ventures/founder-skills의 ic-sim도 정식
다중 심사자·아티팩트 생성 파이프라인을 실행하지 않았으므로 그 시뮬레이션을 수행했다고 주장하지 않는다.
공개 스킬은 검토 방법이며 저자의 경력·내용 정확성·제품 성공을 보증하지 않는다.
