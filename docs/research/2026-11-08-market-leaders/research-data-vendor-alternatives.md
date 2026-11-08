# 재무·시장 보조차트 공급자 대안

확인일 **2026-11-08**. 공식 원문 조사만 했다. 가입·구매·키 조회·설치·기존 파일 변경은 없었다. 세 공급자에서 확보한 한국 재무 행은 **0개**로, 문서상 기능과 실제 확보를 구분한다.

**판단:** 국내 8개 사례의 2020~2022년 실적·당시 정보를 공부하려면 **DART 원문·접수정보를 우선**, FnGuide를 정규화·비교의 보조 후보로 둔다. FMP·Alpha Vantage는 한국 전 분기와 공개 시점 검증 전에는 채택하지 않는다. 글로벌 지원·가격 심볼·미국 예시는 한국 재무 커버리지 증거가 아니다.

| 후보 | 공식 문서에서 확인 | 한국 005930·096530 / 과거 분기 확보보장 | 발표·정정 이력의 미확인 범위 |
|---|---|---|---|
| **FnGuide / DataGuide·FnSpace** | DataGuide는 재무 DB 1983년~현재, 국내 기업 재무제표·비율을 안내. 유료 연간 계약·ID·Excel 설치형이다. API 상품 FnSpace는 회원가입 후 통합키와 패키지 구매가 필요하다.[N1][N2][N3] | **보장 없음·상품문서 확인만.** 1983년 시작을 모든 기업의 분기자료 시작으로 해석하지 않는다. 두 기업 공개 페이지 표본 열람은 502로 실패했다.[N4][N5] | 최초 발표 시각, 당시 버전 조회, 모든 정정 전후 값 보존 여부는 확인 못함. 컨센서스·실적속보·확정 실적도 구분 필요. |
| **Financial Modeling Prep** | 재무 3표·연간/분기 기능, 재무 지원 심볼 목록을 안내. 요금표상 Starter 재무는 미국, Premium은 미국·영국·캐나다, Ultimate는 글로벌로 구분한다.[M1][M2][M3] | **보장 없음·문서만.** 공식 심볼 목록 무키 호출은 **401**. 한국 두 종목의 목록 포함·통화·2019~2023 전 분기는 미검증이다.[M4] | FAQ는 국제 종목의 `filing date`를 실제 SEC 접수일 대신 보고기간 날짜로 매핑한다고 명시한다. 이를 국내 공시일로 쓰면 안 된다. 정정본 전체·당시 버전 조회도 미검증.[M5] |
| **Alpha Vantage** | `INCOME_STATEMENT`는 연간·분기, GAAP/IFRS 정규화, 통상 최근 실적 발표 당일 갱신을 설명한다. API키 필수, 기본 하루 25회와 유료 확장 안내가 있다.[A1][A2] | **보장 없음·문서만.** 공식 검색 기능은 있으나 한국 심볼 목록이나 두 종목 재무 응답을 확인하지 못했다. IBM 예시·글로벌 가격 지원으로 한국 재무를 추론하지 않는다. | 발표 당일 갱신은 과거 최초 공시일·정정 이력 제공을 뜻하지 않는다. 한국 분기 수록 시작·끝과 삭제/수정 전 원본은 미검증. |

**HTML 이용 조건:** DataGuide 안내는 조회·분석 목적이며 기계적 대량 추출·DB 구축, 외부 재판매·무단 공유를 제한한다. 이 조건을 FnSpace 계약에 그대로 대입하지 말고 별도 확인해야 한다.[N2] FMP는 여러 사람이 보는 내부/외부 웹·앱에 표시하려면 별도 계약이 필요하다고 명시한다. 개인 요금제 결제만으로 공유 HTML 권한이 생기지 않는다.[M6] Alpha Vantage 약관은 개인 비상업 이용을 기본으로 하고 그 밖의 이용은 별도 서면 조건을 둔다. 세 곳 모두 이번 조사로 팀 공유·공개 HTML·원자료 포함 다운로드를 허용받은 것은 아니다.[A3]

**DART와의 목적별 비교:** DART 전체 재무제표 가이드는 2015년 이후 사업연도, 1분기·반기·3분기·사업보고서 코드, 연결/별도 선택과 접수번호를 설명한다. 공시검색은 접수일·접수번호를 제공하고 `last_reprt_at=N`이면 정정보고서를 포함한 제출 보고서를 검색하도록 명시한다. 따라서 공시일·정정 원문 추적의 기준으로 적합하다. 다만 접수일은 시각이 아니고 IR 실적 발표가 공시보다 빠를 수도 있다. 최신 재무 API 값만 받아 당시 수치라 하지 말고 접수번호별 원문과 대조해야 한다. 이번에는 키 없이 **가이드만 확인**했으며 8개사 전 분기 확보·정정 이력 복원·HTML 공유 조건을 검증하지 않았다.[D1][D2]

후속 확인은 삼성전자·씨젠 각 한 분기의 원문, 연결 범위, 단위, 누적/단분기, 공시일·정정본 대조부터 시작한다. DART의 동일 계정명이 기업 간 자동 비교를 보장하지는 않는다.

**원천 분리:** 가격은 기존 시계열, 기업 재무는 공시/재무 DB, 금리·환율은 ECOS/FRED로 나눈다. ECOS/FRED는 기업 재무 대안이 아니다. 최신 보정 자료와 당시 공개본을 구분하며 보조차트를 예측 신호나 주가 원인으로 단정하지 않는다. 한국 실응답이 없는 공급자 조사는 여기서 종료한다.

## 직접 출처와 열람 범위

공통 확인일: **2026-11-08**. N1~N3·M1~M3·M5~M6·A1~A3는 공식 문서 열람 성공, N4~N5는 502, M4는 무키 401이다. D1~D2는 웹 타임아웃 뒤 일반 HTTP 200으로 가이드를 확인했으며 데이터 API 호출 성공은 아니다.

[N1]: https://help-dataguide.fnguide.com/ko/articles/DataGuide-%EC%84%9C%EB%B9%84%EC%8A%A4-%EC%86%8C%EA%B0%9C-24a3434a
[N2]: https://help-dataguide.fnguide.com/ko/articles/%EC%9D%B4%EC%9A%A9-%EB%B0%8F-%EC%9A%94%EA%B8%88-%EC%95%88%EB%82%B4-48b18a4b
[N3]: https://help-fnspace.fnguide.com/ko/articles/FnSpace-%EC%84%9C%EB%B9%84%EC%8A%A4%EB%8A%94-%EC%96%B4%EB%96%BB%EA%B2%8C-%EC%9D%B4%EC%9A%A9%ED%95%98%EB%82%98%EC%9A%94-b08f8be8
[N4]: https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?gicode=A005930
[N5]: https://comp.fnguide.com/SVO2/ASP/SVD_Main.asp?gicode=A096530
[M1]: https://site.financialmodelingprep.com/developer/docs/stable/income-statement
[M2]: https://site.financialmodelingprep.com/developer/docs/stable/financial-symbols-list
[M3]: https://site.financialmodelingprep.com/pricing-plans
[M4]: https://financialmodelingprep.com/stable/financial-statement-symbol-list
[M5]: https://site.financialmodelingprep.com/faqs?code=calendar
[M6]: https://site.financialmodelingprep.com/terms-of-service
[A1]: https://www.alphavantage.co/documentation/
[A2]: https://www.alphavantage.co/premium/
[A3]: https://www.alphavantage.co/terms_of_service/
[D1]: https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020
[D2]: https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001
