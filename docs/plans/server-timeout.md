# server-test 병합 검사에 시간 제한 두기

- 작성일: 2026-11-23
- 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

PR #829(일봉 연속조회)가 `source_switch` 시험에서 요청을 끝없이 보냈다. chute batch `b20261123-152822`의 server-test가 25분 넘게 멈췄고, 큐 전체가 막혔다. 오케스트레이터가 시험 프로세스를 손으로 끝냈다. 사용자는 server-test에 시간 제한을 두자는 오케스트레이터의 제안을 승인했다. 제한이 있으면 이런 PR은 사람이 끄지 않아도 `반송(시간 초과)`로 끝난다.

## 조사 결과(작성 시점)

### chute의 시간 제한

- `[[verify]]` 단계도 `timeout`(초)을 받는다. 적지 않으면 3600초다(`~/code/chute/src/config.rs`의 `default_timeout`). `chute config-check`가 단계마다 시간 제한을 보인다. 지금 server-test는 `시간 제한 3600초`로 나온다.
- 그래서 server-test에 제한이 없던 것은 아니다. 3600초가 멈춘 batch의 1,939초보다 길어서 걸리지 않았다.
- 제한을 넘기면 chute가 그 단계의 프로세스 그룹에 SIGTERM을 보내고 5초 뒤 SIGKILL을 보낸다. 결과는 `시간 초과`로 남는다. 반송 사유는 `timeout`이고 상태는 `반송(시간 초과)`다(`chute --skill`).
- 시간 초과는 다시 돌리지 않는다(`~/code/chute/src/verify.rs`, `cause == Cause::TimedOut`이면 재실행 없이 실패). 멈춘 batch에서는 손으로 보낸 SIGTERM이 종료 실패로 기록돼 chute가 server-test를 한 번 더 돌렸다(`server-test.2.log`). 시간 제한으로 끝나면 이 재실행이 없다.
- `scripts/evidence.py`는 cargo를 새 세션(`start_new_session=True`)으로 띄운다. chute의 SIGTERM을 받은 `dev.py`가 `stop_process`로 그 세션에 SIGTERM을 보낸다. 멈춘 batch의 로그에서도 `source_switch` 시험 바이너리가 `signal: 15`로 끝났다. 시험 바이너리가 남지 않는다.

### 측정

chute `history.jsonl`의 `step_times`에서 2026-11-19 11:40부터 2026-11-23 16:07까지 batch 기록을 셌다. 멈춘 batch는 server-test 시간이 기록되지 않아 빠졌다.

| 단계 | 횟수 | 가장 짧음 | 중앙값 | 90% | 가장 김 |
|---|---|---|---|---|---|
| server-test | 59 | 205초 | 333초 | 439초 | 600초 |
| collector-test | 75 | 54초 | 87초 | 169초 | 296초 |
| clippy | 76 | 3초 | 35초 | 68초 | 111초 |
| check | 166 | 4초 | 7초 | 13초 | 20초 |
| account-server-test | 10 | 4초 | 7초 | 12초 | 12초 |
| setup-test | 8 | 1초 | 1초 | 3초 | 3초 |
| desktop | 2 | 58초 | - | - | 118초 |

server-test의 가장 긴 600초는 batch `b20261123-133756`이다. 그 실행에서 컴파일이 1분 24초였고 나머지는 시험 실행이었다. 이 시간에는 `compile-gate.lock`을 기다린 시간도 들어 있다. 멈춘 batch는 컴파일 1분 32초 뒤 `source_switch` 시험 세 개가 60초 넘게 돌고 있다는 줄을 남겼다.

## 확정된 결정

- server-test 단계에 시간 제한을 둔다. 사용자가 승인했다. 제한을 두는 것은 검증을 약하게 하는 변경이 아니다.
- 제한은 20~30분 범위에서 정한다(오케스트레이터의 제안, 사용자 승인).
- `chute.toml`은 이 작업만 고친다.

## 스스로 정한 결정과 이유

- **server-test의 제한은 1200초다.** 측정한 가장 긴 정상 실행(600초)의 2배다. 오케스트레이터가 잰 정상 최댓값 495초의 약 2.4배다. 승인 범위(20~30분)의 아래 끝이라 멈춘 PR이 큐를 가장 짧게 막는다. 멈춘 batch였다면 1,939초 대신 1200초에 반송됐다.
- **자리는 `run` 바로 뒤다.** `[[post_verify]] e2e`가 `run`, `probe`, `timeout`, `failed`, `paths` 순서로 적었다. 같은 순서를 따른다.
- **다른 단계는 이 작업에서 바꾸지 않는다.** 사용자가 승인한 범위는 server-test다. 다른 단계 이야기는 아래 "사용자가 정해야 하는 결정"에 올린다.
- **작업 하나(`minor-fix`, `basic`)로 둔다.** 설정 한 줄이다. 검증 판정에 닿지만 판정 규칙은 바꾸지 않고 기존 키의 값만 정한다.

## 작업

| 작업 ID | 내용 | 방식 | 방식의 이유 | 순서 |
|---|---|---|---|---|
| `server-test-timeout` | `chute.toml`의 `[[verify]] server-test`에 `timeout = 1200`을 더한다 | `basic` (`minor-fix`) | 설정 한 줄. 판정 규칙은 그대로다 | 단독 |

핵심 경로: `server-test-timeout` 하나(poteto 작업 0개).

진행 중인 `kiwoom-token-owner`, `kis-rest-edges`, `source-switch-edges`, `e2e-flaky-check`는 `chute.toml`을 고치지 않으므로 겹치지 않는다.

## 범위 밖

- PR #829의 무한 요청 자체. 그 PR의 작업자가 반송을 받아 고친다.
- `scripts/evidence.py`와 `dev.py`의 프로세스 정리. 위 조사대로 지금도 시험 바이너리가 끝난다.
- chute의 기본 시간 제한(3600초)과 시간 초과 처리. chute 쪽 일이다.
- 시험 하나하나의 시간 제한(예: 60초를 넘긴 시험을 끝내는 것). cargo test 기본 기능이 아니고 시험 코드를 고치는 일이다.

## 사용자가 정해야 하는 결정

- **다른 검증 단계에도 시간 제한을 둘까.** 지금은 모두 기본 3600초다. 같은 방식(가장 긴 정상 실행의 약 2배, 최소 몇 분)으로 정하면 예는 다음과 같다. collector-test 600초(가장 김 296초), clippy 300초(111초), check 300초(20초), account-server-test·setup-test 300초(12초·3초), desktop 600초(118초, 기록 2번뿐). collector-test는 `crates/server/`가 바뀌어도 돌고 서버 코드를 함께 시험하므로 같은 종류의 멈춤이 생길 수 있다. 승인하면 따로 작은 작업을 세운다.
- **드물게 오래 걸리는 정상 실행.** 시간 제한에는 컴파일 시간이 들어간다. 툴체인을 올리거나 의존성을 많이 바꾼 PR은 server-test 시험 크레이트를 처음부터 컴파일해 1200초를 넘길 수 있다. 그런 PR이 `반송(시간 초과)`를 받으면 작업자는 제한을 늘리지 않는다(chute 규칙). 그때는 오케스트레이터가 사용자에게 올리고, 사용자가 제한을 올리는 별도 PR을 둘지 정한다.
