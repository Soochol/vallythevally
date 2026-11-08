# 네이버 증권을 통한 재무·시장 자료 확보 조사

확인일: 2026-11-08. 기존 HTML·코드·차트 입력을 수정하지 않았다. 부모는 무인증 소량 HTTP 표본을 직접 확인했고 기존 워커 세 개가 과거 재무, 시장자료, 재무 의미·출처를 나누어 조사했다.

## 결론

현재 화면용 응답에서 최근 재무·현재 시장 지표를 읽을 수 있고, 지수 가격은 연구 기간 전체의 보존 자료가 있다. 그러나 이번 조사에서 네이버를 통해 확보한 2020~2022 분기 재무 값은 없으며 최초 공개일·정정 버전도 복원하지 못했다. 네이버만으로 과거 재무·시장환경을 모두 충족한다고 할 수 없다. 이 경로는 문서화된 공식 지원 API로 확인되지 않았다.

또한 네이버 공식 FAQ는 서비스 화면 직접 열람 외의 개인 프로그램·웹페이지 재가공과 제3자 재배포를 금지한다고 안내한다. 응답의 기술적 접근 가능성과 보고서에 재사용할 수 있는 이용 조건을 분리해야 한다. 신규 HTML 재무·시장 데이터의 주 수집원으로 채택하는 안은 권하지 않는다. 기존 보고서에 포함한 NAVER 가격도 이 안내를 확인하기 전에 사용한 것이므로, 외부 공유·추가 확장 시 사용 조건이 확인된 원천으로 대체할 범위를 검토해야 한다. 이번에는 기존 자료를 삭제·변경하지 않았다.

공식 안내: https://help.pay.naver.com/faq/content.help?faqId=17106

## 실제 확인한 방법과 범위

| 자료 | 화면/응답 경로 | 이번 검증 |
|---|---|---|
| 최근 분기 재무 | https://m.stock.naver.com/api/stock/005930/finance/quarter | 삼성전자 6열·16행, 2025.06~2026.09, 마지막 열 isConsensus=Y. NAVER·씨젠도 최근 동일 기간. |
| 최근 연간 재무 | https://m.stock.naver.com/api/stock/005930/finance/annual | 2023.12~2026.12 4열, 마지막 열 예상. |
| 과거 분기 재무 | 현재 기업분석→Wisereport 재무분석 iframe | 연결은 확인, 공급자 본문은 연결 재설정/502로 실패. 과거 기간 선택·응답 미확인. |
| 지수 일별 가격 | https://api.finance.naver.com/siseJson.naver?symbol=KOSPI&requestType=1&startTime=20190701&endTime=20230630&timeframe=day | 기존 KOSPI/KOSDAQ 일별 각각990개, 2019-07~2023-06. |
| 지수 페이지네이션 | https://m.stock.naver.com/api/index/KOSPI/price?pageSize=3&page=400 | 2021-12-13·10·09 세 행 실제 반환. 전체페이지 완전성은 미검증. |
| 기준금리 회의 일정/결과 | https://stock.naver.com/api/securityService/marketindex/standardInterest/KOR/calendars?page=15&pageSize=3 | 2021년 3개 회의 결과 반환. 효력일 기준 일별 이력 또는 당시 최초 공개본을 보증하지 않음. |
| 시장 수급·거래대금 | https://m.stock.naver.com/domestic/index/KOSPI/total 및 KOSDAQ 화면 hydration | 현재 값과 필드는 확인, 2020~2022 이력·일부 수급 단위는 미확인. |
| 원달러·국고채 | 시장지표 화면의 실제 노출 요청 | 환율 현재 요약만 확인. 시험한 과거 환율 요청400, 한국국채 요청500; 전체 제공 불가를 뜻하지 않음. |

모바일 재무의 financeInfo.trTitleList에 기간과 예상 여부, rowList에 지표와 columns 값이 있다. 헤더의 기간순서대로 columns 키를 대응시켜야 하며 객체 키 순서에 의존하지 않는다. 단위·연결/별도·누적/단독분기·연환산 성격은 원문과 대조해야 한다. Y열 제외만으로 당시 실적을 입증할 수 없고, N은 최초 공시본이나 감사 완료라는 뜻이 아니다. 표본에는 공개시각·접수번호·정정 이력이 없다.

과거 연도와 날짜 인자를 붙인 부모 표본 요청은 최근 응답과 같은6열을 반환했다. 시험한 인자가 적용되지 않았다는 사실만 확인했으며 다른 과거 조회 수단이 전혀 없음을 증명하지 않는다. 접근 실패 뒤 헤더/인증을 변경해 차단을 우회하지 않았다.

## 보고서에 적용할 원천 제안

네이버 화면은 최신 수치와 표시 방식의 참고·대조 대상으로 두고, 분기 재무는 기업 IR·DART 원문과 공개일/정정본, 시장 금리·환율은 한국은행 ECOS/공식 발표 이력, 지수·시장 수급은 이용 조건이 확인된 거래소·공급자 자료를 우선한다. 이 조사는 대체 원천의 이용허락을 일괄 보증하지 않는다.

## 상세 조사와 표본

- [과거 재무 경로](research-naver-financial-history.md)
- [시장자료 경로](research-naver-market-data.md)
- [재무 의미·공식 안내](research-naver-finance-semantics.md)
- [부모 HTTP 검사 기록](research-naver-finance-probe.json)
- [최근 분기 응답 표본](research-naver-quarter-sample.json)
