# 공용 자료 파일

수집 데몬이 공용 자료를 파일로 쓰고 `vally-server`가 읽는다. 배경과 결정은 [플랜](plans/collector-shared-data.md)(확정 1, 결정 A1~A5)에 있다. 형식 타입과 쓰기 함수는 `crates/server/src/shared_data/`에 있고, 수집기는 그 타입으로 쓴다.

## 서버 설정

| 변수 | 뜻 |
|---|---|
| `VALLY_SHARED_DATA_DIR` | 자료 폴더. 절대 경로여야 한다. 없으면 서버는 공용 자료 폴링을 켜지 않고, 수집 거래원 당일 흐름은 `<VALLY_HOGA_DATA_DIR>/shared`를 쓴다. |
| `VALLY_SHARED_DATA_POLL_MILLIS` | 폴링 간격. 기본 1000. 1 이상의 정수. |
| `VALLY_SCREENER_SNAPSHOT_STALE_SECS` | 장중 스크리너가 받아들이는 스냅샷 나이 한도(초). 기본 120. 1 이상의 정수. 넘으면 실행이 `stale_data`로 실패한다. |

서버는 간격마다 종류 폴더에서 관측일이 가장 늦은 파일을 `stat`으로 보고, 지난번과 바뀐 파일만 블로킹 스레드에서 읽어 메모리 판을 바꿔 끼운다. 요청은 메모리 판만 읽는다. 읽지 못한 파일(깨짐, 모르는 형식 버전, 폴더와 다른 종류)은 이전 판을 두고 종류별 오류 수를 센다. 같은 파일 버전은 오류를 한 번만 센다.

## 파일 형식

한 파일 자료는 `{"header": {...}, "body": {...}}` JSON 하나다. 덧붙이는 자료는 JSONL이고 첫 줄이 머리(`header` 객체 자체), 이후 한 줄에 항목 하나다.

머리 칸(camelCase):

| 칸 | 뜻 |
|---|---|
| `formatVersion` | 형식 버전. 지금 1. 읽는 쪽은 아는 버전만 읽는다. |
| `kind` | 자료 종류(닫힌 열거형). |
| `observationDate` | 관측일 `YYYYMMDD`. |
| `asOf` | 자료의 기준 시각, Unix 초. 판의 나이는 지금 − `asOf`다. |
| `writtenAt` | 쓴 시각, Unix 초. |
| `sources` | 받은 키 이름과 증권사(`kiwoom`·`kis`) 목록. |

## 쓰는 규칙

- 한 파일 자료(`write_snapshot`): 같은 폴더의 임시 파일(`.<이름>.tmp-<pid>`)에 쓰고 `fsync` 뒤 rename한다. 읽는 쪽은 `<YYYYMMDD>.json`만 본다.
- 수집기가 쓰는 JSONL(덧붙이는 자료, `usage/`, 사건 기록)에는 빈 줄을 쓰지 않는다. 줄마다 줄바꿈 하나로 끝난다.
- 덧붙이는 자료(`FeedWriter`): 한 줄을 한 번의 쓰기로 보낸다. 다시 열 때 줄바꿈 없이 끝난 꼬리는 잘라 낸다. 읽는 쪽은 지난번 위치부터 읽고 줄바꿈이 없는 마지막 줄은 다음에 읽는다. 관측일 파일이 바뀌면 처음부터 읽는다. 파일이 줄었어도 처음부터 읽는다.

## 키 배정표

데몬이 어느 `rest` 키가 어느 일을 받을지 정하는 설정 파일이다(`collector supervise --shared-config <경로>`, 기본 `~/.config/vally/collector-shared.json`). 데몬은 매일 07:35 계획 때 다시 읽는다. 읽지 못하거나 검사에 걸리면 직전에 읽은 배정(직전 사본은 `<--data>/plan/shared-assignment.last.json`)을 쓰고 상태 API에 `stage_failed` 경보를 낸다. 직전 배정도 없으면 공용 자료 일을 돌리지 않고 경보한다. 파일이 없으면 경보 없이 공용 자료 일을 돌리지 않는다(이 기능을 쓰지 않는 지금 동작). 바뀐 배정은 다음 관측일 자식부터 쓴다. 장중에는 읽지 않는다.

```json
{"version": 1,
 "keys": {"rest-01": {"total_per_second": 5}},
 "jobs": {"probe": {"keys": ["rest-01", "rest-02"], "period_secs": 30, "options": {"calls_per_tr": 4}}}}
```

- `jobs`의 이름은 닫힌 열거형이다(`crates/collector/src/shared/mod.rs`의 `JobName`). 지금은 시험용 `probe`와 `snapshot`, `kiwoom_themes`, `overview`, `intraday_samples`, `rankings`다. 뒤 작업이 자기 일을 한 줄씩 더한다.
- 일마다 `keys`(순서가 우선순위), `period_secs`(1 이상, 없으면 일의 기본값. `rankings`는 10), `options`(일이 정하는 선택값, 없으면 일의 기본값)를 둔다. `keys`의 키는 모두 활성 `rest` 키여야 하고 그 일이 받는 증권사여야 한다. 같은 키를 두 번 적을 수 없다.
- 같은 일에 키가 여럿이면 일이 나눌 단위를 키 수로 나눠 그 키들이 동시에 부른다. 키 `i`가 단위 `u`를 `u % 키 수 == i`일 때 맡는다. 키 하나가 멈추면(재시작 한도, 8050 등) 남은 키들이 몫을 다시 나눠 갖는다. 마지막 키까지 멈추면 그 일은 서고 상태 API에 경보가 난다.
- `keys.<이름>.total_per_second`(선택)를 적으면 그 키의 `KiwoomRest` 합계 창을 그 값으로 켜서 모든 TR의 1초 전송 합계가 그 값을 넘지 않게 한다. 적지 않으면 TR별 창(5)만 지킨다.
- 모르는 칸, 모르는 일 이름, `rest`가 아닌 키, 키 목록에 없는 키, 0인 주기·한도, 일이 받지 않는 선택값은 읽기 오류다.
- 데몬은 배정표에 든 `rest` 키마다 공용 자료 자식(`collector shared --child`) 하나를 띄운다. 어느 일에도 든 적 없는 `rest` 키는 띄우지 않는다.

## 키별 TR 사용량

공용 자료 자식과 데몬의 REST(예비 키가 아침 목록·마감 뒤 대조에 쓰는 세션)가 1분마다 키·TR별 사용량을 `<--data>/usage/<YYYYMMDD>.jsonl`에 한 줄씩 덧붙인다. 날짜는 그 1분이 시작한 KST 날짜다. 한 줄은 한 번의 쓰기로 가고 빈 줄은 쓰지 않는다. 자식은 1분이 끝나면(키움 REST의 1분 카운터가 닫힐 때) 사건 `usage`로 데몬에 알리고, 파일은 데몬이 쓴다. 보낸 것이 없는 분은 쓰지 않는다. 일을 바꾸는 중이라 끝나지 못한 1분은 남지 않는다.

TR 줄:

```json
{"v":1,"at":"2026-11-18T09:01:00+09:00","key":"rest-01","broker":"kiwoom","scope":"tr","tr":"ka10095","sent":12,"rate_limited":1,"resent":1,"max_wait_ms":1050,"max_per_second":5}
```

키 줄(그 분에 TR 줄이 하나라도 있으면 한 줄):

```json
{"v":1,"at":"2026-11-18T09:01:00+09:00","key":"rest-01","broker":"kiwoom","scope":"key","max_per_second":7}
```

- `sent`는 보낸 요청 수(다시 보낸 것 포함), `rate_limited`는 제한 응답(429 등)을 받은 수, `resent`는 제한 응답 뒤 다시 보낸 수, `max_wait_ms`는 TR 창이 비기를 기다린 가장 긴 시간, `max_per_second`는 최근 1초(창 길이 1.05초) 전송 수의 최댓값이다.
- 키 줄의 `max_per_second`는 모든 TR(토큰 발급 제외)의 최근 1초 전송 합계의 최댓값이다. 합계 창이 꺼져 있어도 센다.
- **한도 확인(플랜 결정 B5)**: ADR 0035의 미확인 사항("초당 5회"가 키 하나의 TR 합계인지)은 `total_per_second` 없이 한 키에 TR이 다른 일 둘을 함께 배정한 관측일 하루의 줄로 가린다.
  - 키 줄 `max_per_second`가 5를 넘은 분에 TR마다 `max_per_second`가 5 이하인데 `rate_limited`가 나면 합계 한도다. 그때는 `rest` 키마다 `total_per_second: 5`를 켜고 일을 키마다 하나씩 둔다.
  - 키 줄이 5를 넘었는데 `rate_limited`가 0이면 TR이 독립이다. 한 키에 TR이 다른 일 여럿을 둘 수 있다.
  - `crates/collector/src/shared/usage.rs`의 `judge_limit`이 이 규칙이다. 확인하기 전에는 `total_per_second: 5`를 켠 배정으로 돈다.

## 오늘 시세 스냅샷 (`snapshot`)

플랜 결정 C1이다. 전 종목 오늘 시세를 거래소마다 한 판씩 받아 최신 하나만 덮어쓴다.

- 시각: 관측일 08:00부터 KST :00·:30에 한 판씩 받는다. 20:00 이전 마지막 판은 19:59:30이다. 20:00 뒤 20:00:30에 한 번 더 받아 마감 시세(`closing: true`)로 두고, 다음 관측일 첫 판까지 그대로 둔다. 일은 데몬이 관측일 자식에게 배정할 때만 돌아서 휴장일·주말에는 받지 않는다. 새 관측일의 첫 판을 쓴 뒤 지난 관측일 파일을 지운다.
- 대상: 그날 데몬이 받은 `ka10099`의 모든 행(ETF·ETN 포함, 서버 종목 목록과 같은 분류). 데몬이 아침 목록을 받을 때 `<--data>/listing/<YYYYMMDD>.json`에 종목 코드와 NXT 거래 여부(`nxtEnable == "Y"`)를 남기고 최근 3일 것만 둔다. 일은 그날 파일을 읽고, 없으면 가장 가까운 이전 날 것을 읽는다. 이전 날 것을 쓰는 동안에도 판마다 그날 파일이 생겼는지 보고, 생기면 그 목록으로 바꾼다. 둘 다 없으면 호출 없이 실패한다. 이 파일은 공용 자료 폴더가 데이터 폴더 바로 아래 `shared`일 때(기본값) 찾는다.
- 호출: 거래소마다 `ka10095`(100종목 묶음, 통합은 `_AL`, NXT는 `_NX` 접미사, NXT는 NXT 거래 종목만)와 코스피·코스닥 종합지수 `ka20003` 각 1회. 호출 수는 판마다 (종목 수 ÷ 100 올림) × 2 + (NXT 종목 수 ÷ 100 올림) + 2다(거래소 셋 기준).
- 키가 여럿이면 거래소 순서로 늘어놓은 묶음(지수 둘은 맨 끝)을 번호 `u`가 `u % 키 수 == 슬라이스`인 키가 맡는다. 키는 서로 다른 프로세스라 각자 `<공용 자료 폴더>/snapshot-parts/<날짜>.<판 시각>.<슬라이스>-<키 수>.json`에 조각을 쓰고, 마지막 조각을 쓴 키가 조각을 모아 거래소별 파일을 쓴다. 두 키가 동시에 모아도 같은 내용이다.
- 한 묶음이라도 실패하면 그 키는 조각을 쓰지 않아 그 판은 만들어지지 않고 이전 판이 남는다. 모든 거래소·키의 응답을 합쳐 읽히는 행이 하나도 없거나(조각을 모으는 키가 판정하고 이전 판을 둔다) ka20003 응답에 종합지수 행이 없는 것도 실패다. 그날 목록 파일을 읽지 못하면 이미 읽은 목록으로 계속 돈다. 일의 `failures()`와 일 통계의 마지막 오류에 남는다. 정상 응답에서 일부 종목 행이 빠지거나 읽히지 않으면 본문 `missing`에 센다.
- 선택값: `options.venues`(기본 `["krx","combined","nxt"]`)로 받을 거래소를 고른다. 모르는 칸·중복·빈 목록은 읽기 오류다.
- 본문(`SnapshotBody`): `closing`, `requested`(요청한 종목 수), `missing`, `stocks`(종목 행), `indices`(종합지수 행. 세 파일에 같다). 종목 행은 `code`, `day`(응답 날짜), `currentWon`, `baseWon`, `openWon`, `highWon`, `lowWon`, `volume`, `tradedMillionWon`, `tradedAt`(체결 시각, Unix 초. 없으면 null)이고 가격은 원 단위 양수다. 머리 `asOf`는 마지막 조각을 마친 시각이다.

## 폴더 배치

`<VALLY_SHARED_DATA_DIR>/<종류 폴더>/<관측일>.<확장자>`다. 뒤 작업이 자기 줄을 더한다.

| 종류 | 폴더 | 한 파일(`.json`) | 덧붙임(`.jsonl`) | 본문 |
|---|---|---|---|---|
| `probe` (시험용) | `probe/` | `probe/<YYYYMMDD>.json` | `probe/<YYYYMMDD>.jsonl` | `ProbeBody`, `ProbeItem` |
| `snapshotKrx` | `snapshot-krx/` | `snapshot-krx/<YYYYMMDD>.json` | | `SnapshotBody` |
| `snapshotCombined` | `snapshot-combined/` | `snapshot-combined/<YYYYMMDD>.json` | | `SnapshotBody` |
| `snapshotNxt` | `snapshot-nxt/` | `snapshot-nxt/<YYYYMMDD>.json` | | `SnapshotBody` |
| `minute` (1분봉) | `minute/<YYYYMMDD>/` | | `minute/<YYYYMMDD>/<키 이름>.jsonl` | `MinuteBar` |
| `quoteMinutes` (분 호가) | `quote-minutes/<YYYYMMDD>/`, `quote-minutes-live/<YYYYMMDD>/` | `quote-minutes/<YYYYMMDD>/<종목>.json.gz`, `quote-minutes-live/<YYYYMMDD>/<키 이름>/_current.json` | `quote-minutes-live/<YYYYMMDD>/<키 이름>/<종목>.jsonl`, `_gaps.jsonl` | `ClosedQuotes`, `CurrentQuotes`, `QuoteMinute` |
| `tradeMinute` (1분 체결) | `trade-minute/<YYYYMMDD>/` | | `trade-minute/<YYYYMMDD>/<키 이름>/<종목코드>.jsonl` | `TradeMinuteLine` |
| 종목 흐름 (`symbol-flow`) | `symbol-flow/<YYYYMMDD>/` | | `symbol-flow/<YYYYMMDD>/<타입>/<종목코드>/<키 이름>.flow`, `links/<키 이름>.jsonl` | `FlowDescription`, `FlowRow` |
| `marketOverview` | `market-overview/` | `market-overview/<YYYYMMDD>.json` | | `OverviewBody`, `MadeCard` |
| `kiwoomThemes` | `kiwoom-themes/` | `kiwoom-themes/<YYYYMMDD>.json` | | `ThemesBody`, `ThemeEntry` |

## 1분봉

`collect` 자식이 받은 실시간 `0B`(종목 체결)와 `0J`(업종 지수)로 1분봉을 만들어 5초마다 `<공용 자료 폴더>/minute/<YYYYMMDD>/<키 이름>.jsonl`에 덧붙인다(플랜 결정 C6). 데몬은 자식을 `collect --child --key <이름> --data <폴더> --shared <공용 자료 폴더>`로 띄운다. `--shared`가 없으면 집계하지 않는다. 형식과 합치기 함수는 `crates/server/src/shared_data/minute.rs`, 집계는 `crates/collector/src/shared/minute/`에 있다.

줄(camelCase, 첫 줄은 `kind: "minute"` 머리):

```json
{"symbol":"005930","instrument":"stock","venue":"krx","minute":540,"open":70000.0,"high":71000.0,"low":69900.0,"close":69900.0,"volume":14,"value":980850,"trades":4,"firstSec":32401,"lastSec":32459}
```

- `instrument`는 `stock`·`index`다. 종목 `symbol`은 등록 글자에서 `_AL`을 뗀 코드, 지수는 업종 코드(`001` 등)다. `venue`는 종목만 갖고 `krx`·`nxt`·`combined`(통합)다. 지수 줄에는 `venue`가 없다.
- `minute`는 KST 자정부터의 분(09:00 → 540)이고 체결 시각 `f20`(HHMMSS)으로 정한다. 날짜는 받은 시각의 KST 날짜다.
- 종목 체결은 `f10`(현재가, 부호 뗌), `f15`(체결량, 부호 뗌)로 센다. `volume`은 체결량의 합, `value`는 체결가 × 체결량의 합, `trades`는 체결 수다. `f15`가 0인 항목은 체결이 아니라 건너뛴다. 거래소는 `f9081`(`KRX`·`NXT`)로 가르고 통합 봉은 둘과 거래소를 알 수 없는 체결을 모두 합친다.
- 지수는 `f10`을 가격으로, `f15`를 거래량으로 센다. `value`는 `f14`(누적거래대금)가 직전 체결보다 늘어난 만큼의 합이다. 자식을 다시 띄운 뒤 첫 체결의 증가분과 `f14`가 없는 체결은 0으로 센다.
- `open`은 `firstSec`가 가장 이른 체결, `close`는 `lastSec`가 가장 늦은 체결의 값이다. 같은 초에는 `open`은 먼저, `close`는 나중에 온 체결이다. `firstSec`·`lastSec`는 KST 자정부터의 초다.
- 같은 (종목, 거래소, 분)의 뒤 줄이 앞 줄을 대신한다. 5초마다 그 사이 바뀐 봉(진행 중인 봉 포함)만 덧붙고, 바뀐 것이 없으면 아무것도 쓰지 않는다. 줄은 분, 종목, 거래소 순으로 쓴다.
- 자식이 다시 뜨면 그날 파일을 읽어 가장 늦은 분에서 5분 안의 봉부터 이어 센다. 그보다 5분 넘게 늦게 온 체결은 세지 않고 `too_late`로 센다.
- 인계로 종목이 다른 키로 옮겨 가면 새 키의 파일에 그때부터 쌓인다. 두 파일에 나뉜 같은 분은 `MinuteBar::merged_with`로 합친다. 받는 쪽을 이른 쪽으로 보고, 시가는 `firstSec`가 더 이른 쪽, 종가는 `lastSec`가 더 늦은(같으면 인수로 받은 뒤쪽) 쪽, 고가·저가는 극값, 양·대금·체결 수는 합이다. 키가 다른 봉은 합치지 않는다(`None`).
- 집계는 원문 쓰기와 다른 작업에서 돈다. 세션은 `0B`·`0J`를 담은 프레임을 가득 차지 않은 큐(16,384개)에 `try_send`로만 넘기고, 큐가 차면 그 프레임을 집계 쪽이 버리고 `dropped`로 센다. 원문 쓰기는 늦어지지 않는다. 누계(`ticks`, `lines`, `dropped`, `skipped`, `unreadable`, `too_late`, `store_errors`)는 1분마다 로그 `분봉 집계 누계`로 남는다. 파일에 쓰지 못하면 바뀐 봉을 그대로 두고 다음 5초에 다시 쓴다. 집계의 오류는 세션을 멈추지 않는다.
- 하루 파일 크기는 진행 중인 봉이 5초마다 한 줄씩 다시 쓰이므로 체결이 잦은 종목일수록 크다. 읽는 쪽은 지난번 위치부터 읽고 같은 키의 뒤 줄을 앞 줄 대신 쓴다.

## 분 호가 (`quoteMinutes`)

수집기가 한 종목의 1분 동안 받은 10호가를 줄여 장중 파일과 닫힌 날 파일로 쓰고, 서버는 요청한 날짜·종목만 읽는다([ADR 0050](adr/0050-quote-minutes-are-shared-data-made-by-the-collector.md)). 형식·집계·쓰기·읽기는 `crates/server/src/shared_data/quote_minutes/`에 있다. 760종목 하루치를 메모리에 올리지 않으므로 `SharedData::poll_once`에는 넣지 않는다.

- 장중(`quote-minutes-live/<YYYYMMDD>/<키 이름>/`):
  - `<종목>.jsonl`: 끝난 분을 한 줄씩 덧붙인다(`FeedWriter`, 머리 `kind: "quoteMinutes"`). 종목 파일은 처음 쓸 때 연다.
  - `_gaps.jsonl`: 그 키의 끊긴 구간 `[fromSec, toSec]`을 한 줄씩 덧붙인다(`FeedWriter`, 머리 `kind: "quoteMinutes"`).
  - `_current.json`: 진행 중인 분 묶음(`CurrentQuotes`: `{"minutes": {"<종목>": QuoteMinute}}`)을 `write_snapshot_at`으로 덮어쓴다.
- 닫힌 날(`quote-minutes/<YYYYMMDD>/`):
  - `<종목>.json.gz`: `Envelope<ClosedQuotes>`(`{"minutes": [...], "gaps": [[fromSec, toSec], ...]}`)를 gzip으로 압축해 쓴다. 쓰는 쪽이 `.tmp` 폴더에 다 쓴 뒤 rename으로 바꿔 끼운다.
- 항목(`QuoteMinute`, camelCase): `minute`(KST 자정부터의 분), `closeSec`(마지막 호가 시각, KST 자정부터의 초), `singlePrice`(마지막 호가가 단일가 호가인지), `combined`·`krx`·`nxt`(`VenueQuote`: `close`, `peak`, `priceMax`). 각 사다리(`Ladder`)는 `asks`(매도, 낮은 가격부터)·`bids`(매수, 높은 가격부터)이고 단은 `[price, qty]`다. 잔량이 0보다 큰 단만 남기며, JSON에서는 빈 사다리와 빈 거래소를 생략한다.
- 집계 규칙:
  - `singlePrice`: 가격이 0이 아닌 단이 양쪽 모두 3개 이하(빈 호가 포함)이면 참이다.
  - `close`·`closeSec`·`singlePrice`는 넣은 순서의 마지막 호가다.
  - `peak`와 `priceMax`는 단일가 호가를 빼고 센다. `peak`는 거래소별 총잔량(매도 합 + 매수 합)이 가장 큰 시점의 사다리이고 같으면 먼저 온 쪽이다. `priceMax`는 거래소별 가격마다 가장 큰 잔량이며, 통합은 한 시점 통합 잔량의 최댓값이다.
  - 같은 분이 여러 키에 나뉘면 `QuoteMinute::merged_with`로 합친다(`close`는 `closeSec`가 늦은 쪽, 같으면 뒤쪽; `peak`는 총잔량이 큰 쪽, 같으면 앞쪽; `priceMax`는 가격마다 큰 쪽).
- 읽기(`read_quote_day`, `quote_days`):
  - 닫힌 날 폴더(`quote-minutes/<YYYYMMDD>`)가 있으면 그것만 읽고, 거기 종목 파일이 없으면 장중 파일이 있어도 `None`이다.
  - 닫힌 날 폴더가 없으면 장중 폴더의 모든 키에서 키마다 `_current.json`을 먼저 읽고 `<종목>.jsonl`을 나중에 읽어 합치며, 그 종목 자료가 있는 키의 `_gaps.jsonl`만 합쳐 오름차순으로 돌려준다(쓰는 쪽은 끝난 분을 덧붙인 뒤 `_current.json`을 갱신한다). 줄바꿈 없는 잘린 꼬리와 깨진 줄은 건너뛴다.
  - `quote_days`는 닫힌 날 폴더와 장중 폴더의 `YYYYMMDD` 날짜를 합쳐 오름차순으로 돌려준다(`.tmp` 같은 비날짜 폴더는 제외).
- 장중 쓰기(`crates/collector/src/shared/quotes/`):
  - `collect` 자식에 `--shared <공용 자료 폴더>`가 있으면 1분봉과 나란히 별도 작업으로 돈다. 세션은 `"0D"`가 든 실시간 프레임을 해석 없이 유한 큐(16,384개)에 `try_send`로만 넘기고, 큐가 차면 집계 쪽이 버리고 `dropped`로 센다. 연결 끊김(`Down`)·재연결(`Live`) 신호는 별도 무제한 채널로 보내 프레임 큐가 차도 버려지지 않게 한다. 원문 쓰기는 늦어지지 않는다.
  - 필드: 시각 `21`(HHMMSS), 매도 가격 `41`~`50`, 매수 가격 `51`~`60`, 통합 잔량 `61`~`70`·`71`~`80`, KRX 잔량 `6044`~`6053`·`6054`~`6063`, NXT 잔량 `6066`~`6075`·`6076`~`6085`. 빠지거나 빈 값은 0이고 가격·잔량의 부호는 뗀다. 시각을 읽을 수 없거나, 종목이 `_AL`로 끝나지 않거나, `_AL`을 뗀 글자가 `domain::StockCode::parse`를 지나지 못하면 `skipped`다.
  - 분은 호가시각(`21`)으로 정하고 날짜는 받은 시각의 KST 날짜다. 날이 바뀌면 남은 진행 분을 모두 끝내 쓰고 새 날을 연다.
  - 한 종목에 다음 분 호가가 오면 앞 분이 바로 끝나고, 호가가 오지 않은 종목은 받은 프레임 시각 가운데 가장 늦은 시각(`now`)이 분 끝 + 5초 이상일 때 끝난다. 이미 끝난 분보다 이르거나 같은 분의 호가는 세지 않고 `too_late`로 센다.
  - 5초마다와 종료 때 끝난 분을 `<종목>.jsonl`에 먼저 덧붙이고 끊긴 구간을 `_gaps.jsonl`에 덧붙인 뒤, 바뀐 것이 있으면 `_current.json`을 덮어쓴다. 쓰기에 실패하면 `store_errors`를 세고 작성기를 다시 열며, 남은 분과 진행 상태는 다음 5초에 다시 쓴다. 종료 때는 저장 뒤 `sync`하며 끝나지 않은 분은 `_current.json`에 남긴다.
  - 끊긴 구간은 첫 `Down`부터 다음 `Live`까지를 KST 자정부터의 초로 적는다. 다시 시작했을 때 `_current.json`에 진행 분이 있으면 그 가운데 가장 늦은 `closeSec`부터 첫 `Live`까지를 끊긴 구간으로 적고 진행 분을 이어 센다. 종료 때 열려 있는 끊김은 적지 않는다.
  - 누계(`books`, `minutes`, `gaps`, `dropped`, `skipped`, `unreadable`, `too_late`, `store_errors`)는 1분마다 로그 `분 호가 집계 누계`로 남는다.

## 1분 체결 (`tradeMinute`)

`collect` 자식이 `--shared`가 있을 때 받은 실시간 `0B`(주식체결)에서 종목별 마지막 체결 10건을 분이 끝난 뒤 `<공용 자료 폴더>/trade-minute/<YYYYMMDD>/<키 이름>/<종목코드>.jsonl`에 한 줄씩 덧붙인다. 형식(`TradeMinuteLine`, `trade_minute_path`)은 `crates/server/src/shared_data/trade_minute.rs`, 집계·쓰기는 `crates/collector/src/shared/trade_minute/`에 있다. `0D`는 읽지 않는다(호가는 `quote-minutes-live`가 맡는다).

- 대상: `_AL`로 끝나고 `domain::StockCode::parse`를 지나는 종목의 `0B`만 읽는다. 수량(`f15`)이 0이거나 가격(`f10`)이 0이거나 읽을 수 없는 항목은 건너뛰고 센다. 체결이 없는 종목은 쓰지 않는다.
- 줄(camelCase, 첫 줄은 `kind: "tradeMinute"` 머리): `{"minute":540,"trades":[[32401,71000,3],[32402,71010,-4]]}`. `minute`은 `recv_ms`의 KST 분이고 `trades`는 `[체결 초(f20), 가격(절댓값), 부호 있는 수량]` 튜플 최대 10건이다.
- 닫힘과 재시도: 1초마다 큐를 비운 뒤 시계가 분 끝 + 1초를 지났으면 닫고, 늦은 분의 프레임이 오면 앞 분을 닫는다. 종료(`finish`) 때는 끝나지 않은 분도 쓴다. 닫은 분의 늦은 프레임은 버리고 센다. 쓰기에 실패한 분의 체결은 다음 분 줄에 이어 싣고(종목당 10건까지), 읽는 쪽은 같은 분 줄이 둘이면 이어 붙여 마지막 10건을 쓴다.
- 파일 핸들과 지우기: `FeedWriter::open_at`으로 그 묶음을 쓸 때만 열고 닫는다(전 종목 핸들을 열어 두지 않는다). 새 날짜를 열 때 `trade-minute/` 아래 8자리 날짜 폴더 가운데 최근 7개 밖을 지운다.
- 격리: 세션은 `0B`가 든 프레임만 가득 차지 않는 큐(16,384개)에 `try_send`로 넘기고 기다리지 않는다. `SharedData::poll_once`에는 넣지 않고 호가 복기 요청 때만 읽는다.

`kiwoom_themes`는 ADR 0042의 테마 목록·구성종목이다. 머리의 `asOf`가 받은 시각이고 본문은 테마마다 코드·이름·구성종목 코드다. 일 이름은 `kiwoom_themes`, 키움 키만 받는다.

## 시장 개요와 장중 표본

일 `overview`(60초마다, 08:00~20:00)가 코스피·코스닥의 칸을 만들어 `market-overview/<관측일>.json`에 쓴다. 칸 값은 서버 `GET /api/market-overview/*`가 내는 값과 같은 모양이다(`index`, `sectors`, `flow`·`turnover`의 기간 5·20·60, `streaks`). 계산은 서버의 `market_overview::{index,sectors,flow,turnover,streaks}_card`를 그대로 부른다. 칸마다 `context.source`가 받은 증권사이고, 칸 안의 실패는 그 부분만 `failed`다. 지난 거래일 투자자 값은 데몬 자식이 그 관측일(07:45 경계) 동안 메모리에 둔다.

- 일의 `keys` 순서가 우선순위다. 칸 `u`(시장·칸 순서의 번호)는 키 `u % 키 수`가 맡고, 그 키의 증권사가 받을 수 없는 칸(한투의 연속 매매)은 순서상 다음에 그 칸을 받을 수 있는 키가 맡는다. 받을 수 있는 키가 없으면 처음 키가 그 칸을 `unsupported_by_source` 실패로 쓴다.
- 키마다 `market-overview-parts/<관측일>.<키>.json`에 자기 칸을 쓰고, 잠금을 잡은 채 모든 조각을 합쳐 `market-overview/<관측일>.json`을 쓴다. 같은 칸이 둘이면 더 늦게 만든 것을 쓴다. 머리의 `asOf`는 합친 뒤 남은 칸 가운데 가장 오래된 것이고, `sources`는 그 칸을 만든 키만이다.
- 연속 매매의 ETF·ETN 제외는 그날 종목 행 파일(`<데이터 폴더>/listing/`)의 `exchange_traded: true` 종목을 가리는 것이다(서버는 종목 사전의 종류로 같은 종목을 가린다). 이 칸은 없으면 거짓이라 쓰지 않는다. 파일이 없으면 그 칸이 `collector_unavailable` 실패다.
- 한투 키의 공용 자료 자식은 아직 한투 세션(앱키·시크릿)을 받지 못한다. 그 키는 이 일에서 자기 칸을 `이 한투 키의 공용 자료 자식에는 한투 세션이 없습니다` 오류로 못 만든다. 데몬이 한투 자격을 자식에게 넘기는 작업이 있어야 한다.

일 `intraday_samples`(09:00~15:30, 매 분)는 ADR 0034 줄 형식 그대로 `market-samples/<관측일>.jsonl`에 시장마다 투자자·프로그램을 한 줄씩 덧붙인다(한 분 4줄). 형식은 서버의 `market_overview::Sample`이다. 일의 이름은 `overview`, `intraday_samples`이고 키움·한투 키를 받는다.

## 순위 (`rankings`)

수집 데몬이 배정표에 적은 조건의 순위를 10초(기본)마다 미리 받아 파일로 쓰고, 서버는 읽기만 한다. 서버가 읽는 일은 따로 한다. 서버 쪽 읽기는 `crates/server/src/shared_data/rankings.rs`다.

배정 예:

```json
{"version": 1,
 "jobs": {"rankings": {"keys": ["rest-kis", "rest-01"], "options": {"pages": 5, "variants": [{"kind": "tradeAmount", "market": "all", "venue": "combined", "excludeManaged": false}]}}}}
```

- `options.variants`는 미리 만들 조건 목록이다. 항목은 서버 `api::Ranking`의 JSON에서 `excludes`를 뺀 것이다(적어도 무시한다). 없으면 기본 목록(`default_rankings()`)이다. 종류마다 기본 선택값(웹의 시작 선택값) × 시장(전체·코스피·코스닥, 프로그램·호가잔량은 코스피·코스닥, 많이 본 종목은 시장 없음) × 통합 거래소로 35개다. `options.pages`는 조건마다 받을 쪽 수로 기본 5(1~30)다. 같은 조건을 두 번 적으면 읽기 오류다.
- 시간대는 관측일 08:00~20:00이다.
- 조건의 키는 서버 순위 캐시 `QueryKey`의 본문과 같은 규칙(`market_source::rankings::condition_key`: `Ranking`의 JSON에서 `excludes`를 뺀 글자)이다. 서버는 요청의 조건을 같은 함수로 키로 만들어 찾는다.
- 받을 키는 `keys` 순서가 우선순위다. 조건마다 그 키가 받을 수 있는지(`RankingSource::check`: 종류, 선택값, 조합)를 보고, 처음 받을 수 있는 키의 증권사에 속한 키들이 그 조건을 조건 번호 순으로 나눠 받는다. 받을 수 있는 키가 없으면 첫 키가 그 조건을 `unavailable`로 적는다. 예: 한투 키가 첫째, 키움 키가 둘째면 한투가 받지 못하는 조건(외국인 연속 순매수, 프로그램 순매수, 한투가 당일 누적만 받는 많이 본 종목 `minute1` 등)만 키움 키로 나간다.
- 연속조회는 `pages`쪽까지 걷는다. 목록이 먼저 끝나면(`end`) 거기서 멈춘다. 한투 순위는 한 쪽으로 끝난다.
- 조건 하나가 실패하면 그 조건만 이전 값(`last`)을 두고 `state`를 `failed`로 적는다. 다른 조건은 새 값이다.

파일은 키마다 조각 하나다: `<VALLY_SHARED_DATA_DIR>/rankings/<YYYYMMDD>/<키 이름>.json`. 키가 서로 다른 파일을 쓰므로 쓰기 경합이 없다. 서버는 관측일이 가장 늦은 폴더의 조각들을 읽어 한 판으로 합치고, 조각 파일이 바뀐 때만 다시 합친다. 같은 조건이 여러 조각에 있으면 받은 시각이 가장 늦은 쪽을 쓴다.

조각 본문(`RankingsPartBody`, camelCase): `periodSecs`, `pages`, `conditions`(배열). 항목: `key`(조건 키), `state`(`ready`·`failed`(`at`, `message`)·`unavailable`), `last`(없을 수 있다. `rows`, `pages`(받은 쪽 수), `pageRows`(쪽마다 받은 행 수. 서버가 요청 쪽 수만큼 앞에서 자르는 데 쓴다. 없는 옛 조각은 빈 목록), `end`, `limited`, `receivedAt`(Unix 초), `broker`). 행은 `code`, `name`, `price`, `changeRate`, `figures`이고 순번·상장 여부·제외 거름은 서버가 읽을 때 정한다. 머리 `asOf`는 그 키가 마지막으로 돈 시각이고 `sources`에 그 키와 증권사가 하나 든다. 조각이 낡았는지는 지금 − `asOf`가 `periodSecs`의 두 배를 넘는지로 본다(`MergedCondition::is_stale`).

한투 키의 자식은 아직 순위를 받을 `KisRest` 연결이 없다(`Market::Kis(None)`). 그 키가 맡은 일은 오류로 남고 파일을 쓰지 않는다. 한투 키 자격증명을 자식에 건네는 길은 이 일 다음에 더한다.

| 종류 | 폴더 | 한 파일(`.json`) | 본문 |
|---|---|---|---|
| `rankings` | `rankings/` | `rankings/<YYYYMMDD>/<키 이름>.json` | `RankingsPartBody` |

## 종목 흐름

`collect` 자식이 받은 실시간 프레임 가운데 종류 표(`crates/collector/src/shared/flow/mod.rs`의 `FLOW_KINDS`)에 든 타입을 종목마다 1초 묶음으로 `<공용 자료 폴더>/symbol-flow/<YYYYMMDD>/<타입>/<종목코드>/<키 이름>.flow`에 덧붙인다. `--shared`가 없으면 쓰지 않는다. 종목코드는 `_AL`을 뗀 글자다. 형식과 쓰기·읽기 타입(`FlowDescription`, `FlowRow`, `FlowBlock`, `FlowWriter`, `FlowCursor`)은 `crates/server/src/shared_data/symbol_flow.rs`에 있다. 종목마다 파일이 나뉘므로 `DataKind`와 서버의 `SharedData` 주기 폴링에는 넣지 않는다. 서버는 거래원(`0F`) 흐름을 요청한 종목에 한해 읽어 준다([수집 거래원 API](collected-brokers-api.md)).

- **경로**:
  - 흐름 파일: `<공용 자료 폴더>/symbol-flow/<YYYYMMDD>/<타입>/<종목코드>/<키 이름>.flow` (`flow_path`)
  - 연결 기록: `<공용 자료 폴더>/symbol-flow/<YYYYMMDD>/links/<키 이름>.jsonl` (`flow_links_path`)
- **블록**: 고정 32바이트 머리(리틀엔디언: magic `SFLW` 4B, 종류 1=설명·2=행 1B, 코덱 0=그대로·1=zstd 1B, 예약 2B, payload 길이 u32, 행 수 u32, 첫 `recv_ms` i64, 끝 `recv_ms` i64) 뒤에 payload가 온다. payload는 zstd로 압축해 작아질 때만 코덱 1을 쓰고, 그렇지 않으면 그대로 둔다. 손상된 길이가 메모리를 크게 잡지 않게 payload 길이에 상한(32MiB)을 둔다. 행 블록의 payload는 `[recv_ms, "값"|null, ...]` JSON 배열의 배열이며 값은 원문 글자 그대로, 설명 블록의 `fids` 순서다.
- **설명 블록**: `{"formatVersion":1,"typeCode":"0F","symbol":"005930","date":"20261124","key":"collect-01","fids":[...]}` JSON이다. 파일 첫 블록으로 쓰며, 같은 파일을 다시 열 때 FID 목록이 바뀌었으면 새 설명 블록을 먼저 덧붙인다. 읽는 쪽(`FlowCursor`)은 설명 블록으로 각 행 블록의 FID를 알므로 종류별 분기가 없다.
- **쓰기·복구**: 종목마다 파일 핸들을 열어 두지 않고 묶음을 쓸 때만 연다. 프로세스가 처음 만지는 파일만 블록을 훑어 잘린 꼬리를 잘라 내고, 쓰다 실패하면 쓰기 전 길이로 되돌린다. 세션은 `offer`·`link`를 `try_send`로만 넘기고, 쓰기 실패 묶음은 스트림당 상한 안에서 다음 1초에 다시 쓰며 한 종목 실패가 다른 종목을 막지 않는다.
- **종류 표(`FLOW_KINDS`)**: `FlowKindSpec { type_code, fids }` 한 줄을 더하면 쓰기 코드 변경 없이 해당 타입의 흐름 파일이 생긴다. 지금 등록한 다섯 종류는 다음과 같다.
  - `0F`(거래원): FID 141~180. 매도·매수 상위 거래원 이름·코드·수량·증감.
  - `0w`(종목 프로그램매매): FID 20, 10, 202, 204, 206, 208, 210, 211, 212, 213.
  - `1h`(VI 발동·해제): FID 9001, 9068, 9069, 1221, 1223, 1224, 1225, 1236, 1237, 1238, 1239, 1489, 1490.
  - `0H`(주식 예상체결): FID 20, 10, 11, 12, 15, 13, 25.
  - `0B`(주식 체결): FID 20, 10, 15, 1313, 9081.
- **연결 기록(`links`)**: `{"t":<유닉스 ms>,"event":"start"|"live"|"down"|"alive"|"end"}` JSONL이다. worker가 시작하면 `start`, 끝나면 `end`, 세션이 `live`·`down`으로 바뀔 때 각각 기록하고 30초마다 `alive`를 남긴다.
- **지우기**: `finalize`가 `complete.json`을 쓴 뒤 `remove_finished_days`를 불러 정리 완료 표시(`store/<YYYYMMDD>/complete.json`)가 있는 가장 새 날보다 앞선 정리 완료 날의 `symbol-flow/<YYYYMMDD>` 폴더를 지운다. 정리 완료 표시가 없는 날은 지우지 않는다. 기본 공용 자료 폴더는 `<데이터 폴더>/shared`이며, 감독 데몬이 다른 `--shared` 경로를 쓰면 `finalize`에 `--shared`로 넘긴다. 지우기 오류는 로그만 남기고 정리를 실패시키지 않는다.
