# 시험이 남기는 권한 잔여물과 남은 흔들리는 스크리너 시험

- 작성일: 2026-11-19
- 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

사용자는 오케스트레이터 대기 목록의 #7과 #9를 진행하라고 했다("#7, #9도 진행해줘"). 앞 차수는 `docs/plans/server-flaky.md`(PR #613)다.

- #7: `crates/server/tests/account_login.rs`의 `when_the_state_file_cannot_be_removed_after_deletion_memory_and_file_still_agree`는 상태 디렉터리 권한을 0o500으로 바꾸고, 시험 중간에 0o700으로 되돌린다. 그 사이 단언이 실패하면 되돌리는 줄에 닿지 못한다. 그러면 쓰기 권한 없는 폴더(`target/tmp/.tmpXXXX/state/vallythevally`)가 worktree에 남는다. 2026-11-19 작업 `flaky-login-link`(PR #621)에서 이 때문에 `orch done`이 worktree를 지우지 못했다. orch 쪽 정리 보강은 오케스트레이터가 따로 한다. 이 플랜은 시험 쪽만 고친다.
- #9: `crates/server/tests/screener_run.rs`의 `a_run_is_refused_while_recent_days_fill_and_when_the_store_lacks_the_need_day`는 `fake.delay("ka10081", 500ms)`에 기댄다. `taskset -c 0`으로 돌렸을 때 한 번 189행(`Api::result`의 200 단언)에서 패닉했다(PR #629 리뷰어 관찰, 항상 재현되는지는 확인하지 않았다). PR #629가 `ScriptedTransport::hold`를 더해 같은 파일의 일곱 시험을 바꿨다. 이 시험도 같은 장치로 고칠 수 있다.

## 확정된 결정

- 계정 시험은 단언이 실패하거나 패닉해도 권한을 되돌린다. 예로 든 방식은 Drop 가드다.
- 스크리너 시험은 고정 지연 대신 `fake.hold`와 필요하면 시계 옮기기로 결정적으로 바꾼다. 고치기 전 실패를 지연 주입으로 보인다.
- 시험을 지우거나 건너뛰지 않는다. 시간 제한만 늘려 끝내지 않는다.
- 재현은 지연 주입이나 그 실행에만 거는 제한(`taskset`)으로 한다. PC 전체에 부하를 걸지 않는다.
- 다른 시험 파일의 같은 권한 모양과 같은 파일에 남은 `fake.delay` 시험은 플랜에 적는다. 고칠지는 플래너가 정한다.

## 조사 결과(작성 시점)

### 권한·읽기 전용 표시를 바꾸는 다른 시험

저장소의 Rust, Python, 셸, TypeScript에서 `set_permissions`, `from_mode`, `set_readonly`, `chmod`를 찾았다. 폴더를 지우지 못하게 만드는 것은 그 폴더나 그 위 디렉터리에서 소유자 쓰기 권한(`u+w`)을 빼는 경우뿐이다. 파일 권한은 지우기를 막지 않는다. 이 모양은 `account_login.rs`의 0o500 하나뿐이다.

| 위치 | 바꾸는 것 | 지우기를 막는가 |
|---|---|---|
| `crates/server/tests/account_login.rs` 570행 | 상태 디렉터리 0o500 | 막는다. 이 플랜에서 고친다 |
| `crates/server/tests/token.rs`의 `with_modes` | 파일 0o644, 디렉터리 0o755·0o700 | 막지 않는다. 디렉터리에 소유자 쓰기가 남는다 |
| `crates/server/src/kiwoom/token_file.rs`, `key_file.rs`, `trading/switch.rs`의 단위 시험 | 파일 0o644·0o600, 디렉터리 0o755 | 막지 않는다 |
| `crates/server/src/collector/telegram.rs`, `crates/collector/src/supervise/mod.rs`의 단위 시험 | 파일 권한 | 막지 않는다 |
| `crates/collector/tests/plan.rs`, `alert_unit.rs`, `supervise_process.rs` | 파일 0o600·0o644·0o755 | 막지 않는다 |
| `crates/server/tests/kiwoom_link.rs`, `financials*.rs`, `collector_board.rs` | 디렉터리 0o700, 파일 0o600·0o644 | 막지 않는다 |
| `scripts/test-dev.py`, `scripts/test-live.py`, `scripts/test-offline.sh`, `.claude/skills/verify-vally/scripts/vv.py` | 실행 권한 추가, 디렉터리 0o700 | 막지 않는다 |

### `screener_run.rs`에 남은 `fake.delay`

| 시험 | 지연 | 가정 | 처리 |
|---|---|---|---|
| `a_run_is_refused_while_recent_days_fill_and_when_the_store_lacks_the_need_day` | `ka10081` 500ms | 최근 채우기 중 거절 두 번이 최근 채우기 안에 끝나고, 과거 이어 받기 중 실행 두 번이 그 사이 커밋 없이 끝난다 | 고친다 |
| `regression_223_adjustment_refetch_missing_midway_recovers_or_excludes_after_restart_and_delisting` | `ka10081` 5초 | `backfill` 단계를 본 뒤 5초 안에 취소한다 | 고친다 |
| `intraday_adjustment_and_same_day_history_updates_abort_the_whole_result` | `ka10095` 500ms | 수집 요청이 보인 뒤 500ms 안에 업데이트가 시작한다 | 고친다 |
| `intraday_different_conditions_share_full_listing_collection_and_failures_never_return_partial_results` | `ka10095` 200ms | 두 번째 실행이 첫 실행의 수집이 끝나기 전에 그 수집에 합류한다 | 범위 밖(아래) |
| `runs_racing_into_recent_read_the_store_from_before_recent_or_are_refused` | `ka20006` 1.5초 | 없음. 거절, 최근 전, 최근 뒤 세 결과를 모두 받는다 | 범위 밖(아래) |

189행 패닉의 원인으로 추정하는 것은 다음과 같다. `run_screen`(`crates/server/src/screener/mod.rs`)은 시작할 때 저장소 세대를 잡고, 판정 전과 판정 뒤에 세대가 같은지 본다. 과거 이어 받기 응답이 500ms마다 와서 커밋되므로, 실행이 느리면 실행 중에 세대가 바뀌어 `409 data_changed`가 난다. 그러면 `Api::result`의 200 단언이 189행에서 실패한다. 작업자가 지연 주입으로 확정한다.

## 스스로 정한 결정과 이유

- **계정 시험은 되돌리는 일을 Drop 가드에 둔다.** 가드는 `Machine`보다 뒤에 만들어 먼저 해제되게 한다. 그러면 패닉으로 풀릴 때도 `TempDir`가 지우기 전에 권한이 돌아온다. 지금 되돌리는 시점(재시작 전)은 그대로 둔다. 그 시점에 가드를 명시적으로 놓는다. 앞 차수가 되돌리는 시점을 상태 확인 뒤로 옮긴 이유(#530)를 깨지 않기 위해서다.
- **스크리너는 같은 모양의 세 시험을 함께 고친다.** 같은 파일이고 같은 장치(`fake.hold`)로 고친다. 따로 두면 남은 시험이 다음 반송을 만든다.
- **두 시험은 범위 밖으로 둔다.**
  - `intraday_different_conditions_share…`: 붙잡기로 첫 수집을 멈춰 둘 수는 있다. 하지만 두 번째 실행이 그 수집에 합류했는지 바깥에서 알 신호가 없다. 언제 풀지를 다시 시간으로 정해야 한다. 결정적으로 만들려면 제품 쪽에 관찰 지점이 필요하다. 그것은 이 요청의 범위를 넘는다. 두 요청이 `tokio::join!`으로 함께 나가고 창은 응답 두 번(약 400ms)이다. batch 기록에 실패는 없다.
  - `runs_racing_into_recent…`: 세 결과를 모두 받으므로 지연이 늦어져도 실패하지 않는다. 지연은 경합이 날 확률을 높이는 장치다.
- **고치기 전 실패는 임시 sleep으로 보인다.** 189행 실패는 시험 쪽에 sleep을 넣어서는 재현되지 않는다. 커밋이 실행 도중에 일어나야 하기 때문이다. 그래서 `run_screen`의 세대 확인 앞에 임시 sleep을 넣는다. 다른 두 시험은 시험 쪽 대기와 동작 사이에 sleep을 넣는다. 임시 sleep은 커밋하지 않는다. 그 실행에만 거는 `taskset -c 0` 반복도 함께 돌린다.
- **작업은 둘이고 병렬이다.** 계정 작업은 `account_login.rs`만, 스크리너 작업은 `screener_run.rs`만 고친다. 겹치는 파일이 없다.

## 작업

| 작업 ID | 내용 | 방식 | 방식의 이유 | 순서 |
|---|---|---|---|---|
| `login-perm-guard` | 계정 삭제 시험의 권한 되돌리기를 Drop 가드로 옮긴다 | `basic` (`minor-fix`) | 시험 파일 하나의 몇 줄이다 | 병렬 |
| `screener-run-hold` | `screener_run.rs`의 세 시험에서 `fake.delay`를 `fake.hold`로 바꾼다 | `basic` (`minor-fix`) | 시험 파일 하나만 고치고, 장치는 PR #629에 이미 있다 | 병렬 |

## 범위 밖

- orch의 worktree 정리 보강. 오케스트레이터가 따로 한다.
- 위 표의 두 스크리너 시험과 `screener_update.rs`의 지연 중 취소 시험(앞 차수 플랜의 범위 밖과 같다).
- 제품 코드. 스크리너의 세대 확인과 계정 `expire` 동작은 맞다. 임시 sleep은 재현에만 쓴다.
- 시험 제한 시간, `RUST_TEST_THREADS`, `chute.toml`의 검증 단계.

## 사용자가 정해야 하는 결정

없다. 검증을 약하게 하는 작업(검증 단계 삭제, 시간 제한 증가, `paths` 축소)은 넣지 않았다. `intraday_different_conditions_share…`를 결정적으로 만들려면 제품에 관찰 지점을 더해야 한다. 원하면 따로 요청한다.
