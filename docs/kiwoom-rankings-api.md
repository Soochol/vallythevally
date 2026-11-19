# 순위 조회 서버 경로 `POST /api/rankings`

순위 창이 키움 순위 TR을 한 경로로 부르는 방법이다. 서버는 키움 순위 TR 11개를 `Ranking` 13종으로 나눠 받고, 연속조회를 따라 걷고, 중복을 빼고, 서버의 종목 목록으로 거르고, 짧은 스냅숏으로 같은 키움 요청을 합친다. 인증정보를 읽거나 실제·모의 키움을 부르지 않고 합성 transport로 시험한다. 기준 설계는 [순위 창 플랜](plans/ranking-window.md)이다.

## 경로

`POST /api/rankings`. 읽기 전용이지만 순위마다 조건 모양이 달라 JSON 몸을 쓴다. 몸은 4 KiB까지 받는다.

```json
{ "ranking": { "kind": "tradeAmount", "market": "all", "venue": "combined", "excludes": { "etfEtn": true, "preferred": false }, "excludeManaged": false },
  "pages": 3,
  "trigger": "user" }
```

| 필드 | 뜻 |
|---|---|
| `ranking` | 순위 13종 중 하나와 그 조건. 창에 저장하는 `Ranking`과 같은 타입이다 |
| `pages` | 1페이지부터 몇 페이지까지 받을지. 1~30. 범위 밖이거나 정수가 아니면 `400 bad_request`다 |
| `trigger` | `user`는 창을 열거나 조건을 바꾸거나 더 보기를 누른 요청, `refresh`는 주기 갱신이다 |

응답은 `RankingPage`다.

```json
{ "rows": [ { "rank": 1, "code": "005930", "name": "삼성전자", "listed": true, "price": 71200, "changeRate": -3.21,
              "figures": { "kind": "tradeAmount", "tradeAmount": 88000000000, "volume": 1234567, "placesGained": 2 } } ],
  "pages": 3, "end": false, "limited": false, "hidden": 4, "fetchedAt": 1794222949 }
```

| 필드 | 뜻 |
|---|---|
| `rows[].rank` | 중복을 빼고 거른 뒤 남은 줄의 차례. 1부터 빈틈없이 이어진다 |
| `rows[].name` | 키움이 준 종목 이름 |
| `rows[].listed` | 앱 종목 목록에 있는 종목인가. 없는 종목(ELW 등)도 자리에 남는다 |
| `rows[].price`, `changeRate` | 원, 퍼센트. TR이 주지 않는 열은 `null`이다 |
| `rows[].figures` | 순위마다 다른 열. 금액은 원, 수량·잔량은 주로 바꿔 내보낸다 |
| `pages` | `rows`가 나온 키움 페이지 수. 요청한 수보다 적을 수 있다(목록이 먼저 끝났다) |
| `end` | `rows`가 키움 목록의 마지막 페이지까지 덮는다 |
| `limited` | 30페이지에 닿았는데 키움이 다음 페이지가 있다고 한다. 이때 `end`는 거짓이다 |
| `hidden` | ETF·ETN 빼기와 우선주 빼기 칩으로 뺀 줄 수. 중복과 목록에 없는 종목은 세지 않는다 |
| `fetchedAt` | 스냅숏을 받은 Unix 초 |

스냅숏이 `pages`보다 많은 페이지를 갖고 있어도 앞쪽 `pages`만 돌려준다. 이때 `end`는 거짓이다.

## 순위별 키움 TR과 고정 값

요청 필드와 코드값은 [키움 공식 명세](https://openapi.kiwoom.com/m/guide/apiguide/01/ka10032)를 따른다. "고정"은 창에서 고르지 않고 서버가 언제나 보내는 값이다. 경로는 ka90003·ka00198이 `/api/dostk/stkinfo`, 나머지는 `/api/dostk/rkinfo`다.

| `ranking.kind` | TR | 창에서 고르는 값 | 고정 |
|---|---|---|---|
| `tradeAmount` | ka10032 | 시장, 거래소, 관리종목 빼기(`mang_stk_incls` 0=미포함, 1=포함) | — |
| `tradeVolume`, `turnover` | ka10030 | 시장, 거래소, 장 구분(거래량만), 관리종목 빼기(`mang_stk_incls` 0=포함, 1=미포함). `sort_tp` 1=거래량, 2=회전율 | `crd_tp`·`trde_qty_tp`·`pric_tp`·`trde_prica_tp` 0 |
| `volumeSurge` | ka10023 | 시장, 거래소, 견주는 때, 정렬, 관리종목 빼기(`stk_cnd`) | `trde_qty_tp` 5, `pric_tp` 0 |
| `gainers`, `losers` | ka10027 | 시장, 거래소, 상·하한가 포함, 거래대금 하한, 관리종목 빼기(`stk_cnd`). `sort_tp` 1=상승률, 3=하락률 | `trde_qty_cnd` 0000, `crd_cnd`·`pric_cnd` 0 |
| `expected` | ka10029 | 시장, 거래소, 정렬, 관리종목 빼기 | `trde_qty_cnd`·`crd_cnd`·`pric_cnd` 0 |
| `investorNetBuy` | ka10065 | 시장, 투자자 11종, 방향, 단위 | 거래소 없음 |
| `foreignStreak` | ka10035 | 시장, 거래소, 방향 | `base_dt_tp` 0 |
| `program` | ka90003 | 시장(코스피 `P00101`·코스닥 `P10102`), 거래소, 방향 | `amt_qty_tp` 1 |
| `bidAskBalance` | ka10020 | 시장(코스피·코스닥), 거래소, 정렬, 관리종목 빼기 | `trde_qty_tp` 0000, `crd_cnd` 0 |
| `creditRatio` | ka10033 | 시장, 거래소, 관리종목 빼기 | `trde_qty_tp` 0, `updown_incls` 1, `crd_cnd` 0 |
| `mostViewed` | ka00198 | 구간 | 시장·거래소 없음 |

요청 몸의 모양은 `crates/server/src/kiwoom/api.rs`의 생성자가 정한다. 서버는 `Ranking`을 그 생성자로 바꾸기만 한다.

### 열

| `figures.kind` | 순위 | 값 |
|---|---|---|
| `tradeAmount` | 거래대금 | `tradeAmount`(원), `volume`, `placesGained`(키움 이전 순위 − 지금 순위. 위로 오르면 양수) |
| `tradeVolume` | 거래량 | `volume`, `previousDayVolumeRate` |
| `turnover` | 회전율 | `turnoverRate`, `volume` |
| `volumeSurge` | 거래량 급증 | `surgeRate`, `surgeVolume`, `volume` |
| `movers` | 상승률, 하락률 | `priceChange`(원), `volume` |
| `expected` | 예상체결 | `expectedPrice`, `expectedChangeRate`, `expectedVolume`. `price`·`changeRate`는 `null` |
| `netAmounts` | 투자자별 순매수(금액), 프로그램 | `net`, `buy`, `sell`(원) |
| `netQuantities` | 투자자별 순매수(수량) | `net`, `buy`, `sell`(주) |
| `foreignStreak` | 외국인 연속 | `netD1`·`netD2`·`netD3`·`netTotal`(주), `limitExhaustionRate`. `changeRate`는 `null` |
| `bidAskBalance` | 호가잔량 | `totalSellRemaining`, `totalBuyRemaining`, `netBuyRemaining`, `buyRatio`. `changeRate`는 `null` |
| `creditRatio` | 신용비율 | `creditRatio`, `volume` |
| `mostViewed` | 많이 본 종목 | `referencePrice`, `changeFromReferenceRate`, `placesGained`. `price`·`changeRate`는 `null` |

## 걷기와 연속조회

서버는 1페이지부터 `pages`만큼 `KiwoomRest::call`로 받는다. 다음 페이지는 앞 응답의 `next-key`로 받는다.

- `cont-yn: N`이면 `end`다. 거기서 더 받지 않는다.
- 30페이지에 닿았는데 다음 키가 있으면 `limited`다. 31번째 호출은 없다.
- 같은 `next-key`가 되풀이되면 오류다. `cont-yn: Y`인데 `next-key`가 없어도 오류다. 둘 다 끝으로 가장하지 않는다. 화면이 "마지막 순위입니다"를 보이기 때문이다. 응답은 `503 kiwoom_unavailable`, 사유 `protocol`이다. `intraday_feed.rs`의 체결·프로그램매매 걷기는 되풀이 키에서 경고만 하고 멈추지만 순위는 오류로 돌린다.
- 걷다가 한 페이지라도 실패하면 오류를 돌리고 부분 결과를 캐시에 넣지 않는다. 그 걷기를 기다리던 요청은 모두 같은 오류를 받는다. 오류가 알려진 뒤 온 요청은 1페이지부터 다시 받는다.
- 키움 페이지에 행이 하나 이상 있는데 읽힌 행이 하나도 남지 않으면 오류다. 해석에 실패한 행과 값이 너무 커서 뺀 행이 읽히지 않은 행이다. 응답은 `503 kiwoom_unavailable`, 사유 `protocol`이고 부분 결과를 캐시에 넣지 않는다. 행이 0개인 페이지는 빈 결과다. 일부 행만 읽히지 않은 페이지는 읽힌 행만 쓰고 경고를 남긴다.
- 투자자별 순매수(ka10065)는 연속조회가 없어 첫 페이지에서 끝난다.

## 중복과 거르기

캐시 뒤에서 요청마다 한다. 순서는 다음과 같다.

1. 종목코드로 중복을 뺀다. 먼저 나온 줄을 남긴다. 중복은 `hidden`에 세지 않는다.
2. 요청이 고른 칩을 앱 종목 목록(`SymbolDirectory`)의 종류로 적용한다. ETF·ETN 빼기는 ETF 종류와 ETN 종류를 함께 빼고 인프라투자금융·뮤추얼펀드·리츠는 남긴다. 우선주 빼기는 우선주만 뺀다. 뺀 줄 수가 `hidden`이다.
3. 남은 줄에 1부터 `rank`를 붙인다.

앱 종목 목록에 없는 종목은 종류를 모르므로 칩에 걸리지 않고 `listed: false`로 남는다. 관리종목 빼기는 서버 종목 목록에 상태가 없어 키움 조건으로 보낸다. ETF·ETN 빼기와 우선주 빼기는 키움에 보내지 않는다. 그래서 빼기만 다른 요청은 같은 키움 요청이고 스냅숏을 함께 쓴다.

## 스냅숏 캐시

캐시 키는 키움 요청(TR과 요청 몸)이다. 값은 페이지별 원본 행, 마지막 `next-key`, 끝인지, 받은 시각이다. 서버 메모리에만 두고 디스크에 쓰지 않는다([ADR 0003](adr/0003-market-data-is-a-cache.md)).

| 상황 | 동작 |
|---|---|
| 스냅숏이 8초보다 새것이고 요청 `pages`만큼 있거나 끝이다 | 키움을 부르지 않는다 |
| 새것인데 페이지가 모자라고 끝이 아니다 | 남긴 `next-key`로 모자란 페이지만 이어 받아 붙인다. 키움이 키를 거절하면(요청 오류나 알 수 없는 오류) 1페이지부터 다시 받는다 |
| 낡았거나 없다 | 1페이지부터 `pages`만큼 받고, 성공하면 통째로 바꾼다. 이어 받은 스냅숏의 받은 시각은 처음 받은 때 그대로다 |
| 60초 동안 아무도 읽지 않았다 | 버린다. 다음 순위 요청이 올 때 치운다 |

받은 시각은 걷기가 끝난 때다. 시각의 단위는 초라서 새것의 경계는 정확히 8초 전이다(7초는 새것, 8초는 낡았다).

같은 키의 걷기는 한 번에 하나다. 걷기는 요청과 따로 도는 작업이다. 그 사이 들어온 같은 키 요청은 그 걷기를 기다려 결과를 같이 쓰고, 실패하면 같은 오류를 같이 받는다. 더 깊은 `pages`를 원하는 요청은 그 걷기가 끝난 뒤 이어 받는다. 걷기를 시작한 요청이 끊겨도 걷기는 끝까지 가고 기다리던 요청이 그 결과를 받는다. 기다리는 요청이 없어도 끝까지 가며, 끝까지 간 결과만 스냅숏이 된다.

## 우선순위

`trigger: "user"`는 `Priority::Screen`, `"refresh"`는 `Priority::Background`로 REST 대기열에 선다. 깊이 펼친 창의 주기 갱신이 차트 봉 페이지와 주문을 밀어내지 않게 하기 위해서다.

같은 키에 둘이 겹치면 걷기를 기다리는 요청 가운데 가장 높은 우선순위로 받는다. 대기열에서 기다리는 페이지 호출은 더 높은 우선순위의 요청이 들어오면 그 순위로 올라가고, 걷기의 다음 페이지 호출도 그 순위로 나간다. 이미 키움으로 나간 호출은 바꿀 수 없다.

## 투자자별 순매수의 현재가·등락률

ka10065는 매도·매수·순매수만 준다. 서버는 그 줄의 종목을 ka10095(지정종목 정보, KRX 시세) 한 번으로 채운다. 한 번에 100종목까지다. 현재가는 원, 등락률은 `(현재가 − 기준가) / 기준가`다. ka10095 결과는 같은 스냅숏에 담겨 8초 동안 다시 부르지 않는다.

ka10095가 실패하거나 어떤 종목의 행을 주지 않거나 그 종목의 현재가가 0이면 그 종목의 `price`와 `changeRate`는 `null`이고 순위는 그대로 나온다. 기준가가 0인 행도 같다.

## 오류

| 상황 | 응답 |
|---|---|
| `pages`가 1~30이 아니거나 몸이 읽히지 않는다 | `400 bad_request` |
| 몸이 4 KiB를 넘는다 | `413 payload_too_large` |
| 키움이 연결되지 않았다 | `503 kiwoom_unavailable`, 사유 `not_connected`. 다른 키움 조회와 같다 |
| 키움 실패 | 다른 키움 조회와 같은 코드와 사유 |
| 되풀이되는 `next-key`, 키 없는 `cont-yn: Y`, 행이 있는데 하나도 읽히지 않은 페이지 | `503 kiwoom_unavailable`, 사유 `protocol` |
| 앱 종목 목록을 아직 받지 못했다 | 다른 조회와 같은 종목 목록 실패 |

키움 호출은 [REST 대기열](../crates/server/src/kiwoom/rest.rs)을 지나므로 초당 호출 한도, 같은 요청 합치기, 관문 규칙을 그대로 따른다.
