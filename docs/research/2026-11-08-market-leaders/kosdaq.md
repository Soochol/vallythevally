# 코스닥 선정 사례 생애 연구: 2020~2022년 파일럿

씨젠·에코프로비엠·위메이드는 검증 가능한 사업 변화와 큰 가격 재평가를 공부하기 위한 선정 사례다. 수젠텍은 동일 진단 테마 안에서 가격 주도 지속 실패를 비교하는 사례다. 실제 NAVER 일별 가격으로 고점·후속 하락을 계산했으며, 에코프로비엠은 2023년 상반기에 과거 고점을 넘어 재확산했다. 전 종목 순위나 지수기여 판정은 아니다.

작성·원문 확인: 2026-11-08. 본 파일은 통합 HTML 보고서의 연구 입력이며 HTML 자체는 이 담당 파일 범위 밖이다.

## 연구 범위와 가격 기준

- 이 파일의 주도력 약화는 선정 종목의 가격 고점 대비 약화와 사업 기대의 검증이라는 학습용 표현이다. 시장 대비 상대강도를 측정한 판정이 아니다.
- 모집단 순위 연구가 아닌 3개 핵심 사례와 1개 동일 테마 비교의 사후 선정 파일럿이다. 전체 1위·상승기여 1위·정밀 지수기여를 주장하지 않는다.
- 주 조사기간은 2020-01-01~2022-12-31, 가격 버퍼는 2019-07-01~2023-06-30이다. 가격 고점은 주 조사기간 내 일별 수정종가의 최댓값으로 제한한다.
- 주 시계열은 NAVER siseJson의 종가 열 하나로 통일한다. 거래량 0 및 가격 0 이하 행은 제외한다. 씨젠·에코프로비엠·위메이드는 각 990개, 수젠텍은 988개 관찰점이다.
- NAVER 과거 가격은 취득시점의 조정 자료다. 분할·무상증자 전후 단절 조정은 관찰했으나 공식 조정식·현금배당 포함 여부·유상증자 권리 처리를 독립 확인하지 못했다. 총수익률·배당 재투자 수익률로 해석하지 않는다.
- Yahoo 원응답은 분할/무상증자 효력일·배당 자료의 보조 대조용으로만 보존한다. Yahoo adjclose는 분할·배당 조정이므로 NAVER 주 시계열과 혼합하거나 가격지수 상대강도에 사용하지 않는다.
- 고점 이후 저점 하락률=100×(고점일 이후~2023-06-30 최저 수정종가/고점 수정종가−1). 말일 대비 변화도 같은 식이다. 전 기간 최대낙폭(MDD)을 계산한 것은 아니다.
- 공시일을 사건 기준으로 사용한다. 회사 보도자료가 과거 공시일을 명시하는 경우 공개일과 게시일을 함께 적는다. 계약 체결일·승인일·신주기준일·기업행사 효력일·거래지원 종료 시행일은 구분한다.
- asOf는 그 날짜까지 발표된 정보만 사용한다. 아직 발표되지 않은 반기·분기·연간 실적, 후일 주가 고점·하락 결과를 당시 질문의 답으로 넣지 않는다.
- phases의 시작·종료일은 가격과 사건을 공부하기 위한 사후 구분이며 인과적 전환점 추정치가 아니다. 사실(evidence)과 해석(interpretation)을 별도 필드로 둔다.
- 재무 수치는 출처의 연결/별도 및 잠정/감사 상태를 명시한다. 공급자 가격 소수·원 단위 반올림이나 미래 조정으로 수치가 바뀔 수 있어 원응답과 SHA256을 보존한다.

## 계산으로 확인한 가격 경로

모두 NAVER 취득시점 조정 종가(원). 당시 거래소에 표시된 명목 종가가 아니며 현금배당 처리 명세는 미확인이다. 고점은 2020~2022년, 고점 이후 최저점은 고점 다음 관찰일부터 2023-06-30까지다.

|선정 사례|연구기간 고점일|고점 수정종가|후속 최저일|최저 수정종가|고점→최저|고점→2022말|고점→2023상반기말|
|---|---|---:|---|---:|---:|---:|---:|
|씨젠|2020-08-07|156,901|2023-06-30|20,550|-86.90%|-82.66%|-86.90%|
|에코프로비엠|2021-11-18|138,011|2022-02-10|77,578|-43.79%|-34.32%|77.58%|
|위메이드|2021-11-19|237,000|2022-12-08|30,050|-87.32%|-86.69%|-83.52%|
|수젠텍|2020-08-06|55,500|2023-06-27|7,210|-87.01%|-81.71%|-86.97%|

[price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [price-ecoprobm](https://api.finance.naver.com/siseJson.naver?symbol=247540&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [price-wemade](https://api.finance.naver.com/siseJson.naver?symbol=112040&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)

## 사례별 사실·해석·당시 질문

### 씨젠 (096530) — 핵심 선정 사례: 코로나19 PCR

신규 진단 수요가 실제 대규모 실적으로 연결되었지만, 가격 고점과 이익·매출 고점이 일치하지 않는 사례. 전 종목 수익률·거래대금·지수기여 순위로 선정한 주도주는 아니다.

**상장·시장:** 2022년 분기보고서로 상장일과 코스닥 지위를 확인. 본 연구의 2020~2023상반기 가격은 KOSDAQ 종목코드 기준이며 시장 이전 사건을 관찰하지 않았다. [sg-listing](https://kind.krx.co.kr/external/2022/05/16/002564/20220516005799/11013.htm)

**공부할 가설:** PCR 검사 수요의 긴급 확대와 수출·장비 기반 확충이 사업의 변화를 뒷받침했다. 수요 정상화 우려와 비코로나 전환을 확인해야 하는 시기로 옮겨갔다는 해석은 가능하지만, 사건 하나가 주가 변동을 일으켰다고 단정하지 않는다.

**생애 구간(사후 구분)**

- **탄생 (2020-01-01~2020-03-26)** — 사실: 식약처의 3월 26일 공개 목록에 Allplex의 2월 12일 긴급사용승인이 명시되어 있다. 해석: 새로운 검사 수요를 매출로 연결할 규제상 경로가 확인된다. 3월 26일은 목록 게시일이며 최초 시장 인지일로 간주하지 않는다. [sg-mfds](https://www.mfds.go.kr/eng/brd/m_60/view.do?seq=74424)
- **확산 (2020-03-27~2020-08-07)** — 사실: 5월 공개 1분기 매출은 818억원. NAVER 시계열의 2020~2022년 최고 수정종가는 8월 7일이다. 해석: 실적 확인과 기대 확산이 함께 관찰된다. 8월 13일 발표된 2분기 실적을 8월 7일 당시 확정 정보로 소급하지 않는다. [sg-q120](https://kr.seegene.com/media/center-view/201) [price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **성숙 (2020-08-08~2021-12-31)** — 사실: 8월 13일 2분기 매출 2,748억원·영업이익 1,690억원이 공개되었고, 2021년 2월 18일 2020년 연매출 1조1,252억원이 발표되었다. 2021년에는 1주당 1주 무상증자가 결정되었다. 해석: 사후에 보면 실적 확대가 이어져도 앞선 가격 고점을 계속 갱신하지는 못했다. 호실적 그 자체를 주도 지속의 충분조건으로 보지 않는다. [sg-q220](https://kr.seegene.com/media/center-view/204) [sg-fy20](https://kr.seegene.com/media/center-view/229) [sg-bonus](https://kr.seegene.com/media/center-view/234) [price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **주도력 약화 (2022-01-01~2022-12-31)** — 사실: 5월 공개 1분기 매출은 4,515억원으로 높았지만, 회사는 5월 16일 자료에서 PCR 수요 감소가 매출에 영향을 줄 것이라고 밝혔다. 연말 수정종가는 이전 고점보다 낮았다. 해석: 현재 실적의 크기와 향후 수요의 방향을 분리해서 읽는 구간이다. 수요 발언만으로 전체 하락을 설명하지 않는다. [sg-q122](https://kr.seegene.com/media/center-view/276) [price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **후속 경과 (2023-01-01~2023-06-30)** — 사실: 2월 17일 발표된 2022년 잠정 매출은 8,534억원, 영업이익은 1,959억원이다. 6월 30일 가격은 2022년 말보다도 낮다. 해석: 코로나 특수 약화와 비코로나 성장 기대를 함께 추적해야 한다. 2023년 상반기 가격만으로 장기 사업 실패를 확정하지 않는다. [sg-fy22](https://kr.seegene.com/media/center-view/284) [price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)

**공개일 기준 사건**

- **2020-03-26 / 식약처 긴급사용승인 목록 게시** — 목록은 씨젠 제품의 승인일을 2020-02-12로 표시한다. 이벤트 날짜는 실제 열람한 목록의 게시일이며 승인일과 구분했다. [sg-mfds](https://www.mfds.go.kr/eng/brd/m_60/view.do?seq=74424)
- **2020-08-13 / 2분기 대규모 실적 공개** — 연결 매출 2,748억원, 영업이익 1,690억원. 가격 고점 8월 7일보다 발표가 늦다. [sg-q220](https://kr.seegene.com/media/center-view/204) [price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **2021-04-08 / 100% 무상증자 결정** — 1주당 신주 1주. 회사 자료의 배정기준일은 4월 26일, Yahoo 기업행사 효력일 표시는 4월 23일이다. 서로 다른 날짜 개념이다. [sg-bonus](https://kr.seegene.com/media/center-view/234) [yahoo-seegene](https://query1.finance.yahoo.com/v8/finance/chart/096530.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits)
- **2022-05-13 / 1분기 실적 공시** — 회사 5월 16일 게시물은 5월 13일 공시를 명시한다. 매출 4,515억원·영업이익 1,997억원. 같은 게시물의 PCR 수요 감소 관련 발언은 5월 16일 공개 정보로 취급한다. [sg-q122](https://kr.seegene.com/media/center-view/276)
- **2023-02-17 / 2022년 잠정 실적 공개** — 매출 8,534억원·영업이익 1,959억원. 비코로나 제품 확대 계획이 함께 제시되었다. 당일 잠정치이므로 후속 감사보고서 숫자로 바꿔 쓰지 않았다. [sg-fy22](https://kr.seegene.com/media/center-view/284)

**업종 내부·확산 비교:** 수젠텍과 코로나19 진단 수요를 공유하지만, 씨젠은 PCR, 수젠텍의 2020년 FDA 사례는 항체 IgG 검사다. 허가·용도·실적 전환 경로가 다르다. 두 선정 종목의 2020~2022년 최고 종가가 각각 2020-08-07과 2020-08-06에 관찰되므로 수젠텍을 시간상 후발주라고 확정할 수 없다. 같은 테마의 동반 확산·지속 실패 비교이며, 업종 내 순위 증명이 아니다. [sg-listing](https://kind.krx.co.kr/external/2022/05/16/002564/20220516005799/11013.htm) [su-fda](https://www.fda.gov/media/141888/download) [price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)

**당시 기준 관찰(미래 결과를 보지 않는 연습)**

- **2020-06-30에 알려진 사실:** 3월 공개 식약처 목록으로 긴급사용승인 사실을 확인할 수 있었다. 5월 13일 공시된 1분기 연결 매출은 818억원이다. 회사는 2분기에 코로나 수출 영향이 본격화될 것으로 기대했다. 당시 질문: 2분기 실제 매출과 이익은 어느 정도일까? / 검사 수요와 판매단가가 얼마나 지속될까? [sg-mfds](https://www.mfds.go.kr/eng/brd/m_60/view.do?seq=74424) [sg-q120](https://kr.seegene.com/media/center-view/201)
- **2022-06-30에 알려진 사실:** 5월 13일 공시된 1분기 매출은 4,515억원이다. 5월 16일 회사 자료는 PCR 수요 감소와 비코로나·자동화 사업 확대 계획을 함께 밝혔다. 당시 질문: 이후 분기 PCR 감소를 다른 제품 매출이 어느 정도 보완할까? / 높아진 인력·연구개발 기반의 비용은 어느 수준에서 유지될까? [sg-q122](https://kr.seegene.com/media/center-view/276)

**학습 포인트:** 실적 발표 이전의 기대와 발표 이후의 확정 실적을 구분한다. 무상증자 전후 당시 명목가격을 그대로 비교하면 수익률이 왜곡된다. 일시적 수요의 확대가 장기 이익의 지속을 보장하는지는 별도 질문이다.

**사례 한계:** 진단 업종 전체 모집단·거래대금·수급·상대강도 순위를 분석하지 않았다. 2022년 잠정 실적과 후속 감사 숫자가 다를 수 있다. NAVER 수정식과 배당 처리를 독립 재구성하지 못했다.

### 에코프로비엠 (247540) — 핵심 선정 사례: 하이니켈 양극재

다년 공급계약과 설비 확대 기대, 2022년 가격 약화, 2023년 상반기 재확산을 함께 관찰할 수 있다. 2022년 약세를 영구 주도력 상실로 단정하지 않기 위한 반례다.

**상장·시장:** 2022년 증권신고서에 코스닥 상장일 명시. 본 연구기간은 코스닥 사례로 분류하며 이후 시장 이전 논의는 연구 범위 밖이다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm)

**공부할 가설:** 장기 공급계약은 사업 가시성을 높일 수 있으나, 계약 규모는 당시의 가격·이행 조건을 읽어야 한다. 설비·사고·경쟁 및 자본조달 위험과 가격 변동을 함께 보되 인과 효과를 추정한 연구는 아니다.

**생애 구간(사후 구분)**

- **탄생 (2020-02-03~2021-06-30)** — 사실: 2020년 2월 3일 공개된 장기 공급계약은 약 2.74조원, 공급기간은 2020~2023년이다. 해석: 소재 수요 확대 기대가 고객 계약이라는 관찰 가능한 정보로 연결되는 구간이다. 계약 체결일 1월 31일을 공개일로 사용하지 않았다. [bm-contract20](https://www.hankyung.com/article/202002035339L) [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm)
- **확산 (2021-07-01~2021-11-18)** — 사실: 2021년 9월 9일 2024~2026년 공급계약 관련 공정공시가 있었으며, 주 시계열의 연구기간 고점은 11월 18일이다. 해석: 판매단가 변동 조건이 있는 계약 금액을 확정 미래 매출이나 이익과 동일시하면 안 된다. [bm-contract21](https://www.newsis.com/view/NISX20210909_0001577309) [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm) [price-ecoprobm](https://api.finance.naver.com/siseJson.naver?symbol=247540&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **성숙·급격한 약화 (2021-11-19~2022-02-10)** — 사실: 2022년 1월 21일 오창공장 화재·재해발생 공시와 이후 생산중단 공시가 있었다. 고점 이후 관찰기간 최저 종가는 2월 10일이다. 해석: 사업 위험이 가시화된 시기와 가격 조정이 겹쳤지만, 화재만의 가격 효과를 분리하지 못했다. 내부자거래 관련 보도의 개별 인과·사법 판단은 본 파일에서 검증하지 않아 수치화하지 않는다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm) [price-ecoprobm](https://api.finance.naver.com/siseJson.naver?symbol=247540&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **재평가 (2022-02-11~2022-12-31)** — 사실: 4월 6일 유상증자와 1주당 3주 무상증자 계획이 공개되었다. NAVER 가격은 6월 기업행사 전후의 조정 계열을 사용한다. 해석: 주식 수·자금조달·설비투자의 변화를 단순 주가 하락과 분리한다. 연말 가격은 앞선 고점 아래지만 사업의 영구 실패 증거는 아니다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm) [price-ecoprobm](https://api.finance.naver.com/siseJson.naver?symbol=247540&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **재확산 (2023-01-01~2023-06-30)** — 사실: 2월 회사 발표에서 에코프로비엠 2022년 연결 매출은 5조3,569억원, 영업이익은 3,825억원이다. 2023년 상반기 NAVER 최고 종가는 과거 연구기간 고점을 넘어선다. 해석: 주도력 약화를 곧 영구 상실로 해석하면 이 경로를 놓친다. 실적 발표만이 반등을 유발했다고 주장하지 않는다. [bm-fy22](https://www.ecoprobm.com/sub0701/view/page/3/id/1064) [price-ecoprobm](https://api.finance.naver.com/siseJson.naver?symbol=247540&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)

**공개일 기준 사건**

- **2020-02-03 / 장기 양극재 공급계약 공시** — 약 2.74조원, 2020-01-01~2023-12-31 공급. 후속 증권신고서 계약표의 계약 체결일은 2020-01-31이며 발표일과 다르다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm) [bm-contract20](https://www.hankyung.com/article/202002035339L)
- **2021-09-09 / 차기 장기 공급계약 공정공시** — 후속 증권신고서의 공개일 기록과 당일 기사로 확인. 약 10.11조원, 2024~2026년 공급이며 원재료 시세에 따라 거래 금액이 달라질 수 있다. 계약 체결일은 9월 8일이다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm) [bm-contract21](https://www.newsis.com/view/NISX20210909_0001577309)
- **2022-01-21 / 오창공장 화재와 재해발생 공시** — 4월 6일 증권신고서는 1월 21일 재해발생, 1월 24일 생산중단, 2월 8일 정정 생산중단 공시를 기록한다. 원 공시 개별 문서는 미확보여서 후속 일차자료의 공시 이력으로 검증했다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm)
- **2022-04-06 / 유상증자·무상증자 계획 공개** — 무상증자는 기존 1주당 신주 3주, 기준일 6월 28일 계획이다. Yahoo는 6월 27일 4:1 기업행사로 표기한다. 유상증자 권리의 전체 현금흐름 조정은 별도로 재구성하지 못했다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm) [yahoo-ecoprobm](https://query1.finance.yahoo.com/v8/finance/chart/247540.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits)
- **2023-02-03 / 2022년 실적을 회사가 발표** — 에코프로비엠 연결 매출 5조3,569억원·영업이익 3,825억원. 에코프로 지주회사 연결 숫자와 혼동하지 않았다. [bm-fy22](https://www.ecoprobm.com/sub0701/view/page/3/id/1064)

**업종 내부·확산 비교:** 회사는 2022년 증권신고서에서 엘앤에프·포스코케미칼의 증설과 경쟁을 설명한다. 이를 양극재 산업의 사업 확산 증거로 사용하되 경쟁사 주가가 시간상 후행했거나 어느 회사가 더 높은 상대강도를 보였다는 주장은 하지 않는다. 이 파일에는 해당 두 회사 가격계열이 없으므로 후발주 가격 확산·업종 내 우열은 미검증이다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm)

**당시 기준 관찰(미래 결과를 보지 않는 연습)**

- **2022-06-30에 알려진 사실:** 4월 6일 증권신고서에서 기존 공급계약·오창공장 사고·유무상증자 계획을 읽을 수 있었다. 장기 공급계약은 원재료 시세와 판매단가 조건을 고려해야 하며, 회사는 경쟁업체 증설 위험도 기재했다. 당시 질문: 생산 재개와 증설이 예정된 물량 이행을 뒷받침할까? / 권리·주식 수 변화를 반영한 가격과 현금흐름은 어떻게 비교해야 할까? [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm)

**학습 포인트:** 공개일·계약 체결일·납품기간은 서로 다르다. 매출액 확대와 주가 하락은 동시에 일어날 수 있다. 2022년 조정만 보고 2023년 상반기 재확산을 지워서는 안 된다.

**사례 한계:** 원 공시 일부는 2022년 증권신고서에 기재된 과거 공시 이력으로 확인했다. 2022년 유상증자의 신주인수권 가치·추가 납입 현금흐름을 포함한 투자자 총수익률을 계산하지 않았다. 2023년 상반기 가격 재확산의 투자자별 수급·원인별 기여는 검증하지 않았다.

### 위메이드 (112040) — 핵심 선정 사례: 블록체인 게임·플랫폼 기대

출시·이용 지표 확대·계열사 전략 확산과 토큰 유통 신뢰 문제, 가격 약화를 함께 공부할 수 있다. 코스닥 전체 주도력 순위나 지수기여 1위라는 뜻이 아니다.

**상장·시장:** 거래소 신규상장 공고로 상장일, 2021년 회사 보도자료의 KOSDAQ 112040 표시로 당시 시장을 확인했다. 토큰 상장폐지를 주식 상장폐지로 기재하지 않는다. [wm-listing](https://kind.krx.co.kr/external/2009/12/16/000683/20091216001127/70760.htm) [wm-launch](https://www.newswire.co.kr/newsRead.php?no=929269)

**공부할 가설:** 미르4 글로벌의 관찰 가능한 이용 지표와 WEMIX 플랫폼 기대를 구분한다. 토큰의 거래지원 상태는 상장 주식의 상장 유지와 별개이며, 실적의 매출 성장·비용 증가·회계 범위도 나누어 읽어야 한다.

**생애 구간(사후 구분)**

- **탄생 전 준비 (2020-01-01~2021-08-25)** — 사실: 이 구간의 실제 가격을 보존했다. 8월 26일 당일 회사 자료가 글로벌 출시를 알렸다. 해석: 블록체인 플랫폼 기대를 글로벌 출시 이전의 확정 성과로 소급하지 않는다. [wm-launch](https://www.newswire.co.kr/newsRead.php?no=929269) [price-wemade](https://api.finance.naver.com/siseJson.naver?symbol=112040&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **확산 (2021-08-26~2021-11-19)** — 사실: 11월 3일 IR에서 글로벌 출시, 10월 27일 동시접속자 100만명 돌파, 계열사 위메이드맥스의 9월 1일 블록체인 게임 개발사 전환을 확인한다. 연구기간 가격 고점은 11월 19일이다. 해석: 게임 지표와 사업 전략이 계열사로 확산되는 모습이다. 계열사 전략 전환은 후발 기업 확산의 근거지만 주가 후행 순서나 실현 수익성의 증거는 아니다. [wm-q321](https://irsvc.teletogether.com/wemade/pdf/wemade2021Q3_kor.pdf) [price-wemade](https://api.finance.naver.com/siseJson.naver?symbol=112040&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **성숙 (2021-11-20~2022-05-11)** — 사실: 2022년 5월 11일 공시 보도에서 1분기 매출은 1,310억원, 영업이익은 약 65억원이다. 매출 확대에도 전년 동기 대비 이익이 감소했다. 해석: 이용자·토큰 생태계의 확대 기대를 비용 차감 후 영업성과와 연결해 검증할 단계로 본다. [wm-q122](https://www.yna.co.kr/view/AKR20220511030451527) [price-wemade](https://api.finance.naver.com/siseJson.naver?symbol=112040&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **주도력 약화·신뢰 검증 (2022-05-12~2022-12-31)** — 사실: 코인원 11월 24일 원문은 유통량·정보 제공·자료 신뢰 등을 거래지원 종료 사유로 제시하며 12월 8일 시행을 예고한다. 같은 날인 12월 8일에 고점 이후 최저 종가가 관찰된다. 해석: 사유는 거래소 측 판단이다. 이 사건이 전체 하락을 설명한다거나 법적 사실을 모두 확정했다는 뜻은 아니다. 가격은 2021년 고점부터 이미 약화했다. [wm-end](https://coinone.co.kr/info/notice/1971) [price-wemade](https://api.finance.naver.com/siseJson.naver?symbol=112040&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **후속 경과 (2023-01-01~2023-06-30)** — 사실: 2월 15일 IR의 2022년 잠정 매출은 4,586.02억원·영업손실은 805.98억원이다. 코인원은 2월 16일 WEMIX 거래지원 재개를 공지했다. 6월 말 가격은 2021년 고점 아래다. 해석: 일부 거래지원 재개와 가격 반등을 예전 수준의 주도력 회복으로 동일시하지 않는다. [wm-fy22](https://irsvc.teletogether.com/wemade/pdf/wemade2022Q4_kor.pdf) [wm-relist](https://coinone.co.kr/info/notice/2057) [price-wemade](https://api.finance.naver.com/siseJson.naver?symbol=112040&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)

**공개일 기준 사건**

- **2021-08-26 / 미르4 글로벌 출시 발표** — 회사 배포 보도자료는 170개국·12개 언어 출시를 알렸다. 출시 효과를 출시 전 확정 매출에 반영하지 않았다. [wm-launch](https://www.newswire.co.kr/newsRead.php?no=929269)
- **2021-11-03 / 3분기 IR로 이용 지표와 확산 공개** — 글로벌 출시일·동시접속자 지표·계열사 전략 전환을 명시했다. 8월 30일 100% 무상증자 결정도 같은 자료에서 확인하되 이 정보의 최초 게시일로 11월 3일을 주장하지 않는다. [wm-q321](https://irsvc.teletogether.com/wemade/pdf/wemade2021Q3_kor.pdf)
- **2022-05-11 / 1분기 매출 증가·영업이익 감소 확인** — 당일 공시 보도는 매출 1,310억원과 영업이익 약 65억원을 전했다. 해당 분기 IR 원문 확보에 실패하여 이 항목은 명시적으로 이차자료를 사용했다. [wm-q122](https://www.yna.co.kr/view/AKR20220511030451527)
- **2022-11-24 / WEMIX 거래지원 종료 결정 공지** — 코인원 원문 19:40 게시. 종료 시행은 12월 8일 15:00이다. 위메이드 코스닥 주식의 상장폐지 사건이 아니다. [wm-end](https://coinone.co.kr/info/notice/1971)
- **2023-02-15 / 2022년 연간 잠정 실적 공개** — IR은 연간 매출 성장과 영업적자를 함께 제시했다. 감사가 완료되지 않았고 추후 변경될 수 있다고 명시한다. [wm-fy22](https://irsvc.teletogether.com/wemade/pdf/wemade2022Q4_kor.pdf)

**업종 내부·확산 비교:** 위메이드맥스의 2021년 9월 1일 블록체인 게임 개발사 전환은 11월 3일 모회사 IR에서 확인된다. 이는 계열사 사업 전략의 확산 증거이며, 맥스의 상대강도나 매출 성과까지 입증하지 않는다. 게임 매출과 플랫폼 수수료, 토큰 가격은 서로 다른 변수이므로 코인 시세를 주식 수익률 대신 사용하지 않았다. [wm-q321](https://irsvc.teletogether.com/wemade/pdf/wemade2021Q3_kor.pdf) [wm-end](https://coinone.co.kr/info/notice/1971)

**당시 기준 관찰(미래 결과를 보지 않는 연습)**

- **2022-06-30에 알려진 사실:** 2021년 11월 IR에서 미르4 글로벌 이용 지표와 위메이드맥스 전략 전환을 확인할 수 있었다. 5월 11일 공시 보도상 1분기 매출은 늘었지만 영업이익은 전년 동기 대비 줄었다. 당시 질문: 비용 증가에 비해 플랫폼·게임 매출은 얼마나 지속될까? / 이용자와 거래 활동의 증가가 반복 가능한 현금흐름으로 이어질까? [wm-q321](https://irsvc.teletogether.com/wemade/pdf/wemade2021Q3_kor.pdf) [wm-q122](https://www.yna.co.kr/view/AKR20220511030451527)

**학습 포인트:** 출시 후 지표의 확대와 주식 가격 상승을 같은 개념으로 취급하지 않는다. 토큰 유통 신뢰·거래지원 위험과 게임 자체의 성과를 함께 보되 분리한다. 잠정 IR 수치와 후속 감사·정정 수치를 섞으면 당시 판단을 재현할 수 없다.

**사례 한계:** 위메이드맥스 등 다른 게임주 가격계열을 확보하지 않아 업종 내 주가 확산 순서는 검증하지 않았다. 2022년 1분기 실적은 공시를 전한 이차자료로 확인했다. 토큰 매각 관련 회계 재분류 전후의 전 수치를 대사하지 않았으며, 2023-02-15 IR의 잠정 수치만 명시적으로 사용한다.

### 수젠텍 (253840) — 동일 테마 비교: 가격 주도 지속 실패

코로나19 진단이라는 공통 테마 안에서 제품·허가가 다른 사례. 실제 연매출 확대와 가격 고점 미회복을 함께 볼 수 있어 비교 대상으로 택했다. 기업 실패·무실적 종목 또는 코스닥 전체 비주도 최하위라는 뜻이 아니다.

**상장·시장:** 2016-11-11 코넥스 상장 후 2019-05-28 코스닥 이전 상장을 회사의 2021년 반기보고서와 2023년 분기보고서로 확인했다. 따라서 연구기간 시작 전에 코스닥에 있었다. [su-listing](https://kind.krx.co.kr/external/2021/08/13/001605/20210813004467/11012.htm) [su-q123](https://kind.krx.co.kr/external/2023/05/15/002283/20230515005010/11013.htm)

**공부할 가설:** FDA 허가의 유무보다 어떤 검사에 어떤 범위로 허가되었는지를 확인해야 한다. 사업 성과가 발생해도 가격 주도 지속은 보장되지 않으며, 2023년 1분기의 실적 위축은 그 발표일 이후에만 알 수 있다.

**생애 구간(사후 구분)**

- **탄생 (2020-01-01~2020-03-31)** — 사실: 일별 가격에서 초기 상승과 변동을 관찰한다. FDA 최초 EUA 발급일은 이후인 9월 3일이다. 해석: 상반기 가격 움직임을 이미 FDA EUA를 받은 결과로 설명하지 않는다. 초기 상승 원인의 개별 보도 전수조사는 하지 못했다. [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [su-fda](https://www.fda.gov/media/141888/download)
- **확산 (2020-04-01~2020-08-06)** — 사실: NAVER 시계열의 2020~2022년 최고 종가는 8월 6일에 관찰된다. 해석: 씨젠과 동일 테마의 동반 확산 사례로 읽되 씨젠보다 나중에 상승했다는 후발 순서는 주장하지 않는다. [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **성숙 (2020-08-07~2020-12-31)** — 사실: 9월 3일 IgG 항체 검사 EUA 발급은 FDA 승인서와 당해 연방관보로 확인된다. 연구기간 고점 뒤의 사건이다. 해석: 허가 뉴스가 곧 새 가격 고점이나 지속 성과를 보장하지 않았다는 사후 비교다. 해당 허가는 급성 감염 판정용 PCR와 다르다. [su-fda](https://www.fda.gov/media/141888/download) [su-federal](https://public-inspection.federalregister.gov/2020-25603.pdf?1605793520=) [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **가격 주도 지속 실패 (2021-01-01~2022-12-31)** — 사실: 2021년 알레르기 진단 판매계약이 있었고, 2022년 3월 공개 2021년 매출은 약 772억원이다. 같은 주 가격계열은 2020년 고점을 회복하지 못했다. 해석: 가격 지속 실패와 실적 부재를 구분한다. 제품 다각화와 매출 증가는 있었으며, 비주도 비교는 가격 경로에 국한된다. [su-handok](https://www.handok.co.kr/board/en_pressView?idx=4218) [su-fy21](https://kind.krx.co.kr/external/2022/03/23/000765/20220323003251/11011.htm) [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- **후속 경과 (2023-01-01~2023-06-30)** — 사실: 3월 8일 공고의 2022년 연결 매출은 약 1,014억원이나, 5월 15일 공개 2023년 1분기 연결 매출은 약 15억원·영업손실은 약 66억원이다. 6월 말 가격은 2020년 고점을 크게 밑돈다. 해석: 사후에는 수요 특수 종료 위험과 가격 지속 실패를 함께 검토할 수 있다. 2023년의 실적을 2020~2022년 당시 투자자가 알고 있었다고 서술하지 않는다. [su-fy22](https://kind.krx.co.kr/external/2023/03/08/000416/20230308001292/00591.htm) [su-q123](https://kind.krx.co.kr/external/2023/05/15/002283/20230515005010/11013.htm) [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)

**공개일 기준 사건**

- **2020-09-03 / SGTi-flex IgG EUA 최초 발급** — FDA의 2021-08-11 재발급 승인서가 최초 발급일을 명시한다. 2020년 연방관보도 이를 기록한다. 재발급 파일을 2020년 9월 3일의 원문 그대로라고 표기하지 않았다. [su-fda](https://www.fda.gov/media/141888/download) [su-federal](https://public-inspection.federalregister.gov/2020-25603.pdf?1605793520=)
- **2021-06-30 / 한독과 알레르기 진단제품 판매계약** — 한독의 날짜가 명시된 원문에서 비코로나 진단 분야의 판매 협력을 확인했다. 계약이 발생했다는 사실과 향후 매출 전망을 분리한다. [su-handok](https://www.handok.co.kr/board/en_pressView?idx=4218)
- **2022-03-23 / 2021년 사업보고서 공개** — 연결 매출 77,201,041,452원, 영업이익 34,813,542,443원. 2021년 말 현재 이미 공개된 실적으로 소급하지 않는다. [su-fy21](https://kind.krx.co.kr/external/2022/03/23/000765/20220323003251/11011.htm)
- **2023-03-08 / 2022년 재무제표를 포함한 주총 공고** — 연결 매출 101,399,255,833원·영업이익 24,970,549,363원. 공고의 감사 전 주의문을 함께 적용한다. [su-fy22](https://kind.krx.co.kr/external/2023/03/08/000416/20230308001292/00591.htm)
- **2023-05-15 / 2023년 1분기보고서 공개** — 연결 포괄손익계산서의 매출 1,537,353,252원, 영업손실 6,646,591,135원. 별도재무제표 숫자와 혼합하지 않는다. [su-q123](https://kind.krx.co.kr/external/2023/05/15/002283/20230515005010/11013.htm)

**업종 내부·확산 비교:** 씨젠의 PCR와 수젠텍의 IgG 항체 검사는 검사 목적과 규제상 사용 범위가 다르다. 같은 코로나 테마를 동일한 이익 구조로 취급하지 않는다. 2020년 고점 이후 2021·2022년 연매출은 확대되었지만 가격은 고점을 회복하지 못했으므로, 이 비교의 실패는 가격 주도 지속 실패다. 거래량 0인 2020-03-18·2020-03-30은 수익률 관찰점에서 제외했다. [sg-listing](https://kind.krx.co.kr/external/2022/05/16/002564/20220516005799/11013.htm) [su-fda](https://www.fda.gov/media/141888/download) [su-fy21](https://kind.krx.co.kr/external/2022/03/23/000765/20220323003251/11011.htm) [su-fy22](https://kind.krx.co.kr/external/2023/03/08/000416/20230308001292/00591.htm) [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)

**당시 기준 관찰(미래 결과를 보지 않는 연습)**

- **2021-06-30에 알려진 사실:** 2020년 연방관보에 IgG 항체 검사 EUA의 9월 3일 발급이 기록되어 있었다. 당일 한독 자료에서 알레르기 진단제품 판매계약을 확인할 수 있다. 당시 질문: 코로나 검사 외의 판매 협력이 실제 매출로 이어질까? / 항체 검사 허가를 검사 수요 전체와 같은 크기로 해석해도 될까? [su-federal](https://public-inspection.federalregister.gov/2020-25603.pdf?1605793520=) [su-handok](https://www.handok.co.kr/board/en_pressView?idx=4218)
- **2022-06-30에 알려진 사실:** 3월 23일 사업보고서로 2021년 연결 매출 약 772억원과 영업이익 약 348억원을 확인할 수 있었다. FDA의 2021년 재발급 문서에서 IgG 항체 검사 사용 범위를 확인할 수 있었다. 당시 질문: 검사 종류별·국가별 수요가 얼마나 지속될까? / 코로나 외 진단제품의 매출 비중은 어떻게 달라질까? [su-fy21](https://kind.krx.co.kr/external/2022/03/23/000765/20220323003251/11011.htm) [su-fda](https://www.fda.gov/media/141888/download)

**학습 포인트:** 허가일·허가 범위·재발급일을 각각 기록한다. 후발·비주도·실패라는 말의 기준을 가격·실적·시장순위 중 무엇인지 한정한다. 연매출 증가가 앞선 주가 고점 회복으로 곧바로 이어지지 않을 수 있다.

**사례 한계:** 비교 종목 선택은 사후 표본 선택이다. 같은 테마 전체 승자·실패자 모집단을 비교하지 않았다. 2023년 분기보고서 요약표의 2020년 영업이익 부호가 과거 사업보고서와 달라 그 값은 본 연구에서 사용하지 않았다. 수젠텍을 씨젠의 시간상 후발주 또는 사업 실패 기업으로 확정하지 않는다.

## 기업행사·자료 검증

- 씨젠: 2021-04-08 발표 1:1 무상증자. 회사 배정기준일 4월 26일과 Yahoo 효력일 4월 23일을 구분한다. NAVER 4월 22일 종가 98,000원 → 4월 23일 107,500원으로, 조정 전 가격의 단순 반토막을 하락률로 사용하지 않았다. [sg-bonus](https://kr.seegene.com/media/center-view/234) [price-seegene](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [yahoo-seegene](https://query1.finance.yahoo.com/v8/finance/chart/096530.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits)
- 에코프로비엠: 2022-04-06 공시의 1:3 무상증자는 총 주식 수 기준 4:1이다. NAVER 6월 24일 122,737원 → 6월 27일 133,760원이며 같은 가격 기준으로 계산한다. 유상증자·권리 가격의 정확한 공급자 조정식은 미검증이다. [bm-prospectus](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm) [price-ecoprobm](https://api.finance.naver.com/siseJson.naver?symbol=247540&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [yahoo-ecoprobm](https://query1.finance.yahoo.com/v8/finance/chart/247540.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits)
- 위메이드: 2021-08-30 결정 100% 무상증자는 11월 IR에서 확인된다. Yahoo 효력일 표시는 9월 13일, NAVER 9월 10일 58,700원 → 9월 13일 59,000원이다. [wm-q321](https://irsvc.teletogether.com/wemade/pdf/wemade2021Q3_kor.pdf) [price-wemade](https://api.finance.naver.com/siseJson.naver?symbol=112040&requestType=1&startTime=20190701&endTime=20230630&timeframe=day) [yahoo-wemade](https://query1.finance.yahoo.com/v8/finance/chart/112040.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits)
- 수젠텍: NAVER에서 거래량 0인 2020-03-18·2020-03-30을 제외했다. 정지 사유를 추정하지 않았다. [price-sugentech](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day)
- Yahoo에는 2022-01-03·2022-05-09 가격 행이 없지만 NAVER에는 양의 거래량과 종가가 있다. 주 시계열을 NAVER로 통일하면서 이 누락을 피했고 공급자 간 일자 차이를 보존했다.
- 수젠텍 2023년 분기보고서의 요약표는 2020년 연결 영업이익 부호가 2021년 사업보고서와 다르다. 2020년 매출은 일치하나 영업이익 숫자는 본 연구에서 쓰지 않았다. 2023년 1분기는 요약표 대신 연결 포괄손익계산서 본문을 확인했다. [su-fy21](https://kind.krx.co.kr/external/2022/03/23/000765/20220323003251/11011.htm) [su-q123](https://kind.krx.co.kr/external/2023/05/15/002283/20230515005010/11013.htm)

## 재현·계산 검증

외부 패키지·자격증명 없이 Python 표준 라이브러리로 실행한다. 네트워크 재수집은 공급자의 향후 조정으로 과거값이 달라질 수 있으므로, 제출 당시 결과를 재현하려면 보존한 원응답을 읽는 `--offline`을 쓴다.

```sh
/usr/bin/python3 docs/research/2026-11-08-market-leaders/fetch-kosdaq.py --offline
/usr/bin/python3 docs/research/2026-11-08-market-leaders/kosdaq-build-report.py
/usr/bin/python3 docs/research/2026-11-08-market-leaders/fetch-kosdaq.py --check
```

새 자료 수집: `fetch-kosdaq.py`의 `--offline`을 생략한다. HTTP 요청 URL은 각 series.sourceUrl 및 Yahoo 교차검증 URL에 보존한다. NAVER 원응답은 `kosdaq-naver-종목코드.txt`, Yahoo 원응답은 `kosdaq-yahoo-종목코드.json`, 변환 결과는 `kosdaq-prices.json`, 계산 결과는 `kosdaq-metrics.json`이다.

검증 항목: 4개 종목·기간·중복일·날짜 정렬·양의 종가·거래량 0 제외·원응답 SHA256·고점 탐색·후속 최저 탐색·연말 및 상반기말 하락률 재계산·사례/출처 ID 정합성·asOf에 연결된 출처의 공개일을 점검한다. 부동소수점 계산은 마지막 비율에서만 소수점 6자리로 저장하며 표는 2자리로 표시한다.

고점→최저 식은 `100*(최저 수정종가/고점 수정종가-1)`이다. 예를 들어 위메이드의 237,000원 → 30,050원은 -87.320675%이다. 이 값은 거래비용·세금·권리 행사 현금흐름을 포함한 실현 투자수익률이 아니다.

## 공통 미해결 한계

- NAVER 조정식과 현금배당 처리 명세를 미확보했다. 공급자를 통일해도 지수·종목의 조정 차이가 완전히 없어졌다고 단정할 수 없고, 정밀 총수익률 비교에는 추가 검증이 필요하다.
- 전 종목 모집단·당시 시가총액 가중치·기업행사 전체 원장을 확보하지 않아 상대강도 순위와 지수 상승기여를 계산하지 않았다.
- 거시 환경·수급·밸류에이션과 개별 사건 효과를 분리한 계량 인과분석이 아니다. 뉴스와 주가의 시간적 동행은 원인의 증명이 아니다.
- 자료의 일부는 후속 일차자료가 확인해 주는 과거 공시 이력이며, 각 이벤트의 원 공시 개별 링크를 모두 확보하지 못했다. 확인된 날짜와 한계를 이벤트마다 기재했다.
- 후발주 확산은 수젠텍의 동반 가격 경로, 에코프로비엠 경쟁사 증설, 위메이드맥스 전략 전환 등 확보된 범위로 한정한다. 업종 전체의 후행 주가 확산은 입증하지 않았다.
- 2023년 상반기 실적은 발표 지연 때문에 6월 말에 모두 알려져 있지 않았다. 해당 기간 말일까지 관찰된 가격과 이미 발표된 자료만 경과 설명에 사용했다.

## 실제 열람한 직접 출처

- **sg-listing** — [씨젠 2022년 1분기보고서: 코스닥 상장일·사업](https://kind.krx.co.kr/external/2022/05/16/002564/20220516005799/11013.htm); 씨젠 / 한국거래소 KIND; 공개 2022-05-16; 열람 2026-11-08. 
- **sg-mfds** — [긴급사용승인 코로나19 진단키트 목록](https://www.mfds.go.kr/eng/brd/m_60/view.do?seq=74424); 식품의약품안전처; 공개 2020-03-26; 열람 2026-11-08. 목록 게시일과 승인일(2020-02-12)을 구분
- **sg-q120** — [씨젠 1분기 매출 818억원](https://kr.seegene.com/media/center-view/201); 씨젠; 공개 2020-05-14; 열람 2026-11-08. 본문에 5월 13일 분기보고서 공시를 명시
- **sg-q220** — [씨젠 2분기 영업이익 1,690억원](https://kr.seegene.com/media/center-view/204); 씨젠; 공개 2020-08-13; 열람 2026-11-08. 
- **sg-fy20** — [씨젠 2020년 실적 발표](https://kr.seegene.com/media/center-view/229); 씨젠; 공개 2021-02-18; 열람 2026-11-08. 
- **sg-bonus** — [씨젠 100% 무상증자 결정](https://kr.seegene.com/media/center-view/234); 씨젠; 공개 2021-04-08; 열람 2026-11-08. 
- **sg-q122** — [씨젠 1분기 매출 4,515억원과 PCR 수요 감소 언급](https://kr.seegene.com/media/center-view/276); 씨젠; 공개 2022-05-16; 열람 2026-11-08. 실적 공시일은 본문에서 5월 13일로 확인; 수요 관련 발언은 게시일 기준으로 보수적으로 사용
- **sg-fy22** — [씨젠 2022년 잠정 실적](https://kr.seegene.com/media/center-view/284); 씨젠; 공개 2023-02-17; 열람 2026-11-08. 당시 잠정치 사용; 후속 감사 수치와 혼합하지 않음
- **bm-prospectus** — [에코프로비엠 증권신고서: 계약·무상증자·화재·경쟁](https://kind.krx.co.kr/external/2022/04/06/000659/20220406001886/10001.htm); 에코프로비엠 / 한국거래소 KIND; 공개 2022-04-06; 열람 2026-11-08. 상장일, 공시 이행현황의 과거 발표일, 계약 체결일과 공개일 차이, 유무상증자 계획 확인
- **bm-contract20** — [에코프로비엠 2.74조원 공급계약 공시 당시 보도](https://www.hankyung.com/article/202002035339L); 한국경제 / 한경로보뉴스; 공개 2020-02-03; 열람 2026-11-08. 보조자료: 당일 공시 보도와 후속 증권신고서 교차확인
- **bm-contract21** — [에코프로비엠 10조원 공급계약 공시 당시 보도](https://www.newsis.com/view/NISX20210909_0001577309); 뉴시스; 공개 2021-09-09; 열람 2026-11-08. 보조자료: 고객명·공시일·원재료 가격에 따른 금액 변동 조건
- **bm-fy22** — [에코프로 그룹 2022년 잠정 실적과 에코프로비엠 실적](https://www.ecoprobm.com/sub0701/view/page/3/id/1064); 에코프로비엠 / 에코프로; 공개 2023-02-03; 열람 2026-11-08. 지주회사 수치와 에코프로비엠 연결 수치를 구분
- **wm-listing** — [위메이드 신규상장 공고](https://kind.krx.co.kr/external/2009/12/16/000683/20091216001127/70760.htm); 한국거래소 KIND; 공개 2009-12-16; 열람 2026-11-08. 
- **wm-launch** — [MIR4 글로벌 출시 당일 회사 보도자료](https://www.newswire.co.kr/newsRead.php?no=929269); 위메이드 / Korea Newswire; 공개 2021-08-26; 열람 2026-11-08. 
- **wm-q321** — [위메이드 2021년 3분기 실적발표](https://irsvc.teletogether.com/wemade/pdf/wemade2021Q3_kor.pdf); 위메이드 IR; 공개 2021-11-03; 열람 2026-11-08. 글로벌 출시, 8월 30일 무상증자 결정, 9월 1일 위메이드맥스 전략 전환, 사업 지표
- **wm-q122** — [위메이드 2022년 1분기 실적 공시 보도](https://www.yna.co.kr/view/AKR20220511030451527); 연합뉴스; 공개 2022-05-11; 열람 2026-11-08. 보조자료: 해당 분기 IR 원문 다운로드 미확보; 공시 수치를 전한 당일 기사 사용
- **wm-end** — [WEMIX 거래지원 종료 공지](https://coinone.co.kr/info/notice/1971); 코인원 / DAXA; 공개 2022-11-24; 열람 2026-11-08. 19:40 게시; 종료 결정과 시행일(2022-12-08 15:00)을 구분. 사유는 거래소 측 판단
- **wm-fy22** — [위메이드 2022년 4분기 및 연간 실적발표](https://irsvc.teletogether.com/wemade/pdf/wemade2022Q4_kor.pdf); 위메이드 IR; 공개 2023-02-15; 열람 2026-11-08. 감사 전 잠정 실적; 이후 정정 수치와 섞지 않음
- **wm-relist** — [WEMIX 코인원 원화마켓 거래지원 재개 공지](https://coinone.co.kr/info/notice/2057); 코인원; 공개 2023-02-16; 열람 2026-11-08. 위메이드 주식 상장이 아니라 토큰 거래지원
- **su-listing** — [수젠텍 2021년 반기보고서: 코넥스에서 코스닥 이전](https://kind.krx.co.kr/external/2021/08/13/001605/20210813004467/11012.htm); 수젠텍 / 한국거래소 KIND; 공개 2021-08-13; 열람 2026-11-08. 
- **su-fda** — [SGTi-flex COVID-19 IgG FDA EUA 승인서 재발급](https://www.fda.gov/media/141888/download); 미국 FDA; 공개 2021-08-11; 열람 2026-11-08. 최초 EUA 발급 2020-09-03, 2021-04-23 재발급, 2021-08-11 개정. 현행 다운로드 파일의 첫 페이지 날짜 확인
- **su-federal** — [FDA EUA 목록의 미국 연방관보 게재](https://public-inspection.federalregister.gov/2020-25603.pdf?1605793520=); 미국 FDA / Federal Register; 공개 2020-11-20; 열람 2026-11-08. 2020-09-03 최초 EUA 발급을 사후 확인하는 당해연도 정부 기록
- **su-handok** — [한독·수젠텍 알레르기 진단제품 국내 판매계약](https://www.handok.co.kr/board/en_pressView?idx=4218); 한독; 공개 2021-06-30; 열람 2026-11-08. 
- **su-fy21** — [수젠텍 2021년 사업보고서](https://kind.krx.co.kr/external/2022/03/23/000765/20220323003251/11011.htm); 수젠텍 / 한국거래소 KIND; 공개 2022-03-23; 열람 2026-11-08. 웹 도구 재열람 일부 timeout, urllib 직접 열람으로 연결 매출·이익 확인
- **su-fy22** — [수젠텍 2023년 주주총회소집공고의 2022년 재무제표](https://kind.krx.co.kr/external/2023/03/08/000416/20230308001292/00591.htm); 수젠텍 / 한국거래소 KIND; 공개 2023-03-08; 열람 2026-11-08. 감사 전 재무제표라는 공고 주의문 포함
- **su-q123** — [수젠텍 2023년 1분기보고서](https://kind.krx.co.kr/external/2023/05/15/002283/20230515005010/11013.htm); 수젠텍 / 한국거래소 KIND; 공개 2023-05-15; 열람 2026-11-08. 연결 포괄손익계산서 본문 기준 사용; 요약표의 2020년 영업이익 부호와 2021년 사업보고서 부호가 달라 2020년 영업이익은 채택하지 않음
- **yahoo-definition** — [Yahoo adjusted close의 분할·배당 조정 정의](https://in.help.yahoo.com/kb/adjusted-close-sln28256.html); Yahoo Help; 공개 날짜 미표시/응답자료; 열람 2026-11-08. Yahoo는 기업행사 교차검증에만 사용; 주 시계열은 NAVER
- **price-seegene** — [씨젠 NAVER 일별 종가 응답](https://api.finance.naver.com/siseJson.naver?symbol=096530&requestType=1&startTime=20190701&endTime=20230630&timeframe=day); NAVER Finance; 공개 날짜 미표시/응답자료; 열람 2026-11-08. urllib 직접 열람·원응답 저장. 공급자 조정식과 현금배당 처리 명세 미확보
- **yahoo-seegene** — [씨젠 Yahoo chart 기업행사 응답](https://query1.finance.yahoo.com/v8/finance/chart/096530.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits); Yahoo Finance; 공개 날짜 미표시/응답자료; 열람 2026-11-08. urllib 직접 열람·원응답 저장. 주 가격 데이터와 혼합하지 않음
- **price-ecoprobm** — [에코프로비엠 NAVER 일별 종가 응답](https://api.finance.naver.com/siseJson.naver?symbol=247540&requestType=1&startTime=20190701&endTime=20230630&timeframe=day); NAVER Finance; 공개 날짜 미표시/응답자료; 열람 2026-11-08. urllib 직접 열람·원응답 저장. 공급자 조정식과 현금배당 처리 명세 미확보
- **yahoo-ecoprobm** — [에코프로비엠 Yahoo chart 기업행사 응답](https://query1.finance.yahoo.com/v8/finance/chart/247540.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits); Yahoo Finance; 공개 날짜 미표시/응답자료; 열람 2026-11-08. urllib 직접 열람·원응답 저장. 주 가격 데이터와 혼합하지 않음
- **price-wemade** — [위메이드 NAVER 일별 종가 응답](https://api.finance.naver.com/siseJson.naver?symbol=112040&requestType=1&startTime=20190701&endTime=20230630&timeframe=day); NAVER Finance; 공개 날짜 미표시/응답자료; 열람 2026-11-08. urllib 직접 열람·원응답 저장. 공급자 조정식과 현금배당 처리 명세 미확보
- **yahoo-wemade** — [위메이드 Yahoo chart 기업행사 응답](https://query1.finance.yahoo.com/v8/finance/chart/112040.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits); Yahoo Finance; 공개 날짜 미표시/응답자료; 열람 2026-11-08. urllib 직접 열람·원응답 저장. 주 가격 데이터와 혼합하지 않음
- **price-sugentech** — [수젠텍 NAVER 일별 종가 응답](https://api.finance.naver.com/siseJson.naver?symbol=253840&requestType=1&startTime=20190701&endTime=20230630&timeframe=day); NAVER Finance; 공개 날짜 미표시/응답자료; 열람 2026-11-08. urllib 직접 열람·원응답 저장. 공급자 조정식과 현금배당 처리 명세 미확보
- **yahoo-sugentech** — [수젠텍 Yahoo chart 기업행사 응답](https://query1.finance.yahoo.com/v8/finance/chart/253840.KQ?period1=1561939200&period2=1688169600&interval=1d&events=div%2Csplits); Yahoo Finance; 공개 날짜 미표시/응답자료; 열람 2026-11-08. urllib 직접 열람·원응답 저장. 주 가격 데이터와 혼합하지 않음
