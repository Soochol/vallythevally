# 네이버 재무 화면의 과거 분기 확보 가능성

확인일 **2026-11-08**. 결론: 이번에 검증한 경로만으로는 **2020~2022 보고서의 단독 재무 원천으로 부적합**하다. 최근 재무 응답과 실제 공급자 연결은 확인했지만, 해당 기간의 분기 자료·공개일·정정 전 값을 확보하지 못했다. 이는 네이버에 과거 조회 기능이 전혀 없다는 결론과 다르다. 화면용 응답은 공식 지원 API로 부르지 않는다. 기존 HTML·코드·입력 데이터는 변경하지 않았다.

**기존 표본 재검토.** 부모가 보존한 `research-naver-finance-probe.json`, `research-naver-quarter-sample.json`을 읽었다. [삼성전자 분기 응답][Q]은 HTTP 200, 2025.06~2026.09의 6개 열이며 마지막 열은 `isConsensus=Y`다. [연간][Y]은 2023.12~2026.12의 4개 열이고 마지막은 예상이다. NAVER·씨젠의 보존 분기 응답도 같은 기간이다. [날짜 인자 시험][T]은 과거 값 대신 같은 최근 기간을 반환했다. 이 결과는 시험한 인자의 효력이 확인되지 않았다는 뜻이며, 다른 과거 조회 수단의 부재를 증명하지 않는다. 이 네트워크 시험은 부모 기록을 재검토한 것이며 이번에 반복 호출하지 않았다.

**현재 화면 추적은 성공했다.** 구 PC 기업분석 [coinfo.naver][C]를 무인증 GET하자 현재 [기업현황][N]으로 이동해 HTTP 200을 반환했다. HTML의 `coinfo_cp` iframe은 `navercomp.wisereport.co.kr/v3/company/c1010001.aspx`를 가리켰다. 현재 페이지가 실제 참조하는 [네이버 화면 스크립트][S]도 HTTP 200으로 읽었으며 `financial → c1030001`, `company → c1010001`, `consensus → c1050001`의 연결을 확인했다. 이 중 필요한 **재무분석 경로 하나만** 따라갔다.

| 실제 확인 경로 | 성공/실패 | 확인한 범위·남은 공백 |
|---|---|---|
| [네이버 재무분석][F] | HTTP 200 | `coinfo_cp`가 아래 Wisereport 재무분석을 가리킴. 네이버 외곽 HTML의 응답 성공은 재무 표 확보 성공이 아님 |
| [Wisereport v3 재무분석][W] | 실패: 연결 재설정 `Errno 104` | 기간 선택·연결/별도·분기/누적·실적/예상 표시를 직접 읽지 못함 |
| [Wisereport v3 기업현황][I] | 실패: 같은 연결 재설정 | 공급자 본문과 추가 조회 스크립트를 확보하지 못함. 웹 열람 도구도 접근 실패 |
| [검색에 노출된 공급자 기업개요][O] | 실패: 직접 GET 연결 재설정, 웹 도구 502 | 검색 요약의 과거 연간 연구개발비는 과거 분기 재무 조회의 검증 자료로 사용하지 않음 |

Wisereport는 현재 네이버가 연결하는 **외부 기업분석 경로**임을 확인했다. 다만 그 내부의 과거 기간 선택 기능과 FnGuide 제공 표기는 이번 직접 본문 열람으로 재확인하지 못했다. 오래된 이용 글은 발견 단서로만 사용했다. 실패 원인이 인증·차단 정책인지 통신 문제인지도 미확인이고, 헤더 위장·쿠키/인증 사용·차단 우회·무작위 URL 탐색이나 반복 재시도는 하지 않았다.

**차트에 쓰기 전 구분할 사항.** 보존된 모바일 표본은 매출·영업이익·영업이익률·EPS·PER 등을 포함하지만 영업현금흐름 행은 없다. 회계기간 키와 예상 표시가 있을 뿐 `published_at`, 접수번호, 정정 이력, 명시적인 연결/별도·누적 구분 필드를 확인하지 못했다. 따라서 예상 열은 실적과 분리하고, 분기 숫자의 성격을 원문과 대조하기 전 YoY·TTM·Q4 차액을 생성하면 안 된다. 회계기간 말일을 공개일로 간주해서도 안 된다. 숫자 누락을 0으로 채우지 않는다.

**실제 확보한 2020~2022 분기 관측값은 이번 조사에서 0개**다. 추가 검토 후보는 관측된 재무분석 iframe의 정상 화면에서 기간·재무기준 선택과 실제 요청을 확인하는 절차다. 현재 그 화면을 읽지 못했으므로 작동하는 과거 요청 형식을 제시할 수 없다. 네이버 자료는 최근 화면 확인·교차검증 후보로 두고, 본 보고서의 과거 수치와 당시 시점 재현은 별도로 보존한 기업 IR·DART 원문 및 발표일로 뒷받침하는 편이 적절하다. 주가 원인이나 예측력을 검증한 조사는 아니다.

[Q]: https://m.stock.naver.com/api/stock/005930/finance/quarter
[Y]: https://m.stock.naver.com/api/stock/005930/finance/annual
[T]: https://m.stock.naver.com/api/stock/005930/finance/quarter?startTime=20190101&endTime=20231231&year=2021
[C]: https://finance.naver.com/item/coinfo.naver?code=005930
[N]: https://stock.naver.com/domestic/stock/005930/info/company
[S]: https://ssl.pstatic.net/imgstock/fn/real/pc/_next/static/chunks/app/domestic/stock/%5Bcode%5D/info/%5Bsection%5D/page-116f71bd2ade3072.js
[F]: https://stock.naver.com/domestic/stock/005930/info/financial
[W]: https://navercomp.wisereport.co.kr/v3/company/c1030001.aspx?cmp_cd=005930&theme=light&cn=
[I]: https://navercomp.wisereport.co.kr/v3/company/c1010001.aspx?cmp_cd=005930&theme=light&cn=
[O]: https://navercomp.wisereport.co.kr/company/c1020001.aspx?cmp_cd=005930&cn=
