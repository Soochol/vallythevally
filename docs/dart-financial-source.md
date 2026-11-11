# DART 재무 원자료 수집

`financials` 모듈은 #159의 회사별 원자료 저장소다. #160의 지표 계산은 여기서 하지 않는다. `OPENDART_API_KEY`는 선택 설정이며 `VALLY_ENV_FILE` 또는 프로세스 환경에서 읽는다. 키가 없으면 가격 API는 계속 동작하고 재무 응답은 `not_configured`다.

## 접근과 수명

- `GET /api/symbols/{code}/financial-source`: 저장 자료와 상태를 읽고, 첫 접근 또는 KST 날짜가 바뀐 첫 접근에서 백그라운드 수집을 시작한다.
- 같은 경로의 `POST`: 수동 갱신이다. 진행 중인 회사 수집과 합쳐진다.
- `Financials::open`: 후속 계산 API가 같은 수집기를 사용할 Rust 인터페이스다. 거래소는 인자로 받지 않는다.
- `VALLY_FINANCIAL_DB_PATH`: 독립 SQLite 파일이다. 기본은 사용자 DB와 같은 디렉터리의 `financials.db`다. 이 파일은 삭제하고 다시 수집할 수 있다. 사용자 원본 DB 마이그레이션에는 참여하지 않는다.
- `VALLY_DART_BASE_URL`과 `VALLY_KIND_BASE_URL`: 기본은 각 공식 HTTPS 호스트다. 시험에서는 HTTP 루프백으로 바꿀 수 있다. 리다이렉트는 따르지 않는다.

시작할 때 전 종목의 재무를 수집하지 않는다. 요청한 회사의 2015년부터 현재 사업연도까지 4개 보고서 구분을 조회하고 배당은 사업보고서 구분만 조회한다. DART 전송 간격은 최소 250ms다. 회사코드별 수집 하나만 실행하고 보고서 하나가 끝날 때마다 저장하므로, 중간 결과를 읽고 재시작 후 이어 받을 수 있다.

`last_checked_at`은 공시 목록을 끝까지 성공적으로 확인한 시각이다. `last_attempt_at`은 수집을 시작한 시각이며, 각 요청의 `checked_at`은 시도 시각이고 `last_success_at`은 마지막 성공 시각이다. 실패 후에도 마지막 성공 시각은 유지된다. 실패 또는 미완료 구간은 다음 접근에서 60초 간격으로 재시도하며 수동 갱신은 이 간격을 기다리지 않는다. 매일 미공시 구간을 다시 확인한다. 공시 목록의 변화가 있으면 과거 정정 누락을 막기 위해 해당 회사의 보고서 구분들을 재조회한다. 공시 목록은 `last_reprt_at=N`과 페이지 검증으로 정정 전후 식별을 보존한다.

## 회사와 주식 종류

[공식 고유번호 목록](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019018)의 `stock_code` 정확 일치로 회사를 찾고 [기업개황](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019002)으로 회사와 현재 결산월을 확인한다. 정확 일치가 없으면 [KRX KIND 종합정보](https://kind.krx.co.kr/corpdetail/totalinfo.do?method=loadInitPage)가 사용하는 `/common/searchcorpname.do?method=searchCorpNameJson`의 명시적 `repisusrtcd2`·`fssunqno` 연결을 확인한다. 여러 후보이거나 정확 일치가 없으면 `company_mapping_unverified`다. 종목명 유사도나 코드 끝자리를 사용하지 않는다.

관측일은 2026-11-11이다. 공개 공식 조회 결과는 다음과 같다.

| 요청 | 실제 관측 |
|---|---|
| [KIND 보통주 `005930` 조회](https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005930) | `repisusrtcd2=005930`, `fssunqno=00126380` |
| [KIND 우선주 `005935` 조회](https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005935) | 빈 목록 |
| [KIND 우선주 전체 검색](https://kind.krx.co.kr/common/searchcorpnameall.do?method=searchCorpNameAllJson&searchCodeType=number&searchCorpName=005935) | 빈 목록 |
| [KIND 우선주 자동완성](https://kind.krx.co.kr/common/akc.jsp?q=005935&s=1) | 빈 목록 |

실제 `005935` 연결은 검증하지 못했다. KIND가 요청과 다른 대표 보통주를 반환해도 연결하지 않는다. 회사 매핑 미확인은 해당 종목에만 적용하며, 이미 검증된 회사·기간의 저장 자료를 비우지 않는다. 합성 fixture의 연결 성공은 응답 형식과 분기 처리를 검증하며 실제 우선주 지원을 실증하지 않는다. 추가 자격증명을 요구하는 KRX 서비스는 사용하지 않는다. 일반 우선주의 공식 실연결은 [후속 작업 #167](https://github.com/Soochol/vallythevally/issues/167)에서 검증한다.

회사 재무는 회사코드로 공유한다. 배당 원문의 `stock_knd`와 종목의 주식 종류는 별도로 보존한다. 회사 연결만 확인된 우선주는 세부 배당 종류가 확인된 것으로 간주하지 않고 `preferred_issue_class_unverified`를 남긴다. 종류를 확인하지 못한 DPS를 보통주 값으로 채우면 안 된다.

## 실제 보고기간 검증

[전체 재무제표 API](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)의 사업연도·보고서 구분·당기명은 실제 날짜 구간을 뜻하지 않는다. 모든 원계정 필드, 통화, 접수번호와 요청의 연결/별도 기준을 보존하고, [접수번호별 XBRL 원본](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019019)을 보강한다.

검증은 같은 접수번호의 [공시 목록](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001)에 적힌 보고서명의 보고월과 XBRL context의 실제 날짜를 대조한다. 보고서명에서 날짜를 만들어 내지 않고, 실제 context 종료일이 그 보고월에 들어오는지만 확인한다. 계정 ID의 namespace·이름, 회사 식별자, 연결/별도 dimension, 통화 unit, 정확한 금액도 일치해야 한다. 상세 dimension이나 비표준 계정, 모호한 context는 추측하지 않는다.

`current_period`와 `cumulative_period`는 각각 `thstrm_amount`와 `thstrm_add_amount`에 대응한다. 재무상태표는 instant, 손익계산서의 분·반기 당기금액은 실제 3개월 duration을 요구한다. CF는 3개월로 가정하지 않고 원본 duration을 쓴다. 연간 및 짧아진 기간도 실제 시작·종료일을 보존하며 임의로 늘리거나 합산하지 않는다.

`verified`에는 실제 기간/시점과 context ID·원본 파일명·접수번호가 있다. `unverified`는 원금액과 함께 `matching_context_missing`, `ambiguous_context`, `report_period_anchor_missing`, `receipt_mismatch` 등의 사유를 남긴다. 후속 계산은 검증된 기간만 사용해야 한다. 원문이 실패하면 원자료와 실패 상태를 남기고, 기존 성공 자료가 있으면 그 자료를 유지한다.

배당은 [공식 `alotMatter` 응답](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS002&apiId=2019005)의 `stlm_dt`를 결산기준일로 보존한다. 응답 자체에는 사업연도가 없으므로 요청한 사업연도·사업보고서 구분은 상위 `Report`가 가진다. 결산기준일이 없거나 잘못되면 `dividend_settlement_date_unverified`이며, 현재 결산월로 채우지 않는다.


## 실패 계약

연결 응답 `013`만 별도 조회로 이어진다. 인증·네트워크·한도·잘못된 응답은 별도로 전환하지 않는다. 양쪽이 `013`이면 `absent`다. 계정이 없는 것과 보고서 자체가 없는 것은 원문 목록과 `absent`로 구분할 수 있다. `Fetch.data`는 마지막 성공 자료이고 `failure`가 함께 있으면 갱신에 실패한 저장 자료다. 없는 금액을 0으로 바꾸지 않는다.

인증키는 저장 모델에 없으며 원문에 반사된 값도 제거한다. 외부 오류 메시지·요청 URL을 응답과 로그에 쓰지 않는다. reqwest의 debug/trace 로그는 인증키가 든 URL을 남길 수 있어 필터에서 차단한다.

시험은 `crates/server/tests/financials.rs`의 합성 DART·XBRL·KIND 응답과 fake-kiwoom으로 수행한다. 실제 인증 API나 사용자 서버를 호출하지 않는다.
