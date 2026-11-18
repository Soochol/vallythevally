# 키움 모의투자 서버 띄우기

모의투자는 서버 프로세스 하나가 모의 키움에만 붙는 구성이다. 결정과 이유는 [ADR 0030](adr/0030-kiwoom-mock-trading-runs-as-its-own-server-process.md), 용어는 [GLOSSARY](../GLOSSARY.md)의 **투자구분**이다. 실전 서버와 같은 PC에서 함께 띄울 수 있다.

이 문서의 절차는 실제 키움 모의 서버(`mockapi.kiwoom.com`)에 붙는다. 자동 시험이 아니다. 자동 시험은 합성 transport와 루프백 가짜만 쓴다([AGENTS.md](../AGENTS.md)).

## 설정 파일

저장소 밖에 새 파일을 만들고 권한을 600으로 한다. 메인 체크아웃의 `.env`는 고치지 않는다.

```sh
install -m 600 /dev/null ~/.config/vallythevally/mock.env
```

내용은 세 줄이다. 값은 자리표시자다. 실제 값은 화면에 찍지 않는 방법으로 옮긴다.

```
VALLY_KIWOOM_ENV=mock
VALLY_KIWOOM_MOCK_APP_KEY=<모의 앱키>
VALLY_KIWOOM_MOCK_APP_SECRET=<모의 시크릿>
```

- 실전 키 변수(`VALLY_KIWOOM_APP_KEY`, `VALLY_KIWOOM_APP_SECRET`)는 넣지 않는다. 설정 파일이든 프로세스 환경이든 있으면 서버가 뜨지 않는다.
- 키움 주소 변수(`VALLY_KIWOOM_BASE_URL`, `VALLY_KIWOOM_WS_URL`)는 비워 둔다. 비우면 모의 공식 주소(`https://mockapi.kiwoom.com`, `wss://mockapi.kiwoom.com:10000/api/dostk/websocket`)를 쓴다. 적으려면 `mockapi.kiwoom.com`이거나 루프백이어야 한다.
- 프로세스 환경의 값이 설정 파일 값을 덮는다. 셸에 실전 `VALLY_*` 변수가 남아 있으면 먼저 지운다.
- 모의 키는 환경에서만 받는다. 화면의 키 저장·삭제는 거절하고, 키 파일(`kiwoom-key.json`)은 읽지 않는다.
- `VALLY_ACCOUNT_SERVER_URL`은 모의와 함께 쓸 수 없다.

## 켜기

작업 디렉터리는 메인 체크아웃 루트다(`web/dist`, `data/mock/`). `VALLY_ENV_FILE`은 절대 경로다.

```sh
VALLY_ENV_FILE=$HOME/.config/vallythevally/mock.env target/dev/bin/vally-server
```

시작 로그에 투자구분 `mock`과 호스트 `mockapi.kiwoom.com`이 보이고, `api.kiwoom.com`은 보이지 않는다. 화면은 `http://127.0.0.1:8081`이다.

모의 키의 공인 IP가 키움 포털에 등록돼 있어야 한다. 미등록이면 `8050`으로 멈춘다([ADR 0004](adr/0004-dedicated-kiwoom-app-key.md)).

## 기본 경로

경로 설정을 주지 않으면 투자구분이 기본값을 정한다. 설정을 주면 그 값이 앞선다.

| 설정 | 실전 기본 | 모의 기본 |
|---|---|---|
| `VALLY_LOCK_PATH` | `$XDG_RUNTIME_DIR/vallythevally/server.lock` | `$XDG_RUNTIME_DIR/vallythevally/mock/server.lock` |
| `VALLY_TOKEN_PATH` | `$XDG_STATE_HOME/vallythevally/token.json` | `$XDG_STATE_HOME/vallythevally/mock/token.json` |
| `VALLY_KIWOOM_KEY_PATH` | `$XDG_STATE_HOME/vallythevally/kiwoom-key.json` | `$XDG_STATE_HOME/vallythevally/mock/kiwoom-key.json` |
| `VALLY_DB_PATH` | `data/vally.db` | `data/mock/vally.db` |
| `VALLY_SCREENER_DB_PATH` | `data/screener.duckdb` | `data/mock/screener.duckdb` |
| `VALLY_FINANCIAL_DB_PATH` | DB 옆 `financials.db` | DB 옆 `financials.db` |
| `VALLY_BIND` | `127.0.0.1:8080` | `127.0.0.1:8081` |
| `VALLY_SCREENER_UPDATE_ON_START` | `on` | `off` |

`XDG_RUNTIME_DIR`이 없으면 잠금은 `/tmp/vallythevally-<uid>/` 아래, `XDG_STATE_HOME`이 없으면 `$HOME/.local/state` 아래다. 주문 사용 스위치(`kiwoom-orders.json`)와 등록 IP 기록(`kiwoom-ip.json`)은 키 파일과 같은 폴더다. 모의에는 기본 계정 상태 파일이 없다.

## 실전과 함께 띄우기

실전 서버는 지금 하던 대로 기본 설정으로 켠다(포트 8080). 모의 서버는 위 설정 파일로 켠다(포트 8081). 잠금·토큰·DB가 따로라 서로 기다리거나 덮지 않는다. 키가 달라서 토큰을 가진 프로세스가 키마다 하나라는 규칙도 그대로다.

## 투자구분 표시와 섞임 방지

경로를 덮어써서 모의가 실전 파일을 가리켜도 열리지 않도록 파일에 투자구분이 적힌다.

- 토큰 파일: 다른 투자구분의 파일은 읽지도 쓰지도 않는다. 읽지 못한 것으로 보고 조회와 발급을 멈춘다.
- 주문 사용 스위치 파일: 다른 투자구분의 파일은 꺼진 것으로 보고 쓰지 않는다.
- 사용자 자료 DB: 다른 투자구분의 DB는 서버가 뜨지 않는다. 표시 없는 기존 DB는 실전이다.

## 확인 기록

아직 없다. 병합 뒤 수동 확인을 하면 날짜와 통과·실패만 별도 PR로 더한다. 계좌번호·주문번호·키는 적지 않는다.
