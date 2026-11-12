# DART 재무 원자료 수집

`financials` 모듈은 #159의 회사별 원자료 저장소다. #160의 지표 계산은 여기서 하지 않는다. `OPENDART_API_KEY`는 선택 설정이며 `VALLY_ENV_FILE` 또는 프로세스 환경에서 읽는다. 키가 없으면 가격 API는 계속 동작하고, 정상 저장소의 기존 자료는 `not_configured` 상태로 읽는다. 재무 저장소를 열지 못하면 재무 응답만 `failed`와 `storage` 실패를 표시한다.

## 접근과 수명

- `GET /api/symbols/{code}/financial-source`: SQLite의 저장 자료와 상태만 읽는다. 회사 연결도 외부에서 확인하지 않으며, 업데이트 전 자료는 `not_collected`다.
- `GET /api/financial-update`: 전체 작업의 저장된 대상·진행·실패·마지막 확인을 읽는다. 재시작 후 미완료 작업은 `interrupted`로 표시한다.
- `POST /api/financial-update`: 코스피·코스닥 지원 종목 전체의 회사를 공식 규칙으로 확인하고 회사번호로 합쳐 최근 자료를 업데이트한다. 실행 중 반복 시작은 하나로 합친다. 중단된 작업은 저장된 범위와 완료 지점을 이어 쓴다.
- 기존 원자료·계산 API의 `POST`도 같은 전체 작업을 시작한다. 종목별 별도 수집 경로를 만들지 않는다.
- `Financials::read`: 후속 계산 API가 사용하는 저장 자료 조회 인터페이스다. 거래소는 인자로 받지 않는다.
- `VALLY_FINANCIAL_DB_PATH`: 독립 SQLite 파일이다. 기본은 사용자 DB와 같은 디렉터리의 `financials.db`다. 이 파일은 삭제하고 다시 수집할 수 있다. 사용자 원본 DB 마이그레이션에는 참여하지 않는다.
- `VALLY_DART_BASE_URL`과 `VALLY_KIND_BASE_URL`: 기본은 각 공식 HTTPS 호스트다. 시험에서는 HTTP 루프백으로 바꿀 수 있다. 리다이렉트는 따르지 않는다.

서버 기동이나 차트 조회는 수집을 시작하지 않는다. 명시적으로 시작한 전체 작업은 올해를 포함한 최근 3개 사업연도와 비교 계산에 필요한 앞선 한 해의 보고서를 채운다. 이미 저장한 과거 보고서의 정정도 확인한다. 2015년 이후 전체 과거 채우기·사용자 일시정지·자동 일정은 후속 티켓의 범위다. DART 전송 간격은 최소 250ms이며 회사번호별 수집 하나만 실행한다.

전체 작업은 `financial_update`에 대상 종목과 공식 매핑 결과·회사별 완료 지점·실패를 저장한다. 보고서 하나가 끝날 때마다 원자료도 저장한다. 저장 실패는 `failed/storage`로 표시하고 저장하지 못한 완료 수를 반환하지 않는다. 회사별 원천 실패는 기록하고 다른 회사를 계속 처리한다. 미지원 상품·공식 회사 연결 미확인·배당 주식 종류 미확인은 별도 수로 제공한다. 공통 창의 마지막 확인은 전체 작업의 마지막 종료 시각이며, 새 작업 중에도 이전 확인 시각을 유지한다.

회사 `last_checked_at`은 공시 목록을 끝까지 성공적으로 확인한 시각이다. `last_attempt_at`은 수집을 시작한 시각이며, 각 요청의 `checked_at`은 시도 시각이고 `last_success_at`은 마지막 성공 시각이다. 실패 후에도 마지막 성공 시각은 유지된다. 수동 업데이트는 새 공시·정정·누락·실패한 자료를 받고 변경 없는 정상 보고서는 다시 받지 않는다. 공시 목록은 `last_reprt_at=N`과 페이지 검증으로 정정 전후 식별을 보존한다.

`Collection.refresh_version`은 공시 목록 변경이나 수동 갱신으로 요청한 세대다. `Collection.disclosure_version`은 목록 snapshot 커밋까지 끝난 세대이며 `Fetch.refresh_version`은 해당 재무제표·배당 요청이 마지막으로 성공한 세대다. 수동 요청 세대를 먼저 저장하고 새 목록과 목록 완료 세대를 함께 커밋한 뒤 보고서를 갱신한다. 목록 커밋 전 저장이 실패하면 요청 세대와 목록 완료 세대의 차이로 재시작 후 목록부터 다시 받는다. 목록을 커밋한 뒤 일부 보고서만 처리했어도 남은 보고서 요청을 이어 받는다. `last_checked_at`만으로 회사 전체 갱신 완료를 판정하지 않는다. 미완료 저장 자료는 `stale`, 갱신 실패가 남은 자료는 `partial_failure`다.

`Fetch.validated_version`은 저장 자료가 함께 사용 가능한 것으로 확인된 공시 목록 세대다. 변경 없는 보고서를 재사용할 때는 이 검증 세대만 올리고 실제 `refresh_version`·`checked_at`·`last_success_at`은 바꾸지 않는다. 재사용할 값들의 검증 세대는 묶어서 확정하므로, 다른 요청의 재시도를 기다리는 중에도 그대로인 비교자료끼리 세대가 갈라져 차트 값이 끊기지 않는다. 기존 저장 자료에 검증 세대가 없으면 실제 성공 세대를 사용한다. 계산 입력의 실제 성공 세대가 달라도 함께 검증된 목록 세대가 같으면 사용할 수 있으며, 검증 세대가 다른 입력을 섞어 계산하지 않는다.

기존 자료에 정정이 있으면 새 자료를 `Collection.staged_reports`에 저장하고, `Collection.reports`에는 마지막 일관된 자료를 유지한다. 갱신 중의 시도 시각·실패는 기존 자료에도 표시하며, 새로 받은 자료와 재사용한 비교자료가 모두 같은 공시 목록에서 확인되면 한 번에 표시 자료로 확정한다. 세대 필드가 없던 기존 자료에서도 접수번호가 최신 정정에 대응하는지 함께 확인하며, 기본 세대가 같다는 이유로 옛 값과 새 값을 섞지 않는다. 일부 실패나 서버 재시작에도 갱신 중 성공 자료를 보존하므로 정상적으로 받은 보고서를 다시 받지 않고 실패분만 이어 받는다. 최초 수집은 기존처럼 확인된 보고기간부터 표시한다.

저장 보고서의 접수번호와 연결되지 않는 공시가 있으면 `Collection.unpublished_check_version`에 그 확인 세대를 남기고, 미공시로 남아 있던 요청도 다시 확인한다. 정정된 보고서의 재무제표·배당 중 한쪽이 미공시였으면 그 요청도 함께 재확인한다. 회사의 결산월로 과거 사업연도·보고기간을 추측해 요청을 제외하지 않는다. 알려진 정상 보고서에 대응하는 정정만 있으면 다른 정상 보고서나 관련 없는 미공시 요청을 모두 다시 받지 않는다. 미공시 구간을 매일 무조건 재조회하는 대신, 공시 목록에 아직 자료와 연결되지 않는 보고서가 남았는지 확인한다.

세대 필드가 없는 기존 저장 자료도 읽는다. 저장한 최신 목록과 기존 접수번호가 어긋나면 해당 요청을 다시 받는다. 정상 읽기마다 모든 연도를 다시 조회하지 않는다. 목록 조회가 실패하면 다음 명시적 업데이트에서 다시 확인한다. 목록 원천이나 목록 커밋이 실패한 동안에는 이전 보고서의 verified 자료·접수번호·실제 기간·성공 시각·성공 세대를 유지한다. 미완료 목록 대신 옛 목록으로 새 보고서를 성공 처리하지 않는다.

## 회사와 주식 종류

[공식 고유번호 목록](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019018)의 `stock_code` 정확 일치로 회사를 찾고 [기업개황](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019002)으로 회사와 현재 결산월을 확인한다. 정확 일치가 없으면 [KRX KIND 종합정보](https://kind.krx.co.kr/corpdetail/totalinfo.do?method=loadInitPage)가 사용하는 `/common/searchcorpname.do?method=searchCorpNameJson`의 명시적 `repisusrtcd2`·`fssunqno` 연결을 확인한다. 여러 후보이거나 정확 일치가 없으면 `company_mapping_unverified`다. 종목명 유사도나 코드 끝자리를 사용하지 않는다.

관측일은 2026-11-11이다. 공개 공식 조회 결과는 다음과 같다.

| 요청 | 실제 관측 |
|---|---|
| [KIND 보통주 `005930` 조회](https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005930) | `repisusrtcd2=005930`, `fssunqno=00126380` |
| [KIND 우선주 `005935` 조회](https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005935) | 빈 목록 |
| [KIND 우선주 전체 검색](https://kind.krx.co.kr/common/searchcorpnameall.do?method=searchCorpNameAllJson&searchCodeType=number&searchCorpName=005935) | 빈 목록 |
| [KIND 우선주 자동완성](https://kind.krx.co.kr/common/akc.jsp?q=005935&s=1) | 빈 목록 |

이 코드 검색만으로는 `005935` 연결을 검증하지 못했다. KIND가 요청과 다른 대표 보통주를 반환해도 연결하지 않는다. 회사 매핑 미확인은 해당 종목에만 적용하며, 이미 검증된 회사·기간의 저장 자료를 비우지 않는다. 합성 fixture의 연결 성공은 응답 형식과 분기 처리를 검증하며 실제 우선주 지원을 실증하지 않는다. 추가 자격증명을 요구하는 KRX 서비스는 사용하지 않는다. 이후 #167에서 삼성전자 변경상장 공시에 명시된 `005935`·`005930`의 같은 발행인 연결과 KIND의 정확 `005930` 회사번호를 확인했다. resolver는 이 공시 한 건을 제한된 근거 목록으로 두고 발행인·종류별 단축/표준코드·회사번호를 실제 대조한다. [관측·재현 방법과 실패 계약](dart-preferred-company-mapping.md)을 따른다. 전체 우선주의 자동 발견과 적용 범위 확대는 [후속 작업 #179](https://github.com/Soochol/vallythevally/issues/179)이며, 목록 밖 종목은 계속 미확인이다.

회사 재무는 회사코드로 공유한다. 배당 원문의 `stock_knd`와 종목의 주식 종류는 별도로 보존한다. 회사 연결만 확인된 우선주는 세부 배당 종류가 확인된 것으로 간주하지 않고 `preferred_issue_class_unverified`를 남긴다. 종류를 확인하지 못한 DPS를 보통주 값으로 채우면 안 된다.

## 실제 보고기간 검증

[전체 재무제표 API](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)의 사업연도·보고서 구분·당기명은 실제 날짜 구간을 뜻하지 않는다. 모든 원계정 필드, 통화, 접수번호와 요청의 연결/별도 기준을 보존하고, [접수번호별 XBRL 원본](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019019)을 보강한다.

검증은 같은 접수번호의 [공시 목록](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001)에 적힌 보고서명의 보고월과 XBRL context의 실제 날짜를 대조한다. 보고서명에서 날짜를 만들어 내지 않고, 실제 context 종료일이 그 보고월에 들어오는지만 확인한다. 계정 ID의 namespace·이름, 회사 식별자, 연결/별도 dimension, 통화 unit, 정확한 금액도 일치해야 한다. 상세 dimension이나 비표준 계정, 모호한 context는 추측하지 않는다.

`current_period`와 `cumulative_period`는 각각 `thstrm_amount`와 `thstrm_add_amount`에 대응한다. 재무상태표는 instant, 손익계산서의 분·반기 당기금액은 실제 3개월 duration을 요구한다. CF는 3개월로 가정하지 않고 원본 duration을 쓴다. 연간 및 짧아진 기간도 실제 시작·종료일을 보존하며 임의로 늘리거나 합산하지 않는다.

`verified`에는 실제 기간/시점과 context ID·원본 파일명·접수번호가 있다. `unverified`는 원금액과 함께 `matching_context_missing`, `ambiguous_context`, `report_period_anchor_missing` 등의 사유를 남긴다. 후속 계산은 검증된 기간만 사용해야 한다. 원문이 실패하면 원자료와 실패 상태를 남기고, 기존 성공 자료가 있으면 그 자료를 유지한다.

배당은 [공식 `alotMatter` 응답](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS002&apiId=2019005)의 `stlm_dt`를 결산기준일로 보존한다. 응답 자체에는 사업연도가 없으므로 요청한 사업연도·사업보고서 구분은 상위 `Report`가 가진다. 결산기준일이 없거나 잘못되면 `dividend_settlement_date_unverified`이며, 현재 결산월로 채우지 않는다.


## 실패 계약

연결 응답 `013`만 별도 조회로 이어진다. 인증·네트워크·한도·잘못된 응답은 별도로 전환하지 않는다. 양쪽이 `013`이면 `absent`다. 계정이 없는 것과 보고서 자체가 없는 것은 원문 목록과 `absent`로 구분할 수 있다. `Fetch.data`는 마지막 성공 자료이고 `failure`가 함께 있으면 갱신에 실패한 저장 자료다. 없는 금액을 0으로 바꾸지 않는다.

요청과 XBRL `DocumentReceiptNumber`가 다르면 보고서의 재시도 가능한 `receipt_mismatch` 실패다. 기존 확인 자료의 금액·접수번호·기간·마지막 성공 시각·성공 세대는 유지하며, 원천 복구 후 해당 요청을 다시 받아 교체한다. 비표준 계정이나 모호한 context 같은 개별 `unverified`만으로 자동 재조회를 반복하지 않는다.

재무 저장소 초기화 실패는 서버 시작을 중단하지 않는다. 가격·사용자 자료 API는 계속 서비스하며, 재무 저장소를 고친 뒤 서버를 다시 시작하면 연다. 실행 중 쓰기 실패는 해당 회사의 `Snapshot.failure=storage`와 저장 자료로 드러난다. 디스크의 첫 요청 기록부터 실패할 때는 프로세스 안에 수동 목록 갱신 의도와 회사별 시도 시각을 유지한다. 다음 명시적 업데이트가 그 목록 갱신을 재개하며 목록 완료 세대는 목록 snapshot 저장 성공 후에만 올라간다. 첫 요청을 디스크에 전혀 쓰지 못한 상태에서 프로세스까지 종료되면 그 메모리 의도는 복원할 수 없다. 요청 기록이 성공한 뒤의 목록 커밋 실패는 서비스·DB를 재오픈해도 복원한다.

종목 식별·매핑 저장 실패도 종목코드별 실패 시각과 수동 갱신 의도를 프로세스 메모리에 보관한다. 일반 조회는 이 실패와 저장 자료만 읽으며 외부 호출을 하지 않는다. 다른 회사 수집은 계속 가능하다. 매핑 저장이 복구되면 기존 수동 갱신 의도도 회사 수집기에 전달한다. 명시적인 수동 요청은 실패를 다시 시도한다. 사용자 원본 DB를 대신 사용하지 않는다.

인증키는 저장 모델에 없으며 원문에 반사된 값도 제거한다. 외부 오류 메시지·요청 URL을 응답과 로그에 쓰지 않는다. reqwest의 debug/trace 로그는 인증키가 든 URL을 남길 수 있어 필터에서 차단한다.

시험은 `crates/server/tests/financials.rs`의 합성 DART·XBRL·KIND 응답과 fake-kiwoom으로 수행한다. 실제 인증 API나 사용자 서버를 호출하지 않는다.
