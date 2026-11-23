# 시간·경합에 흔들린 시험 고치기

작성일 2026-11-23. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 풀려는 문제

#834 병합 batch가 29분 걸렸다. PC 부하(load 11~15)에서 실제 시간이나 공유 자원에 기대는 시험이 흔들려 chute가 재시도와 추가 검증을 돌렸다. 오늘(2026-11-23) `chute flaky` 장부에 오른 시험을 결정적으로 고친다. 같은 모양의 다른 시험은 고치지 않고 목록만 남긴다.

## 대상과 로그로 본 원인

근거 로그는 `~/.local/state/chute/repos/Soochol__vallythevally/batches/<batch>/verify-*/`이다. 원인은 로그와 코드로 좁힌 가설이고, 작업자가 확인한다.

| 시험 | batch | 실패 모양 | 가설 |
|---|---|---|---|
| `public_listener::a_hundred_and_fifty_symbol_lookups_fit_the_default_account_bucket` | b20261123-162019, b20261123-133756 | `heavy`가 99, 또는 100을 넘어 "한도가 걸리지 않는다" | 시험의 가짜 시계(`VALLY_CLOCK_START`)가 멈추지 않은 tokio 시간을 따라 흐른다. 계정 버킷은 초 단위로 초당 20씩 다시 찬다. 요청 150번이 1초를 넘기면 버킷이 다시 찬다 |
| `public_listener::a_full_account_in_flight_cap_refuses_that_account_at_once_and_spares_others` | b20261123-023325 | "공개 포트를 열 수 없습니다 … Address already in use", "서버가 시작하지 못했다" | `free_port()`가 포트를 골라 닫은 뒤 서버가 다시 bind한다. 그 사이에 같은 바이너리의 다른 시험이 그 포트를 가져간다 |
| `public_user_data::every_user_route_saves_for_its_account_and_hides_it_from_the_other` | b20261123-162019 | "서버가 시작하지 못했다" | 같은 `free_port()` 틈으로 보인다. 이 파일은 tracing을 켜지 않고 시작 오류도 버려서 로그에 원인이 없다 |
| `public_user_data::bad_bodies_are_refused_with_the_same_status_code_and_message_as_the_operator_listener` | b20261123-091908 | "서버가 시작하지 못했다" | 같음 |
| `financials::writer::a_writer_is_taken_by_the_first_launch_and_kept_until_the_service_is_dropped` | b20261123-162019 | `release`의 5초 제한에서 `Elapsed` | 갱신이 끝났는지 확인하지 않고 300ms를 잔 뒤, 실제 시간 5초 안에 갱신 작업이 서비스를 놓기를 기다린다 |
| `supervise_day::a_failed_index_request_is_recorded_as_failed_and_the_day_goes_on` | b20261123-162019 (verify-2) | `index_checked` 기록이 0줄이라 `checked[0]`에서 패닉 | 시간을 멈춘 시험(`start_paused`)이 finalize 끝을 본 뒤 가상 1초만 기다리고 일지를 읽는다. 지수 대조 기록은 그 뒤에 쓰일 수 있다 |
| `shared_minute::a_full_aggregation_queue_drops_frames_on_the_aggregation_side_and_counts_them` | b20261123-142258 | `gate.arrived()`가 거짓 | 실제 시간 5,000×2ms(10초)만 기다리며 집계 쪽 신호를 확인한다 |
| `shared_minute::a_minute_split_between_two_key_files_merges_to_the_hand_computed_bar` | b20261123-142258 | "분봉 줄 3개가 쓰이지 않았다: 0" | `wait_for_lines`가 실제 시간 10초 동안만 파일을 확인한다 |
| `shared_minute::only_bars_changed_since_the_last_tick_are_appended_and_a_later_line_replaces_an_earlier_one` | b20261123-142258 | "분봉 줄 4개가 쓰이지 않았다: 0" | 같음 |

`public_rankings_at_their_limit_delay_an_operator_ranking_by_at_most_two_seconds`(b20261123-132839, 세션 확인 DB 풀 시간 초과로 503)는 a04b2661에서 시험이 지워져 대상에서 뺀다. 같은 세션 확인 503이 남은 공개 시험에도 걸릴 수 있는지는 `clock-server-public` 작업자가 보고서의 목록에 적는다.

## 확정된 결정

- 오늘 흔들린 시험만 고친다. 같은 모양(실제 시계로 시간 상한을 단언하거나, 고른 포트를 다시 bind하는 등)의 다른 시험은 고치지 않고 작업마다 보고서에 목록만 적는다.
- 시간에 기대면 이 저장소가 쓰는 가짜 시계(tokio 멈춘 시간, `VALLY_CLOCK_START`와 `clock().jump`)나 상태·신호 기다리기로 바꾼다. 원인이 앱의 경합이면 앱을 고친다. 앱의 운영 동작은 바꾸지 않는다.
- 단언을 지우거나 느슨하게 하지 않는다. 재시도를 더하거나 시간 제한을 늘려 감추지 않는다.
- 재현과 확인은 `docs/development-builds.md`의 결정적 방법과 그 실행에만 거는 제한(`taskset`)으로 한다. 같은 시험을 여러 벌 동시에 돌리거나 PC 전체에 부하를 걸지 않는다.

## 스스로 정한 결정

- 작업을 넷으로 나눈다. 요청은 server와 collector 둘로 나누라고 했지만, 서로 다른 파일을 고치고 순서가 필요 없는 일은 따로 두어야 동시에 돈다. 공개 리스너 시험만 진행 중인 `source-switch-edges`를 기다려야 하므로 재무 writer 시험을 따로 떼어 바로 돌게 한다. collector도 분봉(`shared_minute`)과 하루 감독(`supervise_day`)이 다른 파일과 다른 원인이라 둘로 둔다.
- 공개 리스너의 버킷 시험은 기본 계정 버킷(burst 100, 가벼운 요청 비용, 초당 보충량)을 그대로 두고 `84..=86` 단언도 그대로 둔다. 시험 동안 시계는 명시한 `jump`로만 움직이게 한다. 이를 위해 시험용 시계에 흐르지 않는 방식이 필요하면 앱에 더해도 되지만, 운영 기본값(시스템 시계)과 `VALLY_CLOCK_START`의 지금 동작은 바꾸지 않는다. 버킷 설정값을 바꿔 시간을 피하는 방법은 시험 이름("default account bucket")과 어긋나 쓰지 않는다.
- 공개 리스너 포트 경합은 포트를 고른 뒤 닫았다가 다시 bind하는 틈을 없애는 것으로 고친다(미리 bind한 리스너를 넘기는 시작 경로 등). bind 실패를 재시도하는 방식은 쓰지 않는다.
- 네 작업 모두 `poteto`다. 시험만 고치는 일로 끝날 수도 있지만 원인이 동시성(포트, 갱신 작업 수명, 집계 스레드, 감독 일정)과 잠금(재무 writer 잠금)에 있고, 원인이 앱이면 그 코드를 고쳐야 한다.

## 작업

| 작업 | 방식 | 프로필 | 순서 | 이유 |
|---|---|---|---|---|
| `clock-server-public` | poteto | implementer | `after: source-switch-edges` | 공개 리스너 시험 3개(버킷 보충, 포트 경합 2파일). 포트 틈을 없애려면 `crates/server/src/public/mod.rs`나 앱 시작을 고칠 수 있다. 진행 중인 `source-switch-edges`가 `crates/server/tests/public_listener.rs`와 `crates/server/src/public/mod.rs`를 고친다 |
| `clock-server-financials` | poteto | minor-fix | 병렬 | 재무 writer 잠금 시험 하나. 갱신 작업 수명·잠금이 걸린다 |
| `clock-collector-minute` | poteto | minor-fix | 병렬 | 분봉 시험 3개. 같은 기다리기 도우미(`wait_for_lines`, 집계 쪽 gate 기다리기)를 공유한다 |
| `clock-collector-day` | poteto | minor-fix | 병렬 | 하루 감독 시험 하나. 멈춘 시간과 일지 기록 순서가 걸린다 |

약속 작업은 없다. 네 작업은 서로의 결과를 쓰지 않는다.

핵심 경로: `source-switch-edges` → `clock-server-public`.

진행 중인 다른 작업과의 겹침: `kis-rest-edges`(#829), `kiwoom-token-owner`(#835), `screener-kis-summary`는 이 플랜의 파일에 닿지 않는다. `source-switch-edges`만 겹쳐 `clock-server-public`을 그 뒤에 둔다.

## 범위 밖

- 같은 모양의 다른 시험 고치기(목록만 남긴다). 예: `crates/collector/tests/serve/process.rs`의 `free_port()`, `public_listener.rs`의 `started.elapsed() < Duration::from_secs(2)` 같은 실제 시간 상한 단언.
- 지워진 `public_rankings_at_their_limit_delay_an_operator_ranking_by_at_most_two_seconds`와 세션 확인 DB 풀 크기 조정.
- chute 재시도·검증 설정.

## 사용자가 정해야 하는 결정

- 검증을 약하게 하는 작업은 없다.
- 작업자들이 보고서에 남길 "같은 모양의 다른 시험" 목록을 이어서 고칠지는 보고를 받은 뒤 정한다.
