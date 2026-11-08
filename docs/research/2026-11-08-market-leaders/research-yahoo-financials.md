# Yahoo 재무·시장 보조차트 확보 조사

확인일 **2026-11-08**. 결론: 한국 종목의 식별·가격 조회 가능성과 **2020~2022 재무 분기 자료 확보는 별개**다. 현재 검증으로 Yahoo를 당시 재무 차트의 단독 원천으로 채택하기 어렵다. 일부 연간 표는 공식 검색색인에서 확인했지만, 두 종목의 최근·과거 분기 전체 범위와 당시 공개 버전은 검증하지 못했다. 기존 HTML·코드·입력 자료는 수정하지 않았다.

**저호출 표본과 상태.** 삼성전자 `.KS`, 씨젠 `.KQ`를 대상으로 무인증 재무 페이지를 각각 1회 요청했다. 모두 429여서 해당 호스트 재요청을 중단했다. 과거·최근 및 연간·분기를 묶어 비교하려던 시계열 시험도 삼성전자 첫 요청에서 429가 나와 나머지 요청을 취소했다. 인증키·쿠키·프록시·우회 수단은 쓰지 않았다. 부모가 먼저 성공한 응답과 이번 실패는 아래처럼 구분한다.

| 대상·근거 | 실제 확인 범위 | 미확인·제약 |
|---|---|---|
| [삼성전자 재무 화면][S] | 부모는 HTTP 200·816,058바이트, 이번 GET은 429. 공식 검색색인은 TTM 및 2025/2024/2023/2022년 12월 말 연간 열, Annual/Quarterly 버튼을 노출 | 버튼 존재는 분기 열 확보 증거가 아님. 2020·2021 연간 및 2020~2022 분기 미확인 |
| [씨젠 재무 화면][C] | 이번 GET 429 | 최근·과거 분기/연간 기간, 통화·표 단위·예상치 구분 모두 재무 본문 기준 미확인 |
| [부모의 과거 분기 시계열 요청][T] | 2019-01-01~2024-01-01 경계 요청은 HTTP 200이나 meta만 있고 관측값 0개 | 시험한 종목·항목·기간의 빈 응답이며 모든 과거 재무 부재를 뜻하지 않음 |
| [이번 연간/분기 6항목 시험][U] | HTTP 429, 관측치 분석 불가 | 씨젠·최근 기간 추가 호출 중단. 실패를 빈 재무자료로 처리하지 않음 |
| [quoteSummary][Q] | 부모 요청 401 | 인증 우회·재시험하지 않음. 공개적으로 작동하는 재무 수집 경로로 제시할 수 없음 |

**단위와 식별.** [삼성전자 공식 화면의 검색색인][S]에는 `Currency in KRW`, `All numbers in thousands`가 함께 표시된다. 원 단위 변환 시 표 배율을 적용해야 하며 EPS·주식수 등 행별 예외도 원문 대조가 필요하다. 이를 씨젠의 재무 단위까지 확인한 것으로 확장하지 않는다. [Yahoo 공식 거래소 안내의 검색색인][E]은 Korea Stock Exchange `.KS`, KOSDAQ `.KQ`를 구분한다. 기존 보존 `kospi-raw-samsung-yahoo.json`과 `kosdaq-yahoo-096530.json`의 실제 chart 메타도 각각 KSE/KOSDAQ·KRW를 보여준다. 이는 **가격** 메타이며 재무제표 통화·연결 기준을 보증하지 않는다. 부모의 `^KS11` 월봉 성공 역시 재무 API의 기간 지원 근거가 아니다.

**발표일·정정·예상.** 이번에는 원 재무 관측값을 새로 확보하지 못해 `asOfDate`·공개일·정정 버전·연결/별도 필드를 실측 검증하지 못했다. 표의 회계기간 종료일이나 TTM을 발표일로 대체하면 안 된다. 연간 표, 분기 표, TTM, 분석가 예상치와 forward 지표는 구분해야 하며, 최근값을 과거 분기나 당시 시장 정보로 소급하지 않는다. EPS 분할 조정, 적자 PER 처리 및 K-IFRS 영업이익과 공급자 표준화 항목의 일치도 남은 검증 사항이다.

**공식 서비스 안내와 화면용 응답은 구분한다.** [Yahoo 공식 안내의 검색색인][H]은 Morningstar 재무자료 전환을 10월 26일 선택 적용, **11월 9일 전면 적용 예정**이라고 설명한다. 과거 기간의 계산법·항목명도 달라질 수 있다는 안내이므로, 확인일 현재 전환 완료로 쓰거나 두 방식의 영업이익·현금흐름을 이어 붙이면 안 된다. help/subscriptions 본문은 부모가 이미 429를 확인했으므로 이번에는 요청하지 않았다. [Gold 소개의 공식 검색색인][G]에 장기 다운로드 기능이 있어도 정확한 한국 8종목의 2020~2022 분기 범위를 보증하지 않는다. 유료 계정·다운로드는 미검증이다. 여기서 시험한 query 경로는 공식 지원 API 계약으로 확인되지 않은 화면용 응답이다.

[yfinance 문서][Y]의 연간·분기·TTM 인터페이스는 편의 기능이다. [유지관리자 코드][R]는 Yahoo 응답을 표로 재배열하며 빈 자료 가능성도 언급한다. 따라서 서버가 반환하지 않은 기간을 라이브러리가 생성할 수는 없다. 코드의 ‘4년/5분기’ 주석도 Yahoo 공식 보장이나 이번 한국 표본의 실측 범위로 인용하면 안 된다. 패키지 설치·실행은 하지 않았다. 과거 재무 패널은 IR/DART 원문·공개일·버전 보존을 우선하고 Yahoo는 검증된 범위의 교차 확인 후보로 두는 판단이다.

[S]: https://finance.yahoo.com/quote/005930.KS/financials/
[C]: https://finance.yahoo.com/quote/096530.KQ/financials/
[T]: https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/005930.KS?type=quarterlyTotalRevenue,quarterlyOperatingIncome&period1=1546300800&period2=1704067200
[U]: https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/005930.KS?type=annualTotalRevenue,annualOperatingIncome,annualOperatingCashFlow,quarterlyTotalRevenue,quarterlyOperatingIncome,quarterlyOperatingCashFlow&period1=1546300800&period2=1704067200
[Q]: https://query1.finance.yahoo.com/v10/finance/quoteSummary/005930.KS?modules=incomeStatementHistoryQuarterly,incomeStatementHistory
[E]: https://au.help.yahoo.com/kb/finance-for-web/exchanges-cover-sln2310.html
[H]: https://help.yahoo.com/kb/SLN37694.html
[G]: https://ca.help.yahoo.com/kb/SLN36623.html
[Y]: https://ranaroussi.github.io/yfinance/reference/yfinance.financials.html
[R]: https://github.com/ranaroussi/yfinance/blob/main/yfinance/scrapers/fundamentals.py
