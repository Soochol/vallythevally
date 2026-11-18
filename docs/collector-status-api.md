# 수집 감독 데몬 상태 API

[ADR 0026](adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md) "수집 현황판"의 계약이다. 커넥터(`vally-server`)는 수집기 코드를 가져다 쓰지 않고([ADR 0025](adr/0025-collector-stores-closed-days-for-the-app.md)) 이 문서와 `crates/collector/tests/fixtures/status/`의 예시 JSON만 보고 자기 타입을 만든다. 데몬이 내보내는 메시지가 예시와 같은 모양인지, 예시가 데몬의 타입으로 읽히고 그대로 다시 써지는지를 `crates/collector/tests/supervise_status.rs`가 확인한다.

형식 버전은 1이다. 필드를 더하는 것은 버전을 올리지 않는다. 읽는 쪽은 모르는 필드를 무시한다. 필드를 지우거나 형·뜻·단위를 바꾸면 버전을 올리고 이 문서에 이력을 적는다.

## 소켓

- unix socket이다. 경로는 `collector supervise --socket <경로>`로 정한다. 없으면 상태 폴더(`--state`, 기본은 `$XDG_STATE_HOME` 또는 `$HOME/.local/state` 아래 `vallythevally/collector`) 아래 `supervise.sock`이다.
- 소켓 파일 권한은 600이다. 데몬이 폴더를 새로 만들면 권한은 700이다. 이미 있는 폴더는 건드리지 않는다.
- 데몬이 뜰 때 그 자리에 남은 소켓 파일은 지운다. 소켓이 아닌 파일이 있으면 지우지 않고 데몬이 시작하지 못한다. 연결을 받는 소켓이면(다른 데몬이 살아 있다) 지우지 않고 `--socket`을 적었는지와 상관없이 데몬이 시작하지 못한다. 같은 키를 쓰는 다른 데몬은 키 잠금 단계에서 이미 실패한다. 이 확인과 지우기와 소켓 열기는 소켓 옆의 잠금 파일(`<소켓 경로>.lock`)을 쥔 채 하므로, 두 데몬이 동시에 같은 낡은 소켓 위에 떠도 하나만 소켓을 얻고 다른 하나는 시작하지 못한다. 잠금 파일은 데몬이 끝나도 지우지 않는다.
- 데몬이 끝나면 소켓 파일을 지운다.
- 소켓을 만들지 못하면(경로가 unix socket 한도인 100여 바이트를 넘는 경우 등) `--socket`을 적었을 때는 데몬이 시작하지 않는다. 적지 않아 기본 경로를 쓸 때는(그 자리에 살아 있는 데몬이 있는 경우는 빼고) 오류를 로그에 남기고 상태 API 없이 수집을 이어 간다. 수집이 상태 API에 기대지 않게 하려는 것이다. 그때 커넥터는 "데몬 꺼짐"으로 보게 되므로 기본 경로가 짧은지 확인한다.
- 동시에 열 수 있는 연결은 16개다. 넘으면 `too_many_connections` 오류 한 줄을 보내고 닫는다.
- 요청은 읽기 전용이다. 재시작, 인계, 등록, 멈춤 같은 명령을 시키는 요청은 없다. 그런 이름의 요청은 `read_only` 오류를 받는다.

## 줄 형식

연결 위로 줄 단위 JSON(UTF-8, 줄 끝 `\n`)이 오간다. 줄 하나가 메시지 하나다. 요청 한 줄은 4096바이트까지다. 넘으면 `bad_request` 오류를 보내고 연결을 닫는다(오류 줄이 닿지 않을 수 있다). 줄의 첫 바이트를 받은 뒤 10초 안에 줄 끝이 오지 않아도 `bad_request` 오류를 보내고 닫는다. 반쪽 줄만 보내고 멈춘 연결이 동시 연결 슬롯을 붙들지 못하게 하려는 것이다. 요청을 하나도 보내지 않고 30초가 지난 연결도 `bad_request` 오류를 보내고 닫는다. 붙기만 하고 슬롯을 붙드는 연결을 치우려는 것이다. 요청을 한 번이라도 보낸 연결은 줄 사이에 쉬어도 끊지 않는다.

모든 메시지에 `v`(형식 버전)와 `type`이 있다.

## 요청

클라이언트가 보낸다. 요청 한 줄에 응답 한 줄이 온다. 한 연결로 여러 번 물을 수 있다. `coverage`와 `disk`의 응답은 파일을 읽는 동안 하트비트를 막지 않으려고 따로 처리되므로, 같은 연결에서 뒤에 보낸 요청의 응답보다 늦게 올 수 있다. 한 연결에서 응답을 기다리는 `coverage`·`disk`는 4개까지이고, 다섯째 요청부터는 대기열에 두었다가 앞의 응답이 끝나는 대로 차례로 처리한다. 대기열은 16개까지이고, 가득 차면 자리가 날 때까지 그 뒤의 줄을 읽지 않는다. 대기열에 든 요청 뒤의 `status`와 `watch`에도 바로 답한다. 클라이언트가 쓰기만 닫은 연결에는 느린 디스크 때문에 파일 읽기가 5초를 넘겨도 30초까지는 응답을 보낸다. 응답은 `type`으로 가른다.

| `type` | 응답 | 예시 |
|---|---|---|
| `status` | `status` | `request-status.json` |
| `coverage` | `coverage` | `request-coverage.json` |
| `disk` | `disk` | `request-disk.json` |
| `watch` | `status`, 그 뒤 감시 흐름 | `request-watch.json` |

`coverage`와 `disk`는 파일을 읽는 응답이라 데몬이 30초까지 같은 결과를 다시 쓴다. 읽기는 한 번에 하나만 돌고, 기다리던 요청이 끊겨도 읽기는 끝나서 결과를 남긴다. 정리된 날을 다시 정리하느라 폴더를 갈아 끼우는 중에 읽은 결과는 다시 쓰지 않고 다음 요청이 새로 읽는다. `status`는 데몬의 지금 상태다.

## 감시 연결

커넥터는 연결 하나에 `watch`를 보내 두고 유지한다. 데몬은 첫 응답으로 `status` 한 줄을 보내고, 그 뒤 N초(`watch_every`, 기본 5초)마다 `status` 한 줄과 `heartbeat` 한 줄을 이 순서로 보낸다. 데몬의 단계(`phase`)가 바뀌면 다음 주기를 기다리지 않고 바로 `status` 한 줄을 보낸다. 감시 연결로도 요청을 계속 보낼 수 있다.

커넥터의 판단은 아래와 같다. 판단은 커넥터가 하고, 데몬은 하트비트를 빠짐없이 보내기만 한다.

| 커넥터가 본 것 | 판단 |
|---|---|
| 소켓이 없거나 연결이 거부됨 | 데몬 꺼짐 |
| 연결은 됐는데 하트비트가 3번 잇달아 오지 않음 | 데몬 응답 없음 |
| 하트비트가 오고 `phase`가 `off_hours` | 정상 |

감시는 한쪽 방향이다. 데몬은 커넥터가 있는지 보지 않고, 연결이 없거나 끊겨도 똑같이 돈다. 연결마다 보내기 대기열이 64줄이다. 읽지 않는 연결로 대기열과 소켓 버퍼가 차서 5초 동안 한 줄도 더 넣지 못하면 데몬은 그 연결만 끊는다. 요청 수십 개를 한 번에 써 보내도 대기열이 비는 대로 순서대로 답한다. 끊긴 연결은 다시 연결하면 된다.

## 응답

모든 응답에 `sent_at`(KST, `2026-11-18T09:00:05+09:00`)이 있다. 오류는 없다.

### `status` (`reply-status.json`, `reply-status-filled.json`)

`status` 객체:

| 필드 | 뜻 |
|---|---|
| `date` | 데몬이 맡은 날짜. `YYYYMMDD` 정수 |
| `phase` | 데몬의 단계: `off_hours`(장 밖 대기), `morning_prep`(아침 준비), `collecting`(장중 수집), `after_close`(마감 뒤 처리: 마감 뒤 목록, 지수 일봉 대조, 토큰 재발급), `finalizing`(정리 중) |
| `today` | 오늘의 요약. 아래 표 |
| `keys` | 키마다 한 항목. 아래 표 |
| `universe_changes` | 그날 아침 종목 목록의 전날 대비 변동. 아침 목록이 아직 없으면 `null` |
| `observation_day` | 그날 관측일 판단과 근거. 판단 전(07:20 전)에는 `null` |
| `alerts` | 경보 목록. 오래된 것이 앞이고 최대 200개다. 넘치면 오래된 것부터 버린다. 계획의 알림이 200개를 넘어도 같다 |

`today`(종목 수 단위, 예외는 `register_failed_batches`):

| 필드 | 뜻 |
|---|---|
| `planned_stocks` | 계획에 든 종목 |
| `receiving_stocks` | 상태가 `receiving`인 키가 지금 받는 종목(인계받은 것 포함) |
| `register_failed_batches` | 등록에 실패한 묶음(50종목 단위) 수. 종목 수가 아니다 |
| `disconnected_stocks` | 상태가 `disconnected`나 `stopped`인 키의 종목. 인계되지 않은 채 끊긴 몫이다 |
| `handed_off_stocks` | 예비 키로 인계된 종목 |
| `excluded_stocks` | 키 용량이 모자라 계획에서 제외된 종목 |

`keys[]`:

| 필드 | 뜻 |
|---|---|
| `name` | 키 이름 |
| `app_key_hash_prefix` | 앱키 해시(`sha256:` 뒤)의 앞 8자. 키를 가리는 용도이고 비밀값은 아니다 |
| `role` | `collecting`(수집) 또는 `spare`(예비) |
| `state` | `waiting`(대기), `connecting`(연결 중), `receiving`(받는 중), `disconnected`(끊김), `stopped`(멈춤), `handed_off`(인계됨) |
| `stocks` | 지금 맡은 종목 수. 인계된 키는 0이다 |
| `messages_per_second` | 직전 자식 하트비트 구간의 초당 프레임 수. 아직 모르면 `null` |
| `register_failures` | 지금 자식의 등록 실패 묶음 수 |
| `restarts` | 그날 자식 재시작 수 |
| `rest` | REST 진행: `planned_jobs`, `finished_jobs`(작업 수). 지금은 둘 다 0이다 |

`universe_changes`는 `{added, removed, renamed, halt_started, halt_lifted}`다. 앞의 둘과 뒤의 둘은 `{code, name}` 배열이고 `renamed`는 `{code, from, to}` 배열이다.

`observation_day`는 `{verdict, reasons}`다. `verdict`는 `observed`, `not_observed`, `unknown`이고 `reasons`는 사람이 읽는 근거 문장 배열이다.

`alerts[]`는 `{at, kind, message}`다. `at`은 KST 시각이다. `kind`는 `excluded`(제외 발생), `plan_note`(계획의 알림), `handoff`(인계), `handoff_skipped`(인계하지 못함), `key_stopped`(키 멈춤), `register_failed`(등록 실패), `market_open_missing`(관측일인데 `0s`가 정한 시각까지 오지 않음), `observation_unknown`(관측일인지 알 수 없어 관측일로 보고 돌림), `index_mismatch`(코스피 지수 일봉과 관측일 판단이 어긋남), `stage_failed`(하루 단계 하나가 실패함: 종목 목록, 계획, 마감 뒤 처리, 정리 등)이다. 읽는 쪽은 모르는 `phase`와 `kind`를 그대로 보여 준다. 새 값은 형식 버전을 올리지 않는다.

### `heartbeat` (`reply-heartbeat.json`)

감시 연결에서만 온다. `sequence`는 그 연결에서 1부터 늘어난다. `phase`는 `status.phase`와 같은 값이다.

### `coverage` (`reply-coverage.json`)

`days[]`는 날짜 내림차순이고 최대 60일이다. 항목은 `{date, state, verified, planned_stocks, received_stocks}`다.

- `state`: `complete`(`store/<날짜>/complete.json`이 있고 읽히며 `format_version`이 1), `incomplete`(날짜 폴더는 있고 `complete.json`이 없음), `in_progress`(`store/<날짜>.tmp`만 있음. 정리 중이거나 다시 정리하느라 폴더를 갈아 끼우는 중), `verify_failed`(`store/<날짜>.tmp`만 있고 그 `verify.json`이 `passed: false`: 원문 대조가 실패해 봉인하지 못한 날. 사람이 봐야 한다), `unreadable`(`complete.json`이 읽히지 않거나 `format_version`이 1이 아님). 읽는 쪽은 모르는 `state`를 그대로 보여 준다. 새 값은 형식 버전을 올리지 않는다.
- `verified`, `planned_stocks`, `received_stocks`는 `complete.json`([수집 저장소 형식](collector-store-format.md)의 "complete.json")에서 구한다.
  - `verified`는 `verify.passed`다(원문 대조 통과 여부).
  - `planned_stocks`는 `plan.planned_stocks`다. 수집 키에 맡긴 종목, 용량 때문에 제외된 종목, 거래정지로 등록하지 않은 종목을 합한 수다. 그날 계획 파일이 없어 `plan`이 `null`이면 `null`이다.
  - `received_stocks`는 `stocks[]`에서 `received`가 `true`인 종목 수다. 계획에 없는데 받은 종목도 센다.
  - `state`가 `complete`가 아니면 셋 다 `null`이다.

### `disk` (`reply-disk.json`)

`filesystem`은 데이터 폴더가 있는 파일 시스템의 `{free_bytes, total_bytes}`다(일반 사용자가 쓸 수 있는 여유). 읽지 못하면 `null`이다. `raw`는 `raw/<날짜>/` 아래 파일 크기 합(바이트), `store`는 `store/<날짜>/`와 `store/<날짜>.tmp/`의 합이다. 날짜 내림차순이고 각각 최대 60일이다.

### `error` (`reply-error-*.json`)

`{code, message, supported_version}`이다. 오류 뒤에도 연결은 쓸 수 있다. 예외는 `too_many_connections`와 너무 긴 줄이다.

| `code` | 때 |
|---|---|
| `bad_request` | JSON 한 줄이 아니거나 `v`·`type`이 없거나 줄이 너무 김 |
| `unsupported_version` | `v`가 1이 아님 |
| `unknown_request` | 모르는 `type` |
| `read_only` | 명령처럼 보이는 `type`(`restart`, `handoff`, `stop` 등) |
| `too_many_connections` | 동시 연결 한도 |

## 버전이 다를 때

- 데몬은 `v`가 1이 아닌 요청에 `unsupported_version`과 `supported_version`으로 답한다.
- 클라이언트는 응답의 `v`가 자기가 아는 버전과 다르면 그 응답을 해석하지 말고 "형식 버전 불일치"로 보여 준다. `collector status`가 그렇게 한다.
- 필드만 더해진 새 데몬은 같은 버전이다. 클라이언트는 모르는 필드를 무시한다.

## 비밀값

응답에는 앱키, 앱시크릿, 토큰, 서비스 키가 없다. 키는 이름과 해시 앞 8자로만 보인다.

## 터미널

`collector status [--socket <경로>] [--state <폴더>]`는 `status`를 한 번 묻고 사람이 읽는 표로 찍는다. 데몬이 없으면(소켓이 없거나 연결이 거부됨) "데몬 꺼짐"을 찍고, 연결됐지만 5초 안에 답이 없으면 "데몬 응답 없음"을 찍고, 응답의 `v`가 1이 아니면 응답을 읽지 않고 "형식 버전 불일치"를 찍는다. 셋 다 종료 코드 1이다. 인수 오류는 2다.
