# 잠금·삭제 보안 검토 — 2026-11-04

OpenAI security-best-practices/security-threat-model과 Trail of Bits sharp-edges의
암호 API·인증·설정·JavaScript/Python 경계 검토를 적용했다. 적용 출처는 [public-skills.md](public-skills.md).
사용자가 이미 정한 기기 로컬 금고/서버 암호문/AI 전달 맥락 공개라는 경계를 따른다.
모든 재현은 임시 합성 금고와 로컬 프로세스에서 수행한다. 외부 감사나 무취약성 인증이 아니다.

## GB-LOCK-01 — 잠금 시작 후 기존 연결이 요청을 완료할 수 있음

- 위험: medium. 같은 OS 사용자로 이미 연결한 클라이언트가 필요하다. 원격 비인증 공격으로 분류하지 않는다.
  사용자가 잠금 명령을 내렸는데 데이터 접근이 계속되거나 연결이 종료를 지연시키는 개인정보·가용성 문제다.
- 근거: 이전 `src/cli.ts::close`는 broker 종료를 기다린 뒤 vault를 닫았다.
  `src/broker.ts::startBroker.close`의 `server.close`는 연결 중인 소켓이 끝나기를 기다렸고
  기존 소켓의 data 핸들러는 계속 요청을 처리했다. 5초 idle timeout은 주기적으로 보내는 peer를 제한하지 못한다.
- 수정 전 실제 Unix socket 회귀: 종료 시작 뒤 partial get_context를 완성하자 read 횟수 **1**, 기대값 **0**으로 실패했다.
  실제 PTY에서도 partial peer를 둔 `lock`이 2초 내 종료하지 못해 실패했다.
- 수정: vault가 먼저 새 조회/쓰기를 거절하도록 closing을 설정한다. broker는 closing을 확인하고
  모든 열린 소켓을 종료한다. 중복 close는 같은 Promise를 사용하며 두 정리 작업 모두 기다린다.
  이미 수락한 쓰기는 암호화 저장을 마친 뒤 키를 지운다. 응답을 받지 못한 쓰기를 자동 재전송하지 않는다.
- 검증: `test/broker.test.mjs` 실제 socket, `test/lock-terminal.py` 실제 PTY;
  전체 Node 검사 60/60. 연결 종료는 EOF 또는 미완성 프레임의 reset을 허용하되 맥락 응답을 허용하지 않는다.
- 남는 경계: 잠금 전 전달된 맥락은 회수할 수 없다. 같은 OS 사용자 악성 프로그램·root·디버거로부터
  열린 금고를 격리하지 않으며 JS 힙의 모든 과거 문자열 복사본을 안전 소거한다고 주장하지 않는다.
