# 키움 오류를 한 곳에서 판정하고 대응하는 설계 제안

상태: §2 코드 표, §5 정책의 REST 부분, §8 브라우저 계약은 #20·#21(PR #26)에서 구현했다. 구현과 다른 점은 ADR 0009가 우선한다: §5 T행의 관문은 경로별이 아니라 조회 전체에 하나다. WebSocket 부분(§7)은 #4에서 구현한다. 조사일: 2026-11-09.

추천은 `kiwoom/error.rs`가 REST와 WebSocket의 실패를 닫힌 범주로 판정하고, 코드 표 하나가 대응 정책을 선택하게 하는 것이다. HTTP 상태보다 공급사 상세 코드를 먼저 본다. 재시도는 호출자마다 새로 시작하지 않고, 공유 실행기가 예산과 다음 허용 시각을 소유한다. `8050`은 HTTP 상태와 관계없이 발급과 시세 요청을 멈춘다.

이 문서는 공개된 공통 오류 목록 전체를 조사했지만, 키움 내부 오류 전체를 확보했다는 뜻은 아니다. 공식 자료가 스스로 "주요 오류코드"라고 부르며, WebSocket 상세 오류 전체표는 확인하지 못했다. 이 한계를 `Unknown`과 안전한 기본 정책으로 설계에 반영한다.

## 1. 근거와 확인 범위

### 조사 기준

코드 기준은 메인 체크아웃 `4d003f771ab86cd0a233842c5209d6b540368d58`이다. #18은 조사 시점 OPEN이며 #19 구현 worktree는 읽거나 수정하지 않았다. 따라서 아래의 현재 동작은 #19 병합 뒤 재대조해야 한다. [ADR 0004](../adr/0004-dedicated-kiwoom-app-key.md)와 [D18](decisions-r1.md)은 이미 토큰 파일 재사용, 발급 간격 10분, 8050 중단을 결정했다. 해당 문서에 적힌 개정일 2026-11-10은 조사일보다 뒤지만, 현재 체크아웃에 존재하는 결정으로 취급했다.

근거 수준은 다음처럼 구분한다.

| 표기 | 뜻 |
|---|---|
| 공식 원문 | 키움 포털, 공지, FAQ, 공식 저장소의 문서나 소스 직접 확인 |
| 실측 원문 | 이 저장소에 기록된 응답과 fixture. 이번 조사에서 API를 호출했다는 뜻은 아님 |
| 실측 기록 전재 | `docs/kiwoom.md`가 hoga-ops의 과거 관측을 옮겨 적음. 원래 실행을 재현하지 않음 |
| 추정·정책 제안 | 공식 설명으로 보장되지 않는 해석 또는 우리가 선택할 대응 |
| 실측 필요 | 자료만으로 확정할 수 없음. 이번 작업에서는 접속하지 않음 |

### 공식 출처

| 출처 | 확인 내용과 한계 |
|---|---|
| [오류코드 화면](https://openapi.kiwoom.com/errorcode/errorCodeView), [화면이 사용하는 공개 목록](https://openapi.kiwoom.com/errorcode/getErrorCodeListAjax) | 공통 REST 상세 코드 37개. 목록의 `errorCode`, `errorMsg`, `userIndcErrorCode`를 확인했다. 마지막 필드는 최상위 코드 대응의 근거이며 별도의 HTTP 상태 열은 없다. |
| [공식 JSON 명세](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/_data/kiwoom_api_spec.json) | `error_codes` 37개. API 337개. 포털과 코드 집합은 같고 8050 설명이 다르다. 원문 SHA-256은 `42a7b3912c9d9588c83bdc2db7779c8d2e038703a2b5562e54ef46ae905cba79`. |
| [공식 SDK 오류 처리](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/core/errors.py), [인증](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/core/auth.py), [WS](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/core/ws_client.py) | REST 대괄호 외 WS `CODE=8005` 형식, 숫자 문자열 정규화, LOGIN 인증 재시도 구현. 구현 사례이지 모든 응답의 계약이나 안전한 운영 정책의 보장은 아니다. |
| [공지 16](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAZPagingDetailView?seqid=16), 2025-08-22 | 오류코드 화면 신설. WebSocket·주문 오류는 향후 추가 예정이라고 설명한다. 현재 37개 표에도 WS 실측 4개는 없다. |
| [공지 49](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAZPagingDetailView?seqid=49), 2026-07-03 | 국내 조회 초당 5회, 계좌·토큰별 세션 하나, 세션당 200종목. `1701` 전체 한도와 `1702` 그룹 한도는 미국주식 정책에도 관련되지만, 현재 앱의 국내 시세 범위를 늘릴 이유는 아니다. |
| [공지 46](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAZPagingDetailView?seqid=46), [FAQ 42](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=42) | 월~토 07:50~07:55, 일 05:00~05:15 접속 단절 안내. 구체적인 close 숫자는 명시하지 않는다. |
| [FAQ 목록](https://openapi.kiwoom.com/board/Board0301View), [공지 목록](https://openapi.kiwoom.com/board/Board0101View) | 목록 각각 42건·59건을 읽고, 아래에서 인용하는 관련 본문을 확인했다. 제목만 보고 본문을 읽었다고 간주하지 않았다. |

웹 검색 도구로 일부 포털 페이지가 열리지 않아, 공개 HTML과 화면의 문서 조회 AJAX를 HTTP로 읽었다. 게시판도 공개 목록·상세 조회 AJAX를 읽었다. 로그인과 자격증명은 사용하지 않았으며 `api.kiwoom.com`, `mockapi.kiwoom.com`, WebSocket에는 접속하지 않았다. 조사 중 내려받은 자료를 저장소에 별도 저장하지 않았다.

### 원문 사이의 차이

| 차이 | 판단 |
|---|---|
| GitHub 8050은 지정단말기 인증 실패, 포털 8050은 IP 등록 안내 | 숫자로 판정하고 문구의 동일성을 요구하지 않는다. 반복 발급 잠금은 공식 표의 정의가 아니라 `kiwoom.md` §11.10의 과거 관측 기록이다. 8050만으로 두 원인을 자동 구별하지 않는다. |
| [FAQ 8](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=8)은 100종목, 최신 공지 49와 [FAQ 41](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=41)은 200종목 | 최신 공지와 직접 실측 §10.7이 일치하는 200을 사용한다. REST ka10095의 100개와 혼동하지 않는다. |
| [FAQ 10](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=10)은 만료 전 같은 토큰, [FAQ 25](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=25)는 생성 6시간 뒤 재요청하면 새 토큰·기존 토큰 폐기 | 더 구체적인 FAQ 25와 §11.10의 관측을 따른다. 발급 간격 10분은 우리 보호 정책이며 키움의 공식 잠금 임계값이 아니다. |
| [FAQ 21](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=21)은 8001의 원인에 토큰 만료·타 계좌 토큰·도메인도 듦 | 코드 이름만으로 실제 원인을 단정하지 않는다. 다만 자동 발급 허용은 검증된 8005에 한정하는 보수안을 추천한다. |
| 공식 SDK는 `AUTH_RETRY_RETURN_CODES={8005,8031,8103}` | 8031은 명세상 투자구분 불일치, 8103은 토큰·단말기 혼합 실패다. 우리 전용 실계좌 앱에서는 두 코드를 무조건 재발급하지 않는다. 정책을 넓히려면 별도 근거가 필요하다. |
| 0B·0J 명세는 REG·REMOVE 결과를 문자열 타입, 0 정상·1 오류로 설명 | 실제 오류는 105112 같은 여섯 자리 정수다. `0`만 성공, 모든 비영 값은 실패로 받는다. 타입은 정수와 숫자 문자열을 정규화한다. |

## 2. 코드 목록과 분류 제안

### REST 공통 목록 37개

이 표의 의미는 공식 원문의 요약이고, 범주·정책 ID는 제안이다. 모든 행의 출처는 §1의 포털 목록과 고정 GitHub 명세다. `상위`는 포털의 `userIndcErrorCode`다. 실제 본문과 HTTP 조합을 전부 실측한 값은 아니다.

| 상세 코드 | 상위 | 공식 의미 요약 | 범주·정책 ID |
|---|---:|---|---|
| 1501 | 2 | API ID 누락 | 요청 결함 Q |
| 1504 | 1 | URI와 API ID 불일치 | 요청 결함 Q |
| 1505 | 2 | API ID 없음 | 요청 결함 Q |
| 1511 | 2 | 필수 입력 누락 | 요청 결함 Q |
| 1512 | 2 | HTTP 헤더 없음·읽기 실패 | 요청 결함 Q |
| 1513 | 2 | authorization 누락 | 요청 결함 Q |
| 1514 | 2 | authorization 형식 오류 | 요청 결함 Q |
| 1515 | 2 | 인증 Grant Type 형식 오류 | 요청 결함 Q |
| 1516 | 2 | 헤더 내 토큰 없음 | 요청 결함 Q |
| 1517 | 2 | 입력 형식 오류 | 요청 결함 Q |
| 1687 | 7 | 재귀 호출 제한 | 요청 결함 Q |
| 1700 | 5 | API별 유량 초과 | 호출 한도 R |
| 1701 | 5 | 전체 유량 초과 | 호출 한도 R |
| 1702 | 5 | 그룹 유량 초과 | 호출 한도 R |
| 1901 | 7 | 시장 코드 없음 | 종목·거래소 불일치 S |
| 1902 | 7 | 종목 정보 없음 | 종목·거래소 불일치 S |
| 1903 | 7 | 종목·거래소 정보 없음 | 종목·거래소 불일치 S |
| 1999 | 7 | 예기치 않은 공급사 실패 | 공급사 일시 실패 T, 잠정 |
| 8001 | 3 | 앱키·시크릿 검증 실패 | 인증 차단 A |
| 8002 | 3 | 앱키·시크릿 검증 실패, 상세 사유 | 인증 차단 A |
| 8003 | 3 | 토큰 조회 실패 | 인증 처리 불명확 U-auth |
| 8005 | 3 | 토큰 무효 | 인증 무효 I |
| 8006 | 7 | 토큰 생성 실패 | 인증 처리 불명확 U-auth |
| 8009 | 7 | 토큰 발급 실패 | 인증 처리 불명확 U-auth |
| 8010 | 3 | 발급 IP와 요청 IP 불일치 | 인증 차단 A |
| 8011 | 7 | 발급 grant_type 누락 | 요청 결함 Q-auth |
| 8012 | 7 | 발급 grant_type 값 오류 | 요청 결함 Q-auth |
| 8015 | 7 | 토큰 폐기 실패 | 인증 처리 불명확 U-auth |
| 8016 | 7 | 폐기할 토큰 누락 | 요청 결함 Q-auth |
| 8020 | 2 | appkey·secretkey 입력 누락 | 요청 결함 Q-auth |
| 8030 | 2 | 앱키 실전·모의 구분 불일치 | 인증 차단 A |
| 8031 | 2 | 토큰 실전·모의 구분 불일치 | 인증 차단 A |
| 8040 | 3 | 단말기 인증 실패 | 인증 차단 A |
| 8050 | 3 | IP 미등록, GitHub는 지정단말기 실패 | 인증 차단 A |
| 8103 | 3 | 토큰 또는 단말기 인증 실패 | 인증 차단 A, 원인 미확정 |
| 8104 | 2 | 모의투자 미지원 API | 기능 미지원 F |
| 8200 | 1 | 법인 미지원 API | 기능 미지원 F |

최상위 값은 성공 0과 오류 1·2·3·5·7을 확인했다. 1은 API 지원 문제, 2는 입력 문제, 3은 인증 문제, 5는 한도 문제, 7은 여러 내부·조회 실패를 묶는다. 이는 이 목록을 요약한 설명이며 모든 가능한 최상위 값의 공식 열거형은 아니다. 4·6의 의미는 확인하지 못했으므로 이름을 만들어 붙이지 않는다. 3만으로 재발급하면 8050을 반복하고, 5만으로 물러서면 1634를 반복한다.

### 목록 밖에서 만난 코드

아래 행도 같은 코드 표에 들어간다. REST와 WS와 close의 숫자는 별도 네임스페이스를 쓴다.

| 네임스페이스·코드 | 의미 | 확인 수준·출처 | 범주·정책 ID |
|---|---|---|---|
| REST 1634 | ka10095 요청에 100개 초과 | 실측 원문, [kiwoom.md §10.6·10.9](../kiwoom.md). 공통 공식표에는 없음 | 묶음 한도 B |
| WS 105112 | REMOVE 해지 실패. type 혼합에서 재현 | 실측 원문, [§8](../kiwoom.md#8-websocket). type 혼합이 이 코드의 유일 원인이라는 보장은 없음 | 제어 요청 실패 C |
| WS 105115 | 접속 전체 등록 수 초과 | 실측 원문, §10.7·10.9 | 실시간 등록 한도 L |
| WS 105118 | 그룹 등록 수 초과 | 실측 원문, §10.7·10.9 | 실시간 등록 한도 L |
| WS 305003 | 해지 그룹 없음 | 실측 원문, §10.9 | 구독 상태 불일치 D |
| 성공 0 + 빈 행 | 조회 대상에 데이터 없음. 없는 코드·NXT 미지원이 같은 모양 | 실측 원문, §9·12.4·13 | 조회 대상 없음 E |

조사한 공급사 비영 코드의 합집합은 42개다. 공식 REST 37개와 공식표 밖 실측 5개다. 실측 기록은 REST 5개 `1511,1634,1700,8005,8050`와 WS 4개로 9개다. 이 중 8050은 §11.10의 전재와 ADR 0004·작업 요청의 사고 보고를 포함한 수이며, `kiwoom.md` §9·10의 직접 응답만 세면 8개다. `8050 + HTTP 403 + 11초 8회`는 작업 요청의 사고 보고로만 확인했고 원본 HTTP 로그는 보지 않았다. 성공 빈 행 한 형태와 close 2개는 이 42개에 넣지 않는다.

### WebSocket LOGIN·REG·REMOVE와 close

LOGIN은 공식 `ws_client.py`에서 0 성공을 확인했다. 실패의 특정 값·메시지 조합 전체는 확보하지 못했다. 공식 SDK는 상위 상세 코드와 메시지 속 `CODE=NNNN`을 함께 본다. 따라서 `WS control return_code`를 직접 보존하고, 메시지 속 인증 상세가 있으면 그쪽을 분류에 사용한다. REST 공통 37개가 모두 LOGIN에서 발생한다고 주장하지 않는다.

REG·REMOVE는 명세의 일반 오류 1과 위 실측 4개를 지원하고 나머지는 `Unknown`으로 간다. REAL·PING에는 `return_code`가 없어도 정상이다. LOGIN·REG·REMOVE ACK에서 값이 없는 경우와 구별해야 한다. [공식 0B·0J 명세와 WS 클라이언트](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/tree/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom).

키움이 정의한 close 전체표는 확인하지 못했다. 아래는 [IANA WebSocket close 등록부](https://www.iana.org/assignments/websocket/websocket.xhtml)와 [RFC 6455 §7.4](https://www.rfc-editor.org/rfc/rfc6455#section-7.4)에 따른 프로토콜 의미이며, 키움 실측을 분리했다.

| close 코드 | 프로토콜 의미·키움 근거 | 제안 |
|---|---|---|
| 1000 | 정상 종료. §11.9에는 두 번째 LOGIN 때 기존 세션이 `Bye`를 받은 기록 전재 | 자기 종료면 끝. 점검 시간에는 종료까지 대기. 그 밖은 기존 토큰으로 제한 재접속. 이 숫자만으로 토큰 만료·중복 LOGIN을 확정하지 않음 |
| 1001 | 상대가 떠남. 키움 실측 없음 | 일시 연결 실패로 물러섬 |
| 1002·1003·1007·1009·1010 | 프로토콜·데이터·크기·확장 문제. 키움 실측 없음 | 같은 연결 입력 반복 중단, WS만 운영자 점검 |
| 1008 | 정책 위반. 키움 실측 없음 | WS만 중단. 인증 상세가 없으면 전역 인증 차단으로 승격하지 않음 |
| 1011·1012·1013·1014 | 내부 오류·재시작·나중 재시도·게이트웨이 오류. 키움 실측 없음 | 제한 재접속, 토큰 발급 금지 |
| 1005·1006·1015 | 종료 상태 없음·비정상 종료·TLS 실패를 나타내는 예약 관측값. close 프레임에 보내면 안 됨 | 전송 실패로 취급. 1006은 §11.9에 반복 관측 전재가 있으나 원인 미확정 |
| 1004, 미할당 값, 기타 값 | 예약 또는 의미 미확인. 3000대 등록 코드도 키움 계약으로 확인되지 않음 | `UnknownClose`, 토큰 발급 없이 WS 보호 정책 적용 |

점검 종료 시각은 공식 공지로 확인됐지만, 그 시간대에 실제로 오는 close 숫자와 복구 지연은 실측 필요다. 최신 공지의 200종목·단일 세션은 정책 근거로 쓰되, 잠금 기간이나 실패 횟수는 추측하지 않는다.

## 3. HTTP 상태와 상세 코드는 따로 보존한다

| 입력 | 확인 수준 | 현재·제안상 의미 |
|---|---|---|
| HTTP 200, 상위 2, `[1511:…]` | §9 실측 원문 | 입력 오류 |
| HTTP 200, 상위 3, `[8005:…]` | §10.2 실측 원문 | 인증 무효. 401만 감시하면 놓침 |
| HTTP 429, 상위 5, `[1700:…]` | §10.1 실측 원문 | 호출 한도 |
| HTTP 200, 상위 5, `[1634]` | §10.6 실측 원문 | 묶음 크기 오류. 429 정책과 분리 |
| au10001 HTTP 403, `[8050]` | 작업 요청의 사고 보고 | 인증 차단. 200 전제 때문에 중단 분기가 실행되지 않은 사고 |
| 8050이 200·403·429 모두에서 오는가 | 실측 필요 | 공식표에는 HTTP 대응표가 없음. 같은 코드의 다중 상태 발생을 입증한 것은 아님 |

HTTP 독립 분류의 근거는 모든 조합이 이미 실측됐다는 주장이 아니다. 상세를 읽을 수 있는데도 HTTP 분기가 먼저 버리면 이미 알려진 차단 원인을 잃는다는 점이다. 공식 SDK의 `_raise_structured_error`도 HTTP 오류에서 구조화 본문을 검사한다. 판정은 다음 순서를 제안한다.

1. 전송 실패와 HTTP 응답을 구분한다. 응답이 있으면 상태와 제한된 헤더, 본문을 경계에서 한 번 읽는다.
2. JSON의 코드 필드를 정규화하고 REST `[NNNN:…]`·`[NNNN]`, WS `CODE=NNNN`에서 상세를 찾는다. 인식한 실패 상세가 있으면 HTTP와 상위 0보다 우선한다. 모순은 별도 기록한다.
3. 상세가 없으면 해당 프로토콜의 상위 코드를 본다. WS의 여섯 자리 코드, 공식 SDK가 지원하는 최상위 상세 코드도 네임스페이스를 유지해서 분류한다. 상위 3·5만으로 발급·물러서기를 정하지 않는다.
4. 판정 가능한 상세가 없을 때 HTTP 429는 R, 5xx는 T로 폴백한다. 기타 비성공 상태는 `UnknownHttp`다. 401·403만으로 새 토큰을 발급하지 않는다. 알려지지 않은 상세가 있으면 `Unknown`으로 보존하며 429·5xx로 자동 재시도 권한을 넓히지 않는다.
5. 성공에는 HTTP 200, 정상화된 상위 0, 필요한 응답 스키마를 모두 요구한다. ACK도 명시적인 0을 요구한다. 204·빈 본문·누락 코드·문자열 파싱 실패·상위 0과 실패 상세의 충돌을 조용히 성공시키지 않는다. REAL·PING은 별도 프레임 스키마다.
6. 성공 payload를 해석한 뒤 빈 행을 대상 문맥과 함께 `EmptyTarget`으로 바꾼다. 여러 상세가 충돌하면 차단 A를 우선하고, 그 외는 `Protocol`로 실패시킨다. 첫 대괄호의 네 자리만 잘라 쓰지 않는다.

예를 들어 `HTTP 429 + 8050`은 A, `HTTP 500 + 8005`는 I로 판정한다. 이는 실제 관측이라고 쓰지 않고 합성 회귀 입력으로 검사한다. 범용 프록시가 만들어 낸 비JSON 5xx는 T가 된다.

## 4. 현재 코드의 처리 지도

모든 위치는 조사 기준 커밋의 파일·함수다.

| 위치 | 파싱·분기 | 재시도·상태·브라우저 영향 |
|---|---|---|
| [`kiwoom/transport.rs`](../../crates/server/src/kiwoom/transport.rs), `ReqwestTransport::send` | HTTP 상태·본문, `cont-yn`·`next-key` 수집. 15초 timeout. URL을 뺀 `TransportError(String)` | 여기서 retry 안 함. `Retry-After`는 보존하지 않음 |
| [`kiwoom/wire.rs`](../../crates/server/src/kiwoom/wire.rs), `Envelope`, `detail_code` | 상위는 `Option<i64>`. 모든 필드는 기본값 가능. 상세는 `[` 뒤 ASCII 네 자리만 읽어 `u16` | 숫자 문자열 불허. 닫힘 구분자 확인 없이 `[17000]`도 1700으로 읽음. WS 여섯 자리·`CODE=` 미지원 |
| [`kiwoom/rest.rs`](../../crates/server/src/kiwoom/rest.rs), `judge_issue` | JSON 실패를 빈 Envelope로 대체. 429 또는 1700 먼저. 비200은 Transport. 200의 비0에서만 8001~8200 halt | 8050·403은 halt 안 함. 200의 8005도 발급 경로에서는 halt. 정상 토큰 스키마 실패는 AuthFailed이나 halt·발급 cooldown 없음 |
| 같은 파일, `judge` | JSON 실패를 빈 Envelope로 대체. 429·1700, 5xx, 비200, 상위·상세 순서. 상위 없음 또는 0이면 성공 | 5xx는 제한 retry. 200의 8005는 재발급. 그 밖 8001~8200은 전역 halt. 모든 나머지 비0은 BadRequest |
| 같은 파일, `send_market` | `Verdict`를 상태에 반영 | R: 전체 1초 정지, 같은 job 누적 3회 후 실패. 전송: Screen 0.5초 1회, 나머지 1·2·4초 3회. 8005: job별 재전송 1회·세대별 invalidate. halt는 auth에 저장 |
| 같은 파일, `next_step`, `issue`, `Queue::fail_queued` | 토큰 없음·stale이면 발급을 우선. halt이면 대기 요청 실패 | 일반 발급 실패는 대기 job을 실패시키지만 발급 gate를 저장하지 않음. 이후 새 job이면 다시 발급. halt 시 이미 전송한 요청은 취소되지 않으며 Backoff job은 재큐잉 시 실패 |
| [`kiwoom/auth.rs`](../../crates/server/src/kiwoom/auth.rs), `current`, `invalidate`, `halt` | 토큰 세대·만료 10분 전·stale·halt 관리. invalidate 5분 내 두 번째는 거절 | 발급 시도 전체의 최소 간격은 아님. `InvalidAgain`은 현재 job 실패로만 끝남. `issued`와 `stale`을 같이 둘 수 있어 halt 직전 응답의 처리도 별도 검토 필요 |
| [`kiwoom/api.rs`](../../crates/server/src/kiwoom/api.rs) | 봉인된 `MarketRequest`, `ApiId` 허용 목록, 요청 직렬화·response 타입 | 오류 정책 없음. API allowlist는 유지할 장점 |
| `wire.rs`, `parse_chart` → [`bars.rs`](../../crates/server/src/bars.rs), `fetch_tr` | 첫 행의 `dt`와 `cntr_tm`이 모두 비면 `ChartRows::UnknownSymbol` → `BarError::UnknownSymbol` | 404 `unknown_symbol`. NXT 미지원은 bars에서 먼저 거절. 빈 Vec은 정상 빈 데이터. 손상된 첫 행도 지금은 UnknownSymbol로 갈 수 있음 |
| `bars.rs`, `From<KiwoomError>` → [`http.rs`](../../crates/server/src/http.rs), `From<BarError>` | RateLimited·Transport → Unavailable, AuthFailed → AuthFailed, BadRequest·Parse → Internal | 각각 503 `kiwoom_unavailable`, 502 `kiwoom_auth_failed`, 500 `internal`. 상세 코드·영향 범위·다음 허용 시각은 소거됨 |
| [`app.rs`](../../crates/server/src/app.rs), 첫 발급·`load_symbols_at_startup` | 시작 시 발급 실패를 기록한 뒤 목록 로딩. 목록의 모든 오류를 같은 분기로 받음 | 목록 성공까지 10초마다 반복. 전역 halt면 실제 전송은 막히지만 경고·호출 루프는 계속됨 |
| 같은 파일, `daily_reset`, `daily_token` | 오류 범주 구분 없이 목록 5분, 발급 10분 재시도, 다음 07:45까지 | 내부 요청 retry와 외부 루프의 예산이 별개. 영구 오류도 반복됨 |
| WebSocket 실행기 | 현재 지정된 모듈에 구현 없음 | §5의 LOGIN·REG·REMOVE·close 처리는 설계뿐. #4가 새 소비자 |

`symbols.rs::fetch_directory`도 경계 영향을 확인했다. 응답 스키마가 목록 누락을 빈 Vec으로 받으므로 `HTTP 200 + {}`가 `judge`와 목록 파싱을 통과할 수 있다. 잘못된 응답이 정상 빈 목록으로 바뀌고 `replace`될 위험이다. 실제 그런 응답이 발생했다는 주장은 아니다.

### 우선순위가 높은 빈틈 다섯 가지

1. **비200에서 인증 차단 소거.** 토큰과 시세 판정 모두 HTTP가 먼저이며, 8050을 일반 전송 오류로 돌린다. 작업 요청의 반복 발급 사고와 직접 연결된다.
2. **누락·손상 Envelope를 성공으로 승격.** `unwrap_or_default`와 `(None | Some(0), _)`의 결합이다. 숫자 문자열도 이 경로를 타며, payload의 기본값 때문에 데이터 결손이 가려질 수 있다.
3. **범위로 코드 의미를 뭉갬.** 1701·1702는 BadRequest, 1901~1903은 internal, 1999도 우리 버그로 취급된다. 8006·8009·8104·8200은 HTTP 200이면 모두 인증 전역 halt다. 1634는 우연히 올바르게 무재시도지만 전용 타입은 없다.
4. **발급 실패와 재시도 예산의 소유권이 나뉨.** 8005에는 5분 제한이 있으나 일반 발급 실패에는 공유 gate가 없다. 동시·반복 새 job과 바깥 타이머가 한도를 새로 얻는다. 260ms 전송 간격은 발급 잠금 예방 정책이 아니다.
5. **최종 소비자가 원인을 잃고 같은 루프를 반복.** 앱 타이머는 영구·일시·알 수 없음을 구분하지 않으며, HTTP 변환은 원인과 재개 시각을 버린다. #4가 문서의 "실패 시 다시 보내고 재접속"을 그대로 구현하면 등록 한도·잘못된 REMOVE도 연결을 갈아가며 무한 반복할 수 있다.

### backend.md §4.3과 비교

| 설계 문서 | 현재 코드·제안 |
|---|---|
| HTTP → 상위 → 상세, 8005는 HTTP 200 전제 | 현재 코드가 이 한계를 그대로 구현했다. 제안은 상세 우선으로 문서 자체를 바꿈 |
| 상세 파서는 `\[(\d{4}):` | 코드는 `[1634]`도 처리하나 네 자리 뒤 구분자를 검사하지 않음. 제안은 REST·WS 형식을 정확히 나눔 |
| 0 성공, 비0 실패 | 현재 코드는 상위 누락도 성공. 제안은 성공 증거를 명시적으로 요구 |
| 1501~1999는 잘못된 요청, 8001~8200 중 8005 밖은 인증 차단 | 범위 자체가 1701·1702·1902·1999·8104의 뜻과 안 맞음. 명시 코드 표로 교체 |
| `KiwoomStatus`와 `KiwoomError::UnknownSymbol` 제시 | 현재 Status 구조체 없음. UnknownSymbol은 ChartRows·BarError에 있음. 제안은 원시 증거와 payload 결과를 구분해 보존 |
| 모든 조회·실시간 중단과 브라우저 halted | REST auth halt는 있음. 현재 라우터에 실시간 상태 전송은 없음. #19와 #4의 계약을 연결해야 함 |
| 같은 요청이 3번 연속 한도에 걸리면 실패 | 카운터는 job 안에서 누적되며 다른 종류 실패를 만나도 초기화하지 않음. 제안도 전체 예산 누적을 사용하되 "연속" 표현을 제거 |

추가로 §5.1의 "인증 실패면 invalidate"는 8050까지 재발급하지 않도록 좁혀야 한다. 등록 한도 수신 후 재접속과 일반 제어 실패 재전송도 아래 정책으로 바꾼다. §5.2의 복구 루프는 영구 오류에서 계속 REST를 시도하지 않게 한다.

## 5. 범주별 정책

다음 표는 추천 기본값이다. 시간과 횟수는 공식 보장값이 아니라 우리 운영 선택이며, 기존 대기열의 260ms 간격은 모든 허용 전송에 계속 적용한다. `전역`은 서버 프로세스 종료가 아니라 같은 자격증명의 키움 요청과 발급 중단이다. 웹 서버·저장된 사용자 자료·이미 있는 차트는 계속 제공한다.

| ID·닫힌 범주 | 같은 요청 재시도·물러서기 | 영향 범위·토큰 발급 | 사람·브라우저 계약 |
|---|---|---|---|
| R `RateLimit` | job당 최대 3회 수신. 공유 대기열 1초 중지, 서버가 더 긴 `Retry-After`를 주면 그 시각까지. 1701·1702도 우선 전체 큐에 적용 | 영구 정지 없음, 재발급 없음. 소진 뒤 공유 30초 gate, 그 뒤 단일 조회로 확인 | warn, 반복 시 알림. 최종 503 `kiwoom_unavailable`, `retryAt`. WS는 영향을 받은 제어만 대기 |
| I `TokenInvalid` | REST 시세·WS LOGIN의 검증된 8005에서만 복구. 실패한 토큰 세대에 대해 한 번 발급 후 원요청 한 번 | auth 관리자가 단일 발급. #19의 발급 간격 10분을 무조건 지킴. 간격 안이면 실패로 반환하고 `retryAt`까지 gate. 새 세대도 8005면 전역 중단 | `kiwoom_auth_failed` 502, 사유 `token_invalid` 또는 `issue_cooldown`. 재발급 중·대기·수동조치를 구분 |
| A `AuthBlocked` | 재시도 없음 | 즉시 전역 latch. REST·WS·발급 모두 중단. 설정 수정 뒤 재시작 | error 한 번과 상태 유지. 502 `kiwoom_auth_failed`. 원인과 포털 IP·키·도메인 확인 안내 |
| Q `InvalidRequest` | 같은 입력 재시도 없음 | 해당 API·요청 형태를 결함 상태로 묶음. Q-auth는 인증 실행 경로를 중단하되 인증 차단과 다른 원인 보존. 토큰 발급으로 해결하지 않음 | 개발자 조치, 500 `internal`. 브라우저 입력 검증에서 잡힌 별도 오류만 400 `bad_request` |
| S `SymbolMismatch` | 재시도 없음 | 해당 symbol·venue 문맥만. 전역·발급 영향 없음 | 단일 대상에서 부재가 확실하면 404 `unknown_symbol`. 이미 지원 불가로 확인한 venue는 400 `bad_request`. 묶음 응답에서 어떤 대상인지 불명확하면 503으로 전체 요청 실패, 임의 대상 삭제 금지 |
| E `EmptyTarget` | 재시도 없음 | 해당 조회 결과만. 첫 페이지의 빈 행 하나와 기대 스키마 확인. 빈 목록 자체는 E 아님 | 없는 대상이면 404 `unknown_symbol`. 알려진 NXT 미지원은 사전 400. 중간 페이지·일부만 빈 행이면 `Protocol`, 500 |
| B `BatchLimit` | 같은 묶음 재전송 없음 | 해당 묶음만, 재발급 없음. 상위 요청 생성기가 100개 청킹을 보장 | error, 500 `internal`. 사용자가 잘못 입력했다는 안내 금지 |
| L `RealtimeCapacity` | 같은 desired 집합으로 재접속하지 않음 | WS 등록 집합을 200 이내로 다시 계산, accepted 성공분 유지. 수용 가능한 집합 변경 때만 재시도. 토큰 영향 없음 | `sub_error: realtime_limit`, 관심종목 polling 전환. REST와 정상 구독은 유지 |
| C `ControlRejected` | 105112는 잘못된 type 혼합 여부 검사. 같은 프레임 재전송 없음 | desired가 수정될 때만 전송. 해지 상태가 불명확하면 한 번 연결 재구성 가능, 재실패하면 WS만 중단 | error, WS 상태 사유 `control_rejected`. 실시간 중단을 REST 인증 실패로 표시하지 않음 |
| D `SubscriptionMismatch` | 305003을 즉시 성공으로 간주하지 않음 | 현재 세션에서 해당 그룹 전체가 없음이 확인되고 desired도 해지 상태면 수렴 완료. 그 외 한 번 재구성, 반복하면 WS만 중단 | warn, 상태 `reconnecting` 또는 `halted`와 사유. 토큰 발급 없음 |
| F `Unsupported` | 재시도 없음 | 해당 API·환경만. 다른 정상 시세는 계속. 발급 없음 | 운영자에게 미지원 조건 안내. 현재 앱 allowlist에서 발생하면 500 `internal`, 전역 auth halt 금지 |
| T `Transient` | 조회 Screen 0.5초 1회, Recovery·Background 1·2·4초 3회. 1999는 일시성 보장이 없어 이 제한 안에서만 허용 | 소진 뒤 해당 경로 30초 공유 gate, 단일 확인 요청. 발급은 이 일반 retry를 사용하지 않고 U-auth로 제한 | 503 `kiwoom_unavailable`, warn·`retryAt`. WS 전송은 §7 재접속 정책 |
| U-auth `AuthIndeterminate` | 같은 발급·조회 자동 반복 없음 | 인증 경로를 일단 중단, 최소 10분 뒤 단일 확인 시도만 허용. 두 번째 실패면 수동 재개. 발급의 8005도 이 정책이며 자기 자신을 복구 발급하지 않음 | 502 `kiwoom_auth_failed`, `auth_indeterminate`, 원인 미확정임을 표시 |
| U `Unknown` | 같은 job 자동 retry 0회 | REST는 해당 api-id 경로를 수동 재개까지 중단. 토큰·LOGIN 실패는 인증 경로 중단. WS 제어는 WS만 중단. 알려지지 않은 코드를 8000대라는 이유로 A로 만들지 않음 | 운영자에게 코드·단계 알림. 일반 REST 503 `kiwoom_unavailable`, 인증 경로 502. `manualActionRequired=true`, 자동 반복 금지 |
| P `Protocol` | 파싱·필수 필드·모순 실패는 retry 없음 | 일반 payload는 해당 API 경로 중단, 발급·LOGIN payload는 인증 경로 중단. 토큰 재발급 금지 | 스키마 결함은 500 `internal`, 인증 응답 결함은 502. error와 안전한 필드만 |

한도 3회·전송 횟수·발급 1회는 각각 별도 상한을 유지하되 job의 총 전송도 Screen 4회, 나머지 6회로 제한하는 안을 추천한다. 유형이 번갈아 나타나도 총 예산을 리셋하지 않는다. 이 숫자는 시험 전에 확정할 정책이며, 성공한 한 job이 다른 job의 열려 있는 실패 gate를 임의로 닫지 못하게 한다.

총 전송 상한은 원래 시세 job과 그 재전송을 센다. 토큰 전송은 자격증명 전체의 별도 예산이다. 발급 요청은 R·T·U-auth 중 어떤 원인으로 실패하든 최소 10분 규칙을 우선한다. 발급 성공 시각과 마지막 발급 시도 시각을 구분하고, 실패·timeout·재시작도 간격을 우회하지 못하도록 시도 직전에 후자를 저장하는 안을 추천한다. #19가 성공 시각만 보존한다면 이 차이는 후속 PR에서 보완한다. R의 1초 대기나 일반 조회의 0.5초 재시도가 발급을 다시 허용하지 않는다.

R·T가 반복되면 30초마다 단일 확인 요청만 나갈 수 있다. 확인 실패가 3회 누적되면 대기 간격을 5분으로 늘리고, 성공해야 정상 전송을 연다. app의 목록·복구·정기 발급 루프도 이 gate를 확인한다. 호출자가 새 job을 만들거나 우선순위를 바꾸는 것으로 제한을 우회할 수 없어야 한다.

8050 중단 시 이미 나간 네트워크 요청을 회수할 수는 없다. 이후 송신과 새 토큰 저장·정상 상태 복귀를 막고, 대기·Backoff·발급 대기자도 같은 원인으로 즉시 완료한다. halt 세대보다 오래된 성공 응답이 상태를 되돌리지 못하게 한다.

## 6. 타입과 모듈 경계

아래는 제안서의 Rust 스케치다. 저장소에 구현한 코드가 아니다. 필드는 실제 소유 모듈 안에서 비공개로 두고 생성 경로를 경계 함수로 제한한다.

```rust
pub struct ProviderCode(u32); // WS 305003도 표현. u16 사용 금지
pub struct CloseCode(u16);    // ProviderCode와 혼용 금지

pub enum Phase {
	TokenIssue,
	Rest(ApiId),
	WsHandshake,
	WsLogin,
	WsReg,
	WsRemove,
	WsReceive,
	WsClose,
}

pub enum CodeKey {
	RestDetail(ProviderCode),
	WsControl(ProviderCode),
	WsAuthDetail(ProviderCode),
	WsClose(CloseCode),
}

pub enum ErrorKind {
	RateLimit,
	TokenInvalid,
	AuthBlocked,
	InvalidRequest,
	SymbolMismatch,
	EmptyTarget,
	BatchLimit,
	RealtimeCapacity,
	ControlRejected,
	SubscriptionMismatch,
	Unsupported,
	Transient,
	AuthIndeterminate,
	Unknown,
	Protocol,
}

pub struct Evidence {
	phase: Phase,
	http_status: Option<u16>,
	return_code: Option<i64>,
	code: Option<CodeKey>,
	token_generation: Option<TokenGen>,
	message: SafeMessage, // 검사한 필드만 포함. 본문 원문 제외
}

pub struct KiwoomError {
	kind: ErrorKind,
	evidence: Evidence,
}

pub enum RetryPlan {
	Never,
	RetryAt { at: Instant, remaining: u8 },
	RefreshOnce { seen: TokenGen },
	ReconcileOnce { session: SessionId },
}

pub enum GateScope { Request, Api(ApiId), Realtime, Credential }
pub enum GateAction {
	Keep,
	OpenUntil { scope: GateScope, at: Instant },
	RequireOperator { scope: GateScope },
}

pub struct ErrorPlan {
	retry: RetryPlan,
	gate: GateAction,
	public: PublicFailure, // ApiErrorCode, 고정 reason, 재개 시각
}

fn parse_rest(ctx: RestContext, response: HttpResponse)
	-> Result<SuccessfulPayload, KiwoomError>;
fn parse_ws_control(ctx: WsControlContext, frame: &[u8])
	-> Result<ControlAck, KiwoomError>;
fn classify_close(ctx: CloseContext, close: CloseObservation)
	-> Option<KiwoomError>;
fn decode_chart(payload: SuccessfulPayload, target: ChartTarget)
	-> Result<ChartRows, KiwoomError>;
fn plan_error(error: &KiwoomError, state: &ExecutionState)
	-> ErrorPlan;
```

`SafeMessage`는 키·토큰을 지운 허용 필드 요약이다. 원문을 무조건 담는 `String`과 구분한다. `SuccessfulPayload`는 JSON을 한 번 파싱한 값이며 명시적인 성공 검증을 통과해야만 생성한다. 데이터 타입 변환은 이 값에서 계속하고, `rest.rs`가 Envelope를 따로 다시 판정하지 않는다. 코드 없는 네트워크 오류도 같은 `KiwoomError`로 올리되 코드 0을 발명하지 않는다.

`error.rs`에는 `CodeRule { key, profile }`의 명시 표 하나를 둔다. 각 §2 코드가 정확히 한 행에 대응한다. 프로파일은 §5의 R·I·A 같은 닫힌 enum이다. `ErrorKind`와 기본 정책은 프로파일의 exhaustiveness가 있는 변환에서 나오므로 표의 kind와 정책이 서로 다른 값을 갖지 않게 한다. `plan_error`는 프로파일에 현재 단계·우선순위·예산·gate 시각을 적용한다. 호출자에서 숫자 비교, 메시지 검색, 8001~8200 범위 판단을 하지 않는다. WS 인증 상세가 REST 인증 의미를 재사용할 때도 같은 프로파일 정의를 참조한다.

원시 관측에는 추출된 상세와 상위 코드 모두를 남긴다. 코드 표에는 전체 HTTP 조합을 복제하지 않는다. 알려지지 않은 숫자는 `Unknown` 범주와 원래 `ProviderCode`로 보존하므로 enum을 매번 추가해야 파싱할 수 있는 구조가 아니다. 닫히는 것은 대응 범주와 상태 전이이며, 공급사가 보낼 숫자 전체가 아니다.

역할은 다음처럼 나눈다.

| 모듈 | 소유 |
|---|---|
| `transport.rs` | HTTP·네트워크 관측. `Retry-After`만 필요한 헤더로 추가. 인증 판단·retry 안 함 |
| 새 `error.rs` | 코드 추출·정규화·분류 표·프로파일·외부 오류 투영 |
| `rest.rs` | 전송 큐·총 예산·공유 gate·재시도 실행. `judge`·`judge_issue`의 코드 분기 제거 |
| `auth.rs` | #19 토큰 저장·발급 단일 소유·10분 간격·세대·인증 gate. 호출 단계에 따른 발급 허용 검사 |
| `wire.rs` | 성공 데이터의 숫자·행 해석. 빈 행은 문맥 있는 EmptyTarget 또는 Protocol로 반환 |
| #4 WS 모듈 | ACK 직렬화·desired와 accepted·연결 복구. 분류기는 공통 사용 |
| `app.rs`, `bars.rs`, `http.rs` | 실행기가 준 상태와 public failure를 소비. 자체 키움 코드 해석·영구 오류 타이머 반복 제거 |

정책을 한 곳에 둔다는 것이 캐시·구독·화면을 한 거대 모듈에 합친다는 뜻은 아니다. 진단과 정책을 공유하고 실행 상태는 해당 실행기가 소유한다. 인증 gate만 REST·WS가 공유한다.

## 7. #4 WebSocket에 적용할 상태 전이

1. LOGIN 성공 뒤에도 필요한 REG ACK까지 받은 후 `live`로 간다. 제어 ACK는 한 번에 하나만 기다린다. REAL·PING은 제어 대기 중에도 처리한다.
2. ACK는 `trnm`와 기다리던 연산·세션 세대를 맞춘다. 과거 세션 ACK는 버린다. 성공 ACK에서만 accepted 집합을 변경한다.
3. LOGIN 8005는 공통 인증 관리자에게 복구를 요청한다. REST와 동시에 실패해도 발급 한 번이며 10분 규칙이 우선한다. 8050·8010은 A, 정체 모를 LOGIN 실패는 U다. 코드 3 전체에 `invalidate`를 호출하지 않는다.
4. REG 105115·105118은 L이다. 같은 desired로 재접속해도 제한이 사라지지 않으므로 등록 대상을 조정한다. 우선순위가 낮은 관심종목은 기존 설계대로 1분 REST polling으로 보낸다. 초과를 일으킨 구독은 `realtime_limit`, 나머지 accepted 구독은 유지한다.
5. REMOVE 105112는 C다. type별 요청 생성 불변식을 검사한다. 305003은 D이며 그룹 없음 확인을 생략하고 무조건 성공 처리하지 않는다. ACK 유실로 상태를 모르면 같은 프레임 무한 재전송 대신 한 번 세션을 재구성한다.
6. 일반 전송 단절은 같은 토큰으로 1·2·5·10·30초 재접속하고, 이후 30초에 한 번만 시도한다. 점검 시간에는 끝까지 기다린다. 60초 안에 3번 연속 LOGIN 직후 1000으로 닫히면 WS만 수동 중단하고 다른 세션 가능성을 알린다. 이 기준은 제안이며 원인 확정은 아니다.
7. 알 수 없는 제어 실패·프로토콜 결함은 WS만 중단한다. 인증 A가 아니면 정상 REST까지 중단하지 않는다. WS 복구를 이유로 새 토큰을 발급하지 않는다.
8. 연결 뒤 gap 복구 REST도 공통 오류 계획을 따른다. A·U·P·잘못된 요청에서 §5.2의 무제한 복구 반복을 멈추고 상태에 이유를 남긴다. 이미 받은 실시간 체결을 REST 실패 때문에 허위로 끊겼다고 표시하지 않는다.

`REAL` 한 항목의 숫자 파싱 실패는 제어 ACK 실패와 다른 영향이다. 해당 항목을 버리고 계수하되, 오류율이 높으면 별도 데이터 품질 경고로 올린다. 이 경고만으로 토큰을 발급하거나 세션을 갈아타지 않는다. 데이터 무수신만으로 단절을 확정하지 않는다는 [FAQ 15](https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=15)도 따른다.

## 8. 브라우저 계약과 관찰성

기존 `ApiError.code`와 HTTP 상태는 유지하는 안을 추천한다. 내부 범주를 그대로 브라우저 오류 코드 15개로 늘릴 필요는 없다. 대신 `error`에 타입 있는 `reason`, `retryAt?`, `manualActionRequired`를 추가한다. #4 `ConnectionStatus`는 REST 상태와 realtime 상태를 별도로 내보내고, 각각 같은 `PublicFailure`의 안전한 요약을 가진다. `realtime=halted` 의미는 인증 외 WS 제어 중단까지 넓히므로 사유가 필수다. 무변동·시장 종료를 실패로 만들지 않는다.

`503`이라는 이유만으로 브라우저가 자동 반복하면 U 정책이 무너진다. `manualActionRequired=true`면 자동 refetch를 멈추고, `retryAt`가 있으면 그 전에는 요청하지 않는다. 서버 gate가 최종 방어이므로 오래된 브라우저도 실제 키움 송신을 늘리지 못한다. 인증 cooldown에는 "운영자가 키를 고쳐야 한다" 대신 "다음 발급 가능 시각까지 대기"를 표시한다. REST 인증 문제 중 살아 있는 WS는 있는 그대로 보인다.

로그는 경계의 실패 관측과 실행기가 선택한 최종 행동을 같은 `job_id`·`attempt_id`로 연결한다. 기본 필드는 `api_id`, `phase`, `category`, `code_namespace`, `detail_code`, `return_code`, `http_status`, `elapsed_ms`, `priority`, `token_generation`, `attempt`, `remaining_budget`, `gate_scope`, `retry_at`, `action`, `session_id`다. 영구 중단은 전이 때 error 한 번, 이후 동일 거절은 계수로 남긴다. symbol·job·raw code를 메트릭 label로 무한 확장하지 않는다. 미등록 코드는 메트릭의 `unknown`으로 묶고 숫자는 로그에만 둔다.

au10001 요청·응답 원문, Authorization, 앱키·시크릿·토큰·전체 URL·next-key는 기록하지 않는다. 현재 조회 payload 앞 2KB 로그도 필드 허용 목록을 거친 요약으로 바꾸는 안을 추천한다. 메시지의 동적 실패 사유에 비밀값이 섞일 수 있으므로 `return_msg`도 무조건 안전하다고 보지 않는다. 코드와 단계 등 구조 필드를 우선 보존하고, 필요한 메시지는 길이 제한·마스킹 뒤 보관한다.

비공개 hoga-ops에서는 다음 원칙만 읽어 참고했다. 앱이나 실측 프로그램은 실행하지 않았고 `.env`는 열지 않았다. 이 공개 문서에는 비공개 응답·사건 수치·자격증명을 옮기지 않았다.

| 읽은 자료 | 가져올 원칙 |
|---|---|
| `docs/adr/0143-failure-diagnosis-layers.md` | 백엔드의 진단 1곳, 정책 1곳, 표시 채널 여러 곳. 브라우저의 문자열 역추론을 없앰. 지속 상태와 일회성 알림 구별 |
| `docs/adr/0137-error-handling-strategy.md` | 원인과 실제 기능 영향을 함께 보존. 폴백을 선택한 층이 영향 로그를 소유. 영구 조건·일시 실패·결함을 구분 |
| `hoga/live/kiwoom_failure_evidence.py`, `kiwoom_diagnostics.py` | token·LOGIN·REG·REMOVE·receive·close 단계를 분리하고 제한된 수치 필드만 수집. 진단 실패가 원래 실패를 덮지 않게 함 |

hoga-ops의 큰 진단 체계를 전부 이식할 필요는 없다. 현재 앱에서는 `Evidence`, 정책 표, gate, 브라우저 상태의 일관성부터 확보한다.

## 9. 구현 때 사용할 검증 계획

이번 작업에서는 문서만 검토했다. 아래는 후속 PR의 테스트 계획이며 키움 실서버를 쓰지 않는다.

| 검증 | 고정 입력·검사할 동작 |
|---|---|
| 코드 표 전수 | 공식 37개와 실측 추가 5개가 정확히 한 규칙에 대응. 중복 키·누락 정책 금지. 미등록·최대 u32 코드도 Unknown으로 처리 |
| 실제 REST 응답 | 기존 `ka10081_err_1511.json`, `err_1700.json`, `err_8005.json`, `err_1634.json`의 본문을 그대로 사용. HTTP 상태는 문서의 관측값을 별도 입력으로 연결 |
| 실제 WS 응답 | §8의 105112·LOGIN 성공, §10.7·10.9의 105115·105118·305003을 fixture로 고정. 기록에 없는 필드·문구를 실측처럼 만들지 않음 |
| 빈 행 | 기존 `ka10081_unknown_999999.json`, `ka20006_unknown_999.json`, `ka10080_005935_NX_1.json`. 올바른 첫 페이지·빈 Vec·중간 페이지·일부 필드 손상 구별 |
| HTTP 교차 | 8005·8050·1700·1634를 200·401·403·429·500과 교차. 미관측 조합은 합성이라 명시. 상세 우선, 차단이 throttle보다 먼저인지 검사 |
| 코드 파서 | `[1634]`, `[8005:…]`, `CODE=8005`, 정수·`"0"`·`"0000"`·숫자 문자열. `[17000]`를 1700으로 읽지 않음. 모순·여러 코드·overflow·null·누락·비JSON·HTML도 입력 |
| 성공 검증 | `200 + {}`, `200 + return_code="oops"`, 실패 상세와 상위 0을 성공으로 받지 않음. 누락 목록을 정상 빈 목록으로 replace하지 않음 |
| 토큰·gate | 가짜 clock과 transport로 HTTP 403·8050을 첫 발급·명시 발급·시세 각각에 주고 1회 뒤 송신 0회. 이미 Backoff 중인 job·동시 발급 대기자도 즉시 완료 |
| 동시 인증 무효 | 같은 세대에 REST 여러 개와 LOGIN이 동시에 8005. 발급 최대 1회, 원요청 재전송 상한, 10분 안 재발급 0회, 새 세대 실패 중단 |
| 바깥 루프 | 시작 목록·일일 목록·일일 발급·gap 복구가 gate를 우회하지 못함. 11초에 8번 발급되는 입력 패턴을 fake transport로 재현하고 최초 1회 뒤 차단을 확인 |
| 총 전송 예산 | 1700·5xx·8005를 번갈아 보내도 총 예산 증가 없음. 새 caller가 같은 열린 gate를 리셋하지 않음 |
| WS 상태 | L에 동일 desired 재접속 0회, C에 동일 프레임 반복 0회, D 조건부 수렴. 성공 ACK 전 accepted 불변. 오래된 ACK·timeout·PING·REAL 교차 처리 |
| close | 직접 관측된 1000·1006과 표준 미관측 코드를 분리. 점검·자기 종료·의심 중복 구별, close만으로 발급 0회 |
| 화면·비밀값 | 기존 HTTP 코드 보존, reason·retryAt·manualActionRequired와 상태 일치. 가짜 비밀 표식을 모든 실패 메시지·토큰 응답에 주입해 로그·Debug·wire에 없는지 검사 |

공식 목록을 갱신하는 때에는 네트워크 자료를 테스트 중 내려받지 않는다. 검토한 스냅샷·날짜·해시를 코드 표 변경과 함께 올린다. fixture와 정책 표를 같은 소스로 생성해 테스트가 구현을 그대로 되풀이하게 하지 않고, 위에서 정한 기대 범주·허용 전송 횟수를 독립 assertion으로 둔다.

실측이 추가로 필요한 항목은 같은 상세 코드의 HTTP 다중 조합, 실제 만료 토큰의 응답, LOGIN의 실패 envelope 전체, 점검 close 숫자·복귀 시각, 8050 잠금과 IP 미등록의 구분 가능성, 1999·8003·8006·8009의 회복 조건이다. 이 항목을 확인하려고 고의 과발급·과등록을 반복할 필요는 없다. 자연 발생 관측을 우선 수집한다.

## 10. 진행 순서와 변경 위험

| 순서·PR | 범위 | 의존·위험 |
|---|---|---|
| 1. 진행 중 #19 | 토큰 재사용·시도 최소 10분·모든 HTTP의 8050 중단·회귀 테스트 | 긴급 보호를 이 제안의 전체 승인에 묶지 않음. 토큰 코드는 D18대로 #19만 소유. 일반 HTTP 오류에서 상세가 소거되지 않는지 먼저 닫음 |
| 2. 공통 오류 판정 PR | #19 병합 후 `error.rs`, 명시 42개 표, 정확한 파서, REST 공통 판정, 원인 보존, 기존 HTTP 투영 | `rest.rs`, `wire.rs`, `auth.rs` 연결·`transport.rs` 헤더·`bars.rs`, `http.rs`, `app.rs`, `symbols.rs` 소비처와 테스트. 성공 판정 강화로 그동안 숨었던 payload 문제가 드러날 수 있음 |
| 3. 재시도·상태 계약 PR | 공유 gate·총 예산·바깥 루프 중단·reason·retryAt·manualActionRequired, REST 상태 표시 | 공통 판정 PR의 정책 실행까지 완료하는 단위. 서버 `api.rs`와 생성 TS·브라우저 소비를 함께 갱신. 기존 503 자동 refetch와의 충돌을 검증 |
| 4. #4 WS 구현 PR | LOGIN·REG·REMOVE·close를 공통 분류에 연결, accepted 수렴·등록 한도·WS 상태와 gap 복구 | 2·3을 기반으로 구현. 장중 실측 전에 8050·동시 발급·미등록 코드 입력의 fake 검증 완료. 기존 §5.1의 무조건 재접속 정책 수정 |

2와 3은 독립 배포 사이에 잘못된 자동 발급·retry가 생기면 한 PR로 합친다. 단계 2에서도 A·U·P는 즉시 무재시도로 실행되어야 하며, 판정 타입만 추가하고 옛 retry를 유지하는 중간 상태를 내보내지 않는다. #18은 이 변경의 선행 조건으로 수정하지 않는다.

바뀔 양은 새 오류 모듈 1개, 기존 서버 파일 약 9개와 관련 테스트·계약 소비처다. WS는 아직 없어 이 변경으로 갈아엎는 기존 WS 코드는 없다. 줄 수는 구현 전 확정할 수 없다. 가장 큰 위험은 성공 파싱 강화, 8000대 일괄 halt 제거, 바깥 루프 예산 통합, 브라우저 503 자동 반복 중단이다. 코드 표 자체보다 상태 전이의 동시성 검증에 시간을 둔다.

## 11. 사용자가 결정할 질문

| 질문 | 추천 답과 이유 |
|---|---|
| 공식 공개표 37개와 실측 추가 5개를 시작 목록으로 삼고, 공개 WS 전체표 미확보를 명시해도 되는가? | 예. 없는 전체표를 추정해 채우는 대신 Unknown 정책으로 닫는다. 추가 공식표가 확보되면 검토해서 확장 |
| 자동 토큰 복구를 공식 SDK처럼 8031·8103까지 넓힐 것인가? | 우선 8005만. 현재 전용 실계좌 키에서는 도메인·단말기 문제를 발급으로 숨길 비용이 큼. #19의 10분 제한은 모든 복구보다 우선 |
| 8003·8006·8009 같은 모호한 인증 실패는 영구 차단인가, 자동 반복인가? | U-auth로 분리. 즉시 반복 없이 10분 후 확인 1회, 다시 실패하면 수동 조치. 영구 설정 오류라고 단정하지 않음 |
| 알 수 없는 코드 하나가 오면 서버 전체를 중단할 것인가? | 일반 REST는 해당 API 경로, WS 제어는 WS, 토큰·LOGIN은 인증 경로를 수동 중단. 알려진 8050 같은 A만 전역 중단 |
| 호출 한도와 일시 장애의 반복 예산은? | 기존 job별 횟수를 유지하면서 총 전송 상한·30초 공유 gate·단일 확인 요청을 추가. 실패 확인 3회 뒤 5분으로 늘림. 외부 타이머도 같은 gate 사용 |
| 1999를 우리 버그로 볼 것인가? | 공급사 일시 실패로 잠정 분류하되 조회에만 제한 retry. 일시성은 실측 필요. 발급은 일반 조회 retry를 적용하지 않음 |
| WS 등록 한도·REMOVE 실패에 재접속하면 되는가? | 같은 입력 반복 금지. 등록 집합 조정과 상태 수렴을 우선하고, 불명확한 상태만 재구성 1회. 반복하면 WS만 중단 |
| `ApiError` 코드 자체를 늘릴 것인가? | 기존 코드는 유지하고 reason·재개 시각·수동조치 여부를 추가. #4 상태는 REST와 WS를 분리. 프론트가 키움 숫자를 재판정하지 않게 함 |
| 차단 해제는 자동인가? | A와 반복 U는 설정 수정 뒤 서버 재시작. 새 관리 UI·해제 endpoint는 이번 범위에 넣지 않음. 재시작해도 #19 발급 간격은 유지 |
| #19와 #4 사이 언제 적용할 것인가? | #19 긴급 보호를 먼저 병합하고 공통 판정·실행 정책을 이어서 적용. #4는 그 정책을 사용해 시작 |

## 12. 확인 재현 방법

공통 코드 수는 공식 고정 JSON의 `error_codes` 길이와 코드 집합으로 다시 셀 수 있다. 포털은 `errorcode/getErrorCodeListAjax`의 `resp_data`에서 `errorCode`·`userIndcErrorCode`·`errorMsg`만 비교한다. 게시판은 공개 목록 `SBbsNoticeNOPAFListAjax`, `SBbsNoticeNOPAZListAjax`와 상세 `SBbsNoticeNOPAFDetailAjax`, `SBbsNoticeNOPAZDetailAjax`를 이용했고, 목록 본문은 `noticeList`, 상세 본문은 `noticeDetail`이다. 이는 문서 조회 경로이며 거래 API 검증 명령이 아니다.

현재 코드 분기는 `rg -n 'judge_issue|fn judge|Verdict::|unwrap_or_default|8001|8005|1700' crates/server/src/kiwoom/rest.rs`, 외부 반복은 `rg -n 'while let Err|loop|RETRY|issue_token' crates/server/src/app.rs`로 찾을 수 있다. 실측 코드 집합은 `docs/kiwoom.md` §9·10.9·11.9·11.10과 위 fixture 이름에 대조했다. 이 문서에 링크한 로컬 파일은 읽기만 했고, 산출물은 이 파일 하나다.
