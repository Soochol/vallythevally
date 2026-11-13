# 우선주 공식 회사 연결 자동 발견 (#179)

## 직접 공개 관측

2026-11-12 KST에 인증·로그인·유료 원천 없이 KIND 공개 HTTPS GET으로 현대차2우B `005387`의 연결 경로를 확인했다. 관측 시각은 아래 각 응답에 기록했다. 기존 [#167의 삼성전자 공시 목록](dart-preferred-company-mapping.md)에 현대자동차 URL이나 코드를 추가하지 않았다.

| 단계 | 입력 | 명시적 응답 | 관측 시각 UTC |
|---|---|---|---|
| [공시 본문 검색](https://kind.krx.co.kr/disclosure/searchtotalinfo.do?method=searchTotalInfoSub&forward=searchtotalinfo_detail&kwd=005387%20%EB%B3%80%EA%B2%BD%EC%83%81%EC%9E%A5&fdName=all_mktact_idx&scn=mktact&pageIndex=1&currentPageSize=15&srchFd=2&fromData=2015-01-01&toData=2026-11-12) | `005387 변경상장`, 시장조치·조회기간 명시 | 현대자동차 변경상장 주식소각, 접수 `20260917000117`, 문서 `20260917000264`, 게시 `2026-09-17 16:42` | 2026-11-11T15:18:06.807653Z |
| [문서 경로 조회](https://kind.krx.co.kr/common/disclsviewer.do?method=searchContents&docNo=20260917000264) | 검색이 반환한 문서번호 | `parent.setPath`의 공식 원문 URL | 2026-11-11T15:17:30.858702Z |
| [거래소 원문](https://kind.krx.co.kr/external/2026/09/17/000117/20260917000264/68155.htm) | 위 응답의 URL | 동일 발행인 현대자동차(주)의 보통주 `A005380 / KR7005380001`, 2우선주 `A005387 / KR7005382007` | 2026-11-11T15:18:06.807253Z |
| [정확 보통주 회사 조회](https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005380) | 원문에 명시된 `005380` | `repisusrtcd2=005380`, `repisusrtcd=A005380`, `repisucd=KR7005380001`, `secugrpId=ST`, `comabbrv=현대자동차`, `fssunqno=00164742` | 2026-11-11T15:12:22.344148Z |

위 표는 조사 중 얻은 응답들을 연결한 것이다. 실 키움과 인증 DART는 호출하지 않았다. DART 회사번호는 KIND의 `fssunqno`를 직접 관측한 값이며, 인증된 DART `corpCode.xml`·`company.json`과의 실서비스 대조는 이번 관측에 포함하지 않는다. resolver는 실제 실행 시 기존 DART 고유번호 목록의 보통주 코드·회사번호와 기업개황 회사번호도 대조한다. 이 마지막 단계는 아래 합성 시험으로 검증했다.

원문에는 1우선주 `A005385 / KR7005381009`와 3우선주 `A005389 / KR7005383005`도 있다. 이 두 종목의 자동 발견 전체 경로를 직접 실증했다고 보고하지 않는다. 회사 연결의 `2우선주` 표기만으로 DART 배당 `stock_knd`를 확정하지 않는다.

관측 원문과 URL·관측시각·HTTP Date·SHA-256은 [sources/kind-preferred-discovery-005387](sources/kind-preferred-discovery-005387/observations.json)에 있다. 저장 사본은 줄끝을 LF로 바꾸고 행끝 공백을 정리했다. 원응답과 저장 사본의 크기·해시를 각각 기록하며 자동시험 응답으로 사용하지 않는다. 다른 조사 응답과 상세 기록은 작업 폴더의 `target/task179`에 둔다.

## resolver가 적용하는 범위

기존 DART 정확 종목코드 연결과 KIND 직접 정확 코드 연결이 우선이다. 직접 KIND 응답이 비어 있고 입력이 우선주인 경우에만 대체 경로를 사용한다. 직접 응답이 다른 코드나 중복 후보이면 공시 검색으로 우회하지 않는다. 삼성전자 `005935`의 기존 목록 기반 경로는 유지한다.

목록 밖에서는 정확 단축코드와 `변경상장`을 함께 검색한다. `srchFd=2`, `fdName=all_mktact_idx`, `scn=mktact`, `fromData=2015-01-01`, `toData=실제 KST 관측일`을 보낸다. 서버의 가짜 시계는 관측일을 바꾸지 않는다. 전체 건수와 페이지 크기 15로 첫 페이지의 기대 행수를 정한다. 실제 결과 행과 해석한 행이 모두 기대 행수와 일치해야 게시시각이 가장 최근인 하나를 고른다. 일부 행 누락이나 행 구조 변경은 `invalid_response`다. 그 공시의 제목이 `변경상장 주식소각`일 때만 사용한다. 접수번호와 문서번호는 각각 페이지 안에서 유일해야 한다. 같은 문서가 다른 접수번호·게시일에 붙어도 연결하지 않는다. 가장 최근 게시시각이 같은 경우도 미확인으로 거부한다. 검색 요약에 코드가 있다는 사실만으로 연결하지 않는다.

검색이 반환한 문서번호로 원문 경로를 조회한다. 경로는 KIND HTTPS 원천이고, 접수일·접수번호 뒷부분·문서번호와 일치하는 `/external/.../68155.htm`이어야 한다. 다른 호스트나 임의 리다이렉트를 따라가지 않는다.

지원하는 원문은 HTML 루트 바로 아래 텍스트 PRE 하나에 단일 발행인 제목과 순서가 맞는 ①~⑨ 항목이 있는 변경상장 주식소각 공시다. 같은 발행인의 상장종목명·수량 항목 종류·코드 항목 종류가 일치해야 한다. 코드 항목에는 보통주 하나와 명시적인 1~9우선주가 있으며, 단축코드·표준코드·종류가 각각 중복되지 않아야 한다. 요청 단축코드는 우선주 코드와 정확히 일치해야 한다. 종목명은 해당 발행인과 원문 종류의 정확 표기로 확인하며 `(신형)` 표기만 허용한다.

검색 발행인과 원문 발행인, 보통주 KIND 응답의 회사 약칭이 일치해야 한다. 원문 발행인 끝의 법인표기 `(주)`만 제거해 비교하며 이름 유사도를 사용하지 않는다. 원문이 제공한 보통주 코드로 별도 검색해 단축코드·표준코드·주권 구분·회사번호를 확인한다. DART 목록에도 같은 보통주 코드의 회사가 유일하고 회사번호가 같아야 한다. 코드 끝자리 변환이나 발행인 코드 잘라내기를 하지 않는다.

이 경로는 위 형식의 공식 공시가 검색되는 종목에 적용된다. 모든 우선주를 지원한다는 보장은 아니다. 공시가 없거나 첫 페이지 밖에 있거나, 가장 최근 공시가 다른 형식이거나, 발행인·주식종류·코드가 모호하면 `company_mapping_unverified`를 유지한다. 이전 공시를 무작정 순회하거나 URL 목록을 늘려 지원으로 계산하지 않는다. 과거 공시 이후의 미공시 변경이나 공식 원문의 사실 오류까지 독립적으로 판정하지 않는다.

구조가 깨진 검색·경로·공시는 `invalid_response`, HTTP 실패·리다이렉트는 `remote`, 전송·본문 읽기 실패는 `network`다. 연결 실패는 그 종목의 식별 실패로 업데이트 결과에 남고, 다음 업데이트가 다시 시도한다. 이미 저장한 연결과 회사 자료는 재사용한다. 느린 우선주 공시 조회가 저장 자료 열기와 가격 API를 잠그지 않는다. 업데이트는 종목을 하나씩 연결하고 회사를 하나씩 수집하며, 최근 단계의 회사 수집은 언제나 갱신 세대를 등록하고 모든 보고기간을 다시 확인한다. 갱신 세대는 수집 첫 저장이 성공한 뒤 디스크에 남는다.

공용 모델·HTTP 형식·재무 계산은 바꾸지 않는다. 기존 `Security.evidence` JSON에 검색 URL·응답 SHA-256, 접수·문서번호·게시시각, 원문 경로 응답 SHA-256, 원문 URL·SHA-256, 관측시각, 발행인·양쪽 코드·종류·회사번호, KIND 회사 응답을 보존한다. `share_class`는 배당 종류 확인용이며 우선주에서는 계속 비운다.

## 조사에서 실패하거나 부족했던 경로

- KIND 직접 회사 검색은 `005387`, `005385`, `051905`에서 모두 빈 배열이었다. 보통주 `005380`은 명시적인 회사 응답을 반환했다.
- KIND 통합검색에서 기간·검색 구분을 생략한 `005387` 요청은 0건이었다. 기간과 `srchFd=2`를 넣은 요청은 결과를 반환했다. 0건을 전체 공식 근거 부재로 일반화하면 안 된다.
- KIND 주식현황은 회사 응답의 정확 인자를 넣어도 HTTP 200 오류 페이지를 반환했다. 매핑 근거로 사용하지 않았다.
- KRX 표준코드 시스템의 공개 검색·주권 상세는 열렸다. 검색에는 날짜 제약과 코드부여일 요구가 있었고, 시도한 검색은 요청 코드의 우선주를 발견하지 못했다. 관측한 다른 주권 상세에서 발행기관·단축/표준코드를 확인했지만 요청 종목의 근거로 전용하지 않았다.
- SEIBro 모바일은 `shotn_isin=005387` 입력을 보존한 종목 화면과 회사 사업요약을 반환했다. 정확 코드·표준코드·종류·회사번호의 명시적 연결은 이 응답에서 확보하지 못했다. 공개 데스크톱 XML에 선언된 조회 요청은 `서버오류3`을 반환했다. 모바일 검색도 결과 없음이었다. 새 인증이 필수라고 결론 내리지 않았다.
- KRX 데이터시스템 첫 화면은 HTTP 403이었다. 로그인·접근 우회를 하지 않았으며, 유료 원천이 반드시 필요하다고 결론 내리지 않았다.

검증한 KIND 경로에는 추가 자격증명이나 비용이 없다. 이 경로 밖의 우선주에 대한 제품 범위를 확대하거나 인증·유료 원천을 새로 선택하지 않았다.

## 재확인 명령

공개 네 요청의 코드·종류·문서 식별자를 원문에서 다시 확인한다. 첫 요청의 `toData`는 조회하는 KST 날짜로 바꾼다. 검색이 다른 문서를 반환하면 그 식별자를 이후 요청에 사용한다.

```sh
curl --fail --silent --show-error --get 'https://kind.krx.co.kr/disclosure/searchtotalinfo.do' --data-urlencode 'method=searchTotalInfoSub' --data-urlencode 'forward=searchtotalinfo_detail' --data-urlencode 'kwd=005387 변경상장' --data-urlencode 'fdName=all_mktact_idx' --data-urlencode 'scn=mktact' --data-urlencode 'srchFd=2' --data-urlencode 'pageIndex=1' --data-urlencode 'currentPageSize=15' --data-urlencode 'fromData=2015-01-01' --data-urlencode 'toData=2026-11-12'
curl --fail --silent --show-error 'https://kind.krx.co.kr/common/disclsviewer.do?method=searchContents&docNo=20260917000264'
curl --fail --silent --show-error 'https://kind.krx.co.kr/external/2026/09/17/000117/20260917000264/68155.htm'
curl --fail --silent --show-error 'https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005380'
```

## 합성 자동시험

`tests/financials/discovery.rs`와 `tests/financials/review_fix.rs`는 임의의 2종목·수량으로 만든 공시와 가짜 검색·문서경로·KIND·DART를 사용한다. 실제 관측 사본은 fixture로 넣지 않는다. worktree 내부 임시 DB와 주입한 합성 키움 transport으로 다음을 검증한다.

- 목록 밖 우선주 연결과 출처 보존, 같은 회사 재무 수집 공유, 배당 원문의 종류별 행 보존과 종목 DPS 종류 미확인
- 발행인·단축/표준코드·종류·회사번호 불일치, 코드 외부 참고 문자열, 중복 코드·종류·문서·게시시각, 잘못된 원문 경로
- 검색·경로·원문 각각의 최초 실패와 회사 자료 저장 후 실패, HTTP·본문 읽기·형식 오류, 0초·59초 재호출 억제와 61초 복구
- 기존 자료 보존과 다른 회사 수집, 멈춘 검색 중 다른 종목 연결·저장 자료 열기, 실제 시험 서버의 가격 API 이용
- 불완전한 첫 페이지의 0/59/61초 재시도, 정상 0건·총 35건의 첫 15행·16행 오류, 상충한 접수/문서 identity의 연결 저장 거부
- 신규 우선주 수동 연결을 보통주 자동 수집이 추월한 뒤 실제 보고서·배당 재조회와 갱신 세대 저장, 원천·저장 실패의 기존 자료·수동 의도 보존
- 기존 `mapping.rs`의 DART 직접 연결·KIND 직접 연결·삼성전자 목록 연결 보존

검증 명령과 결과는 PR에 기록한다. 화면과 재무 계산은 #160·#161 범위다.
