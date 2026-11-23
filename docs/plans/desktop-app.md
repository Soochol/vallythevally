# 데스크톱 앱과 개인 엔진 분리 (desktop-app)

작성일 2026-11-23. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

코드 사실의 기준은 `origin/main` `bab13f14`(#803)다. 출발점은 [ADR 0038](../adr/0038-user-kiwoom-keys-stay-in-the-browser-and-collection-runs-on-one-server.md)·[0040](../adr/0040-the-public-listener-serves-browser-logins-and-shared-data-apart-from-the-operator-listener.md)·[0041](../adr/0041-browser-keys-are-locked-by-default-and-the-kiwoom-engine-runs-in-the-browser-as-wasm.md), [공용 자료 플랜](collector-shared-data.md), [다중 증권사 플랜](multi-broker.md), 한투 CORS 조사(`~/.claude/orch/reports/kis-cors/kis-cors.md`, 저장소 밖)다. 사용자는 성능을 가장 중요하게 본다.

## 사용자가 풀려는 문제

사용자가 그리는 최종 모습은 사용자 N명이 각자 N개 증권사를 쓰는 시스템이다. 지금 방향(ADR 0038·0041)은 "키는 브라우저에만 두고 브라우저가 증권사를 직접 부른다"이다. 키움은 이것이 되지만 한투는 안 된다. 한투 REST는 preflight에 501을 주고 CORS 허용 헤더가 없다. 한투 실시간은 평문 `ws://`라 https 페이지에서 mixed content로 막힌다. 다른 증권사도 브라우저 직접 호출을 보장하지 않는다. 그래서 이 방향은 N개 증권사로 넓힐 수 없다.

사용자의 말(2026-11-23):

- "내가 생각하는 최종 그림은 사용자 N명이 N개의 증권사를 사용할 수 있는 시스템을 그리고 있는데"
- "최종적으로는 electron이나 rust 기반 껍데기앱 … 이런걸로 사용자에게 배포하려고 해"
- 웹 공개판을 운영할지 묻자: "운영하지 않는다면, 바로 앱으로 갑니다. 그러면 Funnel 운영 단계(#8)는 공용 서버용으로만 하면 됩니다."
- 플래닝은 지금 하고, 겹치는 구현은 다른 탭 병합 뒤로 미루자는 제안에: "응"

## 확정된 결정 (사용자, 2026-11-23)

1. 최종 배포물은 데스크톱 껍데기 앱이다. 앱은 화면(지금의 `web/`)과 Rust **개인 엔진**(사용자 키로 증권사에 직접 연결하고, 시세 캐시·실시간·계좌·주문을 맡는다)으로 이뤄진다. 키는 사용자 PC 밖으로 나가지 않는다.
2. 운영 서버(서버 PC 한 곳)는 **공용 서버**로서 로그인, 계정별 셋업, 공용 자료(수집 데몬이 만든 순위·시장 개요·30초 스냅샷·히트맵·분봉)만 맡는다. 사용자 키를 받지 않는다.
3. 앱이 나오기 전에 웹 공개판은 운영하지 않는다. Funnel 운영 단계는 공용 서버용으로만 한다.
4. 개인 엔진 분리처럼 `crates/server`의 증권사 연결·시세 부분을 크게 옮기는 구현은 다른 탭의 다중 증권사 작업이 병합된 뒤에 한다. 지금 시작할 수 있는 것(ADR, 껍데기, 조사, 측정)은 바로 시작한다.

## 조사한 것

- **지금 `vally-server`가 이미 개인 엔진 모양이다.** ADR 0023의 "커넥터"는 사용자 PC에서 도는 `vally-server`였고, 키·시세 캐시·실시간·주문·화면 서빙을 모두 한다. 계정 서버와의 루프백 로그인(RFC 8252, PKCE)과 커넥터 토큰, 셋업 동기화(ADR 0024)도 `crates/server/src/account/`에 남아 있다. 데스크톱 앱은 이 커넥터를 껍데기에 담고, 공용 자료를 직접 만들지 않고 공용 서버에서 받게 바꾸는 일이다.
- **화면은 같은 출처의 `/api/*`와 `/api/ws`만 부른다.** `web/src/api/http.ts`는 상대 경로로 `fetch`하고, `web/src/api/socket.ts`의 `sameOriginWsUrl`은 페이지 출처로 `ws(s)://<host>/api/ws`를 만든다. 화면이 개인 엔진이 서빙하는 페이지로 뜨면 화면 코드를 고치지 않아도 된다.
- **서버는 라이브러리로도 쓸 수 있다.** `crates/server/src/main.rs`는 `server::app::main()` 한 줄이고 `app::start(config, lock, adapters)`가 공개 함수다. 화면 파일 폴더는 `VALLY_STATIC_DIR`(기본 `web/dist`)이다.
- **차트는 `lightweight-charts`(캔버스 2D)다.** ADR 0038의 시제품 측정에서 체결 한 건 처리는 4~11µs였고 병목은 그리기였다.
- **브라우저 직접 경로가 이미 들어와 있다.** `web/src/engine/vault/`(IndexedDB 키 보관, 자동 잠금·비밀번호), `web/src/public-mode/keys/`(키 화면), 공개 리스너 CSP의 `connect-src https://api.kiwoom.com wss://api.kiwoom.com:10000`(`crates/server/src/public/csp.txt`), e2e `browser-keys.spec.ts`·`public-csp.spec.ts`다. 키를 쓰는 엔진은 아직 없다(ADR 0041 "첫 단계는 저장만").
- **개발 PC에는 Tauri의 Linux 빌드 의존성이 없다.** `pkg-config`로 `webkit2gtk-4.1`·`libsoup-3.0`을 찾지 못했고, `sudo`는 사람의 인증이 필요하다. `xvfb-run`은 있다. Windows 대상 교차 빌드 도구(`cargo-xwin`, `clang`/`lld`, NSIS)도 없다.
- **chute 병합 검사는 저장소 루트 워크스페이스만 돈다**(`chute.toml`의 `clippy`·`*-test`·`e2e`). 새 폴더는 검사 단계를 더하지 않으면 깨져도 모른다.
- **저장소는 공개(MIT)다.** GitHub Releases를 업데이트 배포처로 쓸 수 있다.
- **코드 서명 시세(2026-11, 웹 검색, 구매 전에 다시 확인).** OV 코드 서명 인증서는 CA에 따라 연 $150~300 정도이고, EV는 연 $400 이상이다. 2024년부터 EV도 SmartScreen 평판을 바로 얻지 못한다. 평판은 파일마다 쌓인다. 2026-03부터 인증서 유효기간은 약 15개월(458~460일)이 상한이다. Azure Artifact Signing(옛 Trusted Signing, 월 $9.99)은 개인은 미국·캐나다, 조직은 미국·캐나다·EU·영국만 받는다. 한국 개인과 조직은 쓸 수 없다. SignPath Foundation은 조건을 갖춘 오픈소스 프로젝트에 무료로 서명해 준다. 이 저장소가 그 조건에 맞는지는 확인하지 않았다. Apple 공증에는 Apple Developer Program(연 $99)과 Mac이 필요하다.

## 껍데기 선택: Tauri와 Electron (결정 D1)

| 축 | Tauri 2 | Electron |
|---|---|---|
| Windows 화면 엔진 | WebView2(Chromium). 차트 성능은 Chrome과 같은 엔진이다 | 앱에 넣은 Chromium. Windows에서는 차트 성능이 같다 |
| macOS 화면 엔진 | WKWebView(Safari 엔진). 캔버스 2D는 빠른 편이지만 Chromium과 다를 수 있다 | Chromium. 모든 OS에서 같다 |
| 설치 크기(추정) | 껍데기는 수 MB에 개인 엔진 크기를 더한다 | Chromium과 Node 때문에 설치본이 약 80~150MB다 |
| 메모리(추정) | 화면은 WebView2 프로세스들을 쓰고 Node 프로세스가 없다 | 앱에 넣은 Chromium에 Node 메인 프로세스가 더해진다. Windows에서는 차이가 흔히 말하는 것보다 작을 수 있으므로 잰다 |
| Rust 엔진 재사용 | 같은 언어다. 엔진을 자식 프로세스로 띄우거나 프로세스 안에 링크한다 | 엔진은 자식 프로세스(또는 napi 모듈)다. 런타임이 하나(Node) 더 있다 |
| 업데이트·서명 | `tauri-plugin-updater`(자체 서명 키로 갱신본을 검증), Windows·macOS 서명 지원 | `electron-updater`, 서명 지원. 더 오래 쓰였다 |
| 보안 기본값 | 기능 허용 목록(capabilities) | `contextIsolation`·sandbox를 직접 맞춰야 한다 |
| 개발 PC 빌드 | Linux 빌드에 webkit2gtk 개발 패키지가 필요하다(결정 D6) | Linux 빌드는 바로 된다 |

**권장: Tauri.** 첫 대상은 Windows(결정 D2)이고 Windows에서는 두 안의 화면 엔진이 같다. 그러면 남는 차이는 크기, 메모리, 그리고 Rust 엔진과 같은 언어라는 점이고 모두 Tauri 쪽이 낫다. 약점은 macOS의 WKWebView다. 맥을 지원할 때 `desktop-bench`의 측정 명령을 맥에서 돌려 판단한다.

껍데기를 다시 고르는 비용은 작게 둔다. 화면은 개인 엔진의 루프백 HTTP/WS만 부르고 껍데기 IPC에 기대지 않는다(S1). 그러면 껍데기를 바꿀 때 창을 띄우는 부분만 다시 짜면 된다.

## 성능 (첫 축)

| 경로 | 지금 아는 것 | 확인 방법 |
|---|---|---|
| 앱 화면의 차트 그리기 | Windows WebView2는 Chromium이라 Chrome과 같을 것으로 본다(추정). 병목은 그리기다(ADR 0038 측정) | `desktop-bench`가 같은 차트 부하를 Tauri 창과 Playwright Chromium에서 재 프레임 시간을 견준다. 개발 PC(WebKitGTK)의 값은 참고용이고, Windows 값은 결정 D5의 Windows PC에서 같은 명령으로 잰다 |
| 개인 엔진 ↔ 화면 통신 | 지금은 루프백 WebSocket이다. 체결 한 건 처리가 4~11µs라 통신이 병목일 가능성은 낮다(추정) | `desktop-bench`가 합성 체결 흐름(정한 초당 건수, 정한 시간)을 루프백 WS와 Tauri IPC 채널로 보내 건당 지연 p50·p99와 화면 프로세스 CPU를 잰다 |
| 공용 서버 부하(N명) | 앱 하나가 순위 10초, 보드 30초, 흐름·시장 개요 60초마다 받으면 사용자당 약 0.17건/초다. 100명이면 약 17건/초이고, 모두 데몬이 쓴 파일을 메모리에서 읽어 준다(추정) | `engine-split-design`이 개인 엔진의 창 간 중복 제거, 판 번호 조건부 요청(304), 밀어주기(SSE/WS)를 견준다. 실제 부하는 운영 단계에서 `GET /api/public-usage`로 본다 |
| 개인 엔진 자체 | 공용 자료를 만들지 않으므로 사용자 PC에 스크리너 일봉 저장소(DuckDB)가 필요 없다(설계에서 확정) | 설계 문서에 엔진에 남는 모듈과 메모리 추정을 적는다 |

숫자는 측정값과 추정을 나눠 적는다. 측정은 한 프로세스에 정한 부하만 건다. PC 전체에 부하를 거는 수단은 쓰지 않는다.

## 스스로 정한 결정과 이유

- **S1 뼈대는 `vally-server`를 자식 프로세스로 띄우고 창이 그 루프백 주소를 연다.** 서버 코드와 화면 코드를 하나도 고치지 않고 지금 화면이 그대로 앱 창에 뜬다. 다른 탭이 `app.rs`·`config.rs`를 다시 짜는 중이라, 라이브러리로 링크하면 시작 함수 모양이 바뀔 때 뼈대가 깨진다. 자식 프로세스는 실행 파일과 환경 변수만 본다. 엔진을 프로세스 안에 둘지와 IPC를 쓸지는 측정 뒤 `engine-split-design`이 정한다.
- **S2 `desktop/`은 자기 Cargo 워크스페이스와 자기 `package.json`을 둔다.** 루트 `Cargo.lock`과 병합 검사의 빌드가 Tauri 의존성을 끌어오지 않는다. 다른 탭이 고치는 `Cargo.lock`과도 부딪치지 않는다.
- **S3 병합 검사에 `desktop/` 단계를 더한다**(`chute.toml`, `paths = ["desktop/"]`). 검사를 늘리는 변경이다. 검사 기계에 webkit2gtk 개발 패키지가 있어야 한다(결정 D6).
- **S4 측정은 저장소에 남는 명령으로 만든다**(`desktop/bench`, 결과는 `docs/desktop-performance.md`). 개발 PC에서 한 번 재고 끝내지 않는다. 같은 명령을 Windows와 맥에서 다시 돌릴 수 있어야 껍데기와 IPC 결정을 검증할 수 있다.
- **S5 개인 엔진 분리의 구현 작업은 설계 ADR 뒤에 후속 플랜으로 나눈다.** 옮길 코드(`kiwoom/`, `kis/`, `market/`, `market_source/`, `trading/`)를 다른 탭이 지금 다시 짜고 있다. 지금 지시서를 쓰면 시작할 때 이미 낡는다. 이 플랜은 설계 작업까지 지시서를 쓰고, 예상 작업 목록은 아래 "다음 단계"에 남긴다.
- **S6 앱 로그인은 ADR 0023의 루프백 흐름과 커넥터 토큰을 다시 쓰는 것을 기대값으로 둔다.** 데스크톱 앱이 RFC 8252가 말하는 바로 그 네이티브 앱이고, 코드가 이미 있다. 브라우저 세션 쿠키(ADR 0040)는 앱에 필요 없다. 공개 리스너가 커넥터 토큰(Bearer)을 받게 할지는 설계가 정한다.
- **S7 ADR 0041의 엔진 방향(WASM, SharedWorker, Web Locks)은 거둔다.** 엔진은 앱 안의 네이티브 Rust이고 지금 서버 코드를 그대로 쓴다. 키 보관은 OS 키체인 쪽으로 간다. 기대값은 키체인에 설치마다 자료 키 하나를 두고 키 목록 파일을 그 키로 암호화하는 것이다. Windows 자격 증명 관리자의 항목 크기 한도(2,560바이트)를 피할 수 있다. 확정은 설계가 한다.
- **S8 지금 걷는 것은 브라우저 키 보관과 브라우저 키움 직접 경로뿐이다**(`public-web-retire`). 웹 공개판을 운영하지 않으므로 쓰는 사람이 없다. 공개 리스너는 공용 서버의 입구로 남는다. 브라우저 세션 로그인과 공개 모드 화면(로그인 안내, 계정 메뉴, 셋업 마법사)은 앱의 로그인 화면이 어떤 모양일지에 달렸으므로 설계 뒤 후속 플랜이 정한다.
- **S9 ADR 0038·0040의 개정 줄은 `public-guards-off` 뒤에 단다.** 그 작업이 같은 두 파일에 개정 줄을 더한다. 새 ADR(`adr-desktop-app`)은 지금 쓰고 본문에서 두 ADR의 어느 부분을 바꾸는지 밝힌다. 두 파일의 개정 줄은 `public-web-retire`가 단다.
- **S10 증권사 조사는 읽기 전용 보고로 한다.** 결과가 `engine-split-design`의 증권사 경계 설계와 결정 D3의 근거가 된다.

## 작업과 순서

| 작업 | 내용 | 방식 | 방식의 이유 | 뒤에 |
|---|---|---|---|---|
| `adr-desktop-app` | 새 ADR(앱 안 개인 엔진, 공용 서버, 웹 공개판 없음), ADR 0023·0041 개정 줄, 용어집 | `basic` | 문서만 고치고, 결정은 이 플랜에서 정했다 | 없음 |
| `broker-survey` | 국내 증권사 개인 API의 연결 방식 조사(REST/WS, COM·OCX, 32비트, IP 등록, 모의) | `basic` | 읽기 전용 조사이고 코드를 고치지 않는다 | 없음 |
| `tauri-shell` | `desktop/` Tauri 2 뼈대, `vally-server` 자식 프로세스, 앱 자료 폴더, 종료 처리, 연기 시험, 병합 검사 단계, 빌드 문서 | `poteto` | 자식 프로세스 수명과 고아 프로세스, 병합 검사 변경 | 없음(결정 D6을 먼저 마친다) |
| `desktop-bench` | 통신(루프백 WS·Tauri IPC)과 차트 그리기 측정 명령, 개발 PC 결과 문서 | `poteto` | 측정값이 껍데기와 IPC 결정의 근거다 | `tauri-shell` |
| `desktop-updater` | 자동 업데이트(서명 키 검증, GitHub Releases 목록), 릴리스 절차 문서, 코드 서명 자리 | `poteto` | 갱신본 서명 검증은 보안 경계다 | `desktop-bench` |
| `engine-split-design` | 개인 엔진·공용 서버 분리 설계 ADR과 설계 문서, 후속 작업 목록 | `poteto` | 여러 모듈에 걸친 새 설계, 인증과 키 보관 | `adr-desktop-app`, `broker-survey`, `desktop-bench` (+ 다른 탭, D10) |
| `public-web-retire` | 브라우저 키 보관·키 화면·CSP의 키움 출처 걷기, ADR 0038·0040·0041 개정 줄 | `poteto` | 저장 형식과 보안 장치를 지운다 | `adr-desktop-app`, `web-shared-age`, `public-guards-off` (+ 다른 탭, D10) |

순차로 둔 이유는 다음과 같다.

- `desktop-bench`와 `desktop-updater`는 `tauri-shell`이 만든 `desktop/src-tauri`를 고친다. 같은 파일을 다시 짜므로 한 줄로 잇는다. `desktop-updater`를 측정 뒤에 두는 것은 측정용 IPC 명령과 업데이트 설정이 같은 `tauri.conf.json`·`lib.rs`를 고치기 때문이다.
- `engine-split-design`은 세 작업의 결과를 쓴다. 용어와 결정은 `adr-desktop-app`에서, 증권사 연결 방식은 `broker-survey`에서, IPC 측정은 `desktop-bench`에서 온다.
- `public-web-retire`는 `web-shared-age`(`web/src/**`)와 `public-guards-off`(`crates/server/src/public/**`, ADR 0038·0040)와 같은 파일을 고친다. `adr-desktop-app`이 더한 ADR 0041 개정 줄 아래에 잇는다.

병렬: `adr-desktop-app`, `broker-survey`, `tauri-shell`은 지금 함께 시작할 수 있다. `tauri-shell`은 결정 D6이 끝나야 빌드할 수 있다. `engine-split-design`과 `public-web-retire`는 조건이 차면 서로 병렬이다.

## 공용 자료 플랜(`collector-shared-data`)의 남은 작업

| 작업 | 웹 공개판이 없을 때의 의미 | 제안 |
|---|---|---|
| `collector-rankings`, `collector-overview`, `heatmap-shared`, `rankings-overview-shared` | 공용 자료이고 앱도 같은 자료를 받는다 | 그대로 |
| `public-guards-off` | 공개 리스너는 앱이 부르는 공용 서버의 입구로 남는다. 공개 요청이 키움을 부르지 않게 하는 일은 그대로 필요하다. CSP와 화면 파일 서빙은 남겨도 해가 없다 | 그대로. 개정 줄 문구("임시 장치는 collector-shared-data로 걷었다")도 그대로 맞다 |
| `web-shared-age` | 자료 나이와 낡음 표시는 앱 화면에도 필요하다. 공개 모드 흐름의 분 맞춤 재요청을 걷는 것도 그대로 맞다 | 하나만 고친다(결정 D8). `not_prepared` 안내 "공개 화면에서는 미리 만든 조건만 볼 수 있습니다"를 "미리 만든 조건만 볼 수 있습니다"로 바꾼다. 앱도 공용 서버에서는 미리 만든 조건만 받는다 |

공용 자료 플랜의 U5(미리 만들 수 없는 요청: 차트 과거 봉, 현재가·당일 요약, 기본 정보, 투자자, 체결·호가·프로그램 조회)는 앱에서는 개인 엔진이 사용자 키로 받는 것이 자연스럽다(결정 D9).

## 다음 단계 (`engine-split-design` 뒤의 후속 플랜에서 나눌 작업 후보)

1. **앱 모드의 개인 엔진.** 엔진이 공용 자료 라우트(스크리너 실행·상태, 순위, 시장 개요, 히트맵, ETF, 재무)를 직접 만들지 않고 공용 서버에서 받아 캐시한다. 일봉 저장소, 재무 갱신, 공용 자료 만들기는 엔진에서 꺼진다.
2. **엔진 루프백 API 보호.** 같은 PC의 다른 프로그램이 주문 라우트를 부르지 못하게, 실행마다 바뀌는 비밀값을 창 주소나 첫 요청으로 넘긴다. 앱에서 주문을 켜기 전에 반드시 해야 한다.
3. **키 보관.** OS 키체인에 자료 키를 두고 키 목록과 토큰 파일을 암호화한다(S7).
4. **앱 로그인과 셋업 동기화.** 루프백 PKCE 흐름과 커넥터 토큰(S6), 공개 리스너가 Bearer를 받는 길, 공용 자료 요청의 계정 버킷.
5. **엔진 수명.** 창을 닫아도 실시간 알림을 위해 엔진을 트레이에 남길지, 엔진이 죽었을 때 다시 띄우는 규칙.
6. **증권사 경계 넓히기.** `broker-survey` 결과로 세 번째 증권사를 붙일지, COM·OCX 증권사는 별도 32비트 보조 프로세스로 할지.
7. **브라우저 세션 로그인과 공개 모드 화면의 처리**(S8).
8. **운영 단계.** 공용 서버용 Funnel(공개 리스너만 연다), IdP 등록, 서버 PC 배포(결정 D12).
9. **배포.** 코드 서명(결정 D4), Windows 설치본 빌드(결정 D5), 첫 릴리스.

## 범위 밖

- 웹 공개판 운영(확정 3).
- 실제 인증서 구매, Apple 개발자 등록, 첫 공개 릴리스, Funnel 켜기. 모두 사용자 승인 뒤에 한다.
- 수집 데몬과 공용 자료 형식. `collector-shared-data`가 한다.
- 휴대폰 앱.

## 받아들일 한계

- **개발 PC 측정은 Windows 값이 아니다.** 개발 PC는 WebKitGTK라 차트 그리기가 WebView2보다 느릴 수 있다. Windows 값은 결정 D5의 Windows PC에서 같은 명령으로 잰다.
- **뼈대의 엔진은 지금 서버 전체다.** 공용 자료도 사용자 키로 직접 받고, 루프백 API 보호도 아직 없다. 뼈대는 배포하지 않는다.
- **루프백 API는 같은 PC의 프로그램에 열려 있다.** 다음 단계 2가 막기 전까지 앱에서 주문을 켜지 않는다.

## 사용자가 정해야 하는 결정

구현을 막는 결정은 D6 하나다. 나머지는 권장안으로 짓는다.

- **D1 껍데기** (권장: Tauri 2). 다른 안: Electron. 근거는 위 표에 있다. 승인 때 Electron을 고르면 `tauri-shell`·`desktop-bench`·`desktop-updater` 지시서를 Electron으로 고쳐 쓴다.
- **D2 지원 OS** (권장: Windows 10/11 x64 먼저. macOS는 그 다음이고 Apple 개발자 등록과 Mac이 필요하다. Linux는 개발용으로만 빌드하고 배포하지 않는다).
- **D3 첫 지원 증권사** (권장: 키움과 한투. 둘 다 지금 서버에 연결 코드가 있다). 세 번째 증권사는 `broker-survey` 결과를 보고 정한다.
- **D4 코드 서명** (권장: 비공개로 시험하는 동안에는 서명하지 않고 SmartScreen 경고를 안내한다. 공개 배포 전에 SignPath Foundation(무료 오픈소스 서명)의 조건을 먼저 확인하고, 안 되면 OV 인증서(연 약 $150~300, 하드웨어 토큰이나 클라우드 서명)를 산다). 다른 안: EV 인증서(연 $400 이상. 2024년부터 SmartScreen을 바로 통과하지 못하므로 값만큼의 이득이 없다). Azure Artifact Signing은 한국에서 쓸 수 없다. macOS는 연 $99다. 구매는 승인 뒤에 한다.
- **D5 Windows 빌드와 측정 기계** (권장: 사용자의 Windows PC 한 대에서 릴리스 빌드와 `desktop-bench`를 돌린다). 다른 안: 개발 PC에서 `cargo-xwin`으로 교차 빌드한다. Tauri는 이것을 실험 기능으로 지원하고 NSIS 설치본만 된다. 측정은 할 수 없다. GitHub Actions의 Windows 러너도 있지만 CI는 일부러 꺼 두었다.
- **D6 개발 PC에 Tauri 빌드 패키지 설치** (★ `tauri-shell`을 시작하기 전에 필요). 작업자는 `sudo`를 쓸 수 없다. 사용자가 이 PC에서 직접 설치한다. 예: `sudo apt install libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev build-essential file`. 설치 전에 `tauri-shell`이 시작되면 작업자는 빌드하지 않고 막힘으로 보고한다. 병합 검사 단계(S3)도 이 패키지에 기댄다.
- **D7 업데이트 배포처** (권장: GitHub Releases. 저장소가 공개라 비용이 없고 서버 PC 대역을 쓰지 않는다). 다른 안: 공용 서버가 갱신 목록과 설치본을 준다. 업데이트 서명 비밀키는 저장소 밖(릴리스 기계)에 두고 사용자가 만든다.
- **D8 `web-shared-age` 문구** (권장: `not_prepared` 안내에서 "공개 화면에서는"을 뺀다). 아직 시작하지 않은 작업이라 오케스트레이터가 지시서를 고친다. 나머지 내용은 그대로다.
- **D9 공용 자료 플랜의 U5** (권장: 나. 미리 만들 수 없는 요청은 개인 엔진이 사용자 키로 받는다. 앱에서는 엔진이 이미 그 코드를 갖고 있다). 다른 안: 가. 수집 데몬의 `rest` 키가 요청을 받아 공용 캐시로 준다. 키가 없는 사용자도 차트를 볼 수 있지만, 데몬에 요청을 받는 길이 새로 생기고 사용자 수에 비례해 운영자 키를 쓴다.
- **D10 다른 탭 작업과의 순서.** 탭이 달라 `after`로 걸 수 없으므로 오케스트레이터가 시작 시점을 지킨다.
  - `engine-split-design`은 다른 탭의 `kis-orders`, `kiwoom-token-owner`, `kis-rest-edges`, `source-switch-edges`, `screener-kis-summary`가 **모두 병합된 뒤** 시작한다. 이 작업들이 개인 엔진으로 갈 `kiwoom/`·`kis/`·`market_source/`·`trading/`·`screener/`를 다시 짠다.
  - `public-web-retire`는 다른 탭의 `source-select-web`, `kis-orders`가 **병합된 뒤** 시작한다. 둘이 `web/src/features/system-settings/**`·`web/src/api/**`를 고치고, 걷어낼 키 화면이 시스템 설정에 붙어 있다.
  - `adr-desktop-app`은 새 ADR 한 파일과 ADR 0023·0041·용어집에 몇 줄을 더한다. `kis-orders`의 `docs/adr/**`·`GLOSSARY.md`와는 몇 줄씩 더하는 관계라 병렬로 돈다. ADR 번호가 부딪치면 나중에 병합되는 쪽이 다음 번호로 바꾼다.
- **D11 키 없이 앱 쓰기** (권장: 된다. 증권사 키가 없어도 로그인하면 공용 자료 화면(스크리너, 순위, 시장 개요, 히트맵)을 쓴다. 차트·실시간·주문은 키가 있어야 한다). 설계가 이 전제로 짓는다.
- **D12 공용 서버 Funnel** (권장: 앱 로그인(다음 단계 4)이 병합된 뒤에 켠다. Funnel에는 공개 리스너만 연다. 앱은 화면을 자기가 갖고 있으므로 공개 리스너의 화면 파일 서빙은 쓰이지 않는다. 걷을지는 다음 단계 7에서 정한다). 실제 켜기와 IdP 등록은 승인 뒤에 한다.

검증을 약하게 하는 작업은 없다. `tauri-shell`은 `chute.toml`에 검사 단계를 하나 더한다(S3).
