# 분 호가 조회 API

차트 보조지표(총잔량, 호가 잔량 히트맵)가 공용 자료 **분 호가**([ADR 0050](adr/0050-quote-minutes-are-shared-data-made-by-the-collector.md))를 차트 **봉 주기** 단위로 묶어 받는 경로다. **운영자 리스너**와 **공개 리스너** 둘 다 제공하며, 키움 REST를 부르지 않는다.

## 요청

- `GET /api/symbols/{code}/quote-totals?period=1m&venue=combined&from=2026-11-23&to=2026-11-24[&after=1795481880]`
- `GET /api/symbols/{code}/quote-depth?period=3m&venue=combined&source=priceMax&from=2026-11-23&to=2026-11-24[&after=1795481880]`

| 인수 | 뜻 |
|---|---|
| `code` | 주식·ETF 종목 코드(`005930`). 지수와 종목 코드가 아닌 문자열은 `400 bad_request`다. |
| `period` | 분봉 주기(`1m`, `3m`, `5m`, `10m`, `15m`, `30m`, `60m`). 필수다. 일봉 이상(`D`~`Y`)은 `400 bad_request`다. |
| `venue` | `combined`(기본), `krx`, `nxt`. `nxt` 요청에서 종목 목록에 이미 있고 NXT 대상이 아니면 `combined`로 돌려준다. 목록이 아직 없으면 기다리지 않고 요청 거래소 그대로 쓴다. |
| `from`, `to` | 한국 날짜(`YYYY-MM-DD`, 양 끝 포함). 필수다. `from > to`이거나 31일을 넘으면 `400 bad_request`다. |
| `after` | Unix 초(선택). `t >= after`인 점만 돌려준다. 장중 5초마다 꼬리만 다시 받을 때 쓴다. |
| `source` | `quote-depth` 전용. `priceMax`(기본), `peak`, `close` 가운데 하나다. |

## 응답

### 총잔량 (`QuoteTotalsPage`)

`web/src/api/generated/QuoteTotalsPage.ts`.

| 칸 | 뜻 |
|---|---|
| `available` | 서버에 분 호가 자료 폴더(`VALLY_SHARED_DATA_DIR` 또는 `VALLY_HOGA_DATA_DIR`)가 설정되었는지 여부. `false`면 기능이 꺼져 있다 |
| `venue` | 실제로 적용된 거래소(`combined`, `krx`, `nxt`) |
| `days` | 요청 범위 날짜마다 `{date, state}`. `state`는 `closed`(닫힌 날 파일 있음), `live`(장중 파일 있음), `notCollected`(그날 폴더는 있으나 요청 종목 없음), `none`(그날 폴더 없음 또는 공용 자료 꺼짐) |
| `points` | 값이 있는 봉마다 `{t, ask, bid}`. `t`는 봉 시작 시각(Unix 초), `ask`·`bid`는 그 봉의 매도·매수 총잔량 |

### 호가 사다리 (`QuoteDepthPage`)

`web/src/api/generated/QuoteDepthPage.ts`.

| 칸 | 뜻 |
|---|---|
| `available` | `QuoteTotalsPage`와 같다 |
| `venue` | 실제로 적용된 거래소 |
| `source` | 적용된 기준(`priceMax`, `peak`, `close`) |
| `days` | `QuoteTotalsPage`와 같다 |
| `points` | 값이 있는 봉마다 `{t, asks, bids}`. `asks`는 `[가격, 잔량]` 오름차순, `bids`는 `[가격, 잔량]` 내림차순 |

## 봉 묶기와 공백 규칙

- 각 날짜는 그날 첫 분이 속한 봉부터 시작한다. 닫힌 날은 20:00 전까지, 장중은 현재 시각이 속한 봉까지 낸다. 날짜를 넘겨 직전 값을 잇지 않는다.
- 봉 안에 분이 있으면 마지막 분이 봉의 유효성을 정한다. 마지막 분이 **단일가 호가**(`singlePrice: true`)이거나 그 거래소 `close`가 비어 있으면 세 기준 모두 점을 내지 않는다.
- `quote-depth`의 `priceMax`는 봉 안 분들의 가격별 최댓값을 합치고, `peak`는 총잔량이 가장 큰 분의 사다리(같으면 이른 분), `close`는 마지막 분의 사다리를 쓴다.
- 봉 안에 분이 없으면 같은 날 직전 분의 `close`를 잇는다(`quote-depth`도 세 기준 모두 그 `close`). 직전 분이 점이 없는 분이거나 `gaps`의 시작 초가 `[직전 분의 closeSec, 이 봉의 끝 초)` 안에 있으면 잇지 않는다.

## 읽기와 캐시

- 공용 자료 폴더(`VALLY_SHARED_DATA_DIR`)가 있으면 그 폴더에서, 없으면 `<VALLY_HOGA_DATA_DIR>/shared`에서 `quote_days`와 `read_quote_day`를 블로킹 스레드 풀(`spawn_blocking`)로 읽는다. 여러 날이 캐시에 없으면 나란히 읽고, 봉 묶기도 블로킹 스레드에서 수행한다.
- 닫힌 날은 `(날짜, 종목)` 단위로 최대 64개까지 LRU 캐시에 두고 다시 압축을 풀지 않는다.
- 장중 날과 날짜 폴더 목록(`quote_days`)은 서버 시계 기준 2초 동안 캐시한다.
- 파일 읽기 오류는 캐시하지 않고 `500 internal`로 답한다.

## 시험

- 경로·규칙: `python3 scripts/dev.py cargo test -p server --test quote_routes`
- 공개 리스너: `python3 scripts/dev.py cargo test -p server --test public_shared`
- TypeScript 계약: `python3 scripts/dev.py cargo test -p server --test contract`
