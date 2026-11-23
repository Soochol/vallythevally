# 개인 엔진과 공용 서버 분리 설계

[데스크톱 앱 플랜](plans/desktop-app.md)과 [ADR 0045](adr/0045-desktop-app-runs-a-personal-engine-and-the-server-keeps-login-and-shared-data.md)가 방향을 정했다. 사용자 N명이 각자 N개 증권사를 쓰고, 앱 안의 **개인 엔진**이 사용자 키로 증권사에 직접 연결하며, **공용 서버**는 로그인, 계정별 셋업, 공용 자료만 맡는다. 이 문서는 지금의 `vally-server`(`crates/server`)를 그 둘로 나누는 설계다. 되돌리기 어려운 결정은 [ADR 0048](adr/0048-personal-engine-child-process-run-secret-keychain-and-loopback-login.md)에 있다. 설계의 첫 축은 성능이다.

코드 사실의 기준은 `origin/main` `871206b1`(#851)이다. 다른 탭의 `kis-orders`, `kiwoom-token-owner`, `kis-rest-edges`, `source-switch-edges`, `screener-kis-summary`와 이 플랜의 `public-web-retire`, `desktop-bench`가 모두 병합된 판이다. 증권사 조사는 `broker-survey` 보고서(`~/.claude/orch/reports/broker-survey/broker-survey.md`, 저장소 밖, 확인일 2026-11-23)를 썼다.

숫자 표기: **측정**은 출처 문서나 명령을 같이 적는다. **추정**은 가정을 같이 적는다. **코드 값**은 코드에 있는 상수이고 위치를 적는다. **정한 값**은 이 설계가 고른 상수다.

## 1. 모듈 지도

`crates/server`는 크레이트 하나로 두고 실행 모드 둘(앱 모드의 개인 엔진, 서버 PC의 공용 서버)로 돌린다. 크레이트를 지금 둘로 쪼개지 않는 이유는 두 가지다. 수집기(`crates/collector`)가 `server`의 `kiwoom/`·`kis/`·`shared_data/`·`financials/`를 라이브러리로 쓴다. 또 `AppState`(`http.rs`)가 모든 모듈을 한 구조체로 묶고 있다. 크레이트를 나누는 일은 아래 표대로 실행 경로가 갈라진 뒤에 따로 판단한다.

표의 뜻은 다음과 같다. **개인 엔진**은 앱 모드에서만 돈다. **공용 서버**는 서버 PC에서만 돈다. **둘 다**는 두 모드가 함께 쓴다. **걷는다**는 두 모드 모두에서 지운다. 공용 서버는 증권사 키를 갖지 않는다(ADR 0045). 그래서 증권사를 부르는 모듈은 공용 서버에서 돌지 않는다. 이 모듈들은 수집기 바이너리 안에서는 계속 쓰인다.

| 항목 | 고른 곳 | 이유 |
|---|---|---|
| `account` | 개인 엔진 | 루프백 로그인(PKCE), 커넥터 토큰, 셋업 동기화를 하는 커넥터 쪽 코드다. 앱 로그인이 이것을 다시 쓴다(5절) |
| `account_routes` | 개인 엔진 | 화면이 부르는 `/api/account/*`와 `/auth/complete`. 공개 리스너는 이것 대신 `/v1/*`를 계정 서버로 넘긴다 |
| `api` | 둘 다 | 화면과 주고받는 DTO(ts-rs). 공용 자료 응답 모양이 두 모드에서 같아야 엔진이 그대로 중계한다(6절) |
| `app` | 둘 다 | 시작 배선. 앱 모드와 공용 서버 모드의 시작 함수를 나눈다. 공용 서버 모드는 `KiwoomRest`·`MarketHub`를 만들지 않는다 |
| `bars` | 개인 엔진 | 차트 봉 캐시. 사용자 키로 받는다(결정 D9) |
| `bin` | 공용 서버 | `dart-smoke`는 OpenDART 키로 재무 클라이언트를 확인하는 도구다. 재무 수집은 서버 PC의 수집기가 한다([ADR 0046](adr/0046-financials-are-collected-by-the-collector-and-the-server-only-reads-them.md)) |
| `clock` | 둘 다 | KST 시계와 시험용 가짜 시계 |
| `collector` | 공용 서버 | 서버 PC 수집 데몬의 상태 소켓, 텔레그램 경보, `/api/collector/*`. 사용자 PC에는 데몬이 없다 |
| `config` | 둘 다 | 설정 해석. 앱 모드(표준 입력 한 줄, 공용 서버 주소)와 공용 서버 모드의 칸이 갈린다 |
| `db` | 개인 엔진 | 로컬 셋업 사본 SQLite(`vally.db`). 공용 서버의 계정별 셋업은 계정 서버 저장소에 있다 |
| `drawing_api` | 둘 다 | 드로잉 DTO. 공개 리스너의 `public/user_data.rs`도 같은 모양을 쓴다 |
| `drawings` | 개인 엔진 | 로컬 드로잉 저장. 공용 서버는 `public/user_data.rs`가 맡는다 |
| `etf` | 공용 서버 | 네이버에서 모으는 ETF 구성·이력. 사용자마다 따로 모을 이유가 없는 공용 자료다. 엔진은 중계한다(6절) |
| `financials` | 공용 서버 | 수집기가 모은 `financials.db`를 읽어 준다(ADR 0046). 엔진은 중계한다 |
| `fundamentals` | 개인 엔진 | 기본 정보. 미리 만들 수 없는 요청이라 사용자 키로 받는다(D9) |
| `heatmap_board` | 공용 서버 | 스냅샷과 계정 셋업의 히트맵 테마로 보드를 계산한다. 엔진이 3,960종목(측정: 아래 10절의 `listed` 행 수) 스냅샷을 30초마다 받지 않게 하려고 서버가 계산한다(6절) |
| `heatmap_flow` | 공용 서버 | 수집 데몬의 분봉으로 흐름을 계산한다. 수집 대상 밖 종목은 `notCollected`다 |
| `http` | 둘 다 | 라우터와 `AppState`. 앱 모드는 공용 자료 라우트 자리에 중계를 붙인다 |
| `instance` | 둘 다 | 잠금 파일. 같은 자료 폴더의 두 번째 실행을 막는다 |
| `intraday_feed` | 개인 엔진 | 호가·체결·프로그램 첫 화면. 사용자 키(D9) |
| `investors` | 개인 엔진 | 외국인 보유·투자자 순매수. 사용자 키(D9) |
| `jump_bars` | 개인 엔진 | 봉 점프 조회. `bars`를 쓴다 |
| `kis` | 개인 엔진 | 한투 REST·WS. 사용자 키로만 쓴다 |
| `kiwoom` | 개인 엔진 | 키움 REST·WS, 키 목록, 토큰 파일. 사용자 키로만 쓴다 |
| `kiwoom_themes` | 공용 서버 | 키움 테마 목록. 공용 자료 폴더에서 읽는다. 스스로 모으는 길(`catalog.rs:205`)은 공용 자료 폴더가 없을 때만 쓰인다 |
| `lib` | 둘 다 | 모듈 목록 |
| `main` | 둘 다 | 바이너리 진입점. 모드는 설정으로 고른다 |
| `market` | 개인 엔진 | 실시간 허브, 구독, 내보내기. `/api/ws`의 근원이다 |
| `market_overview` | 공용 서버 | 시장 개요 카드. 공용 자료 폴더에서 읽는다. 키움으로 직접 받는 길과 장중 표본기는 공용 자료 폴더가 없을 때만 쓰인다 |
| `market_source` | 개인 엔진 | 증권사 시세 경계(`MarketSource`, `MarketStream`)와 전환(7절) |
| `public` | 공용 서버 | 공개 리스너. 공용 서버의 입구다. 화면 파일 서빙과 CSP는 9절대로 걷는다 |
| `public_ip` | 개인 엔진 | 키움 IP 등록을 돕는 공인 IP 확인. 키를 쓰는 PC에서만 뜻이 있다 |
| `quotes` | 개인 엔진 | 현재가. 사용자 키(D9) |
| `rankings` | 둘 다 | 공용 서버는 미리 만든 조건을 공용 자료로 준다. 엔진은 그 밖의 조건을 사용자 키로 받는다(`rankings/kiwoom.rs`의 대체 길) |
| `screener` | 공용 서버 | 스크리너 실행과 일봉 저장소(DuckDB). 엔진에서 빠지는 가장 큰 덩어리다(10절) |
| `setup_bundle` | 개인 엔진 | 셋업 내보내기·가져오기. 로컬 사본의 일이다 |
| `setup_documents` | 개인 엔진 | 로컬 셋업 문서 종류. 공용 서버는 `crates/setup`과 계정 서버 저장소를 쓴다 |
| `shared_data` | 둘 다 | 공용 서버는 공용 자료 파일을 읽는다. 수집기는 같은 모듈의 `write.rs`로 쓴다. 엔진은 응답 모양만 쓴다 |
| `symbols` | 둘 다 | 종목 목록과 검색. 엔진은 증권사 목록으로, 공용 서버는 스냅샷 종목 목록으로 채운다 |
| `sync_log` | 개인 엔진 | 셋업 동기화 기록 |
| `system_routes` | 개인 엔진 | 키 관리, 연결, IP 확인, 주문 스위치 |
| `trading` | 개인 엔진 | 주문, 잔고, 주문 일지, 계좌. 공용 서버에는 주문 라우트가 없다 |
| `user_routes` | 개인 엔진 | 로컬 관심종목·조건식·레이아웃·화면 상태·히트맵 테마. 공용 서버는 `public/user_data.rs`가 같은 경로를 계정 셋업으로 받는다 |
| `userdata` | 개인 엔진 | 로컬 셋업 저장소(SQLite) |
| `write_guard` | 개인 엔진 | 루프백 Host·Origin·`Sec-Fetch-Site` 검사. 엔진 쿠키 검사(3절)가 같은 층에 붙는다 |
| `ws` | 개인 엔진 | `/api/ws`. 공개 리스너에는 없다 |

모듈 단위로 걷는 것은 없다. 걷는 것은 모듈 안의 길이다. 앱 모드에서 꺼지는 것은 `screener_update_on_connect`(`app.rs:142`)의 일봉 갱신, 재무 자동 갱신, 장중 표본기, 키움 테마와 ETF를 스스로 모으는 길이다. 공용 서버에서 걷는 것은 공개 리스너의 화면 파일 서빙과 CSP, 브라우저 세션 로그인이다(9절).

확인 명령과 그 출력은 작업 보고서에 있다. 명령은 `ls crates/server/src`의 항목마다 확장자를 떼고, 이 표의 첫 칸에 정확히 한 번 나오는지 센다.

## 2. 프로세스 모양

**정한 것: 엔진은 껍데기의 자식 프로세스로 둔다. 화면은 엔진의 루프백 HTTP/WS로 통신한다.** 지금 뼈대(S1)의 모양을 그대로 굳힌다.

| 축 | 루프백 WebSocket | Tauri IPC 채널 | 근거 |
|---|---|---|---|
| 초당 3,000건 손실 | 0건 | 0건 | 측정: [`docs/desktop-performance.md`](desktop-performance.md), `xvfb-run -a desktop/bench/run.sh` |
| 지연 p99 | 0.63ms | 0.36ms | 측정: 같은 문서. 시계 해상도가 1ms라 두 값을 가르지 못한다 |
| 화면 CPU, 초당 1,000건 | 3.2% | 8.1% | 측정: 같은 문서 |
| 화면 CPU, 초당 3,000건 | 6.2% | 16.7% | 측정: 같은 문서 |
| 화면 코드 변경 | 없음 | `http.ts`·`socket.ts`를 IPC로 바꾼다 | 코드: 화면의 `fetch` 호출은 `api/http.ts:169` 한 곳이다(`public-mode/session.ts:23`은 `fetcher = fetch` 기본 인자). `new WebSocket`은 `api/socket.ts:59` 한 곳이다 |

IPC 채널은 같은 일에 화면 CPU를 2.5~2.7배(측정, 위 표) 쓴다. 지연은 둘 다 1ms 아래(측정)라 IPC가 얻는 것이 없다. 화면이 IPC에 기대지 않으면 껍데기를 바꾸는 비용도 창 띄우기로 줄어든다.

엔진을 껍데기 프로세스 안에 링크하는 안도 견줬다. 얻는 것은 프로세스 하나 몫의 메모리와 시작 시간이다. 이 값은 재지 않았다(추정: 수 MB와 수십 ms. Rust 바이너리 하나의 고정 비용 정도다). 잃는 것은 세 가지다.

- **장애 격리.** 엔진의 panic, 잠금 오염([ADR 0040](adr/0040-the-public-listener-serves-browser-logins-and-shared-data-apart-from-the-operator-listener.md)이 본 `lock().expect` 연쇄 실패), 메모리 누수가 창을 같이 죽인다. 자식이면 껍데기가 다시 띄운다(8절).
- **의존성 분리.** 껍데기의 Tauri 의존성이 루트 워크스페이스와 `Cargo.lock`에 들어온다. S2가 이것을 막으려고 `desktop/`을 따로 뒀다.
- **시험.** 지금 엔진은 실행 파일과 환경 변수만으로 e2e와 `verify-vally`가 돈다. 안에 링크하면 앱 밖에서 엔진만 띄우는 길을 따로 둬야 한다.

**한계.** 위 숫자는 개발 PC의 WebKitGTK와 GPU 없는 소프트웨어 그리기에서 나왔다(측정 환경은 `docs/desktop-performance.md`). Windows WebView2 값이 아니다. 결정 D5의 Windows PC에서 같은 명령(`python desktop/bench/run.py --out desktop/bench/results/windows.json`)을 돌려 확인한다. 그 결과에서 IPC 채널의 화면 CPU가 WebSocket보다 낮게 나오면 이 절을 다시 본다(후속 `windows-bench`).

## 3. 엔진 루프백 API 보호

**위협.** 엔진의 루프백 포트는 같은 PC의 모든 프로그램이 부를 수 있다. 지금 막는 것은 Host·Origin·`Sec-Fetch-Site` 검사(`write_guard.rs`, ADR 0040)뿐이다. 이 검사는 브라우저 페이지(CSRF, DNS rebinding)를 막지만 브라우저가 아닌 로컬 프로그램은 막지 못한다. 그런 프로그램은 Host와 Origin을 마음대로 적는다. 막을 대상은 다른 OS 사용자의 프로세스, 샌드박스 안의 앱, 포트를 훑는 프로그램이다. 이 사용자로 돌면서 앱 자료 폴더를 읽는 악성 프로그램은 막지 않는다. 그 프로그램은 키 파일과 키체인도 읽을 수 있다. 같은 한계를 [ADR 0023](adr/0023-connector-and-account-server.md)도 받아들였다.

**넘기는 길.**

1. 껍데기가 실행마다 32바이트 난수(정한 값) **입장권**을 만든다. 엔진의 표준 입력 첫 줄 JSON `{"ticket": "<base64url>", "dataKey": "<base64url>"}`로 넘긴다. `dataKey`는 4절에서 쓴다. 엔진은 환경 변수 `VALLY_ENGINE_STDIN=1`이 있을 때만 이 줄을 읽는다. 이 변수가 있는데 줄이 없거나 모양이 틀리면 시작하지 않는다.
2. 껍데기는 엔진이 응답하면 창을 `http://127.0.0.1:<포트>/auth/engine?ticket=<입장권>`으로 연다.
3. 엔진은 입장권을 상수 시간으로 비교한다. 맞으면 입장권을 지우고(한 번만 쓴다) 새 32바이트 난수(정한 값) **엔진 쿠키** `vally_engine`을 `HttpOnly; SameSite=Strict; Path=/`로 둔 뒤 `/`로 302한다. 루프백은 http라 `Secure`는 붙이지 않는다.

표준 입력을 고른 이유는 셋이다. 명령줄 인수는 다른 OS 사용자에게도 보인다. 환경 변수는 엔진이 띄우는 자식과 진단 출력(연기 시험이 엔진 환경을 기록한다)으로 샌다. 표준 입력은 열어 둔 채로 두면 종료 신호로도 쓴다(8절). 입장권을 쿠키로 바꾸는 이유는 주소가 창의 방문 기록에 남기 때문이다. 남은 입장권은 이미 쓰였으므로 다시 쓸 수 없다.

**검사 위치.** 운영자 라우터에 `guard_origin`과 나란히 층 하나(`app.rs:426-429`)를 더한다. 앱 모드에서만 켠다. 검사는 지금의 Host 검사, 엔진 쿠키, 지금의 Origin·`Sec-Fetch-Site` 검사 순서로 돈다. 쿠키가 없거나 틀리면 `401`과 `{"error":{"code":"engine_locked",…}}`를 낸다. 범위는 다음과 같다.

| 경로 | 검사 |
|---|---|
| `/api/*`(아래 `/api/server-mode` 빼고), `/api/ws` 업그레이드 포함 | 엔진 쿠키 필요. WebSocket 업그레이드는 같은 출처의 쿠키를 싣고 오므로 따로 할 일이 없다 |
| `/api/server-mode` | 면제. 껍데기의 준비 확인(`desktop/src-tauri/src/engine.rs:21`의 `READY_PROBE_PATH`)이 쿠키 없이 이 경로의 200을 기다린다. 응답은 서버 모드뿐이고 비밀이 없다 |
| `/auth/engine` | 입장권으로 확인 |
| `/auth/complete` | 면제. 계정 서버가 **시스템 브라우저**를 이 주소로 보낸다(5절). 시스템 브라우저에는 엔진 쿠키가 없다. `state`와 PKCE가 이 길을 지킨다(ADR 0023) |
| 화면 파일(`/`, 정적 파일) | 면제. 비밀이 없다. 쿠키 없이 뜬 화면은 첫 API 호출에서 401을 받는다 |

**화면 코드 변경량.** 0줄. `fetch`와 `WebSocket`이 같은 출처의 쿠키를 저절로 싣는다. 헤더 방식을 고르지 않은 이유가 이것이다. 브라우저의 `WebSocket`은 헤더를 붙일 수 없어서 헤더 방식은 질의 문자열이나 `Sec-WebSocket-Protocol`로 따로 넘겨야 했다. 생성 타입 `ApiErrorCode`에 `engine_locked` 값 하나가 더해진다. 엔진이 다시 뜨면 껍데기가 새 입장권으로 창을 다시 연다. 그래서 화면이 이 오류를 처리할 일은 없다.

**개발과 시험.** `VALLY_ENGINE_STDIN`이 없으면 지금처럼 검사가 없다. e2e, `verify-vally`, `scripts/web.py live`는 바뀌지 않는다. 앱 껍데기는 늘 이 변수를 준다. 연기 시험에 다음을 단정하는 항목을 더한다. 쿠키 없는 `/api/system/*`, 쿠키 없는 `/api/ws`, 쓴 입장권은 401이다. 앱 창은 200이다.

**ADR 0045의 받아들일 한계를 푼다.** "루프백 API 보호가 들어가기 전에는 앱에서 주문을 켜지 않는다"는 이 검사가 병합된 뒤 풀린다.

## 4. 키 보관

**지금.** 엔진의 상태 파일은 모두 평문 JSON이고 `PrivateFile`(`kiwoom/private_file.rs`)로 읽고 쓴다. 대상은 다음과 같다.

- 키 목록(`kiwoom-keys.json`)과 옛 키 파일, 등록 IP 파일(`kiwoom/key_file.rs`)
- 키움 토큰과 발급 기록(`kiwoom/token_file.rs`, 키별 파생 파일)
- 한투 토큰(`kis/token_file.rs`)
- 계정 상태(`account.json`, `account/state_file.rs`)
- 주문 스위치(`kiwoom-orders.json`, `trading/switch.rs`)

`PrivateFile`은 디렉터리 700, 파일 600을 검사하고 임시 파일에 쓴 뒤 이름을 바꾼다. 암호화는 없다. 이 검사는 `std::os::unix`를 쓴다(`private_file.rs:3`). 그래서 엔진은 지금 Windows에서 컴파일되지 않는다. 같은 import가 `instance.rs`, `config.rs`, `app.rs`, `kiwoom/{token_file,key_file,ip_file}.rs`, `kis/token_file.rs`, `trading/switch.rs`, `collector/**`에도 있다(측정: `grep -rln "std::os::unix\|libc::" crates/server/src`). [`docs/desktop-release.md`](desktop-release.md)도 Windows 엔진 빌드를 아직 확인하지 못한 것으로 적는다. 엔진을 Windows에서 빌드하는 일은 후속 `engine-windows-build`다. 앱 자료 폴더는 `%APPDATA%`(Roaming)라 로밍 프로필과 백업 도구가 평문 키를 복사할 수 있다.

**정한 것(S7 확정).** OS 키체인에 설치마다 **자료 키**(32바이트 난수, 정한 값) 하나를 둔다. 위 파일은 모두 그 키로 AES-256-GCM 암호화한다.

- **키체인을 읽는 쪽은 껍데기다.** 껍데기의 `desktop/` 워크스페이스만 키체인 크레이트를 갖는다. Windows는 자격 증명 관리자(`CRED_PERSIST_LOCAL_MACHINE`), macOS는 키체인이다. 엔진은 자료 키를 표준 입력(3절)으로 받는다. 그래서 루트 워크스페이스에 OS 키체인 의존성이 들어오지 않고, 엔진 시험은 자료 키를 주입한다.
- **암호화는 `PrivateFile` 한 곳에서 한다.** 위 파일이 모두 이것을 지나므로 부르는 쪽은 바뀌지 않는다. 봉투는 `{"sealed": 1, "environment": "real", "nonce": "<12바이트 base64>", "ciphertext": "<base64>"}`이다. 쓸 때마다 새 무작위 nonce를 쓴다.
  - 투자구분 표시(`environment`)는 암호문 밖에 그대로 둔다. `PrivateFile::stored_environment`(`private_file.rs:80`)는 파일을 풀지 않고 이 칸만 읽어 모의·실전 파일을 가른다. 봉투에 이 칸이 없으면 지금 규칙(`#[serde(default)]`)대로 실전으로 읽힌다. 그러면 모의 서버의 두 번째 저장부터 거절된다(재현: `EnvironmentOnly`에 봉투를 넣으면 `Real`).
  - 연관 자료(AAD)는 파일 이름과 투자구분이다. 토큰 파일의 암호문을 키 목록 자리에 옮기거나 겉의 투자구분을 바꾸면 풀리지 않는다. 파일 이름을 쓰므로 부르는 쪽이 종류를 넘길 필요가 없다. 암호 구현은 `ring::aead`다. `ring`은 이미 `Cargo.lock`에 있다(reqwest를 거친 간접 의존). `crates/server/Cargo.toml`에 직접 의존을 더하는 변경이다.
- **항목 크기 한도.** Windows 자격 증명의 비밀 값 한도는 2,560바이트다(문서 값: ADR 0045와 플랜 S7). 자료 키는 base64로 44바이트(계산)라 한도와 상관이 없다. 키 목록을 통째로 키체인에 두는 안은 맞지 않는다. 키 한 줄이 약 150~250바이트다(추정: 앱키·시크릿 수십 자에 별칭·증권사·계좌 칸을 더한 JSON). 키가 증권사마다 5개(코드 값: `key_file.rs:13`의 `KEY_LIMIT`)라 증권사 둘에서 약 1.5~2.5KB(추정)이다. 토큰까지 넣으면 한도를 넘는다. N개 증권사에서는 확실히 넘는다.
- **Windows 자료 위치.** `state/`를 `%LOCALAPPDATA%`로 옮긴다. 로밍 사본이 생겨도 자료 키가 그 PC에만 있으므로 풀리지 않는다.
- **옛 평문 파일 옮기기.** 앱 모드의 `PrivateFile`이 봉투가 아닌 JSON을 읽으면 할 일은 셋이다. 평문을 읽는다. 같은 경로에 봉투로 쓴다(임시 파일에 쓴 뒤 이름을 바꾸므로 평문 파일은 그 자리에서 사라진다). 다시 읽어 풀리는지 확인한다. 디스크 블록에 남는 평문 조각은 지우지 못한다(받아들인 한계). 개발 모드(`VALLY_ENGINE_STDIN` 없음)는 지금처럼 평문이다. 개발자의 `~/.config/vally`와 `$XDG_STATE_HOME/vallythevally`는 앱이 읽지 않는다(엔진 환경 규칙, [`docs/desktop-builds.md`](desktop-builds.md)).
- **자료 키를 잃었을 때.** 봉투가 있는데 키체인 항목이 없거나 풀리지 않으면 엔진은 키 상태를 `keys_unreadable`로 알린다. 시스템 설정에서 "키 다시 넣기"를 고르면 봉투 파일을 지운다. 토큰은 다시 발급받는다. 키움은 발급 간격이 최소 10분이다(ADR 0004). 그래서 다시 넣은 뒤 첫 연결이 늦을 수 있다.

| 안 | 얻는 것 | 잃는 것 |
|---|---|---|
| **키체인의 자료 키와 파일 암호화(고름)** | 키체인 항목 하나, 크기 한도와 무관하다. 코드가 `PrivateFile` 한 곳이다. 엔진은 OS를 모른다 | 자료 키를 잃으면 키를 다시 넣어야 한다 |
| 비밀값마다 키체인 항목 | 파일이 없다 | 항목 수가 키·토큰 수만큼 는다. 목록·순서·원자적 교체를 키체인 위에 다시 짜야 한다. 토큰이 자주 바뀌어 키체인 쓰기가 잦다 |
| Windows DPAPI로 파일마다 암호화 | 키체인 항목이 없다 | Windows 전용이다. macOS는 다른 길을 또 짜야 한다 |
| 잠금 비밀번호(PBKDF2) | 사용자 PC를 통째로 훔쳐도 지킨다 | 엔진이 뜰 때마다 묻는다. ADR 0041이 기본으로 고르지 않은 이유와 같다. 나중에 고를 수 있는 선택으로 남긴다 |
| 평문 그대로 | 할 일이 없다 | Windows에 권한 검사가 없고 로밍·백업으로 새어 나간다 |

## 5. 앱 로그인과 셋업

**정한 것(S6 확정).** ADR 0023의 루프백 흐름과 커넥터 토큰을 그대로 쓴다. 바꾸는 곳은 세 군데다.

1. **시스템 브라우저로 연다.** 지금 화면은 `startLogin`이 준 주소로 `window.location.assign`한다(`web/src/features/landing/useLoginStart.ts:18`). 앱 창에서 그대로 하면 IdP 화면이 앱 WebView 안에 뜬다. 이것은 RFC 8252가 금하는 내장 사용자 에이전트이고, Google은 내장 WebView의 OAuth를 막는다. 껍데기가 창의 이동을 가로챈다(Tauri `on_navigation`). 엔진 출처 밖으로 가는 최상위 이동은 막고 시스템 브라우저로 연다. 화면 코드는 바뀌지 않는다.
2. **`/auth/complete`의 응답.** 시스템 브라우저가 이 주소에 온다. 지금은 성공하면 `/`로, 실패하면 `/?login=error&reason=<코드>`로 302한다(`account_routes.rs:129-134`). 화면은 실패 이유를 자기 주소의 `reason`에서 읽는다(`web/src/features/account/loginFailure.ts:23`). 시스템 브라우저에는 엔진 쿠키가 없어 그 주소를 열어도 쓸 수 없고, 앱 창의 주소는 바뀌지 않는다. 그래서 앱 모드에서는 두 가지를 한다.
   - 브라우저에는 짧은 정적 문서를 준다. 성공이면 "로그인했습니다. 앱으로 돌아가세요"이고, 실패면 같은 실패 문구와 "앱에서 다시 시도하세요"다.
   - 앱 창에는 `/api/ws`의 `Account` 메시지로 알린다. 성공은 지금처럼 바뀐 계정 상태로 알린다. 실패는 그 메시지에 마지막 로그인 실패 코드 칸(`loginFailure`)을 더해 알리고, `loginFailure.ts`가 주소 대신 이 칸도 읽는다. 껍데기는 성공과 실패 모두에서 창을 앞으로 가져온다.
3. **포트.** 엔진 포트는 실행마다 바뀐다(`VALLY_BIND`, 껍데기가 고른다). 대기 중인 로그인은 엔진 메모리에 있다. 로그인 도중 엔진이 다시 뜨면 그 로그인은 실패하고 다시 시작해야 한다. 이것을 받아들인다.

**공개 리스너가 Bearer를 받는 길.** 지금 공개 리스너는 세션 쿠키만 받는다. 계정 서버의 Bearer 경로(`/v1/auth/token`, `/v1/me`, `/v1/setup/*`)는 일부러 열지 않았다(ADR 0040 Considered Options). 앱이 인터넷으로 닿는 곳은 Funnel의 공개 리스너 하나다(D12). 그래서 공개 리스너가 커넥터 경로와 Bearer를 받아야 한다.

- 공개 리스너 허용 목록에 계정 서버의 커넥터 라우터(`/v1/auth/{provider}/start`, `/callback`, `POST·DELETE /v1/auth/token`, `/v1/me`, `DELETE /v1/account`, `/v1/setup/{push,changes,summary}`)를 더한다.
- 문(`public/gate.rs`)은 주체를 둘 중 하나로 찾는다. 세션 쿠키가 있으면 세션 계정이다. `Authorization: Bearer`가 있으면 그 토큰의 계정이다. 지금 계정 서버의 `authenticate`(`crates/account-server/src/app.rs:409`)는 `pub(crate)`이고 `(토큰, account_id)`만 돌려준다. 그래서 버킷 키에 필요한 `provider:subject`까지 돌려주는 공개 함수를 계정 서버 라이브러리에 하나 더한다. 세션 쪽의 `session_account`와 같은 모양이다. 둘 다 있으면 거절한다. 공용 자료 라우트(6절)는 두 주체를 모두 받는다.
- Bearer 요청에는 Origin 필수 규칙을 걸지 않는다. 그 규칙은 브라우저가 쿠키를 저절로 싣는 CSRF를 막으려는 것이다. 브라우저는 Bearer를 저절로 싣지 않는다. Host 검사와 `Content-Type: application/json` 규칙은 그대로 건다.
- **계정 버킷.** 버킷 키는 지금처럼 `provider:subject`(`public/gate.rs:121`)다. 세션과 Bearer가 같은 계정이면 같은 버킷을 쓴다. 토큰을 여러 개 받아 한도를 늘리는 길이 없다. 엔진 하나가 창 여럿의 요청을 합치므로(6절) 사용자 하나의 요청 수는 창 수와 상관없어진다.
- **토큰 마지막 사용 시각.** 지금 `touch_token`(`crates/account-server/src/store.rs:242`)은 Bearer 요청마다 SQLite에 `UPDATE`를 한다. 사용자 100명이 초당 25건(추정, 6절 표)을 보내면 초당 25회 쓰기다. 세션과 같은 규칙으로 바꾼다. 마지막 사용 시각은 한 시간(ADR 0040의 세션 규칙) 넘게 지났을 때만 다시 쓴다. 90일 유휴 만료(코드 값: `TOKEN_IDLE_SECONDS`)에는 한 시간 오차가 문제 되지 않는다.

**지금의 브라우저 세션 쿠키 처리.** 앱이 병합될 때까지 그대로 둔다. 앱은 쓰지 않는다. 걷는 시점과 범위는 9절에 있다.

**셋업.** 동기화(ADR 0024)는 지금 코드 그대로다. 하나만 더한다. 히트맵 테마 문서를 바꾸면 엔진이 곧바로 한 번 밀어 올린다. 공용 서버가 보드를 계정 셋업의 테마로 계산하기 때문이다(6절). 밀어 올리기 전에 받은 보드는 옛 테마일 수 있다. 엔진은 밀어 올리기가 끝날 때까지 보드 캐시를 비운다.

## 6. 공용 자료 받기

**모양.** 앱 모드의 엔진은 공용 자료 라우트를 스스로 만들지 않는다. 대상은 지금 공개 리스너가 받는 공용 자료 라우트(`public/mod.rs:160-181`)다. 스크리너 실행·상태, 순위(미리 만든 조건), 시장 개요, 히트맵 보드·흐름, ETF, 재무가 여기에 든다. 키움 테마 목록(`/api/kiwoom-themes`)은 운영자 라우터(`http.rs:78`)에만 있고 화면이 부르지 않는다. 화면은 키움 테마를 `/api/heatmap/board?source=kiwoom`으로 받는다. 그래서 중계 대상에 넣지 않는다. 엔진은 **공용 자료 중계**로 이 라우트를 공용 서버의 같은 경로에 Bearer로 넘긴다. 응답은 메모리에 캐시하고 화면에는 지금과 같은 경로, 같은 JSON으로 준다. 화면 코드는 바뀌지 않는다. 중계는 새 모듈 `crates/server/src/shared_relay/`에 둔다.

**견준 세 안.** 같은 가정에서 사용자 수별로 요청 수와 바이트를 견준다. 아래는 모두 **추정**이다. 실제 값은 운영 단계에서 `GET /api/public-usage`로 잰다.

가정(사용자 하나, 장중):

- 순위 창 하나(조건 하나, 5쪽)가 10초마다 갱신된다(코드 값: `useRankingFeed.ts:9`, 수집 주기 10초).
- 히트맵 보드가 30초(코드 값: `heatmapBoard.ts:8`), 흐름이 60초(코드 값: `heatmapFlow.ts:8`)마다 갱신된다.
- 시장 개요 카드 6장이 각각 60초(코드 값: `marketOverview.ts:14`)마다 갱신된다.
- 응답 크기(비압축)는 보드 576KB(측정: ADR 0040, 보드 응답 하나), 순위 30KB(추정: 100행 × 약 300바이트), 흐름 50KB(추정), 시장 개요 카드 5KB(추정)다.

| 안 | 사용자당 요청/초 | 사용자당 바이트/초 | 10명 | 50명 | 100명 |
|---|---:|---:|---|---|---|
| 중복 제거 없음(지금 화면이 창마다 받는 모양, 같은 자료 창 k개) | 0.25 × k | 23.5KB × k | k배 | k배 | k배 |
| (가) 창 사이 중복 제거 | 0.25 | 23.5KB | 2.5건/초, 235KB/초 | 12.5건/초, 1.2MB/초 | 25건/초, 2.35MB/초(약 19Mbps) |
| (나) (가) + 판 번호 조건부 요청(304) | 장중 0.25, 장외 0.25 | 장중 23.5KB, 장외 약 0.08KB | 장중 (가)와 같다 | 장중 (가)와 같다 | 장중 (가)와 같다, 장외 약 8KB/초 |
| (다) 밀어주기(SSE/WS) | 연결 하나 | 장중 23.5KB(바뀔 때 한 번), 장외 0 | 연결 10개 | 연결 50개 | 연결 100개, 장중 2.35MB/초 |

계산은 이렇다. 요청은 0.1(순위) + 0.033(보드) + 0.017(흐름) + 0.1(카드 6장)이다. 바이트는 3KB + 19.2KB + 0.83KB + 0.5KB다. 장외 304 응답은 헤더만이라 약 0.3KB로 가정했다(추정).

읽는 법:

- **바이트의 82%는 보드다(추정, 위 가정).** 세 안 모두 장중에는 바뀐 자료를 한 번씩 보내므로 바이트가 같다. 대역폭을 줄이는 지렛대는 전송 방식이 아니라 보드 응답 크기다. 압축률과 바뀐 칸만 보내는 안은 후속 `shared-revision`이 잰 뒤 정한다.
- **(가)가 가장 큰 차이를 낸다.** 같은 자료를 여는 창(도킹 창, 떠 있는 창, 페이지 창)이 k개면 공용 서버 요청이 k분의 1로 준다. 엔진의 캐시는 (경로, 질의) 단위다. 같은 키의 동시 요청은 하나로 합친다(single-flight). 캐시 수명은 자료 주기다.
- **(나)는 장외에서만 이득이 있다.** 장중에는 자료가 주기마다 바뀌어 304가 거의 나지 않는다. 장외(20:00~08:00, 주말)에 앱을 켜 둔 사용자의 바이트는 약 300분의 1(추정)로 준다. 판 번호는 공용 자료 파일의 `writtenAt`과 서버가 이미 보는 파일 서명(`shared_data/board.rs:15`)으로 만든다. 응답이 계정 셋업에 달린 라우트는 그 셋업의 revision도 판 번호에 넣는다. 히트맵 보드는 계정의 히트맵 테마 문서로 요청마다 만든다(`public/user_data.rs:148-149`, `heatmap_board/mod.rs:151-158`). 흐름은 그 문서에 든 종목만 받는다. 스냅샷 서명만 쓰면 같은 계정의 다른 기기가 테마를 바꾼 뒤에도 304를 받아 옛 보드를 본다. 공용 자료 라우트에는 지금 ETag와 304가 없다. 공개 리스너의 정적 파일(`public/static_files.rs:182`)에만 `If-None-Match`와 304가 있고, 그 비교 함수를 다시 쓴다.
- **(다)는 신선도에서만 이긴다.** 폴링의 평균 낡음은 주기의 절반이다(순위 5초, 보드 15초). 엔진이 자료의 `asOf`에 주기를 더한 시각 직후에 요청하면 낡음이 그 여유(정한 값 1초) 정도로 준다. 요청 수는 그대로다. 밀어주기는 사용자마다 긴 연결이 Funnel을 지나고, 서버에 구독 상태와 재연결 규칙이 생긴다. 지금 얻는 것은 1초 남짓이다.

**정한 것.** (가)와 (나)를 하고, 엔진의 요청 시각을 `asOf`에 맞춘다. (다)는 하지 않는다. 다시 볼 조건은 둘이다. 장중 요청 수가 공용 서버의 병목으로 측정되거나, 화면이 1초보다 신선한 공용 자료를 요구할 때다.

**키 없이 쓰기(D11).** 공용 자료 중계에는 로그인만 필요하다. 증권사 키는 필요 없다. 키가 없는 사용자도 로그인하면 스크리너, 순위(미리 만든 조건), 시장 개요, 히트맵(키움 테마 포함), ETF, 재무를 쓴다. 로그인하지 않았으면 중계는 지금 공개 리스너의 오류 모양 그대로 `signed_out`을 준다. 화면은 이 모양을 이미 읽는다(`web/src/public-mode/signedOut.ts`).

**미리 만들 수 없는 요청(D9, 승인 값 "나").** 엔진이 사용자 키로 받는다. 차트 과거 봉, 현재가·당일 요약, 기본 정보, 투자자, 체결·호가·프로그램 첫 화면, 미리 만들지 않은 순위 조건이 그 대상이다. 모두 지금 엔진에 있는 코드다(`bars`, `quotes`, `fundamentals`, `investors`, `intraday_feed`, `rankings/kiwoom.rs`). 키가 없으면 지금처럼 `not_connected`다. 순위는 공용 서버가 `not_prepared`를 주고 사용자 키가 있을 때만 엔진이 직접 받는다.

## 7. 증권사 경계

**지금 경계의 모양.**

- **시세는 열린 경계다.** `MarketSource` trait(`market_source/mod.rs:32`)는 능력 집합(`MarketFeature`)과 조회 메서드를 갖고, `Arc<dyn MarketSource>`로 쓰인다. 실시간은 `MarketStream` trait(`market_source/stream.rs:161`)이다. 허브는 원하는 구독만 알리고, 자리 규칙(`SeatRules`)은 증권사가 정한다. 화면은 증권사 이름이 아니라 능력 목록으로 그린다(ADR 0043 `market-source-…`).
- **증권사 식별과 전환은 닫힌 열거형이다.** `api::Broker { Kiwoom, Kis }`(`api.rs:640`, 화면에도 나간다), `market_source/switch.rs`의 `Supplier`·`Wanted`, `route.rs`의 `Receiver`가 그것이다.
- **주문·계좌는 경계가 없다.** `trading/`의 `Lanes::{Fixed, Keyed, Kis}`(`trading/service.rs:112`)와 `Broker`를 가르는 분기가 `trading/service.rs`·`orders.rs`에 흩어져 있다.

**세 번째 REST/WS 증권사.** `broker-survey`가 1순위로 본 NH PLUG, DB증권, LS OPEN API는 모두 OAuth2 client_credentials 토큰과 JSON WS다. 시세 쪽은 받을 수 있다. 새 `MarketSource`·`MarketStream` 구현 하나와 닫힌 열거형 넷(`Broker`, `Supplier`, `Wanted`, `Receiver`)의 갈래로 끝난다. 주문 쪽은 지금 모양으로는 비용이 크다. 서버와 수집기에 `Broker::Kiwoom`·`Broker::Kis`가 130번, 28개 파일에 나온다(측정: `grep -rnoE "Broker::(Kiwoom|Kis)" crates/server/src crates/collector/src | wc -l`과 같은 패턴의 `grep -rlE … | wc -l`. 시험 파일 포함, match가 아닌 비교도 센다). `trading/`에 30번, 키 관리(`kiwoom/key_file.rs`, `kiwoom/keys.rs`)에 38번이다(측정, 같은 패턴). 나머지는 시세 전환, 공용 자료, 수집기에 흩어져 있다.

**정한 것.**

- 세 번째 증권사를 붙이기 전에 주문·계좌 경계를 `MarketSource`와 같은 trait로 세운다(후속 `trading-port`). 주문, 정정, 취소, 잔고, 주문가능, 계좌 실시간이 그 범위다. `Lanes` 분기는 trait 구현 안으로 들어간다.
- `api::Broker`는 닫힌 열거형으로 남긴다. 화면이 받는 닫힌 목록이고, 새 증권사마다 열거형에 값 하나를 더하면 컴파일러가 빠진 곳을 알려 준다.
- 토큰 규칙(발급 간격, 활성 토큰 하나뿐, 수명)은 증권사마다 다르다. 조사에 따르면 한투는 10분이고 토스는 활성 토큰이 하나뿐이다. 그래서 이 규칙은 `MarketSource` 밖의 키·토큰 정책 값으로 둔다. 실시간 자리 한도도 증권사마다 다르다. 조사 값으로 키움 200, 한투 40, DB 50, NH 30, 토스 100이고 세션 수도 다르다. 이 한도는 지금 `SeatRules`가 받는다.
- 모의 지원은 증권사마다 다르다(조사: 한투·토스는 모의가 없다). 주문 경계는 모의 여부를 능력으로 알린다.

**COM·OCX 증권사(대신, 하나, 유안타, LS 구 API).** 엔진 안에 넣지 않는다. Windows 32비트 **보조 프로세스**를 둔다. 모양만 정하고 구현하지 않는다.

- 엔진(64비트)의 자식이다. 수명은 엔진이 쥔다. Job Object(`KILL_ON_JOB_CLOSE`)를 쓴다.
- 보조 프로세스는 COM STA 스레드와 메시지 펌프를 쥐고 증권사 객체만 다룬다. 시세 규칙, 캐시, 허브는 엔진에 남는다.
- 통신은 표준 입출력의 줄 JSON이다. 수집 데몬과 자식의 방식(ADR 0026)을 따른다. 요청에는 번호를 붙이고, 실시간 이벤트는 같은 줄 흐름에 섞는다. 루프백 포트를 열지 않으므로 3절의 보호가 필요 없다.
- 엔진 쪽은 보조 프로세스를 감싼 `MarketSource`·`MarketStream`·주문 경계 구현 하나다. 그래서 위 경계가 그대로 받는다.
- 대신 CYBOS Plus는 크레온 HTS가 로그인한 채 떠 있어야 한다(조사). 보조 프로세스는 HTS를 띄우지 않고, HTS가 없으면 연결 실패로 알린다.

## 8. 엔진 수명

- **창을 닫으면 앱과 엔진이 끝난다. 트레이에 남지 않는다.** 지금 실시간 알림 기능이 없어서 창 없이 엔진을 살려 둘 이유가 없다. 트레이에 남기면 증권사 WS 세션과 엔진 메모리가 사용자가 모르게 계속 쓰인다. 알림 기능이 생기면 설정 하나("창을 닫아도 알림 받기")로 트레이 상주를 더한다. 그때 단일 실행 플러그인이 트레이의 엔진에 창을 다시 붙인다.
- **종료 신호는 표준 입력을 닫는 것이다.** 지금 Windows에서는 종료 요청이 아무 일도 하지 않는다(`desktop/src-tauri/src/engine.rs:160`의 `ask_to_end`). 그래서 10초 유예(코드 값)를 다 기다린 뒤 강제로 끝낸다. 주문 일지와 토큰 파일 쓰기가 중간에 끊길 수 있다. 엔진은 표준 입력의 EOF를 받으면 지금 SIGTERM과 같은 종료 길(`app.rs`의 종료 신호 작업)을 탄다. 이 길은 모든 OS에서 같다. Unix의 SIGTERM은 그대로 둔다.
- **엔진이 죽었을 때.** 껍데기가 자식의 종료를 본다. 1초, 2초, 4초, 8초, 16초(정한 값) 뒤에 다시 띄운다. 5분 안에 다섯 번(정한 값) 죽으면 멈추고 시작 화면에 실패 문구와 엔진 로그 마지막 12줄(코드 값, 지금 시작 화면)을 보인다. 다시 띄울 때마다 새 포트와 새 입장권을 쓰고 창을 새로 연다.
  - 토큰은 파일에 있어서 다시 발급하지 않는다. 키움의 10분 발급 간격(ADR 0004)에 걸리지 않는다.
  - 보내는 중이던 주문의 결과는 주문 일지와 증권사 조회로 다시 맞춘다. 이것은 지금 엔진의 재시작 규칙 그대로다.
  - 화면의 창 배치는 `ui-state`에 저장되어 있어 그대로 돌아온다.
- **업데이트.** 순서는 다음과 같다.
  1. 갱신본을 받고 서명을 확인한다(`desktop-updater`).
  2. 사용자에게 다시 시작을 묻는다. 장중에 주문 창이 열려 있으면 문구로 알린다.
  3. 엔진 표준 입력을 닫는다.
  4. 엔진 종료를 10초(코드 값)까지 기다리고, 넘으면 강제로 끝낸다.
  5. 설치본을 실행한다.
  6. 새 판으로 다시 뜬다.

  엔진이 남아 있으면 Windows 설치본이 엔진 실행 파일을 덮어쓰지 못한다. 그래서 3~4번이 설치보다 앞선다. 이 순서는 지금 [`docs/desktop-release.md`](desktop-release.md)의 순서와 같다. 바뀌는 것은 3번의 종료 요청이 Windows에서도 실제로 엔진에 닿는다는 점이다. 그 전에 엔진이 Windows에서 빌드되어야 한다(`engine-windows-build`).

## 9. 공개 모드 화면과 브라우저 세션의 처리 (S8)

웹 공개판은 운영하지 않는다(확정 3). 공개 리스너는 앱이 부르는 공용 서버의 입구로 남는다.

| 대상 | 처리 | 시점 |
|---|---|---|
| 공개 리스너의 공용 자료 라우트, 계정 버킷, 한도, 사용량 계수 | 남긴다. 앱의 공용 자료 중계가 부르는 곳이다 | 바꾸지 않는다 |
| 공개 리스너의 계정별 셋업 라우트(`public/user_data.rs`) | 남긴다. 히트맵 보드가 계정 셋업의 테마를 읽는 길이다 | 바꾸지 않는다 |
| 계정 서버의 커넥터 라우트(Bearer) | 공개 리스너에 연다(5절) | `public-bearer` |
| `signed_out` 오류 모양과 화면의 해석(`public-mode/signedOut.ts`) | 앱용으로 바꾼다. 엔진 중계가 같은 모양을 내므로 화면이 그대로 읽는다. 파일을 `public-mode/` 밖으로 옮기는 일은 아래 걷기와 함께 한다 | `public-mode-retire` |
| 로그인 화면(`features/landing/useLoginStart.ts`) | 앱용으로 바꾼다. 커넥터 모드 분기(`startLogin`)만 남는다. 껍데기가 시스템 브라우저로 연다 | `public-mode-retire` |
| `retryHold`(429·503의 `retryAt`을 지킨다), `flowMissing`(`notInThemes`를 `missing`에 합친다), `modeProbe`(서버 모드 조회) | 앱용으로 바꾼다. 엔진 중계가 공용 서버의 429와 `notInThemes`를 그대로 넘기므로 앱에서도 필요하다. `isPublicMode()` 조건을 떼고 `public-mode/` 밖으로 옮긴다 | `public-mode-retire` |
| 공개 모드 화면(`PublicSetupWizard`, `PublicAccountMenu`, `PublicSystemSettings`, `PublicUnavailable`, `serverMode`의 `public` 갈래, `rankingPages`) | 걷는다. 앱은 늘 커넥터 모드 화면으로 뜬다. 5쪽을 넘는 순위는 엔진이 사용자 키로 받으므로 `rankingPages`의 5쪽 상한이 필요 없다. 공용 자료가 없을 때의 안내(`not_prepared`, `notCollected`)는 공통 화면에 이미 있다 | `public-mode-retire` |
| 브라우저 세션 로그인(`/v1/session/*`, `__Host-vally_session`, 계정 서버 `session.rs`, 공개 리스너의 세션 주체) | 걷는다. 앱은 Bearer만 쓴다. 쓰는 사람이 없지만 앱 로그인이 병합되기 전에 걷으면 공용 서버의 로그인 시험 길이 없어진다 | 앱 로그인 뒤 `public-mode-retire` |
| 공개 리스너의 화면 파일 서빙과 CSP(`public/csp.txt`, 정적 파일) | 걷는다. 앱은 화면 파일을 자기가 갖고 있다. Funnel 대역폭을 화면 파일이 쓰지 않는다(D12) | `public-mode-retire` |

## 10. 성능 추정

**엔진에서 빠지는 일봉 저장소.**

| 값 | 크기 | 근거 |
|---|---|---|
| 스크리너 저장소 파일 | 269MB(268,972,032바이트) | 측정: 개발 PC `/home/dev/vally-data/server/screener.duckdb`, `ls -la`, 2026-11-18 갱신본 |
| 일봉 행 | 13,960,037행, 3,962종목, 1985-01-04~2026-11-18 | 측정: 같은 파일의 사본을 읽기 전용으로 열어 DuckDB `select count(*), count(distinct code), min(day), max(day) from daily` |
| 주봉·월봉 칸 | 2,911,285, 672,849 | 측정: 같은 사본, `count(distinct (code, date_trunc('week'/'month', day)))` |
| 상장 종목 | 3,960 | 측정: 같은 사본, `select count(*) from listed` |
| 스크리너 메모리 판 | 약 786MB | 추정. 아래 계산 |

메모리 판의 계산은 이렇다. 메모리 판(`screener/memory.rs`의 `PeriodBars`)은 봉마다 칸 번호 4바이트와 6열을 둔다. 열은 값이 `u32`를 넘으면 열 전체가 `u64`가 된다(`Column::Wide`).

- 일봉: 시고저종 최댓값이 110,327,469,800(측정: 같은 사본의 `max(open)`)이라 가격 4열이 8바이트다. 거래량 최댓값은 4,294,967,295(측정, `u32` 최댓값과 같다)이고 거래대금은 21,934,538(측정)이라 두 열은 4바이트다. 봉당 44바이트 × 13,960,037 = 약 614MB다.
- 주봉·월봉: 거래량 합이 `u32`를 넘는다고 보고(추정) 봉당 48바이트로 잡는다. 주봉 약 140MB, 월봉 약 32MB다.

이 값은 첫 스크리너 실행이나 갱신 뒤에 올라간다(`Edition::load`, `screener/memory.rs:289`. 미리 올리는 `warm_memory`는 `screener/mod.rs:197`). 엔진에 남아 있었다면 스크리너를 한 번 쓴 사용자 PC마다 상주했을 크기다. 가격 최댓값 1,103억 원은 실제 주가로 보기 어렵다. 이 한 값이 가격 열 넷을 8바이트로 넓힌다. 4바이트였다면 일봉은 약 391MB(추정, 봉당 28바이트)다. 자료 이상인지는 이 설계 밖이다(보고서의 발견 항목).

**엔진에서 빠지는 갱신 호출.** 일봉 갱신은 키움에 연결할 때마다 돈다(`screener_update_on_connect`). 그 호출이 사용자마다 사라진다. 종목당 일봉 한 쪽을 받는다고 가정하면 3,960회다. TR당 초당 5회(코드 값, [ADR 0035](adr/0035-kiwoom-queue-counts-each-tr-per-second.md))로 약 13분 동안 대기열을 쓴다(추정). 그동안 같은 TR의 화면 요청이 뒤로 밀린다.

**엔진 시작 시간.** 저장소를 여는 일(`Store::open`, `app.rs:314`)은 봉을 읽지 않는다. 메모리 판은 늦게 올라간다. 그래서 시작 시간에 주는 효과는 작다(추정). 큰 효과는 첫 스크리너 실행과 연결 직후에 있다. 엔진의 남은 상주 메모리와 시작 시간은 재지 않았다. 후속 `engine-footprint`가 앱 모드 엔진의 VmRSS와 `/api/server-mode` 첫 200까지의 시간을 분리 전과 뒤에 잰다. Linux에서는 `/proc/<pid>/status`를 읽고, Windows에서는 같은 명령의 작업 집합을 읽는다.

**공용 서버의 사용자 수별 부하.** 6절 표의 (가)+(나)를 쓴다. 모두 추정이다.

| 사용자 | 장중 요청/초 | 장중 응답 바이트/초(비압축) | 토큰 시각 쓰기, 지금 | 토큰 시각 쓰기, 한 시간 규칙 |
|---:|---:|---:|---|---|
| 10 | 2.5 | 235KB | 초당 2.5회 | 시간당 최대 10회 |
| 50 | 12.5 | 1.2MB | 초당 12.5회 | 시간당 최대 50회 |
| 100 | 25 | 2.35MB(약 19Mbps) | 초당 25회 | 시간당 최대 100회 |

공용 자료 파일은 메모리에서 읽는다(`shared_data`의 `Board<T>`, 코드). 히트맵 보드와 흐름은 그 위에서 계정의 테마 문서로 요청마다 다시 만든다(코드: `heatmap_board/mod.rs:151-179`). 100명이면 보드 초당 3.3회, 흐름 초당 1.7회다(추정, 6절의 사용자당 주기). 한 번 만드는 비용은 재지 않았다. `shared-revision`이 잰다. 판 번호가 같으면 304를 내고 다시 만들지 않으므로, 판 번호는 보드를 만들기 전에 스냅샷 서명과 테마 revision만으로 셈한다. 스크리너 실행은 계정당 분당 2회, 전체 분당 3회의 한도(코드 값: ADR 0040, `docs/public-operations.md`)가 묶는다. 요청 수는 병목이 아닐 것으로 본다(추정). 병목 후보는 장중 대역폭이고 그 82%가 보드다(추정). Funnel의 실제 한계는 재지 않았다(ADR 0040의 받아들일 한계). 압축 품질도 바이트를 바꾼다. 보드 응답 576KB의 brotli 기본 품질 압축은 0.58초가 걸렸다(측정: ADR 0040). 그래서 공용 자료 응답은 지금 공개 리스너의 압축 품질(품질 4, ADR 0040)을 그대로 쓴다.

## 11. 후속 작업 목록

같은 파일을 고치는 두 작업은 반드시 한쪽이 다른 쪽의 앞선 작업(앞선 작업의 앞선 작업 포함)이 되게 걸었다. 앞선 작업이 없는 작업은 `engine-guard`, `public-bearer`, `trading-port`, `engine-footprint` 넷이다. 넷의 경로가 서로 겹치지 않는다는 확인은 표 아래에 있다. `GLOSSARY.md`와 `docs/adr/**`에 몇 줄을 더하는 것은 표에 적지 않는다. 그런 변경은 몇 줄씩 더하는 관계다.

| ID | 내용 | 고칠 경로 글롭 | 앞선 작업 | 방식 | 방식의 이유 |
|---|---|---|---|---|---|
| `engine-guard` | 앱 모드 표준 입력 한 줄(입장권), `/auth/engine`, 엔진 쿠키 층, `/api/server-mode` 면제, `engine_locked`, 연기 시험의 401 단정(3절) | `crates/server/src/engine_guard.rs`, `crates/server/src/app.rs`, `crates/server/src/lib.rs`, `crates/server/src/config.rs`, `crates/server/src/api.rs`, `crates/server/tests/engine_guard.rs`, `web/src/api/generated/ApiErrorCode.ts`, `desktop/src-tauri/src/**`, `desktop/scripts/smoke.py`, `docs/desktop-builds.md` | 없음 | `poteto` | 인증 경계이고 주문을 켜는 조건이다 |
| `public-bearer` | 공개 리스너에 커넥터 라우트와 Bearer 주체, `provider:subject`를 돌려주는 계정 서버 공개 함수, 세션·Bearer 같은 계정 버킷, `touch_token` 한 시간 규칙(5절) | `crates/server/src/public/**`, `crates/server/tests/public_*.rs`, `crates/account-server/src/**`, `docs/public-operations.md` | 없음 | `poteto` | 인증과 공개 입구의 허용 목록을 바꾼다 |
| `trading-port` | 주문·계좌 경계 trait, `Lanes` 분기를 구현 안으로(7절). 동작은 바꾸지 않는다 | `crates/server/src/trading/**` | 없음 | `poteto` | 주문 경로의 구조를 바꾸고 여러 증권사에 걸친 새 설계다 |
| `engine-footprint` | 앱 모드 엔진의 VmRSS·시작 시간 측정 명령과 개발 PC 기준값(10절) | `desktop/bench/footprint/**`, `docs/desktop-footprint.md` | 없음 | `poteto` | 측정값이 분리 효과의 근거다. `desktop-bench`와 같은 이유 |
| `engine-windows-build` | `vally-server`를 `x86_64-pc-windows-msvc`로 컴파일되게 한다. `std::os::unix` 쓰는 곳을 OS별로 가른다. Windows의 `PrivateFile`은 권한 검사 대신 사용자 프로필 아래 경로만 받는다(4절) | `crates/server/src/kiwoom/private_file.rs`, `crates/server/src/kiwoom/{token_file,key_file,ip_file}.rs`, `crates/server/src/kis/token_file.rs`, `crates/server/src/trading/switch.rs`, `crates/server/src/instance.rs`, `crates/server/src/config.rs`, `crates/server/src/app.rs`, `crates/server/src/collector/**`, `crates/server/src/shared_data/format.rs`, `docs/desktop-release.md` | `engine-guard`, `trading-port` | `poteto` | 비밀값 파일의 권한 규칙을 OS마다 바꾼다 |
| `engine-keychain` | 껍데기의 키체인 자료 키, `PrivateFile` 봉투(겉의 투자구분, AAD는 파일 이름과 투자구분), 평문 옮기기, `keys_unreadable`, Windows `%LOCALAPPDATA%`(4절) | `crates/server/src/kiwoom/private_file.rs`, `crates/server/src/kiwoom/key_file.rs`, `crates/server/src/config.rs`, `crates/server/src/system_routes.rs`, `crates/server/Cargo.toml`, `Cargo.lock`, `desktop/src-tauri/**`, `docs/desktop-builds.md` | `engine-windows-build` | `poteto` | 비밀값 저장 형식과 옮기기다 |
| `shared-revision` | 공용 자료 라우트의 판 번호(ETag)와 304, 계정 셋업 revision을 넣은 보드·흐름 판 번호, 보드 응답의 압축 크기와 만드는 비용 측정(6절, 10절) | `crates/server/src/shared_data/**`, `crates/server/src/rankings/mod.rs`, `crates/server/src/market_overview/mod.rs`, `crates/server/src/heatmap_board/**`, `crates/server/src/heatmap_flow/**`, `crates/server/src/etf/**`, `crates/server/src/financials/routes.rs`, `crates/server/src/screener/mod.rs`, `crates/server/src/public/**`, `crates/server/tests/public_*.rs`, `docs/collector-shared-data.md` | `public-bearer`, `engine-windows-build` | `poteto` | 여러 공용 자료 모듈에 걸친 캐시 규칙이다 |
| `engine-relay` | 앱 모드의 공용 자료 중계(캐시, single-flight, `asOf` 맞춤, `signed_out`), 공용 서버 주소 설정(6절) | `crates/server/src/shared_relay/**`, `crates/server/src/http.rs`, `crates/server/src/app.rs`, `crates/server/src/config.rs`, `crates/server/src/lib.rs`, `crates/server/tests/shared_relay.rs` | `engine-keychain`, `shared-revision` | `poteto` | 앱 모드의 라우팅을 바꾸는 여러 모듈 설계다 |
| `app-login` | 껍데기의 외부 이동 가로채기와 시스템 브라우저, 앱 모드 `/auth/complete` 성공·실패 문서, `Account` 메시지의 `loginFailure`, 로그인 뒤 창 앞으로(5절) | `desktop/src-tauri/src/**`, `crates/server/src/account_routes.rs`, `crates/server/src/account/mod.rs`, `crates/server/src/api.rs`, `web/src/api/generated/**`, `web/src/features/account/**` | `engine-keychain`, `public-bearer` | `poteto` | 인증 흐름이다 |
| `engine-no-duckdb` | 앱 모드 빌드에서 일봉 저장소·갱신·재무 자동 갱신·표본기를 끄는 cargo 기능. `duckdb`를 선택 의존으로 바꾸고 `Screener`를 쓰는 곳을 그 기능으로 가른다. 번들 빌드 명령(1절, 10절) | `crates/server/Cargo.toml`, `Cargo.lock`, `crates/server/src/screener/**`, `crates/server/src/app.rs`, `crates/server/src/http.rs`, `crates/server/src/lib.rs`, `crates/server/src/public/mod.rs`, `crates/server/src/etf/ma.rs`, `crates/server/src/kiwoom/link.rs`, `crates/server/src/setup_documents.rs`, `desktop/src-tauri/tauri.bundle.conf.json`, `docs/desktop-builds.md`, `chute.toml` | `engine-relay`, `app-login` | `poteto` | 빌드 기능과 병합 검사 설정을 바꾼다 |
| `theme-push-now` | 히트맵 테마 문서를 바꾸면 곧바로 밀어 올리고 보드 캐시를 비운다(5절) | `crates/server/src/account/sync.rs`, `crates/server/src/user_routes.rs`, `crates/server/src/shared_relay/**` | `app-login`, `engine-relay` | `poteto` | 동기화 상태와 캐시가 함께 바뀐다 |
| `engine-lifetime` | 표준 입력 EOF 종료, 다시 띄우기 규칙, 업데이트 전 종료 순서(8절) | `desktop/src-tauri/src/**`, `crates/server/src/app.rs`, `docs/desktop-builds.md`, `docs/desktop-release.md` | `engine-no-duckdb` | `poteto` | 프로세스 수명과 고아 프로세스다 |
| `public-mode-retire` | 공개 모드 화면, 브라우저 세션 로그인, 공개 리스너 화면 파일·CSP 걷기, `signedOut`·`retryHold`·`flowMissing`·로그인 화면 옮기기(9절) | `web/src/public-mode/**`, `web/src/features/landing/**`, `web/src/features/system-settings/SystemSettingsDialog.tsx`, `web/src/features/search/SearchPreview.tsx`, `web/src/features/status/{StatusBar,ShellBanner}.tsx`, `web/src/features/phone/PhoneHeader.tsx`, `web/src/features/workspace/WindowHost.tsx`, `web/src/features/ranking/useRankingFeed.ts`, `web/src/api/**`, `web/src/App.tsx`, `web/src/main.tsx`, `web/e2e/public-*.spec.ts`, `web/e2e/account-login.spec.ts`, `crates/server/src/public/**`, `crates/account-server/src/**`, `crates/server/tests/public_*.rs`, `docs/public-operations.md` | `engine-no-duckdb`, `theme-push-now` | `poteto` | 인증 장치와 시험 파일을 지운다 |
| `windows-bench` | 결정 D5의 Windows PC에서 `desktop-bench`와 `engine-footprint`를 돌려 결과를 남긴다(2절, 10절) | `desktop/bench/results/**`, `docs/desktop-performance.md`, `docs/desktop-footprint.md` | `engine-footprint`, `engine-lifetime` | `basic` | 정해진 명령을 돌려 결과를 옮겨 적는다. 사람의 Windows PC가 필요하다 |
| `third-broker` | 세 번째 증권사(결정 D3, 조사 1순위 NH PLUG·DB증권·LS 중 사용자가 고른 것) | `crates/server/src/<증권사>/**`, `crates/server/src/lib.rs`, `crates/server/src/app.rs`, `crates/server/src/market_source/**`, `crates/server/src/trading/**`, `crates/server/src/api.rs`, `web/src/api/generated/Broker.ts`, `crates/server/src/kiwoom/{key_file,keys}.rs`, `crates/server/src/system_routes.rs`, `web/src/features/system-settings/**`, `crates/collector/src/**` | `public-mode-retire`, `engine-lifetime` | `poteto` | 새 증권사 연결, 키, 주문이다. 고를 증권사는 사용자가 정한다 |

표에서 서로 앞뒤가 없는 두 작업은 같은 파일에 닿지 않는다. 확인은 표를 읽는 짧은 스크립트로 했다. 그 스크립트는 작업마다 앞선 작업의 닫힘을 구하고, 앞뒤가 없는 모든 쌍의 글롭을 앞부분 일치로 견준다. 결과는 겹침 0이다(명령과 출력은 작업 보고서에 있다). 많은 작업이 `crates/server/src/{app,config,lib,api,http}.rs`, `desktop/src-tauri/**`, `crates/server/src/public/**`를 함께 고치므로 대부분 앞뒤로 이어진다. 동시에 돌 수 있는 것은 위 넷, 그리고 `engine-keychain`과 `shared-revision` 같은 몇 쌍이다.

**앞선 작업이 없는 넷의 경로 확인.**

- `engine-guard`는 `crates/server/src/{engine_guard,app,lib,config,api}.rs`, `crates/server/tests/engine_guard.rs`, `web/src/api/generated/ApiErrorCode.ts`, `desktop/src-tauri/src/**`, `desktop/scripts/smoke.py`, `docs/desktop-builds.md`를 고친다.
- `public-bearer`는 `crates/server/src/public/**`, `crates/server/tests/public_*.rs`, `crates/account-server/src/**`, `docs/public-operations.md`를 고친다.
- `trading-port`는 `crates/server/src/trading/**`만 고친다.
- `engine-footprint`는 `desktop/bench/footprint/**`, `docs/desktop-footprint.md`를 고친다. `desktop/src-tauri`와 `docs/desktop-performance.md`는 건드리지 않는다. 측정 대상은 엔진 실행 파일이고 껍데기는 아니다.

네 집합에 같은 파일은 없다. `public-bearer`는 공개 설정을 `public/settings.rs`에서 읽으므로 `config.rs`를 고치지 않는다. 고쳐야 하게 되면 `engine-guard` 뒤로 미룬다.

**사람이 정할 것.** `third-broker`의 증권사(D3)와 `windows-bench`의 Windows PC(D5)는 사용자가 정한다. 나머지는 이 설계의 정한 값으로 시작한다.
