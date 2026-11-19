# ETF 자료 서버 경로 `/api/etf/*`

ETF 페이지가 읽는 서버 경로다. 지금은 서버 실행 파일에 포함한 hoga-ops 동결 스냅샷(ETF 119개, 종목 896개, 편입 4,937건, 구성 기준일 2026-10-30)을 검증해 싣는다. 키움을 부르지 않는다. 설계는 [페이지 플랜](plans/pages-etf.md)의 결정 9와 스스로 정한 결정 5·7이다.

응답 모양은 뒤 작업이 웹을 고치지 않도록 처음부터 넓게 정했다. 종목의 이평선 칸과 자료 출처 칸은 지금 비어 있거나 스냅샷 값이고, `etf-ma`와 `etf-pdf-collect`가 서버에서 채운다. 타입은 `crates/server/src/etf/mod.rs`의 `Etf*`이고 `web/src/api/generated/Etf*.ts`로 생성된다. 필드는 camelCase, 열거 값은 snake_case다.

## 경로

| 경로 | 응답 | 설명 |
|---|---|---|
| `GET /api/etf/funds` | `EtfFundList` | 싣는 ETF 전부. 자료 순서 그대로다 |
| `GET /api/etf/funds/{code}` | `EtfFundDetail` | ETF 하나와 구성 종목(비중 큰 순, 같으면 코드 순) |
| `GET /api/etf/stocks/{code}` | `EtfStockHolders` | 그 종목을 담은 ETF와 비중(비중 큰 순, 같으면 ETF 코드 순) |

오류는 공통 `ApiError`다.

| 상황 | 상태 | `error.code` |
|---|---|---|
| 형식이 틀린 코드(6자리 영문 대문자·숫자가 아님, 소문자 포함) | 400 | `bad_request` |
| 형식은 맞지만 싣지 않은 ETF 코드 | 404 | `not_found` |

`/api/etf/stocks/{code}`는 그 종목을 담은 ETF가 없으면 `holders`가 빈 200이다. 스냅샷은 조사한 ETF 후보 집합이라 담긴 종목이 896개뿐이고, 나머지 종목은 모두 빈 목록이다.

## 응답

`EtfFundSummary`(목록 원소, 상세의 `fund`, 역색인의 `holders[].fund`):

| 필드 | 뜻 |
|---|---|
| `code`, `name`, `issuer`, `benchmark` | ETF 코드, 이름, 운용사, 기초지수 |
| `style` | `active` 또는 `passive` |
| `holdingsCount` | 싣는 구성 종목 수 |
| `top5WeightBps` | 비중 상위 5개의 합(bps) |
| `effectiveHoldings` | 실효 종목 수. 비중 합을 1로 맞춘 뒤 1/Σw². 소수 그대로다 |
| `status` | `EtfDataStatus` |

`EtfDataStatus`(ETF마다):

| 필드 | 뜻 |
|---|---|
| `source` | `snapshot`(내장 스냅샷) 또는 `collected`(수집한 자료) |
| `holdingsAsOf` | 구성 기준일 `YYYY-MM-DD` |
| `lastAttemptAt` | 마지막 갱신 시도 시각(UnixSeconds). 시도한 적이 없으면 null |
| `refreshFailed` | 마지막 갱신이 실패해 이전 자료를 보이는 중이면 true |

`EtfHolding`(상세의 `holdings[]`): `code`, `name`, `weightBps`, `ma`. 이름은 서버 종목 목록(키움)을 먼저 쓰고, 목록이 아직 없거나 종목이 없으면 스냅샷 이름이다.

`EtfMaStates`(`ma`): `ma20`, `ma60`, `ma120`. 값은 `above`(종가가 이평선 위), `equal`, `below`, 또는 null(계산하지 않았거나 일봉이 모자람)이다. 지금은 모두 null이다. 역색인 응답은 종목 하나이므로 `ma`가 `EtfStockHolders` 바로 아래에 있다.

비중은 정수 bps(1bps = 0.01%)다. 비중 합을 100%로 다시 맞추지 않는다. 파생·기타 자산은 싣지 않으므로 합이 100% 미만일 수 있다.

## 검증

서버는 내장 자료를 읽을 때 다음을 확인한다. 실패한 ETF는 싣지 않고 `WARN`으로 ETF 코드와 이유를 남긴다. 다른 ETF는 계속 싣는다.

- ETF 코드와 종목 코드는 6자리 영문 대문자·숫자(예: `091160`, `0222D0`)다.
- ETF 코드는 중복이 없고 운용 방식은 `active`·`passive`다. 이름이 비지 않았다.
- 구성 종목이 하나 이상이다. 한 ETF 안에서 종목이 중복이면 안 되고, 종목 이름이 `stocks`에 있어야 한다.
- 종목 비중은 0~10,000bps 정수다. 0은 미세 편입으로 종목 존재를 유지한다. 음수·소수이거나 필드가 없거나 타입이 틀린 ETF도 그 ETF만 싣지 않는다.
- 비중 합은 1~11,000bps다. 내장 자료의 최댓값은 10,957bps(파생·차입이 섞인 ETF)다.

자료 전체가 읽히지 않거나(JSON 오류), 자료 버전이 1이 아니거나, 구성 기준일이 `YYYY-MM-DD`가 아니면 ETF를 하나도 싣지 않고 `WARN`을 남긴다.

## 내장 자료 만들기

자료는 `crates/server/data/etf/funds.json`이고 `include_str!`로 서버에 포함된다. hoga-ops 스냅샷에서 바꾼다.

```sh
python3 scripts/build-etf-snapshot.py /home/dev/code/hoga-ops/frontend/public/etf-explorer/snapshot.json
```

출력 경로를 둘째 인자로 줄 수 있다. 같은 입력은 같은 바이트를 낸다. 원 자료의 출처와 구성은 hoga-ops의 `docs/research/2026-10-30-etf-explorer/README.md`에 있다.

형식:

```json
{ "schemaVersion": 1, "holdingsAsOf": "2026-10-30",
  "funds": [ { "code": "091160", "name": "KODEX 반도체", "issuer": "삼성자산운용", "style": "passive", "benchmark": "KRX 반도체",
               "holdings": [ { "code": "005930", "weightBps": 1900 } ] } ],
  "stocks": { "005930": "삼성전자" } }
```

변환이 빼는 것: 공탐 점수(`score`)와 검증 상태(`status`, `issuerMatched`), 이평선 상태(`states`), 가격 기준일(`priceAsOf`), 기타 자산(`otherAssets`: 파생상품·인프라펀드 등. 음수 비중이 있다). 이평선은 `etf-ma`가 서버에서 계산한다.
