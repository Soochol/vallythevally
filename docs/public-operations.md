# 공개 리스너 운영

`vally-server`는 운영자 리스너와 따로 **공개 리스너**를 같은 프로세스에 열 수 있다. 공개 리스너는 Tailscale Funnel로 인터넷에 내놓는다. 구조와 결정은 [`docs/plans/browser-keys-funnel.md`](plans/browser-keys-funnel.md)에 있다. 이 문서는 켜고 조정하고 되돌리는 절차를 적는다.

공개 리스너가 주는 것은 로그인한 사용자에게 보이는 공용 자료(종목 목록·검색, 스크리너, 재무 읽기, ETF, 순위, 시장 개요)와 로그인·세션 경로다. 운영자 라우트(`/api/ws`, `/api/system/*`, `/api/trading/*`, `/api/account/*`, 차트 봉, 시세, 스크리너·재무 갱신 `POST` 같은 것)는 공개 리스너에 없고 404다. 수집 현황(`/api/collector/*`)은 로그인한 세션의 계정이 `VALLY_COLLECTOR_ADMINS`에 있을 때만 열린다.

## 켜기와 끄기

공개 리스너는 `VALLY_PUBLIC_BIND`와 `VALLY_PUBLIC_ORIGIN`이 **둘 다** 있을 때만 뜬다. 하나만 있으면 설정 오류로 시작하지 않는다. 둘 다 없으면 지금과 같고 두 번째 포트를 열지 않는다.

- `VALLY_PUBLIC_BIND`: 루프백 주소만 받는다(`VALLY_BIND`와 같은 규칙). `VALLY_BIND`와 같은 주소면 설정 오류다.
- `VALLY_PUBLIC_ORIGIN`: `https://<이름>` 또는 `https://<이름>:<포트>`다. 경로, 질의, 와일드카드, IP는 설정 오류다. 시험용으로 루프백 IP의 `http`만 더 받는다.
- 공개 리스너는 `VALLY_ACCOUNT_SERVER_URL`(커넥터 계정 모드), `VALLY_KIWOOM_ENV=mock`과 함께 쓸 수 없다. 둘 다 설정 오류다.

끄려면 공개 설정을 지우고 재시작한다. 지금과 같은 동작으로 돌아간다.

## 설정

값을 바꾸려면 env(`VALLY_ENV_FILE`이나 서비스 환경)를 고치고 **재시작**한다. 값이 틀리면 설정 오류로 시작하지 않는다. "한도 없음"은 `0`이고, `0`을 받는 항목은 표에서 `0 = 한도 없음`이라고 적은 것뿐이다.

### 계정과 로그인

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `VALLY_PUBLIC_ACCOUNT_DB_PATH` | `VALLY_DB_PATH`와 같은 폴더의 `public-accounts.db` | 계정·세션 SQLite |
| `VALLY_PUBLIC_GOOGLE_CLIENT_ID`, `_CLIENT_SECRET` | 필수 | Google OAuth 클라이언트 |
| `VALLY_PUBLIC_NAVER_CLIENT_ID`, `_CLIENT_SECRET` | 필수 | Naver 앱 |
| `VALLY_PUBLIC_GOOGLE_AUTHORIZE_URL`, `_TOKEN_URL`, `VALLY_PUBLIC_NAVER_AUTHORIZE_URL`, `_TOKEN_URL`, `_PROFILE_URL` | 각 IdP의 실제 주소 | 시험용 IdP 주소 바꾸기. 운영에서는 쓰지 않는다 |
| `VALLY_PUBLIC_ACCOUNT_LIMIT` | 100 | 새 계정 수 상한. 차면 새 가입을 거절하고 기존 계정의 로그인은 받는다 |
| `VALLY_PUBLIC_PENDING_LOGIN_LIMIT` | 10000 | 대기 중인 로그인 흐름 수 |
| `VALLY_PUBLIC_BLOCKED_ACCOUNTS` | 없음 | 차단 계정. `provider:subject`를 쉼표로 잇는다 |

시크릿은 `VALLY_ENV_FILE`로도 읽는다. 파일 권한은 600으로 둔다. 시크릿은 로그에 나오지 않는다.

### 요청 제한과 동시 처리 (D7a)

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `VALLY_PUBLIC_ACCOUNT_RATE`, `_ACCOUNT_BURST` | 초당 20, 100 | 계정 버킷. 같은 계정의 세션 여럿이 한 버킷을 쓴다 |
| `VALLY_PUBLIC_LIGHT_COST` | 0.1 | 메모리만 읽는 경로(종목 하나 조회, 종목 검색, 스크리너 상태, 서버 모드)가 한 번에 쓰는 양 |
| `VALLY_PUBLIC_TOTAL_RATE`, `_TOTAL_BURST` | 초당 200, 400 | 로그인한 요청 전체 버킷 |
| `VALLY_PUBLIC_ANON_RATE`, `_ANON_BURST` | 초당 5, 20 | 익명 요청 전체 버킷(로그인 시작, callback, 세션 조회, 401 응답) |
| `VALLY_PUBLIC_LOGIN_PER_MINUTE` | 30 | 로그인 시작 버킷 |
| `VALLY_PUBLIC_MAX_IN_FLIGHT` | 64 | 전체 동시 처리 |
| `VALLY_PUBLIC_ACCOUNT_IN_FLIGHT` | 8 | 계정당 동시 처리 |
| `VALLY_PUBLIC_ANON_IN_FLIGHT` | 16 | 익명 동시 처리 |
| `VALLY_PUBLIC_REQUEST_TIMEOUT_SECS` | 60 | 요청 시간 상한 |

넘으면 기다리지 않고 바로 거절한다. 버킷이 모자라면 `429`, 동시 처리 자리나 시간이 모자라면 `503`이다. 두 경우 모두 `Retry-After` 헤더와 본문 `error.retryAt`(유닉스 초)이 같은 시각을 가리킨다. 화면 파일은 어느 한도에도 세지 않는다.

### 키움 경로 보호 (임시 장치)

공개 요청이 운영자 키움 키의 대기열을 밀어내는 크기를 묶는 임시 장치다. 수집 데몬이 공용 자료를 만들게 되면(`collector-shared-data`) 걷는다. 코드는 `crates/server/src/public/kiwoom_guard.rs` 한 모듈에 모여 있다.

| 설정 | 기본값 | 뜻 |
|---|---|---|
| `VALLY_PUBLIC_KIWOOM_ACCOUNT_IN_FLIGHT` | 1 | 계정당 키움 경로 동시 |
| `VALLY_PUBLIC_MARKET_CONCURRENCY` | 4 | 시장 개요 묶음 동시 |
| `VALLY_PUBLIC_RANKINGS_CONCURRENCY` | 2 | 순위 묶음 동시 |
| `VALLY_PUBLIC_MARKET_CACHE_SECS` | 15 | 시장 개요 카드 응답 캐시. 모든 계정이 같이 쓰고, 적중한 요청은 동시 자리를 잡지 않는다 |
| `VALLY_PUBLIC_RANKING_MAX_PAGES` | 5 | 공개 순위 최대 쪽 수. 더 청해도 이 값으로 줄인다 |
| `VALLY_PUBLIC_SCREENER_CONCURRENCY` | 4 (0 = 한도 없음) | 스크리너 동시 실행. 자리가 없으면 바로 503 |
| `VALLY_PUBLIC_SCREENER_ACCOUNT_PER_MINUTE` | 2 | 계정당 스크리너 실행 |
| `VALLY_PUBLIC_SCREENER_TOTAL_PER_MINUTE` | 3 (0 = 한도 없음) | 전체 스크리너 실행 |
| `VALLY_PUBLIC_SCREENER_STATUS_CACHE_SECS` | 2 | 스크리너 상태 공용 캐시 |
| `VALLY_PUBLIC_BOARD_CONCURRENCY`, `_FLOW_CONCURRENCY` | 1, 1 | 히트맵 보드·흐름 묶음 동시. `public-user-data`가 쓴다 |
| `VALLY_PUBLIC_FLOW_TR_PER_MINUTE`, `_FLOW_ACCOUNT_TR_PER_MINUTE`, `_FLOW_FETCH_CONCURRENCY`, `_BOARD_TR_PER_WINDOW` | 60, 60, 5, 45 | 히트맵 TR 예산. `public-user-data`가 쓴다 |

키움 경로가 대기열 `Gated`나 한도 대기를 받으면 기다리지 않고 바로 `503`과 짧은 `retryAt`(5초 안)을 낸다. 공개 오류 응답에는 키움 오류 원문이나 `manualActionRequired`가 없고, 고정 문구와 `retryAt`만 있다.

운영자 화면의 같은 TR 요청이 공개 부하 때문에 더 기다리는 시간의 상한은 (묶음 동시 한도 × 공개 요청 하나가 그 TR을 동시에 쌓는 최대 수) ÷ 5초다. 기본값에서 순위는 2초, 시장 개요 웜은 2.4초다. 시장 개요 `flow`의 하루 첫 콜드(기간마다 최대 약 62회)는 한 번 약 12초까지 늘 수 있다.

### 본문 크기

공개 리스너는 모든 요청 본문을 8 MiB로 자른다. 넘으면 `413`이다. 라우트마다 더 작은 한도가 따로 있다.

## 서버 PC 배포에 더할 값

서버 PC의 env 파일(권한 600)에 다음을 더한다. 값 자리는 자리 표시다.

```sh
VALLY_PUBLIC_BIND=127.0.0.1:<공개 포트>
VALLY_PUBLIC_ORIGIN=https://<공개 호스트>
VALLY_PUBLIC_GOOGLE_CLIENT_ID=<Google client id>
VALLY_PUBLIC_GOOGLE_CLIENT_SECRET=<Google client secret>
VALLY_PUBLIC_NAVER_CLIENT_ID=<Naver client id>
VALLY_PUBLIC_NAVER_CLIENT_SECRET=<Naver client secret>
VALLY_COLLECTOR_ADMINS=<provider:subject>
```

`VALLY_COLLECTOR_ADMINS`를 쓰면 `VALLY_COLLECTOR_SOCKET`도 필요하다. 배포는 승인 뒤 `orch deploy run`으로 반영한다.

## 공개 입구 두 안 (플랜 D28, 사용자 결정 2)

공개 리스너는 루프백 포트만 연다. 인터넷 쪽 입구는 Funnel이 만든다. 어느 안이든 코드는 `VALLY_PUBLIC_ORIGIN`만 본다. **출처가 바뀌면 브라우저 IndexedDB 키 보관소가 비므로, 공개하기 전에 정한다.**

### (가) 별도 노드의 443 (권장)

서버 PC에 두 번째 `tailscaled`를 띄워 tailnet의 별도 노드로 만든다. 호스트가 달라 쿠키와 출처가 나뉘고, 운영자 노드에는 Funnel 권한이 없다.

- 출처: `VALLY_PUBLIC_ORIGIN=https://<공개 노드>.<tailnet>.ts.net`
- IdP callback: `https://<공개 노드>.<tailnet>.ts.net/v1/auth/google/callback`, `https://<공개 노드>.<tailnet>.ts.net/v1/auth/naver/callback`
- 두 번째 `tailscaled`: 상태 폴더와 소켓을 따로 쓰고 `--tun=userspace-networking`으로 돌린다. systemd 단위를 하나 더 둔다.

  ```sh
  tailscaled --state=<두 번째 상태 폴더>/tailscaled.state --socket=<두 번째 소켓> --tun=userspace-networking
  tailscale --socket=<두 번째 소켓> up --hostname=<공개 노드>
  ```

- tailnet 정책의 `funnel` 노드 속성은 **그 노드에만** 준다.
- 켜기: `tailscale --socket=<두 번째 소켓> funnel --bg 443 http://127.0.0.1:<공개 포트>`
- 끄기: `tailscale --socket=<두 번째 소켓> funnel --bg 443 off`

### (나) 같은 호스트의 8443

운영 절차가 가장 적다. 쿠키는 포트로 나뉘지 않아 공개 세션 쿠키가 운영자 리스너로 가는 요청에도 실린다. 운영자 리스너는 쿠키를 읽지도 두지도 않아서 지금은 해가 없다.

- 출처: `VALLY_PUBLIC_ORIGIN=https://<서버 호스트>.<tailnet>.ts.net:8443`
- IdP callback: `https://<서버 호스트>.<tailnet>.ts.net:8443/v1/auth/google/callback`, `https://<서버 호스트>.<tailnet>.ts.net:8443/v1/auth/naver/callback`
- 켜기: `tailscale funnel --bg --https=8443 http://127.0.0.1:<공개 포트>`
- 끄기: `tailscale funnel --https=8443 off`

두 안 모두 `ts.net`이 공개 접미사라서 같은 tailnet의 노드끼리는 "같은 사이트"다. 그래서 운영자 리스너가 Host, Origin, `Sec-Fetch-Site`를 따로 검사한다(D27). 운영자 리스너는 루프백 형태 Host와 `VALLY_TAILNET_HOSTS`의 이름만 받고, Origin이 자기 출처가 아니면 거절하고, `/api/*`는 `Sec-Fetch-Site`가 `cross-site`나 `same-site`이면 거절한다.

## 운영 단계 P0~P5

★는 사용자 승인이 필요하다.

| 단계 | 누가 | 내용 |
|---|---|---|
| P0 ★ | 사용자 | 먼저 확인한다. Google OAuth 동의 화면 게시와 Naver 검수가 `*.ts.net` 호스트로 가입 100명을 받을 수 있는지 콘솔에서 본다. "테스트 사용자만"으로 묶이면 일정과 가입 상한이 바뀐다. 입구(가·나)와 호스트 이름도 이때 정한다 |
| P1 ★ | 사용자 | Google Cloud OAuth 클라이언트와 Naver 앱을 등록한다. callback은 고른 안의 `https://<공개 호스트>/v1/auth/{google,naver}/callback`이다. client id·secret은 서버 PC의 env 파일(600)에만 둔다 |
| P2 ★ | 오케스트레이터 | 서버 PC 배포에 위 값을 더하고, 승인 뒤 `orch deploy run`으로 반영한다 |
| P3 | 오케스트레이터 | Funnel 없이 tailnet 전용으로 공개 입구를 연다. (가)를 골랐으면 두 번째 `tailscaled` 노드를 띄운다 |
| P4 ★ | 사용자·오케스트레이터 | 사용자가 tailnet 정책에 `funnel` 노드 속성을 더한다((가)는 공개 노드에만). 오케스트레이터가 Funnel을 켠다 |
| P5 | 오케스트레이터 | 되돌리기를 확인한다 |

P3 확인 목록:

- 로그인, 셋업 저장, 공용 자료 읽기를 해 본다. 운영자 라우트는 404여야 한다.
- 공개 화면을 연 브라우저에서 운영자 주소로 가는 요청에 어떤 쿠키가 실리는지 본다.
- 공개 출처에서 운영자 `/api/ws`, 단순 `POST`, `no-cors` `GET`이 거절되는지 본다.
- 첫 로딩 바이트와 시간을 잰다.

P4 확인 목록:

- 인터넷에서 오는 요청의 Host 모양과 클라이언트 IP 헤더를 본다. 공개 리스너는 IP 헤더를 믿지 않는다.
- 운영자 주소는 여전히 tailnet 전용이고 운영자 라우트는 404인지 본다.
- Funnel 너머의 첫 로딩, 보드, 스크리너 결과 전송 시간을 잰다.
- `GET /api/public-usage`(운영자 리스너)의 계수가 쌓이는지 본다.

P5 되돌리기: Funnel을 끄고, 공개 설정(`VALLY_PUBLIC_*`)을 지우고, 재시작한다. 지금과 같아야 한다. 호스트 이름이나 출처를 바꾸면 브라우저 키 보관소가 비므로 사용자가 키움 키를 다시 넣어야 한다. 바꾸기 전에 사용자에게 알린다.

## 계수 읽는 법

한도를 바꿀 근거는 두 곳에 있다.

- **운영자 리스너 전용 `GET /api/public-usage`.** 공개 리스너에는 이 경로가 없다(404). 시작 뒤 누적값을 낸다.
  - `bundles`: 묶음별 계수. 묶음은 `rankings`, `market_overview`, `screener_run`, `board`, `flow`, `shared`(그 밖 공용 자료), `user_data`, `login`이다. 값은 `responses`(응답 수), `tooManyRequests`(429 횟수), `unavailable`(503 횟수), `waitTotalMs`·`waitMaxMs`(동시 한도에서 기다린 시간. 바로 거절하는 경로는 0이다), `trCalls`(공개 요청이 낸 TR 수. 순위·시장 개요·스크리너는 요청 앞뒤의 키움 대기열 전송 수 차이로 추정하므로 같은 시간의 운영자 호출이 섞일 수 있다).
  - `cacheHits`: 시장 개요 응답 캐시와 스크리너 상태 캐시의 적중 수.
  - `topAccounts`: 요청 수 상위 계정 10개(`provider:subject`).
  - `operatorKiwoomLatency`: 운영자 리스너의 키움 경로 응답 시간. 이번 분(`current`)과 지난 분(`lastMinute`)의 표본 수, p50, 최대(밀리초).
- **분마다 로그 한 줄.** 그 분에 공개 요청이 하나라도 있었을 때만 `공개 사용량 {…}` 한 줄에 위 JSON을 담는다.

429가 자주 나오는 묶음은 그 묶음의 한도를 올리거나 사용 패턴을 본다. 503이 늘면 동시 처리 한도와 `operatorKiwoomLatency`를 함께 본다. 시장 개요 `cacheHits`가 낮으면 캐시 시간을 늘릴 수 있다.

### 차단 계정 넣는 법

1. `topAccounts`에서 요청이 유난히 많은 계정을 찾는다. 값이 `provider:subject`다.
2. env의 `VALLY_PUBLIC_BLOCKED_ACCOUNTS`에 쉼표로 이어 적는다. 예: `google:1234567890,naver:abcdefg`.
3. 재시작한다. 목록의 계정은 세션 확인에서 401이고 로그인도 거절된다.

## 받아들일 한계

- **같은 프로세스.** 공개 처리 중 panic이 운영자 쪽과 나눠 쓰는 `std::sync::Mutex`를 오염시키면 운영자 쪽도 계속 실패할 수 있다. 공개 라우터는 panic을 잡고(`500`), 동시 처리와 시간 상한으로 자원 고갈을 막지만 구조로 없애지는 못한다.
- **대기열 공유.** 공개 요청은 운영자 화면과 같은 `Priority::Screen` 단계로 나간다. 위 계산한 상한만큼 운영자 요청을 늦출 수 있고, 공개 부하가 만든 실패가 공용 관문을 닫으면 운영자 조회에도 `Gated`가 번진다.
- **IP를 모름.** 클라이언트 IP 헤더를 믿지 않아 로그인 시작 버킷을 한 사람이 다 쓸 수 있다. P4에서 Funnel이 넘기는 헤더를 확인한 뒤 IP별 버킷으로 고친다.
- **오래된 브라우저의 `no-cors` `GET`.** `Sec-Fetch-Site`를 보내지 않는 브라우저의 Origin 없는 `GET`은 운영자 리스너에 닿는다. 응답은 읽히지 않는다.
- **가입 상한 선점.** 가입 100명이 차면 새 가입이 막힌다. 차단 목록이 있으므로 받아들인다.
- **시작 시간.** 공개 리스너는 시작할 때 화면 파일을 읽고 br·gzip 사본을 만든다. 걸린 시간은 시작 로그의 `공개 화면 파일을 메모리에 올렸습니다`에 `elapsed_ms`로 남는다.
