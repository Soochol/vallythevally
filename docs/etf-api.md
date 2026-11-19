# ETF 자료 서버 경로 `/api/etf/*`

ETF 페이지가 읽는 서버 경로다. 지금은 서버 실행 파일에 포함한 hoga-ops 동결 스냅샷(ETF 119개, 종목 896개, 편입 4,937건, 구성 기준일 2026-10-30)을 검증해 싣는다. 키움을 부르지 않는다. 설계는 [페이지 플랜](plans/pages-etf.md)의 결정 9와 스스로 정한 결정 5·7이다.

응답 모양은 뒤 작업이 웹을 고치지 않도록 처음부터 넓게 정했다. 종목의 이평선 칸은 서버가 일봉 저장소로 채우고, 자료 출처 칸은 스냅샷 값이고, 서버가 수집한 날짜가 있으면 그 값이다([일별 구성내역 수집](#일별-구성내역-수집)). 타입은 `crates/server/src/etf/mod.rs`의 `Etf*`이고 `web/src/api/generated/Etf*.ts`로 생성된다. 필드는 camelCase, 열거 값은 snake_case다.

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
| `source` | `snapshot`(내장 스냅샷) 또는 `collected`(수집한 자료). 수집한 날짜가 있으면 `collected`다 |
| `holdingsAsOf` | 구성 기준일 `YYYY-MM-DD` |
| `lastAttemptAt` | 마지막 수집 시도 시각(UnixSeconds). 시도한 적이 없으면 null |
| `refreshFailed` | 마지막 수집이 실패해 이전 자료(수집한 적이 없으면 스냅샷)를 보이는 중이면 true |

`EtfHolding`(상세의 `holdings[]`): `code`, `name`, `weightBps`, `ma`. 이름은 서버 종목 목록(키움)을 먼저 쓰고, 목록이 아직 없거나 종목이 없으면 스냅샷 이름이다.

`EtfMaStates`(`ma`): `ma20`, `ma60`, `ma120`. 값은 `above`(종가가 이평선 위), `equal`, `below`, 또는 null(일봉이 모자라거나 저장소에 없음)이다. 역색인 응답은 종목 하나이므로 `ma`가 `EtfStockHolders` 바로 아래에 있다.

## 일별 구성내역 수집

서버가 하루 한 번 서버 종목 목록의 ETF 전부의 구성내역(PDF)을 받아 날짜별로 저장한다. 결정과 근거는 [ADR 0035](adr/0035-etf-holdings-are-collected-from-an-external-web-endpoint.md)다. 키움을 부르지 않는다.

- **출처**: `GET {VALLY_NAVER_BASE_URL}/api/domestic/detail/{ETF 코드}/ETFComponent`. 기본 주소는 `https://stock.naver.com`이다. 오늘 구성만 주고 모든 운용사를 한 형식으로 준다. 공식 OpenAPI가 아니다. 응답 필드는 hoga-ops의 `docs/research/2026-10-30-etf-components-api/README.md`에 있다. `VALLY_NAVER_BASE_URL`은 공식 주소이거나 가짜 응답용 `http` 루프백이어야 한다.
- **시각**: 매일 12:10(KST)이다. 근거는 hoga-ops 조사다. 2026-10-30 12:06(KST)에 38개 ETF를 받았을 때 구성 기준일이 모두 그날이었다. 더 이른 시각은 확인하지 못했다. 주말과 휴장일에도 돌고, 그때 응답의 기준일은 직전 영업일이라 같은 날짜 자료를 다시 쓴다. 시각은 `crates/server/src/etf/collect.rs`의 `COLLECT_AT`이다.
- **호출**: ETF를 코드 순서로 하나씩 부른다. 한 호출이 끝난 뒤 0.5초 이상 지나서 다음을 시작한다. 한 호출의 제한 시간은 30초이고 응답은 4MiB까지 받는다. 재시도하지 않는다.
- **하루 한 번**: ETF마다 마지막 시도 시각이 오늘이면 오늘은 다시 부르지 않는다. 서버를 다시 켜도 같다. 시각이 지난 뒤 켜지면 아직 오늘 시도하지 않은 ETF만 바로 받는다. 서버 종목 목록을 아직 못 받았으면 받을 때까지 기다린다.
- **저장**: 개인 PC 상태 폴더의 `etf-pdf`(사용자 DB와 같은 폴더)이고 `VALLY_ETF_PDF_DIR`로 바꾼다. 원본은 저장소에 커밋하지 않는다.

```
etf-pdf/
  attempts.json                     ETF별 마지막 시도 시각과 실패 여부
  pdf/YYYYMMDD/<ETF 코드>.raw.json  응답 원본 그대로
  pdf/YYYYMMDD/<ETF 코드>.json      정규화한 구성
```

  날짜 폴더는 응답의 구성 기준일이다. 정규화한 구성은 `{ "schemaVersion": 1, "code", "asOf", "holdings": [ { "code", "name", "cuQuantity", "weightBps" } ] }`이다. `cuQuantity`는 CU 한 개당 수량이다.
- **정규화**: `componentItemCode`가 없거나 종목 코드 형식이 아닌 행(원화현금 등)은 싣지 않는다. 비중은 공급자가 준 소수 문자열을 부동소수점 없이 bps로 바꾸고 셋째 자리에서 반올림한다.
- **검증**: 통과한 응답만 저장한다. 통과하지 못하면 그 ETF는 저장하지 않고 이전 자료를 지우지 않는다.
  - HTTP 2xx이고 JSON 목록이며 비어 있지 않다.
  - 모든 행의 `itemCode`가 요청한 ETF 코드다.
  - 모든 행의 기준일이 같고 `YYYY-MM-DD`다. 오늘보다 뒤이거나 이미 저장한 기준일보다 앞서면 안 된다.
  - `componentCount`가 있으면 응답 행 수와 같다.
  - 종목이 하나 이상이고 중복이 없다. 비중은 0~10,000bps이고 CU 수량을 읽을 수 있다.
  - 비중 합이 1~11,000bps다(내장 자료와 같은 범위).
- **실패**: 실패한 ETF는 `WARN`을 남기고 `refreshFailed`를 true로, `lastAttemptAt`을 시도 시각으로 싣는다. 나머지 ETF는 계속 받는다. 수집이 전부 실패해도 서버의 다른 기능은 그대로다.
- **제공**: 수집한 날짜가 있는 ETF는 그 ETF의 최신 수집일 구성을 쓰고 `source`는 `collected`, `holdingsAsOf`는 그 기준일이다. 응답 모양은 같다. 종목 이름은 서버 종목 목록, 스냅샷, 수집 응답의 이름 순서로 쓴다. 수집한 날짜가 없는 ETF는 스냅샷 그대로다. 스냅샷에 없는 ETF는 수집해 저장하지만 이 경로가 싣지 않는다.

## 이평선 계산

서버가 스크리너 일봉 저장소([ADR 0010](adr/0010-screener-reads-a-disk-daily-store.md))를 읽기만 해서 계산한다. 키움을 부르지 않는다.

- 기준일은 저장소 최신 봉의 날짜이고 `EtfFundDetail.maAsOf`와 `EtfStockHolders.maAsOf`에 싣는다. 저장소에 봉이 없으면 null이다([ADR 0015](adr/0015-screener-recent-period-from-latest-bar.md)와 같은 규칙).
- 종목마다 기준일 봉의 종가를 최근 20·60·120개 봉 종가의 단순 평균과 정수로 비교한다. 개수가 모자란 창은 null이다.
- 기준일 봉이 없는 종목(저장소에 없거나 마지막 봉이 더 옛날)은 세 칸이 모두 null이다.
- 계산 결과는 저장소 쓰기 세대가 같은 동안 다시 계산하지 않고 재사용한다.
- 저장소를 읽지 못하면 `WARN`을 남기고 모든 칸과 `maAsOf`를 null로 응답한다.

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
