# 키움 API의 분기·연간 재무지표 제공 범위

확인일: 2026-11-11. 국내 상장 종목의 차트에 재무지표를 표시할 수 있는지 공식 공개 문서와 공식 저장소를 조사했다. 실제 키움 API는 호출하지 않았다.

## 결론

키움 REST API의 `ka10001`은 PER·PBR·ROE·EPS·BPS와 매출액·영업이익·당기순이익을 준다. 그러나 요청은 종목코드뿐이며, 회계연도나 분기를 고르는 항목이 없다. 응답에도 실적의 귀속 연도·분기·공시일이 없다. 따라서 **조회 시점에 제공되는 종목 기본 정보는 받을 수 있지만, 원하는 과거 분기나 연도의 재무 시계열을 받는 용도로는 부족하다.** [주식기본정보요청 공식 명세](https://openapi.kiwoom.com/m/guide/apiguide/01/ka10001)

공개된 국내주식 REST 명세 전체를 확인한 범위에서 분기·연간 재무제표나 과거 재무비율 시계열을 조회하는 별도 API는 찾지 못했다. 이는 공개 명세에 대한 결론이며, 키움의 모든 내부 서비스에 재무 데이터가 없다는 뜻은 아니다. 분기·연간 실적 차트에는 Open DART를 별도 자료원으로 쓰는 구성이 적합하다. [키움 공식 API 스펙](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/_data/kiwoom_api_spec.json), [DART 단일회사 전체 재무제표](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)

## REST API에서 확인한 내용

### ka10001은 기간을 고를 수 없는 종목 기본 정보다

`ka10001`은 `POST /api/dostk/stkinfo`를 사용한다. 요청 본문은 `stk_cd` 하나다. 공통 헤더의 `cont-yn`과 `next-key`는 연속조회용이며, 연도·분기를 선택하는 인자가 아니다. [공식 명세](https://openapi.kiwoom.com/m/guide/apiguide/01/ka10001), [공식 예제](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/examples/국내주식/종목정보/get_domestic_stock_info.py)

| 응답 필드 | 내용 | 공식 명세에서 확인되는 범위 |
|---|---|---|
| `per` | PER | 주가수익비율. 외부 벤더 제공 및 갱신 주기 안내가 있다. |
| `pbr` | PBR | 주가순자산비율. |
| `roe` | ROE | 자기자본이익률. 외부 벤더 제공 및 갱신 주기 안내가 있다. |
| `eps` | EPS | 주당순이익. |
| `bps` | BPS | 주당순자산. |
| `sale_amt` | 매출액 | 단위는 억원. |
| `bus_pro` | 영업이익 | 단위는 억원. |
| `cup_nga` | 당기순이익 | 단위는 억원. |
| `setl_mm` | 결산월 | 결산월만으로 특정 실적의 연도·분기를 식별할 수 없다. |

표의 필드와 설명은 [ka10001 공식 명세](https://openapi.kiwoom.com/m/guide/apiguide/01/ka10001)에 따른다.

문서는 PER·ROE에 대해 외부 벤더에서 공급하며 주 1회 또는 실적 발표 시기에 갱신한다고 설명한다. 이 안내를 다른 모든 필드의 갱신 주기로 확대해서 해석하지 않았다. [공식 명세](https://openapi.kiwoom.com/m/guide/apiguide/01/ka10001)

다음 사항은 공개 명세만으로 확인할 수 없다. 특정 연간 수치나 최근 분기 수치라고 임의로 이름 붙이면 안 된다. [공식 명세](https://openapi.kiwoom.com/m/guide/apiguide/01/ka10001)

- 매출액·영업이익·당기순이익이 어느 사업연도·보고기간에 속하는지.
- 연간, 분기 단독, 연초 이후 누적, 최근 12개월 중 어느 기준인지.
- 연결재무제표와 별도재무제표 중 어느 기준인지.
- 비율의 상세 산식, 실적 반영일, 정정 반영 시점.
- 과거 특정 날짜에 조회했을 때 제공됐던 값의 복원 방법.

### 다른 국내주식 TR도 재무 시계열을 제공하지 않는다

공식 저장소의 스펙에서 국내주식 메뉴의 API 이름과 요청·응답 항목을 검색하고 관련 TR의 전체 항목을 확인했다. 재무제표·실적 항목과 `PER`, `PBR`, `ROE`, `EPS`, `BPS`를 대상으로 확인했을 때 관련된 응답은 `ka10001`과 `ka10026`이었다. [조사한 공식 스펙 고정본](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/_data/kiwoom_api_spec.json)

| TR | 제공 내용과 한계 |
|---|---|
| `ka10026` 고저PER요청 | `pertp`로 저·고 PBR, PER, ROE 구분을 고르고 `stex_tp`로 거래소를 고른다. 종목 목록을 조회하며 회계연도·분기·과거 날짜 인자가 없다. 응답 지표 필드는 `per`로 표기돼 있다. |
| `ka10095` 지정종목 정보요청 | 여러 종목의 시세·거래량·호가·시가총액 등을 준다. 분기·연간 실적 이력은 없다. |
| `ka10100` 종목정보 조회 | 종목 속성과 상태를 준다. 분기·연간 재무제표를 주는 API가 아니다. |
| `ka10081` 등 차트 TR | 가격과 거래량의 봉을 조회한다. 기준일을 지정할 수 있어도 해당 날짜의 재무제표나 재무비율을 주지 않는다. |

표는 [키움 공식 API 스펙](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/_data/kiwoom_api_spec.json)에 따른다. 미국주식 메뉴의 분기 차트는 가격을 분기 봉으로 묶는 API이므로 국내기업 분기 재무제표와 구분해야 한다. [공식 API 가이드](https://openapi.kiwoom.com/m/guide/apiguide)

## OpenAPI+ OCX는 별도 서비스다

OpenAPI+는 Windows COM 기반의 OCX 서비스다. REST의 `ka10001`과 OCX의 `opt10001`을 같은 API 명세로 취급하면 안 된다. 키움은 OCX TR의 목록·입력·출력을 KOA Studio에서 확인하도록 안내한다. [OpenAPI+ 공식 안내](https://www1.kiwoom.com/h/customer/download/VOpenApiInfoView?dummyVal=0), [공식 개발가이드 1.7](https://download.kiwoom.com/web/openapi/kiwoom_openapi_plus_devguide_ver_1.7.pdf)

이번 조사에서 읽은 공식 개발가이드는 함수와 이벤트, KOA Studio 사용법을 설명한다. 해당 가이드만으로는 `opt10001`의 최신 전체 필드나 별도 분기·연간 재무 TR 유무를 확정할 수 없다. KOA Studio를 실행하거나 OCX에 로그인하지 않았으므로 **OCX의 분기·연간 재무 시계열 지원 여부는 미확인**으로 남긴다. REST에서 확인한 한계를 OCX 전체의 미지원 근거로 확장하지 않았다. [공식 개발가이드](https://download.kiwoom.com/web/openapi/kiwoom_openapi_plus_devguide_ver_1.7.pdf), [KOA Studio 제공 안내](https://www1.kiwoom.com/h/customer/download/VOpenApiInfoView?dummyVal=0)

## 분기·연간 실적의 대안은 Open DART다

Open DART의 단일회사 전체 재무제표 API `fnlttSinglAcntAll`은 사업연도 `bsns_year`, 보고서 구분 `reprt_code`, 연결·별도 구분 `fs_div`를 받는다. 제공 범위는 2015년 이후이며, `CFS`는 연결, `OFS`는 별도다. [DART 공식 개발가이드](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)

| 보고서 | `reprt_code` |
|---|---|
| 1분기보고서 | `11013` |
| 반기보고서 | `11012` |
| 3분기보고서 | `11014` |
| 사업보고서 | `11011` |

보고서 코드는 [DART 공식 개발가이드](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)에 따른다. 반기보고서는 Q2 단독 실적과 같은 개념이 아니며, 응답 금액 필드의 기준을 확인해야 한다.

분·반기 손익계산서와 포괄손익계산서의 `thstrm_amount`는 해당 3개월 금액이고, `thstrm_add_amount`는 누적금액이다. 따라서 모든 분기 금액을 누적이라고 가정해 차감하면 안 된다. 4분기 단독 실적을 계산한다면 동일한 연결·별도 및 정정 기준에서 연간 금액과 9개월 누적금액을 비교해야 한다. 후자는 이 필드 정의에 따른 계산상의 권고다. [DART 금액 필드 정의](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)

DART는 수익성·안정성·성장성·활동성 주요지표 API도 제공하지만 제공 시작은 2023년 3분기다. 재무제표와 지표 API의 과거 범위가 다르므로 같은 범위로 가정하면 안 된다. 이 API가 키움의 PER·PBR·ROE·EPS·BPS와 같은 정의의 값을 모두 제공한다는 의미도 아니다. [DART 단일회사 주요 재무지표](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2022001)

## 차트에 적용할 때의 권고

현재 저장소는 이미 `ka10001`에서 PER·PBR·ROE·EPS·BPS를 읽어 종목 기본 정보 응답에 담는다. 매출액·영업이익·당기순이익은 현재 파서에 포함하지 않는다. [종목 기본 정보 변환](../crates/server/src/fundamentals.rs), [키움 응답 파서](../crates/server/src/kiwoom/wire.rs)

현재의 종목 기본 정보 표시는 `ka10001`을 쓸 수 있다. 과거의 분기·연간 매출과 이익은 DART로 기간을 지정해 가져오고, ROE·EPS·BPS와 PER·PBR의 이력은 필요한 산식과 자료원을 따로 정하는 편이 적합하다. 키움이 반환한 비율과 자체 계산한 비율이 같다고 가정하지 않는다. 이 구분은 앞서 확인한 API 범위에 따른 설계 권고다. [키움 명세](https://openapi.kiwoom.com/m/guide/apiguide/01/ka10001), [DART 재무제표 명세](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)

과거 차트에는 회계기간과 자료를 알 수 있게 된 날짜를 나눠 저장하는 것이 필요하다. 예를 들어 1분기 실적을 3월 말부터 이미 알려진 수치처럼 그리면 미래 정보를 과거에 넣게 된다. 저장소의 [실적 용어](../GLOSSARY.md)도 공시된 관측일부터 알려진 것으로 취급한다.

DART 공시검색은 접수번호 `rcept_no`와 접수일 `rcept_dt`를 제공하고, 정정 전 보고서 포함 여부도 선택할 수 있다. 그러나 전체 재무제표 API에는 특정 접수번호를 요청하는 인자가 없다. 따라서 오늘 조회한 과거 실적이 그 당시 공개된 값과 같다고 보장할 수 없다. 공개 시점과 정정 버전을 보존하는 수집이 필요하다는 것은 이 제약에 따른 권고다. [DART 공시검색](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS001&apiId=2019001), [DART 전체 재무제표 요청 인자](https://opendart.fss.or.kr/guide/detail.do?apiGrpCd=DS003&apiId=2019020)

## 조사 범위와 재확인 방법

키움 REST는 공식 포털 명세와 공식 저장소 커밋 `c7a3d25449ed4b4238bef378780c41103c67b9e9`의 `kiwoom/_data/kiwoom_api_spec.json`을 확인했다. OCX는 공식 서비스 안내와 개발가이드 1.7까지만 확인했다. 블로그나 비공식 래퍼의 필드 정의는 결론의 근거로 쓰지 않았다.

REST 제공 범위를 다시 확인할 때는 [공식 스펙](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/_data/kiwoom_api_spec.json)의 `apis`에서 `meta["메뉴 위치"]`가 `국내주식`으로 시작하는 항목을 대상으로 API 이름과 요청·응답의 한글명·설명을 검색하면 된다. 검색어는 `재무`, `매출액`, `영업이익`, `당기순이익`, 그리고 독립된 단어 `PER`, `PBR`, `ROE`, `EPS`, `BPS`다. `upper` 같은 영문 필드명에 `per`가 들어간 경우는 제외했다.
