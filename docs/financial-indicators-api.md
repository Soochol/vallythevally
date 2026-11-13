# 보고기간별 재무지표 API

`GET /api/symbols/{code}/financials?period=Q` 또는 `period=Y`는 SQLite의 저장 자료만 계산한다. 회사 연결 확인·원천 호출·수집을 시작하지 않으며 업데이트 전 상태는 `not_collected`다. 같은 URL의 `POST`는 `POST /api/financial-update`와 같은 전체 최근 자료 업데이트를 시작한다. 전체 진행은 `GET /api/financial-update`, 종목의 계산 결과는 기존 `GET`으로 읽는다. 거래소 인자는 없으며 알 수 없는 쿼리나 Q/Y 이외 주기는 400이다. 기존 `financial-source` 원자료 API와 수집기를 공유한다.

응답 타입은 `api.rs`에서 `FinancialsPage`와 관련 웹 타입으로 생성한다. 여섯 `series`의 `metric`은 `revenue`, `operating_income`, `owner_roe`, `investing_cash_flow`, `dps`, `debt_ratio`다. 금액은 원천 통화의 자연 단위, DPS는 원, 두 비율은 %다. 그림에 쓸 숫자는 `value`이며 없으면 `null`이다. 원금액 문자열은 `inputs[].amount`와 `fields`에 보존한다. 차트 숫자는 유한한 f64이며 원금액의 정밀도를 대신하지 않는다.

## 상태와 갱신

최상위 `status`는 원자료 수집 상태(`not_configured`, `unsupported`, `collecting`, `ready`, `stale`, `partial_failure`, `failed`)를 그대로 따른다. `reason`은 상품 미지원 또는 회사 매핑 미확인 사유다. ETF·업종지수 등 미지원 상품은 DART를 호출하지 않는다. 현재 종목 목록에서 제외되는 ETN은 기존 API와 같이 없는 종목으로 응답한다. 우선주 회사 연결과 주식 종류는 기존 `Security` 계약을 소비하며 추측하지 않는다.

`lastCheckedAt`은 공시 목록을 끝까지 확인한 시각이다. `lastAttemptAt`, `disclosureFailure`, `failure`, `refreshVersion`, `disclosureVersion`은 수집 계약의 동명 필드를 보존한다. `progress`는 현재 저장된 요청들에 대한 `total`, `completed`, `failed`, `pending` 개수다. 정정 중에는 갱신 중 자료의 진행을 세고 차트 값은 마지막 일관된 표시 자료를 사용한다. 사업보고서는 재무제표와 배당을 각각 한 요청으로 센다. 아직 저장하지 않은 미래 요청을 전체 개수에 넣지 않으므로 최초 수집 중 total은 늘어날 수 있다. 재사용한 보고서는 최신 목록에서 검증되면 실제 수집 시각을 바꾸지 않고 완료로 센다. 전체 수집 완료 여부는 최상위 status로 판단한다.

저장 자료가 있는 갱신 실패는 `value`를 유지하고 `inputs[].failure`, `checkedAt`, `lastSuccessAt`과 최상위 상태를 함께 제공한다. 자료가 전혀 없는 실패는 point의 `failed`다. 함께 검증된 공시 목록 세대가 다른 입력으로 차감·ROE를 만들지 않으며 이때 `refresh_incomplete`를 반환한다. 각 입력의 `refreshVersion`은 실제 수집 성공 세대로 보존하므로, 변경 없는 비교기간을 재사용한 정상 계산에서도 입력끼리 다를 수 있다. 정정 중에는 마지막 일관된 표시 자료를 유지하고 갱신 중 자료가 준비되면 확정한다. 수집·재시도·저장 세대 규칙은 [원자료 계약](dart-financial-source.md)을 따른다.

## 점과 공백

각 point는 `businessYear`, `reportCode`, 실제 `period`, `priceBucket`, `basis`, `currency`와 계산 입력을 제공한다. Q에는 네 보고서 구분, Y에는 사업보고서만 포함한다. 각 보고기간은 개별 점이며 빈칸을 0으로 채우거나 잇지 않는다. 아직 실제 기간이 확인되지 않은 요청에는 `priceBucket`이 없을 수 있다.

| status | 의미 |
|---|---|
| available | 계산하고 표시할 수 있음 |
| unpublished | 원자료 API가 보고서 자료 부재를 확인함 |
| missing_item | 보고서에 필요한 표준 계정 또는 확인된 배당 종류가 없음 |
| not_calculable | 실제 기간·기준·통화·분모·비교자료 등 계산 조건을 만족하지 않음 |
| failed | 저장 자료 없이 원천 조회가 실패함 |
| pending | 해당 요청이 아직 완료되지 않음 |
| unsupported | 분기 DPS처럼 해당 주기로 제공하지 않음 |

`reason`은 생성된 `FinancialReason`의 닫힌 목록이다. `period_unverified`일 때 원천 검증의 구체적인 이유는 `inputs[].verificationReason`에 있다. 계정명 유사도로 비표준 계정을 매핑하지 않는다. 인식하는 계정은 `ifrs-full`/과거 `ifrs`의 Revenue, ProfitLossAttributableToOwnersOfParent, CashFlowsFromUsedInInvestingActivities, Liabilities, Equity, EquityAttributableToOwnersOfParent이며 영업이익은 dart_OperatingIncomeLoss 또는 IFRS ProfitLossFromOperatingActivities다. IS/CIS에 같은 사실이 반복된 경우에만 허용하고 서로 다른 값·기간·통화가 있으면 ambiguous_account다. 일반 당기순이익이나 자본총계를 지배주주 계정으로 대체하지 않는다.

원자료의 `current_period`/`cumulative_period`가 verified이고 접수번호가 일치하는 금액만 사용한다. 분기 손익은 확인된 3개월 당기금액을 사용한다. 누적 CF 및 Q4는 같은 사업연도·기준·통화와 함께 검증된 공시 목록 세대, 같은 시작일의 누적기간을 차감하며 3/6/9/12개월과 차감 후 실제 3개월을 확인한다. 서로 떨어진 네 보고서를 ROE의 4분기로 취급하지 않는다. Q ROE는 이어지는 네 실제 3개월 이익과 정확한 12개월 기간, 그 기간 직전일과 기말의 지배주주 지분을 요구한다. Y ROE는 해당 실제 12개월 이익을 사용한다.

`priceBucket`은 실제 종료일이 속한 달력 분기/연도의 첫날 KST 00:00의 Unix 초다. 결산월은 최상위 `fiscalMonth`, 실제 기간은 각 point와 입력에 제공한다. `inputs`는 계정 ID·원래 필드·금액·통화·접수번호·공시일·XBRL context·원본 파일명·성공 시각을 담는다. `latestCorrections=true`는 당시 공개값이 아닌 정정된 최신 공시 기준임을 뜻한다.

짧은 기간은 임의로 연장하지 않는다. 같은 가격봉에 보고기간이 겹치면 `period_overlap`과 `value=null`로 표시하며, 각각 계산한 값이 있으면 `reportedValue`와 원래 입력을 보존해 툴팁에서 확인할 수 있다. `reportedValue`를 차트에 합산하지 않는다. 자본총계가 0 이하인 부채비율은 비우지만 부채·자본 원금액을 모두 반환한다. DPS는 확인된 주식 종류와 실제 연간 결산일이 맞는 현금배당금만 사용하며, 분기는 `annual_only`다.

시험은 `financial_calculations.rs`의 합성 저장 자료 및 `financials.rs`의 가짜 DART/XBRL과 주입한 합성 키움 transport을 사용한다. 실제 인증 API나 사용자 서버를 사용하지 않는다.

## 계산 입력의 상태와 사용 목적

`inputs`의 각 항목에는 `businessYear`, `reportCode`, `usage`, `status`, `reason`이 있다. `usage`는 원금액 `value`, 차감에 필요한 비교자료 `comparison`, DPS 결산기간 판정에 사용한 `reporting_period`다. `role`은 원금액 필드명(`thstrm_amount`, `thstrm_add_amount`, `thstrm`)을 유지하며, 값이 없는 요청 요약은 `statement`다. 입력 상태는 point의 표시 상태와 별도로 읽는다.

| 입력 status | 의미 |
|---|---|
| available | 저장 자료가 있음. 실패가 함께 있으면 마지막 성공 자료이며, 개별 검증 한계는 verificationReason으로 확인 |
| missing_report | 필요한 사업연도·보고서 구분의 요청 엔트리 자체가 없음 |
| unpublished | 비교 요청이 원자료 부재를 확인함 |
| missing_item | 비교 보고서는 있으나 필요한 계정이 없음 |
| not_calculable | 비교 계정의 기간·접수번호 등이 검증되지 않음 |
| failed | 필요한 비교 자료가 원천 실패로 사용 불가 |
| pending | 필요한 비교 요청이 아직 완료되지 않음 |

현재 연간 보고서는 공시됐지만 Q3가 없거나 미공시·항목 없음·실패·대기이면, Q4 point는 `not_calculable / missing_comparison`이다. 현재 보고서 자체의 `unpublished`, `failed`, `pending`과 구분한다. 비교 입력의 원래 상태와 세부 `reason`, 원금액·검증 사유·조회/성공 시각·실패·성공 세대는 그대로 제공한다. 비교 저장 값이 유효하면 갱신 실패가 있어도 계산값을 유지하며 해당 comparison 입력의 failure를 함께 표시한다.

예를 들어 공시된 연간 매출 1000에서 Q3 미공시로 Q4를 만들지 못하면 다음 핵심 필드가 반환된다. 나머지 원자료·출처 필드는 생략했다.

```json
{
  "businessYear": 2024, "reportCode": "11011",
  "status": "not_calculable", "reason": "missing_comparison", "value": null,
  "inputs": [
    {"businessYear": 2024, "reportCode": "11011", "usage": "value", "status": "available", "amount": "1000"},
    {"businessYear": 2024, "reportCode": "11014", "usage": "comparison", "status": "unpublished", "role": "statement", "amount": null}
  ]
}
```

부채비율은 부채·자본 자체의 검증된 동일 instant로 계산하고 그 실제 날짜가 속한 가격봉에 배치한다. 손익·CF duration의 부재·미확인·짧은 기간은 기말 비율을 막지 않는다. 두 입력의 기간·통화·기준·성공 세대와 접수번호를 확인하며, 자본이 0 이하이면 `not_calculable / non_positive_equity`, `period={"kind":"instant","date":"2024-12-31"}`와 두 원금액을 반환한다. 서로 다른 시점은 합치거나 기간을 추측하지 않는다.

DPS의 `reporting_period` 입력은 실제 선택한 verified duration의 계정·기준·원금액·XBRL context/파일·접수번호·checkedAt/lastSuccessAt·성공 세대·갱신 실패를 보존한다. 유효한 저장 기간 근거의 갱신이 실패했더라도 저장 배당값은 유지한다. 예를 들어 DPS 100은 available이고 배당 입력은 정상인 동시에, 기간 근거 입력에는 `failure=network`, `checkedAt=200`, `lastSuccessAt=100`이 함께 올 수 있다.
