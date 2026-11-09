# 키움 WebSocket 오류·응답 코드 조사

조사일: 2026-11-09. 조사·분류 제안만 했으며 구현·실접속·토큰 발급·커밋은 하지 않았다. [ADR 0009](adr/0009-kiwoom-errors-closed-categories.md)와 [공통 오류 제안서](design/kiwoom-errors-proposal.md)의 범주를 사용한다.

**추가로 찾은 핵심은 `105110`(제어 요청 유량), `100013`(LOGIN 완료 전 전문), `900004`(조건검색 일련번호 없음)이다.** close `1009`의 클라이언트 버퍼 초과 사례도 찾았다. `1000 "Bye"`만으로 중복 LOGIN을 확정해서는 안 된다. 공식 WebSocket 전체 오류표는 이번에도 확보하지 못했다.

## 1. 범위와 확인 수준

숫자 코드는 JSON의 `return_code`, 메시지에 담긴 인증 상세 코드, WebSocket close 코드를 구별한다. `105110`과 close `1009`를 같은 코드 공간에 넣지 않는다. 아래의 **확인 수준은 출처의 성격**이며, 해당 코드의 모든 발생 조건을 검증했다는 뜻은 아니다.

| 수준 | 이번 문서에서의 뜻 |
|---|---|
| 공식 | 키움 포털·공지·FAQ 또는 공식 GitHub 조직의 코드. SDK의 처리 분기는 실제 수신 원문과 구별해서 표시한다. |
| 실측 | 이 저장소 `docs/kiwoom.md`의 과거 직접 관측. 이번에 새로 접속했다는 뜻이 아니다. |
| hoga-ops 기록 | 비공개 저장소의 과거 관측 문서·진단 자료. 재실행하지 않았다. |
| 커뮤니티 | 공개 구현 작성자의 관측 설명. 원본 로그가 없으면 그 한계를 표시한다. |
| 추정 | 다른 전송 방식의 코드 의미를 적용한 후보 또는 아직 확인하지 않은 해석. 명시 처리표의 확정 근거로 사용하지 않는다. |

### 집계

§3의 비영 오류 목록은 **11개**다. 중복을 제거하고 주된 근거로 세면 **공식 5개 / 실측 4개 / hoga-ops 기록 1개 / 커뮤니티 1개 / 추정 0개**다. 공식 5개 중 `8031`·`8103`은 **SDK가 LOGIN에서 처리하도록 구현한 후보**이며 실제 WS 응답 원문을 확보한 값이 아니다. 공식 일반 오류 `1`도 특정 원인을 나타내지 않는다. 성공 `0`은 별도로 둔다.

§4에는 WS 발생 근거가 약한 **추정 후보 6개**를 따로 두었다. 이들까지 합치면 조사한 비영 숫자 후보는 **17개(공식 5 / 실측 4 / hoga-ops 1 / 커뮤니티 1 / 추정 6)**다. 후보를 확정 WS 수신 코드 수로 보고하면 안 된다. close 관측값은 별도로 **3개(`1000`, `1006`, `1009`)**이며, 나머지 close 행은 표준의 대응 의미다.

### 조사한 자료

- [오류코드 공개 목록][portal-errors]은 여전히 37개다. `105110`·`105112`·`105115`·`105118`·`305003`·`100013`·`900004`는 없다. [공지 16][notice16]은 WebSocket·주문 코드를 추후 추가한다고 안내한다.
- 공식 [Kiwoom-REST-API][official-root]의 명세·`errors.py`·`ws_client.py`를 고정 커밋 `c7a3d25449ed4b4238bef378780c41103c67b9e9`에서 읽었다. 다른 공식 SDK [pyheroapi][hero-root]는 `9376670bb89e5843980828501b646862822c1f4e`에서 읽었다.
- 포털 0B·ka10172 명세와 공개 게시판 목록(FAQ 42건·공지 59건)을 읽고, 관련 FAQ 3·4·5·7·8·14·15·17·21·41·42·43 및 공지 7·16·46·49·52·60의 본문을 공개 조회 AJAX로 확인했다. 목록을 본 것과 본문을 확인한 것을 구별했다.
- hoga-ops는 `8131d340b6290d6ffdc179af13eb437583e874c3` 기준으로 WS 클라이언트·파서·관련 테스트·ADR·진단 JSON·과거 실측 문서 및 미국 실시간 녹화 자료를 읽었다. `.env`를 열거나 해당 저장소 코드를 실행하지 않았다. 비공개 파일 출처는 `/home/dev/code/hoga-ops/` 기준 경로와 줄이다.
- 공개 자료는 SungmanHan/kiwoom-rest-api-java의 PITFALLS, bamjun/kiwoom-rest-api, younghwan91/kiwoom-client, AlgoLab, autoStock, dayjaview, stockmate-ai를 대조했다. 근거가 있는 추가 수치는 아래에 직접 인용한다. 검색 결과에 섞인 OpenAPI+ OCX의 음수 오류표는 REST WebSocket 표에 넣지 않았다.

[Java PITFALLS](https://github.com/SungmanHan/kiwoom-rest-api-java/blob/a2cab1175aea59b398e02216c3e0918839aae4dd/docs/PITFALLS.md)는 REST 인증·유량 주의사항은 설명하지만 추가 WS 숫자 코드 근거를 제공하지 않았다. hoga-ops의 `tests/unit/live/test_kiwoom_ws_client.py:249-264`는 105118·105110을 가짜 서버로 시험하므로 그 테스트만을 실측 근거로 세지 않았다. 녹화 자료 `docs/research/2026-10-24-us-stock-realtime-live.json.gz`·`2026-10-24-us-stock-realtime-coexist-repeat.json.gz`의 제어 기록은 LOGIN·REG 성공 0만 있었고 새 실패 코드는 찾지 못했다.

## 2. 응답 모양과 판정

### 실제로 기록된 프레임

다음은 이 저장소의 [과거 관측](kiwoom.md#8-websocket)을 옮긴 것이다. 성공 LOGIN의 `sor_yn`은 오류 판정에 사용하지 않는다.

```json
{"trnm":"LOGIN","return_code":0,"return_msg":"","sor_yn":"Y"}
{"trnm":"REG","return_code":0,"return_msg":""}
{"trnm":"PING"}
{"trnm":"REMOVE","return_code":105112,"return_msg":"실시간 항목 해지에 실패했습니다 (ERROR=서비스를 처리하는 중에 오류가 발생했습니다)"}
```

| 메시지 | 필드와 성공·실패 구분 | 출처 |
|---|---|---|
| LOGIN | 요청은 `trnm`, `token`. 응답의 정규화된 `return_code == 0`을 확인한 뒤 REG를 보낸다. 실패는 `return_msg`도 보존한다. | [공식 WS `_login`·ACK 처리][official-login], `docs/kiwoom.md:279-289` |
| REG / REMOVE | 응답의 `trnm`은 요청 서비스명. `return_code`, `return_msg`가 결과다. 명세의 0 성공·1 오류는 일반 설명이며 여섯 자리 비영 코드도 실제로 온다. | [포털 0B][portal-0b], [고정 JSON 명세][official-spec], `docs/kiwoom.md:288-309,467-481` |
| REAL | `trnm: "REAL"`, `data[]` 안의 `type`, `name`, `item`, `values`가 시세다. 결과 코드가 없는 것이 명세상 정상이다. `values`의 FID 숫자는 오류 코드가 아니다. | [포털 0B][portal-0b] |
| PING | 받은 JSON PING을 그대로 돌려준다. `return_code`가 없어도 정상이며 REG ACK로 취급하지 않는다. PING만 오고 REAL이 없는 상태는 그 자체로 연결 오류가 아니다. | [공식 PING 처리][official-ping], [FAQ 15][faq15] |
| 조건검색 | `CNSRLST`·`CNSRREQ`·`CNSRCLR`도 같은 WS를 사용한다. CNSRREQ는 `return_code: 0` 성공, 비영 실패이며 `seq`, `cont_yn`, `next_key`, `data`가 붙는다. | [포털 ka10172][portal-cond], [공지 7][notice7] |
| SYSTEM | VI·CB 등 시스템 공지의 항목 구분값이다. 오류의 `return_code`나 close 코드로 해석할 근거가 없다. 전체 envelope는 이번에 확보하지 못했다. | [FAQ 3][faq3] |

포털 현재 명세는 `return_code`를 `int`, 고정 GitHub 명세는 `String`으로 적었다. [공식 정규화 함수][official-errors]도 정수와 숫자 문자열을 받는다. 따라서 `0`, `"0"`, `"0000"`은 성공으로 정규화하되 `null`, 누락, 빈 문자열, 비숫자, boolean을 성공 0으로 만들지 않는 안을 추천한다. 이 마지막 엄격성은 우리 정책 제안이다. 공식 WS 구현은 정규화 실패에 `or 0`을 적용하므로 그대로 복사하면 누락 LOGIN ACK도 성공 취급할 수 있다.

인증 실패는 `return_msg` 안에 `CODE=8005`가 들어갈 수 있다. [공식 `errors.py:8-27`][official-errors]가 REST의 대괄호와 WS의 `CODE=`를 구별해 설명한다. 메시지의 상세 코드와 상위 `return_code`를 각각 남기고, 상세가 있으면 ADR 0009대로 상세를 먼저 판정한다. 구체적인 WS 실패 envelope를 확보하지 못했으므로 임의로 `return_code: 3`을 붙여 실측 예제로 만들지는 않는다.

REG·REMOVE 성공 응답에는 요청 ID나 `grp_no`가 안 붙은 [관측](kiwoom.md#8-websocket)이 있다. 같은 `trnm`의 제어 요청은 하나씩 보내고, ACK timeout 뒤 늦은 ACK를 다음 요청에 붙이지 않는 안을 추천한다. hoga-ops도 이 문제 때문에 timeout 시 기존 세션을 폐기한다(`hoga/live/kiwoom_ws_client.py:970-1000`). timeout은 공급사 숫자 오류가 아니라 로컬 제어 실패로 별도 기록한다.

## 3. 코드 표

범주 기호는 공통 제안서의 `R RateLimit`, `I TokenInvalid`, `A AuthBlocked`, `Q InvalidRequest`, `L RealtimeCapacity`, `C ControlRejected`, `D SubscriptionMismatch`, `U Unknown`, `P Protocol`이다. 각 행의 **범주와 대응은 제안**이며 공식 SDK 정책을 그대로 채택한다는 뜻이 아니다.

| 코드 | 단계 | 뜻 | 언제 오나 | 출처 | 확인 수준 | 제안 범주(ADR 0009) |
|---|---|---|---|---|---|---|
| 0 | LOGIN / REG / REMOVE / 조건검색 | 처리 성공 | 정상 ACK. REAL 수신을 보장하지는 않음 | [공식 LOGIN][official-login], [포털 0B][portal-0b], `docs/kiwoom.md:280-289,479` | 공식 + 실측 | 성공, 오류 아님 |
| 1 | REG / REMOVE | 일반 오류 표시, 상세 원인 미정 | 명세가 비정상 결과의 일반값으로 설명. 특정 원인의 실제 프레임 미확보 | [포털 0B][portal-0b], [공식 JSON][official-spec] | 공식(명세) | C. 상세 코드가 있으면 상세 분류 우선, 같은 프레임 반복 금지 |
| 8005 | LOGIN | 토큰 무효 | WS 메시지의 `CODE=8005` 형태를 공식 SDK가 명시. 만료·폐기 등 세부 원인의 WS 실측 원문은 없음 | [공식 오류 해석:6-27][official-errors], [공식 LOGIN 분기][official-login] | 공식(SDK의 WS 형식 명시) | I. 같은 토큰 세대에서 한 번만 복구, 발급 간격 준수 |
| 8031 | LOGIN 후보 | 토큰의 실전·모의 구분 불일치 | 공식 공통표의 의미이며 WS LOGIN 재인증 분기에 포함. 실제 WS 수신 원문 미확보 | [공식 오류 코드][official-spec], [공식 공용 재인증 집합][official-errors], [WS connect][official-connect] | 공식(SDK 처리 후보, 수신 미검증) | A. 도메인·토큰 조합 수정, 자동 재발급으로 확대하지 않음 |
| 8103 | LOGIN 후보 | 토큰 인증 또는 단말기 인증 실패 | WS LOGIN 재인증 집합에 포함되나 실패 원인 혼합. 실제 WS 수신 원문 미확보 | [공식 오류 코드][official-spec], [공식 공용 재인증 집합][official-errors], [WS connect][official-connect] | 공식(SDK 처리 후보, 수신 미검증) | A(현 제안서와 동일). 원인 미확정 보존, 자동 재발급 금지 |
| 100013 | REG / 인증 완료 전 제어 | 로그인 완료 전에 보낸 다른 전문을 무시 | 모의 WS에서 LOGIN ACK 전에 REG를 보낸 관측을 공개 구현이 설명. 응답의 전체 필드·trnm 원문 없음 | [autoStock WS 클라이언트:93-99][auto-client], [실측 스크립트:144-147][auto-probe] | 커뮤니티(관측 설명; 참조 원본 로그는 공개 트리에 없음) | C, 요청 순서 결함. LOGIN 성공을 기다린 뒤 desired를 등록, 토큰 발급 금지 |
| 105110 | REG; CNSRREQ에도 공개 사례 | 해당 TRNM 허용 요청 건수 초과 | hoga-ops에서 REG 연속 요청 시 관측, 대략 5 REG/s. 공개 운영 기록도 REG 거절을 설명. 모든 TRNM이 같은 한도라는 보장은 없음 | hoga-ops `docs/plans/2026-07-16-kiwoom-ws-integration.md:17-21`, `hoga/live/kiwoom_ws_client.py:148-151`; [공개 REG 기록][auto-log]; [CNSRREQ 처리][day-live] | hoga-ops 기록(REG) + 커뮤니티(CNSRREQ) | R. 해당 제어를 지연·배치하고 제한 예산 내 재시도. 등록 집합을 줄이는 L과 구별 |
| 105112 | REMOVE | 실시간 항목 해지 실패 | 0B와 0J를 한 REMOVE의 서로 다른 data 원소에 섞어 재현. 모든 복수 type 조합이 금지라는 뜻은 아님 | `docs/kiwoom.md:287-309` | 실측(과거) | C. type·요청 구성 수정, 상태 불명확할 때만 한 번 재구성 |
| 105115 | REG | 접속 전체 등록 허용 수 초과 | 그룹 1의 200개 등록 뒤 그룹 2 추가 거절. 여러 그룹을 써도 총 200 | `docs/kiwoom.md:469-477`; hoga-ops `hoga/live/kiwoom_fields.py:49-53` | 실측(과거), hoga-ops 보강 | L. 등록 집합 재계산, 같은 집합으로 재접속 금지 |
| 105118 | REG | 그룹번호별 등록 허용 수 초과 | 한 그룹에 201개 이상 또는 누적 200 뒤 추가. 0J 업종도 포함 | `docs/kiwoom.md:467-471` | 실측(과거) | L. 그룹·전체 한도를 함께 계산 |
| 305003 | REMOVE | 해지할 그룹번호 없음 | 등록이 없는 그룹 2를 REMOVE | `docs/kiwoom.md:478-481,511` | 실측(과거) | D. 같은 세션에서 그룹 부재와 desired 해지를 확인한 경우에만 수렴 완료 |
| 900004 | 조건검색 CNSRREQ | 존재하지 않는 조건검색 일련번호 | 계정에 없는 `seq`로 조건검색 실행. 공식 SDK 문서·예제에 코드와 의미 명시, 서버 원문은 미확보 | [pyheroapi realtime.py:558-595][hero-condition], [예제의 코드 분기:78-85][hero-example], [FAQ 4][faq4] | 공식(SDK 설명·예제) | Q. CNSRLST 선행·HTS 조건식 존재 확인, 같은 seq 반복 금지. 현재 시세 전용 앱의 처리 범위 확대는 별도 결정 |

`105110`의 원인과 `105115`·`105118`의 원인은 다르다. 숫자의 앞자리로 묶으면 유량 초과와 등록 용량 초과를 혼동한다. 또한 `900004`를 찾았다고 `900001`~`900003`의 뜻을 역으로 만들지 않는다.

`105112`도 모든 복수 type REMOVE 실패로 일반화하지 않는다. [공식 공지 7][notice7]에는 한 data 원소에서 `type:["0B","0D"]`로 복합 해지하는 정상 예가 있다. 이 저장소의 실패는 0B·0J의 서로 다른 원소 혼합에서 나온 기록이다. 공지는 `type:[""]`를 사용하지 않는 실시간 type 오류로 설명하지만 **숫자 코드는 명시하지 않았다.** 이를 105112로 단정하지 않는다.

900004의 공식 예제 파일명은 `ka10171_only_example.py`지만, 내부에서 보내는 전문은 `CNSRREQ`다. 따라서 파일명만 보고 CNSRLST 자체의 오류로 배정하지 않았다. 최신 API의 선행 조건은 포털 ka10172와 FAQ 4로 교차 확인했다.

## 4. WS 발생을 확인해야 하는 공통 코드 후보

[AlgoLab의 WS 설명 §8][algo-ws]은 아래 값을 LOGIN·실시간 관련 오류로 나열한다. 그러나 같은 글이 근거를 공식 **공통** 오류표라고 밝히며 WS 실패 프레임을 제공하지 않는다. 공식 표의 의미까지 확인했지만 **WS 전송 여부·단계·상위 코드 조합은 추정**으로 남긴다. §3의 SDK 전용 근거가 있는 8005·8031은 여기서 중복 집계하지 않았다.

| 코드 | 단계 | 뜻 | 언제 오나 | 출처 | 확인 수준 | 제안 범주(ADR 0009) |
|---|---|---|---|---|---|---|
| 8010 | LOGIN 후보 | 토큰 발급 IP와 요청 IP 불일치 | 다른 IP에서 발급한 토큰 사용 가능성, WS 원문 없음 | [공식 공통표][portal-errors], [공개 WS 설명][algo-ws] | 추정(WS 적용); 의미는 공식 | A |
| 8030 | LOGIN 후보 | 앱키 실전·모의 구분 불일치 | LOGIN은 토큰만 보내므로 직접 앱키 오류가 오는 경로도 미확인 | [공식 공통표][portal-errors], [공개 WS 설명][algo-ws] | 추정(WS 적용); 의미는 공식 | A |
| 8104 | 제어 후보 | 모의투자 미지원 API | 모의에서 미지원 실시간 항목 요청 여부 확인 필요 | [공식 공통표][portal-errors], [공개 WS 설명][algo-ws] | 추정(WS 적용); 의미는 공식 | F Unsupported |
| 1702 | 제어 후보 | 공통 API 그룹 요청 유량 초과 | WS grp_no의 등록 수 제한과 동일하다는 근거 없음. WS에선 105110·105118과 구별 필요 | [공식 공통표][portal-errors], [공개 WS 설명][algo-ws] | 추정(WS 적용); 의미는 공식 | R, 실제 해당 코드 수신 시만 |
| 1902 | REG 후보 | 종목 정보 없음 | 없는 종목의 REG가 이 코드를 주는지, ACK 성공 후 무수신인지 미확인 | [공식 공통표][portal-errors], [공개 WS 설명][algo-ws] | 추정(WS 적용); 의미는 공식 | S SymbolMismatch, 실제 수신 시만 |
| 1903 | REG 후보 | 종목·거래소 조합 정보 없음 | 잘못된 venue 접미사의 실제 실패 방식 미확인 | [공식 공통표][portal-errors], [공개 WS 설명][algo-ws] | 추정(WS 적용); 의미는 공식 | S SymbolMismatch, 실제 수신 시만 |

8001·8050 등 나머지 REST 공통 코드도 WS에서 발생하지 않는다고 단정할 수 없다. 다만 전체 37개를 WS 관측 코드로 복제하지 않는다. WS에서 알려진 상세 인증 코드가 실제로 오면 ADR 0009의 공통 의미를 적용하되, 알려지지 않은 숫자는 `U`로 해당 경로만 멈춘다. LOGIN 오류라고 모두 토큰 재발급 또는 서버 전체 중단으로 바꾸지 않는다.

## 5. close 코드와 사유 문자열

**수신한 close와 클라이언트가 보낸 close, close 프레임 부재를 구별해서 기록한다.** `1006`은 키움이 전송한 close 코드가 아니며, `1009`도 아래 사례는 클라이언트 버퍼 문제다. 표준 의미는 [IANA 등록부][iana]·[RFC 6455 §7.4][rfc6455]를 근거로 한다.

| 코드 | 사유 문자열 | 뜻·언제 오나 | 출처 | 확인 수준 | 제안 범주·정책 |
|---|---|---|---|---|---|
| 1000 | `Bye` | hoga-ops에서는 두 번째 LOGIN이 기존 세션을 종료. stockmate-ai는 LOGIN 미전송 약 10초 뒤에도 같은 종료를 설명 | hoga-ops `docs/plans/2026-07-16-kiwoom-ws-integration.md:19`, `hoga/live/kiwoom_ws_client.py:1149`; [stockmate-ai:845-848][stockmate] | hoga-ops 기록 + 커뮤니티. 원인별 재현은 이번에 안 함 | 정상 종료 또는 원인 미확정 연결 종료. 중복 실행 증거가 있으면 WS 중단·운영자 조치, 시간·원인과 제한 예산을 보고 재접속. 토큰 무효로 단정 금지 |
| 1000 | 미기록 | 연속 재접속 중 LOGIN ACK 전에 서버가 닫힌 공개 관측. 문자열이 비어 있었다고까지 확정하지 않음 | [younghwan91 테스트 설명:373-378][young-close] | 커뮤니티(2026-08-15 관측 설명) | T에 준한 제한 재접속. LOGIN 성공으로 처리하지 않음 |
| 1006 | 미기록; close 프레임 없음 | 비정상 종료의 로컬 관측값. 공급사·네트워크·이벤트 루프 지연 중 원인은 불명 | hoga-ops `docs/diagnostics/2026-10-02-kiwoom-session-recovery/observations.json:1676-1677`, `docs/plans/2026-10-02-kiwoom-session-retirement-and-gc.md:40`; [RFC][rfc6455] | hoga-ops 기록 + 표준 | T에 준한 전송 실패. 제한 재접속, 토큰 발급 금지 |
| 1009 | `The decoded text message was too big for the output buffer` | Tomcat 클라이언트의 텍스트 수신 버퍼를 묶음 REAL이 초과. 서버 인증 거절이 아님 | [autoStock:111-113][auto-client], [운영 분석 L-2][auto-log] | 커뮤니티(2026-10-16 운영 분석) + 표준 | P에 준한 수신 설정·처리 결함. 같은 설정으로 무한 재접속하지 않음 |
| 1001 | 키움 문자열 미확인 | 상대가 떠남 | [IANA][iana] | 공식 표준만, 키움 미관측 | 제한 재접속 |
| 1002 / 1003 / 1007 / 1010 | 키움 문자열 미확인 | 프로토콜·데이터·확장 협상 문제 | [IANA][iana], [RFC][rfc6455] | 공식 표준만, 키움 미관측 | P에 준해 입력·설정 점검, WS만 중단 |
| 1008 | 키움 문자열 미확인 | 정책 위반. 인증 실패라는 뜻으로 고정 불가 | [IANA][iana] | 공식 표준만, 키움 미관측 | U에 준해 WS만 중단, 인증 전체 차단으로 승격 금지 |
| 1011 / 1012 / 1013 / 1014 | 키움 문자열 미확인 | 내부 오류·재시작·나중 재시도·게이트웨이 오류 | [IANA][iana] | 공식 표준만, 키움 미관측 | T에 준한 제한 재접속, 재발급 금지 |
| 1005 / 1015 | 키움 문자열 미확인 | close 상태 없음·TLS 실패를 나타내는 예약 관측값. close 프레임으로 송신 금지 | [RFC][rfc6455] | 공식 표준만, 키움 미관측 | 로컬 전송·TLS 원인 기록, 제한 복구 |
| 1004 / 그 밖의 값 | 미확인 | 예약값 또는 키움에서의 의미 미확인 | [IANA][iana] | 추정하지 않음 | UnknownClose로 WS 보호 정책 |

[FAQ 42][faq42]는 월~토 07:50~07:55, 일 05:00~05:15의 WS 단절을 정상 종료로 설명하지만 **숫자 1000이나 문자열 `Bye`를 보장하지 않는다.** 해당 시간 close의 실제 숫자·문구·재접속 지연은 미확인이다. [FAQ 15][faq15]도 PING 미응답 단절을 설명하지만 그 close 코드·사유·정확한 timeout은 제공하지 않는다.

공개 younghwan91 변경 기록의 ‘같은 토큰 두 세션 가능’ 주장은 [공식 공지 49][notice49]의 토큰별 세션 하나 및 hoga-ops 관측과 충돌한다. LOGIN 직후 짧은 중첩인지 장시간 동시 수신인지 입증되지 않아 단일 세션 정책을 바꾸는 근거로 쓰지 않는다.

## 6. #20 명시 코드 표와 #4 상태 전이에 적용할 안

1. **추가할 확실한 구분은 REG `105110 → R`이다.** 등록 한도 L과 나누고, WS 제어 전송을 지연·배치한다. 기존 소켓과 정상 등록을 유지할 수 있는지 ACK 상태로 판단한다. 한도 확인을 위해 매번 새 LOGIN을 하지 않는다.
2. **`100013 → C`는 LOGIN 대기 상태를 강제하는 근거다.** `Connecting → AwaitLogin → Ready`에서 Ready 전 REG·REMOVE를 막는다. 이 오류가 오면 앞선 REG를 accepted로 세지 않는다. LOGIN 성공 확인 뒤 최신 desired를 구성한다. 공개 모의 관측이므로 실제 전체 응답을 fixture로 고정하기 전에는 알려진 필드만 사용한다.
3. **`900004 → Q`는 조건검색을 도입할 때 사용한다.** CNSRLST를 먼저 받고 계정의 seq를 확인한다. 현재 국내 시세 앱에 조건검색 상태를 추가할 이유는 아니다. 일반 REG의 grp_no 불일치 D와 섞지 않는다.
4. **8005만 자동 재발급 대상으로 유지한다.** 공식 SDK는 8031·8103도 재인증하지만 ADR 0009는 허용하지 않는다. 공식 구현의 복구 목록과 공식 코드의 의미는 별개다.
5. **close와 제어 ACK timeout을 공급사 숫자 오류로 위장하지 않는다.** 종료 방향·수신 close 유무·현재 LOGIN 단계·최근 ACK·desired/accepted 상태를 함께 기록한다. 불명확한 제어 상태는 한 번 재구성하고, 같은 문제가 반복되면 실시간만 중단한다.

## 7. 미확인 항목과 장중 실측 절차

이번에는 실제 키움에 접속하지 않았다. 아래는 후속 실측을 승인받았을 때 사용할 절차다. 정상 실행 중인 #19 작업·실시간 수집과 같은 앱키를 함께 사용하면 기존 세션을 끊을 수 있으므로, **코디네이터 허락을 먼저 받고** `flock -n /run/user/1000/vallythevally/server.lock <실측 명령>`으로 비차단 잠금을 잡는다. 잠금 실패는 중단이다. 기존 사용 가능한 토큰만 재사용하며 없으면 그 실측을 생략한다. 새 토큰 발급·주문은 하지 않는다.

| 미확인 | 최소 실측 | 기록·판정 기준 |
|---|---|---|
| 무효·만료 토큰 LOGIN의 상위 코드와 전체 모양 | 토큰이 아닌 고정 무효 문자열로 1회 LOGIN; 만료 토큰은 기존 보관분이 있을 때만 별도 1회 | `trnm`, 숫자/문자열 타입, `return_code`, 비밀값 제거한 `return_msg`, ACK 전 close 여부. 오류를 보고 자동 발급하지 않음 |
| 100013의 정확한 trnm와 세션 후속 상태 | 새 연결에서 LOGIN 없이 REG 1회. 별도 연결에서 LOGIN을 보내고 ACK 전 REG 1회 | 각 요청에 대한 응답 순서·코드, LOGIN 뒤 같은 연결 사용 가능 여부. 전체 결과를 추정으로 채우지 않음 |
| 없는 type·형식 오류의 숫자 | 정상 LOGIN 뒤 알려지지 않은 2자 type 1개로 REG, 별도 세션에서 REMOVE | 코드와 메시지. 공지의 ‘미사용 type 오류’를 105112로 미리 단정하지 않음 |
| grp_no·refresh 검증 | 정상 세션에서 한 변수씩 누락·잘못된 타입·범위·값을 바꿈. grp_no는 빈 값·비숫자·4자 초과, refresh는 누락·0·1·그 외를 분리 | ACK와 실제 accepted 상태. refresh 0은 기존 등록을 지울 수 있으므로 격리한 소량 구독만 사용 |
| 없는 종목·잘못된 venue | 없는 6자리 코드와 미지원 접미사를 각각 1개 REG. 정상 종목 대조군을 함께 두지 않고 분리 | 오류 ACK인지 성공 ACK 후 무수신인지 구별. 장중이어도 무수신만으로 종목 부재를 확정하지 않음 |
| 105110 정확한 한도·TRNM별 공유 여부 | 별도 허락 뒤 정상 종목 소량으로 REG 간격을 단계적으로 줄이고 최초 105110에서 중단 | 초당 송신 수·응답 시각·TRNM. REMOVE·CNSRREQ와 한도를 공유하는지 별도 측정, 인증/계좌 잠금을 유도하지 않음 |
| REG 실패의 원자성·REMOVE 수렴 | 아주 작은 정상/비정상 혼합 요청 후 REMOVE·재등록 결과 비교 | 부분 accepted 여부, 해지 후 잔여 REAL, grp_no별 상태. ACK 0만으로 전체 반영을 가정하지 않음 |
| 900004와 조건검색 초과 한도 코드 | 조건검색을 실제 도입할 때만 CNSRLST 선행 후 없는 seq 한 개 요청. 10조건·100결과 제한 초과는 별도 허락 없으면 하지 않음 | CNSRREQ/CNSRCLR 단계와 상세 코드; 실제 목록의 사용자 조건식 내용은 보고서에 불필요하게 복사하지 않음 |
| PING 미응답 종료 | 격리 연결에서 정상 로그인 후 한 번만 에코를 멈춤 | 마지막 PING, close 수신·송신 코드·사유·시간. 1000/Bye나 10초를 미리 고정하지 않음 |
| 점검 시간 close | 월~토 07:45부터 연결, 또는 일요일 점검 시작 전 연결을 별도로 승인받음 | close 방향·코드·사유·마지막 ACK, 종료 후 기존 토큰의 재접속 가능 시각. 점검 중 빠른 반복 접속 금지 |
| 1009와 메시지 크기 | 서버를 압박하지 않고 저장한 REAL 프레임을 로컬 수신 제한별로 재생 | 클라이언트가 보낸 close인지 서버 close인지, 실제 프레임 길이. raw 시세와 토큰·계좌 메타데이터 분리 |

공통 기록 형식은 관측 시각(KST), 운영/모의, 연결 세대, 단계, 안전한 요청 형태, 응답 코드와 타입, 정제된 메시지, 수신/송신 close, 마지막 PING·ACK 시각이다. 토큰·앱키·시크릿은 기록하지 않는다. 어떤 실패든 같은 입력의 무한 재시도 대신 한 표본을 확보하고 멈춘다.

[portal-errors]: https://openapi.kiwoom.com/errorcode/getErrorCodeListAjax
[portal-0b]: https://openapi.kiwoom.com/guide/apiGuideContents/14/0B
[portal-cond]: https://openapi.kiwoom.com/guide/apiGuideContents/15/ka10172
[official-root]: https://github.com/Kiwoom-Securities/Kiwoom-REST-API/tree/c7a3d25449ed4b4238bef378780c41103c67b9e9
[official-spec]: https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/_data/kiwoom_api_spec.json
[official-errors]: https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/core/errors.py#L4-L44
[official-connect]: https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/core/ws_client.py#L49-L66
[official-login]: https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/core/ws_client.py#L151-L180
[official-ping]: https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/c7a3d25449ed4b4238bef378780c41103c67b9e9/kiwoom/core/ws_client.py#L182-L197
[hero-root]: https://github.com/Kiwoom-Securities/pyheroapi/tree/9376670bb89e5843980828501b646862822c1f4e
[hero-condition]: https://github.com/Kiwoom-Securities/pyheroapi/blob/9376670bb89e5843980828501b646862822c1f4e/pyheroapi/realtime.py#L558-L595
[hero-example]: https://github.com/Kiwoom-Securities/pyheroapi/blob/9376670bb89e5843980828501b646862822c1f4e/examples/ka10171_only_example.py#L78-L100
[notice7]: https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAZPagingDetailView?seqid=7
[notice16]: https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAZPagingDetailView?seqid=16
[notice49]: https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAZPagingDetailView?seqid=49
[faq3]: https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=3
[faq4]: https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=4
[faq15]: https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=15
[faq42]: https://bbn.kiwoom.com/bbs/VBbsNoticeNOPAFPagingDetailView?seqid=42
[algo-ws]: https://algolab.co.kr/blog/kiwoom-rest-api-realtime-websocket-0b-0d-2026
[auto-client]: https://github.com/hobbiespark/autoStock/blob/4bdd94bc90183de096860c5981374b4657d7f0bb/app/src/main/java/com/autostock/market/KiwoomWebSocketClient.java#L93-L113
[auto-probe]: https://github.com/hobbiespark/autoStock/blob/4bdd94bc90183de096860c5981374b4657d7f0bb/scripts/ws_probe.py#L144-L147
[auto-log]: https://github.com/hobbiespark/autoStock/blob/4bdd94bc90183de096860c5981374b4657d7f0bb/aiDoc/upgrade-2026-10/19-log-review-2026-10-16.md#L17-L22
[day-live]: https://github.com/choidev777-bit/dayjaview/blob/0bd311e0cf0d7b2421d334d7e5785474cf35681f/packages/adapters/kiwoom/live.py#L9-L16
[stockmate]: https://github.com/Eehoyoung/stockmate-ai/blob/120226addcb11d0ef2636687d060b99c95e1d5f8/websocket-listener/ws_client.py#L845-L848
[young-close]: https://github.com/younghwan91/kiwoom-client/blob/7f471f39954832ce79cd47da8919f92c293217f4/tests/test_websocket.py#L373-L378
[iana]: https://www.iana.org/assignments/websocket/websocket.xhtml
[rfc6455]: https://www.rfc-editor.org/rfc/rfc6455#section-7.4
