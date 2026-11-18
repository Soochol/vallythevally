# crates/server의 흔들리는 시험 고치기

- 작성일: 2026-11-18
- 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

PR과 상관없는 서버 시험이 chute batch 검증에서 실패해 PR이 반송된다. 같은 HEAD로 다시 올리면 통과한다. 오케스트레이터가 "흔들리는 서버 시험 4개를 고칩니다"를 포함해 제안했고, 사용자는 "1번 빼고 나머지 진행 너가 다 진행할 수 있으면 해줘"라고 답했다. 대상 넷은 다음과 같다.

| 시험 | 마지막 실패 | 관찰 |
|---|---|---|
| `account_login.rs`의 `when_the_state_file_cannot_be_removed_after_deletion_memory_and_file_still_agree` | 2026-11-18 04:44 batch | `signed_out` 기대가 `signed_in` |
| `kiwoom_link.rs`의 `an_8050_at_the_daily_reissue_leaves_the_link_failed_and_closed` | 2026-11-18 14:55 batch | `fake.issued()` 2 대 1 |
| `screener_run.rs`의 `a_partly_stored_first_week_or_month_is_history_short_until_backfill_fills_it` | 2026-11-18 02:47 batch | 610행 `historyShort` 1 대 0 |
| `screener_run.rs`의 `intraday_midnight_during_collection_returns_an_error_without_rows` | 2026-11-18 14:55 batch | `data_changed` 대 `missing_day` |

## 확정된 결정

- 원인을 찾아 시험이나 제품 코드를 고친다. 부하나 순서가 달라도 결과가 같아야 한다.
- 시험을 지우거나 건너뛰지 않는다. 시간 제한만 늘려 끝내지 않는다.
- 재현과 확인은 지연 주입, 가짜 시계, 그 실행에만 거는 제한(`taskset`)으로 한다. PC 전체에 부하를 걸지 않는다.
- 키움 시험은 합성 transport와 세션을 쓴다.

## 원인(작성 시점 조사)

코드, chute batch 로그(`~/.local/state/chute/repos/Soochol__vallythevally/batches/`), 작업자 보고서를 읽어 찾았다. 재현 실행은 작업자가 한다.

### 1. 계정 삭제 시험: main에서 이미 고쳐졌다

- 예전 시험은 삭제 응답을 받자마자 디렉터리 권한을 0o700으로 되돌린 뒤 상태를 읽었다. 그 사이 삭제가 깨운 동기화가 계정 서버에서 401을 받으면 `expire`가 파일을 지우고 로그아웃했다. 그래서 `signed_out`이 나왔다.
- #530(`f3c8ac74`, 11-18 12:38)이 권한을 되돌리는 시점을 상태 확인 뒤로 옮겼다. 지금은 디렉터리가 0o500인 동안 `expire`의 `file.remove()`가 실패하고, `expire`는 메모리를 그대로 둔다(`crates/server/src/account/sync.rs`의 `expire`). 그래서 어떤 순서로 돌아도 `signed_in`이다.
- 실패 네 번은 모두 #530 이전 트리에서 났다. 이후 batch의 server-test 13회에서는 실패가 없다.
- 남은 약점이 있다. 시험은 401 경로가 상태 확인 전에 돌았는지 확인하지 않는다. 그래서 같은 회귀가 다시 생겨도 가끔만 실패한다.

### 2. 8050 재발급 시험: 원인은 main에서 고쳐졌고 고정 대기가 하나 남았다

- 예전 실패 원인은 20:05 재발급이 연결 중이면 그날을 건너뛰는 제품 경합이었다. `docs/plans/flaky-tests.md`의 `kiwoom-reissue`가 #559(11-18 18:54)로 고쳤다. 시험도 `jump_until_reissued`로 바뀌었다.
- 실패 세 번은 모두 #559 이전 트리에서 났다. 작업자가 본 "main 6번 중 1번"(`mock-marks` 보고서, 15:16)도 그 전이다. 이후 batch 4회에서는 실패가 없다.
- 남은 고정 대기가 있다. 610행과 632행은 `issued()`가 2가 된 뒤 500ms를 자고 `link_state()`가 `Failed`라고 단언한다. `issued()`는 요청을 보낼 때 센다. 8050 응답 처리가 500ms 안에 끝나지 않으면 `failure()`가 패닉한다. 지금까지 이것으로 실패한 기록은 없다.

### 3. 스크리너 시험: 고정 지연 창 안에 시험 동작이 끝나야 한다(시험 결함)

시험은 `fake.delay`로 응답을 일정 시간 늦추고, 그 시간 안에 시험 쪽 동작(취소, 실행 시작)이 끝난다고 가정한다. 부하로 시험 쪽이 늦으면 서버가 먼저 진행해 다른 결과가 나온다. 제품 동작은 맞다.

- `a_partly_stored_first_week_or_month_is_history_short_until_backfill_fills_it`: `ka10081`을 1초 늦추고 과거 이어 받기가 보이면 취소한다. 610행 앞의 두 번째 취소가 1초 넘게 늦으면 200020의 과거까지 저장된다. 그러면 `historyShort`가 1이 아니라 0이다. 로그의 실패와 같다.
- `intraday_midnight_during_collection_returns_an_error_without_rows`: 실제로 흐르는 가짜 시계를 23:59:59에 시작한다. 서버 시작과 실행 요청이 1초를 넘기면 실행이 자정 뒤에 시작한다. 그러면 `run_screen`이 처음 잡은 `now`로 `need_day`를 판단해 `missing_day`를 준다. 이것도 제품 동작으로는 맞다.

같은 원인의 시험이 같은 파일에 더 있다.

- `intraday_backfill_committing_during_collection_invalidates_the_same_update_generation`: 11-18 01:12 batch에서 2079행 `(200, Null)` 대 `data_changed`로 실패했다. 과거 이어 받기(`ka10081` 500ms)가 수집(`ka10095` 1초) 도중에 커밋된다고 가정한다. 실행이 늦게 시작하면 커밋이 수집 전에 끝난다.
- `an_unfilled_history_is_history_short_until_backfill_and_a_pre_1985_listing_then_starts_at_its_first_stored_bar`, `history_short_needs_the_earliest_first_needed_day_over_lines_of_every_period`: 300ms 지연 안에 취소하고 `done`을 정확히 단언한다. 실패 기록은 아직 없지만, 실패한 시험(1초)보다 창이 좁다.
- `a_delisted_stocks_old_bars_do_not_fill_in_the_unstored_start_of_a_new_listings_first_week`: 1초 지연 안에 취소한다.
- `regression_223_pre0800_evidence_expires_when_collection_crosses_0800`: 07:59:59에 시작하고 1.5초 지연으로 08:00을 넘긴다. 자정 시험과 같은 모양이다.

## 스스로 정한 결정과 이유

- **계정 삭제와 8050 시험도 작업에 넣는다.** 관찰된 실패의 원인은 이미 main에서 고쳐졌다. 하지만 요청은 "부하·순서와 상관없이 결정적"이다. 계정 시험은 401 경로를 매번 강제로 돌린다. `POST /api/account/sync`가 동기화 cycle 잠금을 잡으므로 이 요청이 끝나면 401 경로가 한 번 돈 뒤다. 8050 시험은 500ms 대기 대신 `Failed` 상태를 기다린다. 키움에 다시 발급하지 않았다는 확인은 "일어나지 않음"이라 고정 대기로 남긴다.
- **스크리너는 시간 대신 요청을 붙잡는 장치를 쓴다.** 합성 transport에 e2e의 `scenario.hold`/`reply` 같은 장치를 더한다. 시험이 요청 도착을 기다리고, 원하는 순서에 풀어 준다. 지연 시간을 늘리면 실패가 줄 뿐 순서는 보장되지 않는다. 자정·08:00 시험은 시계를 경계 몇 분 전에 시작하고, 수집 요청을 붙잡은 채 `clock().jump`로 경계를 넘긴다. 취소는 업데이트 작업을 `abort`하므로(`screener/mod.rs`의 `cancel`) 붙잡힌 요청은 버려지고 시험이 멈추지 않는다.
- **같은 원인의 형제 시험도 같은 작업에서 고친다.** 같은 파일이고 같은 장치로 고친다. 따로 두면 남은 시험이 다음 반송을 만든다.
- **고치기 전 실패를 지연 주입으로 보인다.** 예를 들어 취소나 실행 앞에 임시로 sleep을 넣으면 기존 시험이 batch 로그와 같은 메시지로 매번 실패해야 한다. 고친 시험은 같은 sleep을 넣어도 통과해야 한다. 이것으로 원인을 확정한다. 임시 sleep은 커밋하지 않는다.
- **작업은 둘이고 병렬이다.** 계정·키움 작업은 `account_login.rs`와 `kiwoom_link.rs`만, 스크리너 작업은 `support/mod.rs`, `screener_run.rs`와 `docs/development-builds.md`의 한 줄만 고친다. 겹치는 파일이 없다. 계정·키움 작업은 붙잡는 장치가 필요 없다. 고칠 대기가 상태 대기 하나씩이기 때문이다.

## 작업

| 작업 ID | 내용 | 방식 | 방식의 이유 | 순서 |
|---|---|---|---|---|
| `flaky-screener-hold` | 합성 transport에 요청을 붙잡는 장치를 더하고, 스크리너 시험 일곱 개의 지연 창을 붙잡기·시계 옮기기로 바꾼다 | `poteto` (`implementer`) | 여러 시험 바이너리가 함께 쓰는 시험 transport에 동기화 장치를 새로 넣는다. 잘못 짜면 시험이 멈추거나 순서가 다시 흔들린다 | 병렬 |
| `flaky-login-link` | 계정 삭제 시험이 401 경로를 매번 돌게 하고, 8050 시험 둘이 고정 대기 대신 `Failed` 상태를 기다리게 한다 | `basic` (`minor-fix`) | 시험 두 파일의 몇 줄이다 | 병렬 |

## 범위 밖

- `screener_update.rs`의 `cancelling_keeps_what_was_stored_and_the_next_update_fetches_only_the_rest`, `a_cancelled_full_update_is_resumed_by_the_next_plain_update`. 지연 중 취소하는 모양은 같다. 하지만 다른 파일이고 batch 기록에 실패가 없다. 이 작업이 만든 장치로 나중에 바꿀 수 있다.
- `financials.rs`의 `updates::interrupted_recent_http_update_reads_checkpoints_and_resumes_the_original_scope`. 11-18 03:01 batch에서 한 번 실패했다(`statement_stream made no source progress: Elapsed`). 원천 진행 제한 시간에 걸린 것이라 원인이 다르다.
- batch 기록에 있는 다른 실패: `an_import_also_beats_an_account_copy_whose_revision_is_ahead_of_this_pcs_clock`(11-17), `market::hub::tests::releasing_one_of_two_feeds_…`(11-18 22:10). 둘 다 같은 batch의 두 실행에서 모두 실패했다. 그 PR의 변경이 원인이다. `refresh_signs_out_a_token_…`은 #542가 이미 고쳤다.
- 제품 코드. 스크리너의 `missing_day`·`data_changed` 판정과 계정 `expire`의 동작은 맞다.
- 시험 제한 시간, `RUST_TEST_THREADS`, `chute.toml`의 검증 단계.

## 사용자가 정해야 하는 결정

없다. 검증을 약하게 하는 작업(검증 단계 삭제, 시간 제한 증가, `paths` 축소)은 넣지 않았다. 계정 삭제와 8050 시험의 관찰된 실패 원인은 #530과 #559가 이미 고쳤다. 이 플랜은 남은 시간 가정을 없애는 일만 한다.
