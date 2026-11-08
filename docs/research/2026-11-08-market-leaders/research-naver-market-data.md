# 네이버 시장 보조차트 자료 경로 조사

확인일 **2026-11-08**. 기존 입력·HTML·코드는 변경하지 않았다. 공개 화면용 경로·표본 응답이며 공식 지원 API가 아니다. 무인증 GET만 사용했고 오류 뒤 우회하지 않았다. 상태는 이번 확인 범위에 한정한다.

**결론:** 지수 가격은 기존 자료를 재사용할 수 있다. 시장 거래대금·수급은 현재만, 기준금리는 2021년 회의 결과까지 확인했다. 원달러·국고채는 아래 한계가 있다. 표본만으로 2019~2023년 전체의 완전성을 보증하지 않는다.

| 분류·자료 | 성공/실패·실제 확인 범위 | 필드·단위·페이지네이션 / 미확인 |
|---|---|---|
| **기존 수집 가능 가격:** KOSPI·KOSDAQ | 기존 보존 일별 자료 각 990개, 2019-07-01~2023-06-30. KOSPI 원본에서 2020-01-02·2022-12-29 행 재확인.[A1][A2] | 날짜·OHLC·거래량·외국인소진율 배열. 지수 pt; 거래대금 없음. 거래량 단위는 이 응답에 없고 외국인소진율을 순매수로 쓰면 안 됨. |
| 지수 `basic`·`price` | `basic` 및 첫 가격 페이지 HTTP 200, 최신 거래일 2026-11-06. `price?pageSize=3&page=400`은 **2021-12-13·10·09** 세 행 반환.[B1][B2][B3] | `localTradedAt`, `closePrice`, 등락·OHLC; pt·등락률 %. 현재→과거 역순, page/pageSize 작동 확인. 거래대금·수급 필드와 총 페이지 수는 없음. |
| **현재만 확인:** 시장별 거래대금·수급 | KOSPI·KOSDAQ 화면 HTTP 200. KOSPI hydration의 `integration`에 `totalInfos`, `dealTrendInfo` 확인; 기준일 2026-11-06.[C1][C2] | 대금 `accumulatedTradingValue` 표시 단위 **백만**, 거래량 **천주**. 수급은 `bizdate`, `personalValue`, `foreignValue`, `institutionalValue`; 응답 자체의 단위 표시는 못 찾음. 과거 페이지 미확인. |
| 원달러 | 현재 요약 HTTP 200: 하나은행 `FX_USDKRW`, `unit=KRW`, `priceDataType=NOTICE_ROUND`, 고시회차·시각 확인.[D1] | 지수 종가와 다른 은행 고시값. 화면 번들의 daily 경로에 2021-06-30 표본 요청은 **400**; 해당 조합 실패이며 과거 자료 부재의 증명은 아님.[D2] |
| 기준금리 | 현재 목록·KOR 달력 HTTP 200. pageSize=3의 15페이지가 **2021-08-26 0.75·07-15 0.50·05-27 0.50** 반환.[E1][E2] | 화면 단위 %. `localTradedAt`, `closePrice`, `fluctuations`, `isRelease`. 1페이지에는 미발표 일정도 포함. 회의별 자료이며 일별 금리가 아님. 전체기간·최초 공개본 미검증.[E3] |
| 국내금리·국고채 | 국내금리 HTTP 200: 2026-11-05 콜·CD·회사채 등과 공급자 BOK/KOFIA 등을 확인. 국채 국가목록 HTTP 200이나 KOR 조회는 **500**.[F1][F2][F3] | 국내금리 목록에 국고채3년은 없었음. `unit=null`이므로 단위 추가 확인 필요. 국고채 수치·과거 이력·정상 요청 인자는 **미확인**. |

**발견 경로:** 구 지수 주소는 새 PC 화면으로 이동했다. 모바일 `__NEXT_DATA__`에서 `/stock/domestic/basic`, `/stock/domestic/integration` 질의·값을 확인했다. 번들의 `/front-api` 접두어로 basic 호출도 200이었다. 기존 `/api/index/KOSPI/basic`도 200이나 현재 화면의 사용 경로와 같다고 단정하지 않는다.[C1][B0][B1]

구 marketindex는 웹 도구에서 리다이렉트 오류였고 새 `/market/marketindex`는 직접 HTTP 200이었다. 연결 번들에서 기준금리 `calendars`와 환율 `daily` 경로를 찾아 표본 요청했다. 페이지·10년 차트·이미지 URL의 존재를 과거 원시 행 전체 지원으로 보지 않았다.[G1][G2][G3]

**적용 판단:** 지금 재사용할 후보는 보존된 지수 가격이다. 기준금리 회의 자료는 후속 검증 후보, 시장 수급·거래대금·환율·국고채 이력은 보류한다. 미래 일정의 `isRelease=false`와 `-`는 결측으로 두고 관측일·발표시각·효력일·조회일을 분리해야 한다. KST·미국 현지일, 휴일, 코스피/코스닥, 원·백만원·억원 및 금리 %를 혼합하지 않는다. 최신 응답은 정정 전 당시 값을 보증하지 않는다. 호출 한도·지원 지속성·재배포 허용 범위는 검증하지 않았으며 화면 하단의 무단배포 금지 문구도 확인했다. 이 조사는 자료 접근 가능성 검토이며 예측 신호나 주가 원인을 검증하지 않았다.[C1][E3][G1]

## 직접 출처

공통 확인일: **2026-11-08**. A1·A2는 부모 연구에서 성공한 URL과 이번에 읽은 보존 자료(`market-daily.json`, `kospi-raw-kospi-naver.txt`)의 근거다. 나머지는 이번 직접 HTTP/웹 열람 결과다. 성공에는 표본 성공만, 실패에는 해당 요청 실패만 부여했다.

[A1]: https://api.finance.naver.com/siseJson.naver?symbol=KOSPI&requestType=1&startTime=20190701&endTime=20230630&timeframe=day
[A2]: https://api.finance.naver.com/siseJson.naver?symbol=KOSDAQ&requestType=1&startTime=20190701&endTime=20230630&timeframe=day
[B0]: https://m.stock.naver.com/front-api/stock/domestic/basic?code=KOSPI&endType=index
[B1]: https://m.stock.naver.com/api/index/KOSPI/basic
[B2]: https://m.stock.naver.com/api/index/KOSPI/price?pageSize=3&page=1
[B3]: https://m.stock.naver.com/api/index/KOSPI/price?pageSize=3&page=400
[C1]: https://m.stock.naver.com/domestic/index/KOSPI/total
[C2]: https://m.stock.naver.com/domestic/index/KOSDAQ/total
[D1]: https://stock.naver.com/api/securityService/marketindex/majors/exchange
[D2]: https://stock.naver.com/api/stockSecurity/exchange-rates/v2/USD/daily?bankType=HNB&date=2021-06-30&size=3
[E1]: https://stock.naver.com/api/securityService/marketindex/standardInterest
[E2]: https://stock.naver.com/api/securityService/marketindex/standardInterest/KOR/calendars?page=15&pageSize=3
[E3]: https://stock.naver.com/api/securityService/marketindex/standardInterest/KOR/calendars?page=1&pageSize=3
[F1]: https://stock.naver.com/api/securityService/marketindex/domesticInterest
[F2]: https://stock.naver.com/api/securityService/economic/bond/nations
[F3]: https://stock.naver.com/api/securityService/economic/bond/KOR
[G1]: https://stock.naver.com/market/marketindex
[G2]: https://ssl.pstatic.net/imgstock/fn/real/pc/_next/static/chunks/app/market/marketindex/bondAndInterest/standardInterest/page-c30aee7485e8fd03.js
[G3]: https://ssl.pstatic.net/imgstock/fn/real/pc/_next/static/chunks/app/marketindex/exchange/%5Bcode%5D/price/page-1f0f9a14885efd69.js
