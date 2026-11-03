# 챕터별 커밋과 되돌리기

작업 브랜치: `codex/growthbrain-recovery-20261103`.
각 챕터는 구현·검증·커밋·푸시를 한 단위로 한다. 진행 기록에는 commit SHA와 검사 결과를 남긴다.

커밋은 소스와 문서의 복구 지점이다. GitHub 푸시는 그 복구 지점의 외부 백업이다.
커밋되지 않은 파일, 무시된 금고·개인 인증, Supabase 데이터, 환경 게시 상태는 커밋으로 복원되지 않는다.

공유된 커밋을 되돌릴 때는 다음처럼 새 취소 커밋을 만든다.

```sh
git status
git log --oneline -10
git revert <되돌릴-커밋-SHA>
npm test
git push origin codex/growthbrain-recovery-20261103
```

의존하는 후속 챕터가 있으면 최신 챕터부터 역순으로 검토한다. 충돌이 나면 임의 파일 삭제나
강제 push로 해결하지 않는다. 되돌리기 명령은 실제로 필요할 때만 실행하며, 현재 작업에서
기존 구현·사용자 데이터를 초기화하지 않는다.
