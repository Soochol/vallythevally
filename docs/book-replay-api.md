# 호가 복기 서버 경로 `/api/book-replay/*` · `/api/symbols/{code}/book-replay*`

차트에서 가리킨 봉의 마지막 순간 호가와 체결을 10호가창·호가주문창에 보여 주는 호가 복기 경로다([ADR 0050](adr/0050-chart-book-replay-reads-the-collected-store.md)). 수집 저장소(`VALLY_HOGA_DATA_DIR`)를 읽기만 하며 키움을 부르지 않는다. 늘 통합 호가(`_AL`)를 반환하므로 거래소 인수는 없다. 운영자 리스너에만 붙고 공개 리스너에는 없다.

타입은 `crates/server/src/api.rs`의 `BookReplay*`이고 `web/src/api/generated/BookReplay*.ts`로 생성된다. 필드는 camelCase, 열거 값은 snake_case다.

## 경로

| 경로 | 응답 | 설명 |
|---|---|---|
| `GET /api/book-replay/access` | `BookReplayAccess` | 서버에 `VALLY_HOGA_DATA_DIR`이 설정돼 있는지(`{"available": true\|false}`) |
| `GET /api/symbols/{code}/book-replay/days` | `BookReplayDays` | 그 종목을 수집한(`registered && received`) 날을 오름차순으로 반환. 최근 60개 날짜 폴더까지만 본다 |
| `GET /api/symbols/{code}/book-replay?date=YYYYMMDD` | `BookReplayDay` | 정리된 날의 1분 끝 호가, 분별 마지막 10건 체결, 수집 구간 |

오류는 공통 `ApiError`다.

| 상황 | 상태 | `error.code` |
|---|---|---|
| `VALLY_HOGA_DATA_DIR`이 설정되지 않음(`days`, `book-replay`) | 404 | `not_found` |
| 종목코드 형식 오류 또는 지수 코드(`IDX:*`) | 400 | `bad_request` |
| `date` 쿼리가 없거나 `YYYYMMDD` 형식이 아님 | 400 | `bad_request` |
| 저장소 파일을 읽거나 해석하지 못함 | 500 | `internal` |

## 응답

`BookReplayAccess`:

- `available`: `boolean`

`BookReplayDays`:

- `symbol`: 종목코드 문자열(예: `"005930"`)
- `days`: `YYYYMMDD` 문자열 배열, 오름차순

`BookReplayDay`:

| 필드 | 형 | 뜻 |
|---|---|---|
| `symbol` | `string` | 종목코드 |
| `date` | `string` | 요청 날짜 `YYYYMMDD` |
| `coverage` | `"collected" \| "symbol_not_collected" \| "day_not_collected"` | 수집 여부. `complete.json`이 없거나 형식 버전이 1이 아니면 `day_not_collected`, 그날 해당 종목이 `registered && received`가 아니면 `symbol_not_collected` |
| `covered` | `[number, number][]` | 그 분이 끝난 순간(`m+1`분 0초)에 수집 중이었던 분의 닫힌 구간 `[from, to]` 목록. 첫 호가 행의 분부터 해당 키(인계 시 `handoff.to`)의 마지막 5분 원문 파일 `HHMM+5`분 전까지(원문 목록이 없으면 `20:05` 전까지) 중 끊김 구간 `[from_ms, to_ms)`에 끝 순간이 걸린 분을 뺀다. 호가 행이 없으면 빈 배열 |
| `books` | `BookReplayBook[]` | 호가 행이 있는 분만, 분 오름차순. 같은 `recv_ms`에서는 Parquet 파일 뒤 행을 고른다 |
| `trades` | `[number, number, number, number][]` | `[minute, timeSec, price, quantity]`. 분마다 마지막 10건까지 받은 순서대로. `timeSec`는 FID 20(`HHmmss`)의 자정 기준 초, `price`는 절댓값, `quantity`는 부호 그대로(+ 매수, - 매도). 수량이 0인 행은 뺀다 |

`BookReplayBook`:

| 필드 | 형 | 뜻 |
|---|---|---|
| `minute` | `number` | `recv_ms`의 KST 자정 기준 분(`0..1439`) |
| `asks` | `[number, number][]` | 매도 1호가부터 `[가격, 잔량]`. 가격은 절댓값이며 가격이 없거나 0인 단은 뺀다 |
| `bids` | `[number, number][]` | 매수 1호가부터 `[가격, 잔량]`. 가격은 절댓값이며 가격이 없거나 0인 단은 뺀다 |
| `totalAsk` | `number` | 매도호가총잔량(FID 121) |
| `totalBid` | `number` | 매수호가총잔량(FID 125) |

## 읽기 경계와 캐시

- `store/<YYYYMMDD>/complete.json`은 날짜마다 한 번 해석해 파일 크기·수정 시각이 같으면 다시 읽지 않고, `registered && received` 종목의 끊김·끝 시각만 유지한다.
- 종목 요청 하나는 해당 종목 버킷의 `0D/<bucket>.parquet`과 `0B/<bucket>.parquet`만 DuckDB 메모리 연결(`enable_autoload_extension = false`)로 읽는다.
- 정리된 날 응답은 최근 16개를 메모리에 캐시하고, 동시 DuckDB 조회는 세마포어 2로 제한한다.

## 오늘 자료 (`complete.json`이 없는 날)

`store/<YYYYMMDD>/complete.json`이 아직 없는 날은 `<VALLY_HOGA_DATA_DIR>/shared`의 당일 파일을 합쳐 같은 모양의 `BookReplayDay`를 응답한다. `complete.json`이 생기면 저장소만 읽는다.

- 호가: `shared_data::read_quote_day`로 `quote-minutes-live/<YYYYMMDD>`(또는 `quote-minutes/<YYYYMMDD>`)에서 통합 종가 호가(`combined.close`)만 취한다. 빈 사다리 분은 빼고 `totalAsk`·`totalBid`는 단 잔량 합이다. 두 폴더가 모두 없으면 `day_not_collected`, 폴더는 있는데 그 종목이 없으면 `symbol_not_collected`다.
- 수집 구간(`covered`): `quote-minutes-live/<YYYYMMDD>` 아래 `<종목>.jsonl`이 있는 키만 대상으로 삼고, 그 키에서 종목이 처음 나온 분(파일 첫 줄의 `minute`)부터 인정한다. 각 키의 `symbol-flow/<YYYYMMDD>/links/<키>.jsonl`을 읽어 `live`~`down`/`end`(`alive`로 연장, `start`가 오면 앞 구간은 마지막 연장 시각에서 끝) 구간을 만들고, 분 끝(`m+1`분 0초)이 구간 안이고 구간이 끝 + 15초 이상까지 이어진 분을 수집 확인 분으로 센다. 첫 호가 분부터 키별 확인 분의 합집합을 `covered`로 준다.
- 체결(`trades`)과 자르기: 위 키들의 `trade-minute/<YYYYMMDD>/<키>/<종목>.jsonl`을 분 순서로 합쳐 같은 분은 이어 붙여 마지막 10건만 쓴다. `books`와 `trades`는 `covered`의 마지막 분까지만 준다. 깨지거나 줄바꿈 없이 끝난 `links`·체결 줄과 모르는 머리의 체결 파일은 경고하고 건너뛴다.
- 날짜 목록(`days`): `complete.json`이 없는 날 가운데 `quote-minutes-live/<YYYYMMDD>/*/<종목>.jsonl`이 있는 날을 함께 돌려준다.
- 캐시와 허가: 오늘 자료는 캐시하지 않으며 기존 동시 조회 세마포어(2)를 함께 쓴다. 상주 폴링 작업은 두지 않고 요청한 종목 파일과 그 키의 `links`만 읽는다.
