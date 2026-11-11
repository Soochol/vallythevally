# 우선주 회사 연결 조사 (#167)

## 확인된 공식 연결

관측 시각: 2026-11-11T14:01:58Z (KST 23:01:58). 추가 인증·로그인·유료 서비스 없이 KIND 공개 HTTPS GET만 사용했다. 인증 DART·키움은 호출하지 않았다.

| 단계 | 요청 코드 | 응답 코드 | 회사 고유번호 | 주식 종류 | 공식 출처 |
|---|---|---|---|---|---|
| 우선주 회사 검색 | `005935` | 없음 (`[]`) | 없음 | 확인 불가 | [KIND 코드 검색](https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005935) |
| 거래소 변경상장 공시 | 없음 (문서 URL 직접 조회) | `A005930` / `KR7005930003`, `A005935` / `KR7005931001` | 문서에 없음 | 보통주 / 1우선주 | [삼성전자(주) 변경상장(주식소각), 2026-04-09](https://kind.krx.co.kr/external/2026/04/09/000375/20260409000536/68155.htm) |
| 공시에 명시된 보통주 코드 회사 검색 | `005930` | `repisusrtcd2=005930`, `repisucd=KR7005930003`, `secugrpId=ST`, `isurcd=00593` | `fssunqno=00126380` | 회사 대표 주권 | [KIND 코드 검색](https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005930) |

공시의 같은 발행인 항목에 두 종류의 단축코드와 표준코드가 명시돼 있다. 이 명시적 연결을 거쳐 보통주 코드의 정확 일치 회사 검색으로 DART 회사 고유번호를 확인할 수 있다. 보통주 검색 응답을 `005935` 요청 응답으로 간주한 것이 아니며, 종목명 유사도나 코드 끝자리 변환을 쓰지 않았다. 모든 일반 우선주에서 이 경로가 자동 발견된다는 뜻은 아니다.

공시의 종류 표기 `1우선주`는 회사 연결 근거다. 이 표기만으로 DART 배당 `stock_knd`의 어느 값이 해당 종목인지 확인됐다고 보지 않는다. DPS 종류 식별은 별도이며 미확인 시 비워야 한다.

## 추가 경로와 한계

- [KIND 종합정보 초기 화면](https://kind.krx.co.kr/corpdetail/totalinfo.do?method=loadInitPage)은 `searchCorpNameJson`으로 발행기관 정보를 얻은 뒤 회사별 종합정보·주식현황을 조회한다. `005935` 직접 검색이 빈 배열인 것은 유지됐다.
- [KIND 주식현황](https://kind.krx.co.kr/corpdetail/stockstatus.do?method=searchStockStatus&isurCd=00593&kisComCd=380725&repIsuCd=KR7005930003&spotIsuTrdMktTpCd=1&comAttrTpCd=1&mode=&tabMenu=1)은 HTTP 200의 페이지 오류 본문을 반환했다. HTTP 성공을 매핑 성공으로 보지 않았다.
- [KIND 통합검색의 시장조치 검색](https://kind.krx.co.kr/disclosure/searchtotalinfo.do?method=searchTotalInfoSub&forward=searchtotalinfo_detail&kwd=005935&fdName=all_mktact_idx&scn=mktact&pageIndex=1&currentPageSize=15)은 `005935` 검색결과 0건이었다. 직접 공시 URL에서 코드를 확인한 것과 자동 검색 성공은 구분한다.

## 재확인

아래 공개 URL의 응답을 직접 비교한다. 공시에서 두 코드의 종류와 동일 발행인 소속을 확인하고, 회사 검색에서는 응답 코드가 `005930`이며 회사번호가 `00126380`인지 확인한다.

```sh
curl --fail --silent --show-error 'https://kind.krx.co.kr/external/2026/04/09/000375/20260409000536/68155.htm'
curl --fail --silent --show-error 'https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005930'
curl --fail --silent --show-error 'https://kind.krx.co.kr/common/searchcorpname.do?method=searchCorpNameJson&searchCodeType=number&searchCorpName=005935'
```

## resolver 적용 범위

[#167](https://github.com/Soochol/vallythevally/issues/167)의 구체화에 따라 검증한 삼성전자 공시 한 건을 제한된 근거 목록으로 사용한다. `client/preferred.rs`의 목록은 발행인·두 종목명·단축/표준코드·종류·회사번호·출처 경로·관측 시각을 가진다. 전체 우선주의 자동 발견·적용 범위 확대는 [#179](https://github.com/Soochol/vallythevally/issues/179)이며 이번 변경에 포함하지 않는다. spec #155의 전체 우선주 목표는 아직 완료가 아니다.

DART 고유번호의 정확 코드 일치와 KIND의 요청 코드 정확 일치가 없고, 우선주 입력이 근거 목록에 있을 때만 공시를 조회한다. KIND가 다른 코드를 반환하거나 중복 후보를 주면 해당 응답으로 연결하거나 공시 경로로 우회하지 않는다. 공시는 다음을 모두 만족해야 한다.

1. 텍스트 `PRE` 블록 하나에 정확한 발행인 제목 하나와 순서가 맞는 ①~⑨ 항목이 있다.
2. 같은 발행인의 `① 상장종목` 항목이 목록의 보통주·1우선주 두 종목과 일치한다.
3. 그 발행인의 `⑨ 코드` 항목에서 보통주·1우선주 각각의 단축코드와 표준코드가 종류별로 정확히 일치한다. 다른 곳에 흩어진 문자열을 연결하지 않는다.
4. 공시에 명시된 보통주 코드로 KIND를 따로 조회한다. 후보가 하나이며 단축/표준코드·주권 구분·회사번호가 일치하고 DART 고유번호 목록의 해당 보통주 회사번호도 정확히 일치한다.
5. 기업개황 응답에 다른 회사번호가 있으면 실패한다.

지원하는 형식의 필수 구조를 읽은 뒤 확인한 다른 발행인·다른 코드·다른 종류·모호하거나 중복된 근거는 `company_mapping_unverified`다. 빈 PRE·PRE 안의 오류 안내·필수 항목/코드 행 누락·지원하지 않는 BODY 포장 등은 매핑 부재가 아니라 `invalid_response`다. 더 넓은 HTML을 추측해서 해석하지 않는다. 빈 본문·깨진 원문·오류 페이지도 `invalid_response`, HTTP 실패·리다이렉트는 `remote`, 전송/본문 읽기 실패는 `network`이며 기존 60초 재시도와 수동 갱신 계약을 따른다. 검증하지 못한 종목 매핑은 저장하지 않으며 회사별 저장 자료는 건드리지 않는다. 이미 저장한 매핑은 기존 수명 규칙에 따라 재시작 후에도 재사용하므로 원문 장애로 기존 연결·회사의 자료를 지우지 않는다.

공용 `Security` 타입은 바꾸지 않는다. 기존 `evidence` 문자열에 JSON으로 출처 URL·관측 시각·발행인·회사번호·양쪽 단축/표준코드·종류·정확 코드 회사 조회 URL을 보존한다. `share_class`는 계속 배당 종류 식별용으로 두고, 회사 연결에 사용한 `1우선주`를 거기에 대입하지 않는다. 같은 회사의 원자료 수집은 회사코드로 합치며 배당 원문의 보통주·우선주·종류불명 행은 각각 보존한다.

## 원문과 합성 시험

관측한 공식 응답 사본(줄끝·행끝 공백 정리)은 [sources/kind-preferred-005935](sources/kind-preferred-005935/)에 보관한다. 이 사본은 관측 증거이며 자동시험용 서버 응답이 아니다.

| 사본 | SHA-256 |
|---|---|
| `notice.html` | `f634dbd8c3e579e2692f2572bd267e322eefbd4acae1845adb45f2c2af23038b` |
| `common.json` | `34cad4d90ed9bf0e7937ae47b2078ef286bd20b2ec253c5234ec81f41dba720a` |
| `preferred.json` | `37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570` |

`tests/financials/mapping.rs`의 합성 공시는 수량을 임의의 100→90주, 20→18주로 바꿨다. 가짜 KIND·DART·XBRL 응답과 worktree 내부 임시 DB로 다음 행동을 검증한다.

- 회사 연결의 provenance 보존, 보통주·우선주 수집 공유 및 재시작 뒤 재사용
- 배당 원문의 종류별 금액 보존과 종목별 DPS 종류 미확인 유지
- 발행인·단축/표준코드·종류·회사번호 불일치, 빈/중복/모호한 응답, 목록 밖·유사 코드의 연결 거부
- 최초·회사 자료 저장 이후의 원문 실패, 재시도 간격·복구, 기존 자료 보존과 다른 회사 수집
- PRE 오류 안내·지원하지 않는 BODY 구조 각각의 `failed/invalid_response`, 같은 시각·59초의 재호출 억제와 61초 복구, 실제 시험 서버 가격 API 이용

검증 명령과 결과는 PR에 기록한다. 공개 원천의 실제 우선주 지원 근거는 위 관측이고, 합성 fixture 성공으로 대체하지 않는다.
