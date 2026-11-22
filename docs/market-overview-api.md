# 시장 종합 서버 경로 `GET /api/market-overview/*`

시장 종합 페이지(`/market`)가 읽는 서버 경로다. 키움 TR 7개(`ka20003` 전업종지수, `ka20005` 업종 분봉, `ka20006` 업종 일봉, `ka10051` 업종별 투자자 순매수, `ka90005`·`ka90010` 프로그램매매, `ka10131` 기관·외국인 연속 매매)와 서버가 쌓은 장중 표본을 한 칸씩 내준다. 인증정보를 읽거나 실제 키움을 부르지 않고 합성 transport로 시험한다(`crates/server/tests/market_overview.rs`). 장중 표본의 저장 결정은 [ADR 0034](adr/0034-intraday-market-samples-are-stored-for-the-day.md), 기준 설계는 [페이지 플랜](plans/pages-etf.md)이다.

거래대금·등락률 순위는 `POST /api/rankings`([순위 경로](kiwoom-rankings-api.md))를 쓴다. 지수 분봉(`ka20005`)과 일봉(`ka20006`)의 봉 자체는 기존 `GET /api/bars`가 지수 종목 코드(`001`, `101`)로 준다. 이 문서의 경로는 그 봉이 주지 않는 것만 낸다.

## 인자

| 인자 | 값 | 뜻 |
|---|---|---|
| `market` | `kospi`, `kosdaq` | 필수. 모든 경로가 받는다 |
| `period` | `5`, `20`, `60` | 거래일 수. 없으면 `20`. `flow`와 `turnover`만 쓰고, 다른 경로는 받아도 무시한다 |

그 밖의 값은 `400 bad_request`이고 키움을 부르지 않는다.

## 응답의 공통 모양

모든 응답에 `context`가 있다.

| 필드 | 뜻 |
|---|---|
| `market` | 요청한 시장 |
| `phase` | 응답을 만든 때의 장 상태. `closed`(주말이거나 08:00 전·20:00 뒤), `preMarket`(08:00~09:00), `regular`(09:00~15:30), `afterMarket`(15:30~20:00). 휴장일 달력이 없어 평일은 시각으로만 가른다 |
| `receivedAt` | 이 응답 뒤에 있는 키움 응답을 받은 가장 늦은 Unix 초. 키움 응답이 하나도 없으면 `null`. 누적선은 가장 늦은 표본을 받은 시각이다 |

페이지의 신선도 한 줄은 `phase`와 `receivedAt`을 쓴다.

한 칸 안의 구역은 `MarketOverviewPart`다. 구역마다 따로 성공하거나 실패하고, 구역 하나가 실패해도 HTTP 상태는 `200`이고 다른 구역은 그대로 온다.

```json
{ "status": "ok", "value": { } }
{ "status": "failed", "error": { "code": "kiwoom_unavailable", "message": "…", "reason": "not_connected", "retryAt": null, "manualActionRequired": false } }
```

`error`는 다른 경로의 오류 본문(`ApiErrorBody`)과 같다. 키움에 연결돼 있지 않으면 모든 구역이 `reason: not_connected`로 실패한다.

## 경로

| 경로 | 칸 | 키움 호출 |
|---|---|---|
| `/api/market-overview/index` | 지수·폭 | `ka20003` 1건 |
| `/api/market-overview/sectors` | 업종 지도 | `ka20003`, `ka10051` 1건씩 |
| `/api/market-overview/flow` | 누가 사고 파나: 기간 | `ka20006` 1건, 거래일마다 `ka10051`, `ka90010` 1건 |
| `/api/market-overview/flow/intraday` | 누가 사고 파나: 오늘 누적선 | 없음(장중 표본) |
| `/api/market-overview/turnover` | 거래대금 추이 | `ka20006` 1건 |
| `/api/market-overview/streaks` | 연속 매매 | `ka10131` 2건 |

화면이 기다리는 호출은 `Priority::Screen`이다. 같은 키움 요청이 동시에 오면 키움 쪽 대기열이 하나로 합친다.

### `index`

`index` 구역 하나. `level`은 지수, `changeRate`는 퍼센트(부호 있음), `tradeValueEok`은 억원이다. `breadth`는 종합지수 행의 상승·보합·하락 종목 수와 상한가·하한가 수다. `volatility`는 코스피 응답에 있는 VKOSPI(업종 코드 `603`)이고 없으면 `null`이다. 응답에 종합지수 행(`001`, `101`)이 없으면 `index`가 프로토콜 오류로 실패한다.

### `sectors`

- `sectors`: `ka20003`의 업종 행. 종합지수 행과 VKOSPI는 뺀다. `level`, `changeRate`, `tradeValueEok`.
- `flows`: `ka10051`의 모든 행. `wholeMarket`이 참인 행이 시장 종합(기준선)이다. `individualEok`, `foreignEok`, `institutionEok`은 억원이다.

두 구역을 `code`로 잇는다. 한쪽이 실패해도 다른 쪽은 온다.

### `flow`

- `investors`: 기간의 거래일마다 개인·외국인·기관 순매수(억원)를 오래된 날부터 준다. 거래일은 `ka20006`이 정하고, 날마다 `ka10051`을 `base_dt`로 불러 종합 행을 읽는다. 거래일 중 하나라도 실패하면 구역 전체가 실패한다. 오늘보다 앞선 날은 그 관측일 동안 서버 메모리에 두므로 다시 부르지 않는다. 처음 부르는 60일은 키움 호출 60건(차례로, 초당 4건 한도)이다.
- `program`: `ka90010`의 가장 최근 `period`개 거래일의 프로그램 순매수(억원). `arbitrageEok`(차익), `nonArbitrageEok`(비차익), `totalEok`(전체).

외국인은 키움이 `내국인대우외국인`을 따로 주므로 그 값은 합치지 않는다. `foreignEok`은 키움의 외국인 열이다.

### `flow/intraday`

오늘(관측일)의 누적선이다. 키움을 부르지 않고 서버가 1분마다 쌓은 표본에서 만든다. `points`는 분 시작 시각(`at`, Unix 초) 순이고, 값은 그날 처음부터의 누적이다. 분마다 `individualEok`, `foreignEok`, `institutionEok`(`ka10051`)과 `programEok`(`ka90005` 전체, 억원)가 있다. 그 분에 한 TR이 실패했으면 그 TR의 값만 `null`이다. 표본은 정규장에만 쌓이므로 표본이 없으면 `points`는 빈 배열이다. 장이 끝난 뒤에도 그날 표본은 다음 관측일 07:45까지 남는다.

### `turnover`

`days`: 기간의 거래일별 거래대금(`tradeValueEok`, 억원)을 오래된 날부터. `ka20006`의 `trde_prica`(백만원)에서 바꾼다.

### `streaks`

`buying`(순매수 연속)과 `selling`(순매도 연속) 구역, 구역마다 `foreign`과 `institution` 목록이다. 키움 순서를 그대로 두고, 그 주체의 `days`가 방향과 맞는 행만 남긴다(순매수 연속은 양수, 순매도 연속은 음수. 키움은 방향 필터로 종목을 고르지만 두 주체 값을 한 행에 함께 주므로 반대 부호가 섞인다). ETF·ETN은 뺀다. `days`는 부호가 방향이고, `netEok`은 연속 기간의 순매매 금액이다. `period`는 받지 않는다. 앱 종목 목록을 아직 받지 못했으면 두 구역이 `reason: symbol_list_loading`으로 실패한다.

## 단위와 키움 요청의 함정

같은 이름의 열이 TR마다 다르다. 서버가 TR별로 읽어 응답에서는 한 단위로 맞춘다.

| TR | 열 | 키움 단위 | 응답 |
|---|---|---|---|
| `ka20003` | `cur_prc`, `flu_rt` | 소수점 있음(`+6613.59`, `-0.67`) | 그대로 |
| `ka20003`, `ka20006`, `ka90005`, `ka90010`, `ka10131` | 금액 | 백만원 | 억원(나누기 100) |
| `ka10051` | `cur_prc`, `flu_rt` | 소수점 빠진 100배 정수 | 100으로 나눔 |
| `ka10051` | `*_netprps` | 억원 정수(`amt_qty_tp=0`) | 그대로 |

- 키움은 음수를 마이너스 둘로 줄 때가 있다(`--528475`). 첫 부호를 방향으로 읽는다.
- 시장 코드가 TR마다 다르다. 코스닥은 `ka20003`·`ka10051`이 `mrkt_tp=1`, 프로그램매매가 `P10102`, `ka10131`이 `101`이다. 모르는 `ka10131` 코드는 거절되지 않고 코스피로 답하므로 서버는 화면 인자(`kospi`·`kosdaq`)만 받고 코드로 바꾼다.
- `ka90005`·`ka90010`의 `kospi200`·`basis` 열은 TR과 시장에 따라 믿을 수 없어 읽지 않는다.
- `ka10131`은 `dt=1`로 부른다. 연속 일수는 기간 인자와 무관하다.
- `ka20006` 한 쪽은 600거래일이다. 기간 최대 60일에는 한 쪽이면 된다.

## 시세 공급원 경계와 한투 구현

이 경로의 응답은 시세 경계(`crates/server/src/market_source/overview.rs`)의 중립 타입에서 만든다. 키움 호출과 해석은 `market_overview/kiwoom_overview.rs`, 한투 호출과 해석은 `kis/overview.rs`가 맡는다. 어느 쪽이 받는지는 `MarketOverview::choose`로 정하고, 정하지 않으면 키움이다. 금액은 경계에서 억원으로 맞춘다.

| 칸 | 키움 | 한투 |
|---|---|---|
| `index` | `ka20003` | `FHPUP02100000`(변동성 지수 없음) |
| `sectors` | `ka20003`·`ka10051` | `FHPUP02140000`과 업종마다 `FHPTJ04030000`(배경 우선순위) |
| `flow` | `ka20006`·`ka10051`·`ka90010` | `FHKUP03500100`·`FHPTJ04040000`·`FHPPG04600001` |
| `flow/intraday` 표본 | `ka10051`·`ka90005` | `FHPTJ04030000`·`FHPPG04600101` |
| `turnover` | `ka20006` | `FHKUP03500100` |
| `streaks` | `ka10131` | 없음. 요청을 보내지 않고 `unsupported_by_source`로 답한다 |

한투의 시간별 프로그램매매는 차익·비차익 열이 없다. 그래서 한투가 쌓은 표본의 프로그램 줄에는 `arbitrage_million_won`·`non_arbitrage_million_won`이 없고 `total_million_won`만 있다. 키움 줄은 세 열이 그대로 있다.
