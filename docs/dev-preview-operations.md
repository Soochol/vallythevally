# 개발·프리뷰 서버 운영

로컬 개발, 서버 PC 프리뷰, 서버 PC 실서버를 세 계층으로 분리해 운영하는 절차다. 실제 tailnet 이름과 IP 주소는 저장소에 적지 않는다.

이 문서의 자리표시는 다음과 같다.

| 자리표시 | 뜻 |
|---|---|
| `<tailnet>` | tailnet의 MagicDNS 이름 |
| `<서버 PC>` | 개발 PC에서 ssh로 부르는 서버 PC 이름 또는 `사용자@호스트` |
| `<사용자>` | 서버 PC에서 서비스를 돌리는 계정 |

## 세 계층 구성

| 계층 | 실행 위치 | 서비스·명령 | 운영자 리스너 | 투자구분 | 데이터 경로 | 접속 주소 |
|---|---|---|---|---|---|---|
| 로컬 개발 | 개발 PC | `python3 scripts/dev.py serve` | `127.0.0.1:8082` | `mock` | `~/vally-data/dev-local` | `http://127.0.0.1:5173` (HMR), `http://127.0.0.1:8082` |
| 서버 PC 프리뷰 | 서버 PC | `vally-dev.service` (`scripts/dev-preview.sh`) | `127.0.0.1:8082` | `mock` | `~/vally-data/dev` + 읽기 전용 공용 자료 | `https://server.<tailnet>.ts.net:8443` |
| 서버 PC 실서버 | 서버 PC | `vally-server.service` | `127.0.0.1:8080` | `real` | `~/vally-data/server` + 공용 자료 | `https://server.<tailnet>.ts.net` (`:443`) |

로컬 개발과 서버 PC 프리뷰는 모두 모의 투자구분(`VALLY_KIWOOM_ENV=mock`)으로만 뜬다. 실서버 서비스와 포트(`8080`, `443`)는 건드리지 않는다.

## 로컬 개발

### 서버와 웹 HMR 함께 띄우기

개발 PC 저장소 루트에서 한 줄로 백엔드와 Vite HMR 서버를 띄운다.

```sh
python3 scripts/dev.py serve
```

이 명령은 다음 순서로 동작한다.

1. `vally-server`를 개발 캐시로 준비한다. 이미 빌드한 실행 파일을 바로 쓰려면 `--no-build`를 붙인다.
2. 부모 셸의 모든 `VALLY_*` 변수와 `OPENDART_API_KEY`를 지우고 모의 투자구분 전용 환경 변수만 채운다.
3. `127.0.0.1:8082`에서 서버를 띄우고 `/api/screener/status`가 200을 돌려줄 때까지 최대 30초 기다린다.
4. `VITE_FAKE_API=0`과 `VITE_API_TARGET=http://127.0.0.1:8082`로 `web/` Vite 개발 서버(`127.0.0.1:5173`)를 띄운다.
5. `Ctrl+C`(SIGINT)나 SIGTERM을 받으면 서버와 Vite 프로세스 그룹을 모두 종료한다.

주요 옵션은 다음과 같다.

- `--port <번호>`: 백엔드 루프백 포트를 바꾼다. 기본값은 `8082`다.
- `--vite-port <번호>`: Vite HMR 포트를 바꾼다. 기본값은 `5173`이다.
- `--data-dir <경로>`: 로컬 개발 데이터 폴더를 바꾼다. 기본값은 `~/vally-data/dev-local`이다.
- `--hoga-dir <경로>`, `--shared-dir <경로>`, `--financial-db <경로>`: 수집 호가, 공용 자료, 재무 DB 경로를 직접 지정한다. 지정하지 않아도 `data-dir` 안에 `hoga/`, `hoga/shared/`, `financials.db`가 있으면 자동으로 연결한다.
- `--tailnet-host <이름>`: `VALLY_TAILNET_HOSTS`를 추가로 지정한다.
- `--backend-only`: Vite를 띄우지 않고 정적 `web/dist`만 서빙한다.
- `--no-build`: `dev.py build`를 건너뛰고 `target/dev/bin/vally-server`를 바로 실행한다.

### 서버 PC에서 최근 표본 내려받기

로컬 개발 PC에서 분 호가와 공용 자료 화면을 확인하려면 서버 PC의 최근 1~5일 표본과 `screener.duckdb`만 내려받는다.

```sh
python3 scripts/dev.py sync-sample --host <서버 PC> --days 2
```

`VALLY_PREVIEW_HOST` 환경 변수를 설정해 두면 `--host`를 생략할 수 있다. 실제 복사 없이 명령만 확인하려면 `--dry-run`을 붙인다.

내려받는 대상은 다음과 같다.

- `server/screener.duckdb`를 `~/vally-data/dev-local/screener.duckdb`로 복사한다.
- 최근 N일(`--days`, 1~5일)의 `hoga/store/<날짜>/`
- 최근 N일의 `hoga/shared/quote-minutes/<날짜>/`, `quote-minutes-live/<날짜>/`, `minute/<날짜>/`, `trade-minute/<날짜>/`, `symbol-flow/<날짜>/`

`vally.db`, `server.env`, `kiwoom-*.json`, `token*.json`, `financials.db`는 복사 대상에 넣지 않는다.

## 서버 PC 프리뷰

폰이나 다른 기기에서 작업 중인 브랜치를 실제 공용 자료와 분 호가 위에서 확인하려면 서버 PC 프리뷰를 쓴다.

### 최초 1회 설정

개발 PC에서 서버 PC를 대상으로 `--setup`을 한 번 실행한다. 같은 명령을 다시 실행해도 같은 상태로 수렴한다.

```sh
scripts/dev-preview.sh --host <서버 PC> --setup
```

이 명령은 서버 PC에서 다음을 준비한다.

1. `~/apps/vallythevally-dev`, `~/vally-data/dev`, `~/.local/state/vallythevally/dev`, `~/.config/systemd/user/vally-dev.service.d` 폴더를 만든다.
2. `tailscale status --json`의 `Self.DNSName`을 읽어 `~/.config/systemd/user/vally-dev.service.d/host.conf`에 `Environment=VALLY_TAILNET_HOSTS=<MagicDNS>:8443`을 적는다. 직접 지정하려면 `--tailnet-host`를 넘긴다.
3. `deploy/systemd/vally-dev.service`를 `~/.config/systemd/user/vally-dev.service`에 설치하고 `systemctl --user daemon-reload`를 실행한다.
4. `tailscale serve --bg --https=8443 http://127.0.0.1:8082`를 등록한다.

### 작업 트리 배포·확인·중지

현재 작업 트리를 서버 PC 프리뷰로 올린다.

```sh
scripts/dev-preview.sh --host <서버 PC>
```

이 명령은 `.git`, `target`, `node_modules`, `.env*`, `*.db*`를 빼고 `~/apps/vallythevally-dev`로 `rsync`한 뒤 원격에서 `vally-server`와 `web/`을 빌드하고 `vally-dev.service`를 재시작한다. `~/vally-data/dev/screener.duckdb`가 없으면 실서버 `screener.duckdb`를 임시 파일 경유로 복사한다. 이미 있는 파일을 최신으로 다시 복사하려면 `--sync-screener`를 붙인다. 백엔드나 웹 빌드를 건너뛰려면 `--skip-server`나 `--skip-web`을 쓴다.

상태 확인과 중지는 다음과 같다.

```sh
scripts/dev-preview.sh --host <서버 PC> --status
scripts/dev-preview.sh --host <서버 PC> --stop
```

## 실주문 차단 5중 방어

개발·프리뷰 환경에서 실계좌 주문이 나가지 않도록 다섯 단계로 차단한다.

1. 환경 변수 초기화와 `VALLY_KIWOOM_ENV=mock` 고정. `scripts/dev.py serve`는 부모 셸의 모든 `VALLY_*` 변수와 `OPENDART_API_KEY`를 지우고 `VALLY_KIWOOM_ENV=mock`을 강제한다. `deploy/systemd/vally-dev.service`도 `VALLY_KIWOOM_ENV=mock`을 고정한다.
2. 실서버 비밀과 알림 미연결. `deploy/systemd/vally-dev.service`는 `VALLY_ENV_FILE`, `VALLY_COLLECTOR_SOCKET`, `VALLY_COLLECTOR_TELEGRAM`을 넣지 않는다.
3. 상태와 DB 경로 분리. 프리뷰는 `~/vally-data/dev/vally.db`, `%t/vallythevally/dev/server.lock`, `~/.local/state/vallythevally/dev/token.json`, `kiwoom-key.json`을 쓰고, 로컬 개발은 `dev-local` 폴더를 쓴다. 실서버 키·토큰·DB를 읽거나 덮지 않는다.
4. 배포 스크립트 실서버 거부 가드. `scripts/dev-preview.sh`는 `VALLY_PREVIEW_SERVICE=vally-server.service`, `VALLY_PREVIEW_PORT=8080`, `VALLY_PREVIEW_HTTPS_PORT=443`이 들어오면 SSH 실행 전에 종료 코드 2로 거부한다.
5. 기동 직후 모의 투자구분 검증. `scripts/dev-preview.sh`는 재시작 뒤 `http://127.0.0.1:8082/api/system/kiwoom` 응답에 `"environment":"mock"`이 없으면 서비스를 즉시 중지하고 실패한다.

## 실서버 승격

프리뷰 확인을 마친 변경은 기본 브랜치로 머지한 뒤 실서버 배포 파이프라인으로 올린다.

1. PR을 연다: `gh pr create`
2. 이 저장소의 머지 큐 도구로 제출한다: `chute submit`
3. `main`에 머지되면 서버 PC 실서버 배포 엔진(`deploy_engine.py`)이 `~/apps/vallythevally`를 갱신하고 `vally-server.service`(`127.0.0.1:8080`, `:443`)를 배포한다.
