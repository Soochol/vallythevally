# 서버 PC 실서버 운영

실서버(`vally-server`, 키움 실계좌, 포트 8080)를 Tailscale 망의 별도 PC("서버 PC")에서 돌리고, 같은 망의 기기(개발 PC, 폰) 브라우저로 `https://server.<tailnet>.ts.net`에 접속하는 구성의 운영 절차다. 계획과 결정은 [서버 PC 이전 플랜](plans/server-pc.md), 보안 결정은 [ADR 0036](adr/0036-remote-access-goes-through-tailscale-serve-and-a-configured-tailnet-name.md)이다. 개발 PC에서 실서버를 돌리던 때의 배포 설명은 [개발 빌드 문서](development-builds.md)의 "상시 운영"에 있다.

이 문서의 자리표시는 다음과 같다. 실제 값은 저장소에 적지 않는다.

| 자리표시 | 뜻 |
|---|---|
| `<tailnet>` | tailnet의 MagicDNS 이름 |
| `<서버 PC>` | 개발 PC에서 ssh로 부르는 서버 PC의 이름 |
| `<서버 PC 사용자>` | 서버 PC에서 서비스를 돌리는 계정 |

`ssh`, `rsync`, `scp`는 개발 PC에서 `<서버 PC>`로 보낸다. 상대 경로(`~/…`)는 양쪽 모두 각 PC의 홈 기준이다.

## 구성

```
 Tailscale 망 (WireGuard로 암호화, 내 기기만)
 ┌───────────────────────────┐        ┌──────────────────────────────────────────────┐
 │ 개발 PC                    │        │ 서버 PC                                       │
 │  브라우저 ────────────────┼─https─▶│ tailscale serve :443 (server.<tailnet>.ts.net) │
 │  orch deploy ──ssh────────┼───────▶│   │ http                                      │
 │  모의 서버 127.0.0.1:8081  │        │   ▼                                           │
 │  (실서버 서비스: 꺼 둠)     │        │ vally-server 127.0.0.1:8080 (루프백만)         │
 └───────────────────────────┘        │   Host·Origin: 루프백 + 설정한 ts.net 이름      │
 ┌───────────────────────────┐        │   데이터 ~/vally-data/server, 상태 ~/.local/state│
 │ 폰 (Tailscale 앱)          │─https─▶│                                              │
 └───────────────────────────┘        └──────────────────────────────────────────────┘
```

- 서버는 루프백(`127.0.0.1:8080`)에만 열린다. 공인 IP·LAN 주소·Tailscale IP의 8080은 연결 거부다.
- 443은 `tailscale serve`가 Tailscale 인터페이스에만 연다. 페이지가 https라 `crypto.randomUUID`와 클립보드가 쓰이고, WebSocket은 `wss`로 붙는다.
- Funnel(`tailscale funnel`)은 켜지 않는다. 켜면 공개 인터넷에 열린다.
- 서버는 `VALLY_TAILNET_HOSTS`에 적은 정확한 이름만 자기 Host로 받는다. 접속 범위를 좁히는 것은 Tailscale ACL의 몫이다.

## 서버 PC 준비

서버 PC에서 한다. 실서버는 아직 켜지 않는다.

### Tailscale

`tailscale serve`를 sudo 없이 쓰도록 operator를 한 번 지정한다. 서버 PC의 sudo가 암호를 물으므로 사람이 서버 PC 터미널에서 한다.

```sh
sudo tailscale set --operator=<서버 PC 사용자>
```

### 배포 checkout과 빌드

```sh
mkdir -p ~/apps
git clone <저장소 주소> ~/apps/vallythevally
cd ~/apps/vallythevally
git checkout main
```

### 수집 데몬 재시작

수집 데몬은 장 전 준비부터 마감 정리가 끝날 때까지 돌고, 꺼지면 모든 키의 수집과 정리가 끊긴다([ADR 0026](adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md)). 그래서 배포가 앱 서버와 달리 데몬을 바로 재시작하지 않는다. 설치(`collector-install`)와 재시작(`collector-restart`)이 같은 판정(`collector-restart --check`)을 거친다. 수집 시간 밖이면 설치가 제자리 파일을 바로 바꾸고, 안이면 새 판을 옆 자리에만 둔다.

`collector restart-window`는 데몬이 쓰는 `ScheduleSettings`와 `Calendar`로 판정하고 한 줄을 출력한다(탭으로 나눈다). 달력은 네트워크 없이 데이터 폴더의 특일정보 캐시와 `calendar/overrides.json`만 읽는다.

| 지금 | 출력 | 배포 |
|---|---|---|
| 수집 시간(판단 시각 07:20부터 마감 시각 20:05 + 정리 여유 120분 = 22:05 전까지) 밖 | `now` | 바로 재시작 |
| 수집 시간 안인데 쉬는 날(주말, 공휴일, KRX 휴장일, 수정 파일의 임시 휴장) | `now` | 바로 재시작 |
| 수집 시간 안, 관측일, 마감 전이거나 `store/<오늘>/complete.json`이 없거나 `store/<오늘>.tmp/`가 남음 | `wait` + 오늘 마감 정리 여유가 끝나는 시각 | 예약 |
| 수집 시간 안인데 오늘이 쉬는 날인지 알 수 없음(특일정보 캐시가 없고 못 받는 해 등) | `wait` + 같은 시각 | 예약 |
| 마감 뒤이고 `complete.json`이 있고 `.tmp`가 없음 | `now` | 바로 재시작 |

수집 시간 밖은 달력을 보지 않는다. 그 시각에는 쉬는 날이든 아니든 데몬이 수집하지 않기 때문이다. 정리가 실패해 `complete.json`이 끝내 없어도 정리 여유가 지나면 재시작한다. 데몬은 다음 날 시작이나 데몬 시작 때 정리를 다시 한다([수집기 문서](hoga-collector.md)의 "데몬 재시작 규칙"). 예약이 걸린 시각에는 판정 없이 재시작하며, 그 시각은 정리 여유가 끝난 뒤라 수집 시간 밖이다. 수집 시간 안에는 돌고 있는 옛 데몬이 그날의 `finalize`와 다시 띄우는 `collect` 자식을 `~/.local/bin/collector`로 띄운다. 그래서 `collector-install`은 수집 시간 안이면 제자리 파일을 건드리지 않고 새 판을 같은 폴더의 `<이름>.next`에만 둔다(`collector.next`, `vally-collector-alert-telegram.next`, 유닛 둘의 `.next`). 같은 날 배포를 다시 하면 `.next`는 마지막 판 하나만 남고(제자리와 같은 판이면 지운다) 예약도 하나다. 마감 뒤 예약된 `collector-restart --scheduled`가 `.next`를 rename으로 제자리에 옮긴 뒤 재시작한다. 수집 시간 밖이면 전부 바로 바꾸고 `.next`는 지운다. 판정이 실패하면 안전한 쪽인 옆 자리에 둔다. 설치된 `collector`가 없으면(첫 설치) 돌고 있는 데몬이 없으므로 바로 둔다. 판정은 이번에 빌드한 `target/release/collector`의 `restart-window`로 한다. 재시작 단계의 `now` 판정도 `.next`를 옮기므로 두 단계 사이에 시각이 마감 쪽으로 넘어가도 새 판이 쓰인다.

설치와 재시작은 같은 판정을 쓴다. 설치가 `now`로 판정하고 제자리 파일을 바꿨으면 유닛 폴더에 `.vally-collector-install-verdict`(내용 `now`)를 남기고, 재시작 단계는 그 파일이 30분 안의 것이면 자기 `--check`를 다시 묻지 않고 바로 재시작한다. 두 단계 사이에 수집 시간이 막 시작됐어도(07:20 직전 설치) 새 판이 든 파일과 옛 데몬이 섞인 채 하루를 보내지 않는다. 그때의 재시작은 시작 시각 직후라 데몬이 그날 일정을 처음부터 도는 쪽이다. 설치가 `wait`로 판정했으면 파일을 지우고, 재시작 단계는 자기 `--check`로 정한다(그 사이 마감 정리 여유가 끝났으면 `now`). 파일은 재시작 단계가 읽으면 지우고, 30분이 지난 파일은 무시하고 지운다.

경보 스크립트와 유닛도 같은 규칙이다. 유닛을 돌고 있는 데몬 옆에서 바로 `daemon-reload`하면 데몬 프로세스는 그대로이지만 유닛 정의가 바뀐다. 그 상태에서 데몬이 죽으면 `Restart=on-failure`가 옛 실행 파일을 새 유닛의 `ExecStart=`·`Environment=`로 다시 띄우고, 옛 바이너리가 모르는 인수면 종료 코드 2로 `RestartPreventExitStatus=2`에 걸려 수집이 끊긴다. 그래서 유닛은 재시작 직전에 옮기고 그때 `daemon-reload`를 한다. 경보 스크립트는 경보 유닛과 짝이라 같이 미룬다. 옮기는 동안 파일마다 옛 판을 `<이름>.prev`로 하드링크해 두고, `daemon-reload`가 실패하면 옮긴 파일을 모두 옛 판으로 되돌리고(새 판은 `.next`로 돌아가 다음에 다시 옮긴다) 재시작하지 않는다. 그래서 실행 파일만 새 판이 되는 섞임은 없다. 되돌린 뒤 유닛 폴더의 `.vally-collector-reload-pending` 표시가 남고, 다음 `collector-install`(수집 시간 안이어도)이나 `collector-restart`가 표시가 있는 동안 다시 reload한다. 예약 실행(`--scheduled`)과 시작 전 정리(`--before-start`)가 이렇게 멈추면 `~/.local/bin/vally-collector-alert-telegram`으로 텔레그램 경보를 보낸다(스크립트가 없으면 건너뛴다). 배포가 부른 재시작 단계는 실패가 배포 출력에 나오므로 경보하지 않는다. 승격은 유닛 폴더의 `.vally-collector-deploy.lock`을 `flock`으로 잡고 하므로(설치의 두기도 같은 잠금) 예약 실행과 배포의 재시작 단계가 겹치면 늦은 쪽이 기다렸다가 옮길 것이 없어 그대로 이어간다. 재시작과 `VALLY_COLLECTOR_STABLE_SECONDS` 동안의 확인은 별도의 `.vally-collector-restart.lock`으로 한 번에 하나만 돌아, 겹친 다른 재시작이 확인 중에 비활성 상태를 보고 실패하지 않는다. 재시작 잠금을 얻은 뒤 두 가지를 본다. 승격 뒤 데몬 실행 파일과 데몬 유닛의 내용이 이 실행이 시작된 뒤 다른 재시작이 이미 재시작하고 확인까지 마친 판과 같으면 다시 재시작하지 않고 그 사실을 한 줄로 남기며 성공한다(잠금 안에서 `.vally-collector-last-restart`에 확인을 마친 시각과 그때 판의 체크섬을 적어 비교한다. 확인에 실패한 재시작은 적지 않는다). 판이 달라졌거나 앞선 재시작이 이 실행이 시작되기 전에 끝났으면 재시작한다. 같은 판이어도 데몬이 지금 active가 아니면 건너뛰지 않고 재시작하고, 재시작하기 직전에 그 기록을 지우므로 확인에 실패한 재시작 뒤에는 옛 기록으로 건너뛰지 않는다. 재시작 잠금의 대기는 확인 시간에서 끌어내 `VALLY_COLLECTOR_STABLE_SECONDS + VALLY_COLLECTOR_LOCK_SECONDS`초이다. 앞선 재시작의 승격·`systemctl restart`·확인이 이 안에 끝나야 하므로 데몬이 멈추는 데 오래 걸리면(유닛의 `TimeoutStopSec`) `VALLY_COLLECTOR_LOCK_SECONDS`를 올린다(앞선 재시작이 다른 확인 시간으로 돌았다면 그 시간이 이 대기보다 길 수 있다). 승격의 `.vally-collector-deploy.lock`은 `VALLY_COLLECTOR_LOCK_SECONDS`(120)초 넘게 못 잡으면 실패한다. 링크가 가리키는 곳을 `readlink -f`로 못 풀면 링크를 일반 파일로 바꾸지 않고 실패한다. 설치된 파일이 심볼릭 링크이면 링크를 두고 링크가 가리키는 파일을 바꾼다(`.next`도 그 파일 옆에 둔다). 예약된 재시작이 실패하면 배포 출력에는 나오지 않으므로 `journalctl --user -u vally-collector-restart.service`와 데몬 경보로 본다. 예약은 `systemd-run`의 일회 타이머라 서버 PC가 재부팅되면 사라진다. 그래서 데몬 유닛은 `ExecStartPre=-%h/.local/bin/vally-collector-restart --before-start`로 시작 직전에 `.next`를 전부 옮긴다(`collector-install`이 이 스크립트를 `collector-restart`의 사본으로 늘 함께 설치한다). 이 시각에는 옛 데몬과 자식이 없으니 파일을 바꿔도 돌고 있는 프로세스를 깨지 않고, 재부팅이든 `Restart=on-failure`든 어차피 데몬을 새로 띄우는 때다. 그래서 장중에 재부팅으로 뜬 데몬도 수집 시간을 보지 않고 새 판으로 뜬다. "재시작은 마감 뒤"는 돌고 있는 데몬을 배포가 끊지 않는다는 규칙이고 이미 꺼진 데몬을 켜는 일에는 걸리지 않는다. 데몬 유닛(`vally-collector.service`)이 같이 바뀌었으면(경보 유닛만 바뀐 때는 `daemon-reload`만 한다) 이미 읽힌 옛 정의로 이번 시작이 진행되므로 정리가 `daemon-reload`를 한 뒤 10초 뒤에 한 번 다시 시작하도록 `systemd-run`으로 걸어 새 정의를 쓴다. `-` 접두어라 이 정리가 실패하거나 스크립트가 없어도 데몬은 뜬다. 그래도 자식과 데몬의 줄 JSON 프로토콜 버전(ADR 0026)이 호환되지 않게 바꾸는 배포는 마감 뒤에 한다. 

Node와 pnpm은 fnm으로 깔려 있어 비대화형 ssh의 PATH에 없다(`bash -lc`에서만 보인다). cargo는 `~/.cargo/bin`에 있다. 배포 스크립트(`deploy/web-build`)는 fnm 설치 경로 `~/.local/share/fnm/node-versions/v<버전>/installation/bin`을 `VALLY_NODE_BIN`으로 받아 PATH에 넣는다. 버전은 `ls ~/.local/share/fnm/node-versions`로 확인한다.

최초 빌드는 개발 문서의 명령과 같다.

```sh
cd ~/apps/vallythevally
flock "$(git rev-parse --path-format=absolute --git-common-dir)/compile.lock" env CARGO_BUILD_JOBS=4 cargo build --locked --release -p server
cd web
pnpm install --frozen-lockfile
pnpm build
```

비대화형 셸에서 같은 명령이 돌아야 배포가 된다. 다음이 모두 경로를 찾는지 확인한다(`<버전>`은 위에서 확인한 값).

```sh
ssh -o BatchMode=yes <서버 PC> 'PATH="$HOME/.local/share/fnm/node-versions/v<버전>/installation/bin:$PATH" sh -c "node --version && pnpm --version"'
ssh -o BatchMode=yes <서버 PC> 'PATH="$HOME/.cargo/bin:$PATH" cargo --version'
```

### systemd 사용자 서비스

개발 PC에서 쓰던 [`deploy/systemd/vally-server.service`](../deploy/systemd/vally-server.service)에 `VALLY_TAILNET_HOSTS` 한 줄이 더해진 것이다. 서버 PC의 `~/.config/systemd/user/vally-server.service`로 둔다.

```ini
[Unit]
Description=Vally 앱 서버 (배포 checkout의 release 빌드)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=10min
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory=%h/apps/vallythevally
Environment=VALLY_ENV_FILE=%h/.config/vally/server.env
Environment=VALLY_DB_PATH=%h/vally-data/server/vally.db
Environment=VALLY_SCREENER_DB_PATH=%h/vally-data/server/screener.duckdb
Environment=VALLY_FINANCIAL_DB_PATH=%h/vally-data/server/financials.db
Environment=VALLY_STATIC_DIR=%h/apps/vallythevally/web/dist
Environment=VALLY_TAILNET_HOSTS=server.<tailnet>.ts.net
ExecStart=%h/apps/vallythevally/target/release/vally-server
Restart=on-failure
RestartSec=10
TimeoutStopSec=60

[Install]
WantedBy=default.target
```

- `VALLY_TAILNET_HOSTS`는 포트 없는 MagicDNS 전체 이름이다. 쉼표로 여러 개를 적을 수 있다. `.ts.net`으로 끝나지 않는 값, 포트·스킴·경로가 붙은 값, 와일드카드, IP는 서버가 시작하지 않는다.
- 이름이 `tailscale serve`가 쓰는 이름과 같아야 한다. 서버 PC에서 `tailscale status --json`의 `Self.DNSName`(끝의 점 제외)이 그 이름이다.
- 이 단계에서는 `daemon-reload`만 한다. enable·start는 "전환 순서"에서 한다.

```sh
mkdir -p ~/.config/systemd/user ~/.config/vally ~/vally-data/server
systemctl --user daemon-reload
```

사용자 서비스가 로그아웃 뒤와 재부팅 뒤에도 돌도록 linger를 켠다.

```sh
sudo loginctl enable-linger <서버 PC 사용자>
loginctl show-user <서버 PC 사용자> --property=Linger
```

두 번째 명령이 `Linger=yes`를 보여야 한다.

### tailscale serve

serve 설정은 전환 순서의 마지막에 한다. 명령과 확인은 다음과 같다.

```sh
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status
```

`serve status`가 `https://server.<tailnet>.ts.net`을 `http://127.0.0.1:8080`으로 넘기는 것으로 보여야 한다. Funnel은 켜지 않는다. 이 tailnet은 HTTPS 인증서 기능이 켜져 있어야 한다. 인증서를 받으면 기기 이름과 tailnet 이름이 공개 인증서 기록(CT 로그)에 남는다.

## 옮길 파일

| 원본(개발 PC) | 내용 | 비고 |
|---|---|---|
| `~/vally-data/server/vally.db`, `vally.db-wal`, `vally.db-shm` | 사용자 DB(SQLite WAL) | 서버를 멈춘 뒤 옮긴다 |
| `~/vally-data/server/screener.duckdb` | 스크리너 저장소 | 서버를 멈춘 뒤 마지막으로 맞춘다 |
| `~/vally-data/server/financials.db` | 재무 DB. 수십 GB | 미리 복사한다 |
| `~/vally-data/server/market-samples/` | 시장 표본 | 있으면 |
| `~/.config/vally/server.env` | 설정과 비밀값 | 권한 600 |
| `~/.local/state/vallythevally/kiwoom-keys.json` | 실전 키 목록(최대 5개). 옛 `kiwoom-key.json`은 처음 켤 때 이 파일로 옮겨지고 지워진다 | 권한 600 |
| `~/.local/state/vallythevally/kiwoom-orders.json` | 주문 사용 스위치 | |
| `~/.local/state/vallythevally/token.json`, `token.<키 ID>.json` | 접근 토큰(키마다 하나) | |
| `~/.local/state/vallythevally/kis-token.json` | 한투 접근 토큰. 앱키 해시와 마지막 발급 요청 시각이 함께 있다 | 한투 키를 쓸 때만 있다. 권한 600 |
| `~/.local/state/vallythevally/kiwoom-ip.json`, `kiwoom-ip.<키 ID>.json` | 등록 IP 확인 상태(키마다 하나) | 있으면 |

옮기지 않는 것: 모의 서버의 `mock/`과 `collector/`(개발 PC에 남는다).

비밀값 파일(`server.env`, `kiwoom-*.json`, `token.json`, `kis-token.json`)의 규칙:

- `scp -p`나 `rsync -a`로 파일째 보낸다. `cat`, `diff`, `grep`, 로그 출력으로 내용을 보지 않는다.
- 받은 쪽은 권한이 600인지 `stat`로만 확인한다.
- 커밋하거나 이슈·PR·메신저에 적지 않는다.

### 한투 환경 변수

`server.env`에 적는다. 값은 이 문서에 적지 않는다([ADR 0039](adr/0039-kis-key-and-token-are-vally-only.md)).

| 변수 | 뜻 | 비고 |
|---|---|---|
| `VALLY_KIS_APP_KEY`, `VALLY_KIS_APP_SECRET` | 한투 앱키와 시크릿 | 둘 다 적거나 둘 다 비운다. hoga-ops와 공유하지 않는다. 모의 서버(`VALLY_KIWOOM_ENV=mock`)에는 적지 않는다 |
| `VALLY_KIS_BASE_URL`, `VALLY_KIS_WS_URL` | 한투 REST·실시간 주소 | 시험용이다. 공식 실전 주소나 루프백만 되고 둘 다 적거나 둘 다 비운다. 비우면 공식 주소다 |
| `VALLY_KIS_TOKEN_PATH` | 한투 토큰 파일 | 기본은 `VALLY_TOKEN_PATH`와 같은 폴더의 `kis-token.json`이다 |

받는 쪽 폴더를 먼저 만든다.

```sh
ssh -o BatchMode=yes <서버 PC> 'mkdir -p ~/vally-data/server ~/.config/vally ~/.local/state/vallythevally && chmod 700 ~/.local/state/vallythevally'
```

## 전환 순서

장이 끝난 뒤(평일 20시 이후나 주말)에 한다. 실서버가 수 분 멈춘다. 같은 키움 키로 두 서버가 동시에 붙으면 안 되므로 개발 PC 서버를 먼저 끄고 서버 PC 서버를 켠다. 순서를 바꾸지 않는다.

사전 조건: 서버 PC 준비가 끝났고, `ssh -o BatchMode=yes <서버 PC> true`가 성공한다.

### 1. 미리 복사 (서버 가동 중)

큰 파일을 미리 보내 정지 시간을 줄인다. 가동 중이라 DB 파일이 일관되지 않을 수 있으므로 `vally.db`와 그 보조 파일은 보내지 않는다. 여기서 보낸 `screener.duckdb`는 어차피 마지막 단계에서 다시 맞춘다.

```sh
rsync -a --partial --info=progress2 --exclude='/mock/' --exclude='/collector/' --exclude='/vally.db*' ~/vally-data/server/ <서버 PC>:vally-data/server/
```

중간에 끊기면 같은 명령을 다시 돌린다.

### 2. 개발 PC 배포 보류

```sh
python3 ~/.claude/skills/orch/orch.py deploy hold --repo vallythevally
```

### 3. 개발 PC 서버 정지

```sh
systemctl --user stop vally-server.service
systemctl --user disable vally-server.service
systemctl --user is-active vally-server.service
ss -ltn 'sport = :8080'
```

`is-active`가 `inactive`이고 `ss`가 아무 줄도 보이지 않아야 한다. disable은 재부팅 뒤 개발 PC에서 서비스가 다시 뜨는 것을 막는다. 서비스 파일은 지우지 않는다(되돌리기 대비).

### 4. 백업

```sh
~/.local/bin/vally-deploy-backup
```

정지 시점의 `vally.db`를 `~/vally-data/backups/`에 남긴다. 이 백업은 되돌리기의 안전망이다.

### 5. 최종 복사 (정지 상태)

정지 상태라 SQLite와 DuckDB 파일 복사가 일관된다. `--delete`는 필수다. 미리 복사 때 받은 보조 파일(`-wal`, `-shm`, DuckDB의 `.wal`)이 정지 뒤에는 개발 PC에서 사라지는데, 받는 쪽에 남으면 다른 DB 본체와 짝이 어긋난 보조 파일이 된다. `mock/`과 `collector/`는 제외 규칙으로 보호된다.

```sh
rsync -a --delete --info=progress2 --exclude='/mock/' --exclude='/collector/' ~/vally-data/server/ <서버 PC>:vally-data/server/
```

### 6. 설정과 상태 파일 복사

```sh
rsync -a ~/.config/vally/server.env <서버 PC>:.config/vally/server.env
rsync -a --ignore-missing-args ~/.local/state/vallythevally/kiwoom-key.json ~/.local/state/vallythevally/kiwoom-keys.json ~/.local/state/vallythevally/kiwoom-orders.json ~/.local/state/vallythevally/token*.json ~/.local/state/vallythevally/kiwoom-ip*.json <서버 PC>:.local/state/vallythevally/
ssh -o BatchMode=yes <서버 PC> 'stat -c "%a %n" ~/.config/vally/server.env ~/.local/state/vallythevally/*.json'
```

`stat`가 보이는 권한이 모두 `600`이어야 한다. 아니면 `ssh <서버 PC> 'chmod 600 <파일>'`로 맞춘다. `server.env` 안에 절대 경로 설정이 있어 서버 PC에서 안 맞을 수 있다. 값은 보지 말고 키 이름만 본다.

```sh
awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/{print $1}' ~/.config/vally/server.env
```

### 7. 서버 PC 서비스 시작

서버 PC에서 한다.

```sh
systemctl --user enable --now vally-server.service
systemctl --user is-active vally-server.service
tailscale serve --bg --https=443 http://127.0.0.1:8080
tailscale serve status
```

서비스가 시작하지 않고 `VALLY_TAILNET_HOSTS` 오류가 보이면 이름 형식(위 "systemd 사용자 서비스")을 고친 뒤 `systemctl --user daemon-reload`와 `restart`를 한다.

## 확인

주문은 넣지 않는다. 전환 전 상태와 비교하려면 개발 PC를 멈추기 전에 `curl -sS http://127.0.0.1:8080/api/system/kiwoom`과 `curl -sS http://127.0.0.1:8080/api/system/orders`의 결과를 저장해 둔다. 응답에는 비밀값이 없어야 하지만 저장 전에 훑어본다.

서버 PC에서:

```sh
systemctl --user is-active vally-server.service
journalctl --user -u vally-server.service -n 200 --no-pager
curl -sS http://127.0.0.1:8080/api/system/kiwoom
curl -sS http://127.0.0.1:8080/api/system/orders
```

- `is-active`가 `active`다.
- 로그에 키움 연결(토큰 발급과 연결 성공)이 보이고 반복되는 오류가 없다. 로그에 비밀값이 나오면 안 된다. 나오면 그 사실을 보고한다.
- `/api/system/kiwoom`의 연결 상태와 `/api/system/orders`의 주문 사용 상태가 전환 전과 같다.

개발 PC에서 serve를 거쳐:

```sh
curl -sS -i https://server.<tailnet>.ts.net/api/trading/account-number
```

- 응답 본문이 `Host가 이 서버의 주소가 아닙니다`가 아니어야 한다. 이 거절이 나오면 `tailscale serve`가 Host를 설정한 이름과 다르게 넘기는 것이므로 `VALLY_TAILNET_HOSTS` 값과 `tailscale serve status`의 이름을 맞춰 본다. 그래도 같으면 ADR 0036의 Host 규칙을 고쳐야 하니 전환을 멈추고 보고한다.

serve가 Host와 Origin을 원래 이름으로 넘기는지는 서버 PC가 아닌 곳에서 쓰기 두 가지로 가른다. 둘 다 상태를 바꾸지 않는다.

```sh
curl -sS -i -X PUT -H 'Origin: https://example.invalid' -H 'Content-Type: application/json' -d '{' https://server.<tailnet>.ts.net/api/system/kiwoom/key
curl -sS -i -X PUT -H 'Origin: https://server.<tailnet>.ts.net' -H 'Content-Type: application/json' -d '{' https://server.<tailnet>.ts.net/api/system/kiwoom/key
```

- 첫 요청은 `Origin이 이 서버가 아닙니다`로 거절돼야 한다(Host 검사를 통과했다는 뜻이다).
- 둘째 요청은 Host·Origin 거절이 아니라 깨진 JSON에 대한 오류여야 한다. 가드를 통과해 본문 해석에서 멈추므로 키가 바뀌지 않는다. 본문을 유효한 JSON으로 바꿔 보내지 않는다.

브라우저에서:

- 개발 PC와 폰에서 `https://server.<tailnet>.ts.net`이 열리고 차트 화면이 보인다.
- 개발자 도구의 네트워크에서 WebSocket이 `wss://server.<tailnet>.ts.net/…`로 연결돼 있다.
- 관심종목 추가나 레이아웃 저장 같은 쓰기가 오류 없이 된다.

닿지 않아야 하는 주소(서버 PC의 LAN IP와 Tailscale IP의 8080):

```sh
curl -sS --max-time 5 http://<서버 PC의 LAN IP>:8080/api/screener/status
curl -sS --max-time 5 http://<서버 PC의 Tailscale IP>:8080/api/screener/status
```

두 명령 모두 연결 거부여야 한다. 응답이 오면 서버가 루프백이 아닌 주소에 바인드돼 있다는 뜻이니 즉시 서비스를 멈추고 `server.env`의 `VALLY_BIND`를 확인한다(서버는 루프백이 아닌 값을 거절하므로 일어나지 않는 것이 정상이다).

## 배포(orch deploy)

배포 스크립트는 이 저장소의 `deploy/`에 있고 대상 SHA의 checkout에서 돈다. `orch deploy`가 대상 SHA를 정해 checkout을 pull하고, 단계마다 `deploy.json`의 `steps`·`restart`·`after`를 차례로 부른다. 스크립트는 fetch·merge를 하지 않는다. checkout 맞춤은 orch의 몫이고, `server-build`는 orch가 주는 `ORCH_DEPLOY_SHA`가 checkout HEAD와 같은지만 한 번 더 본다. 스크립트는 자기 위치(`deploy/`의 부모)를 checkout 뿌리로 쓰므로 checkout 경로를 박지 않는다.

**전환 전까지는 지금의 개발 PC `~/.local/bin/vally-deploy-{server-build,web-build,backup,restart}` 래퍼가 그대로 쓰인다.** 아래 스크립트는 저장소에 올라가 있을 뿐 `orch deploy`가 아직 부르지 않는다. 래퍼를 `host` 설정과 이 스크립트로 바꾸는 전환과 되돌리기 순서는 orch 저장소 `docs/deploy.md`를 따른다. 실계좌 서버라 전환 시각과 첫 원격 배포는 사용자가 따로 승인한다.

### 스크립트와 환경 변수

| 스크립트 | 하는 일 | 환경 변수(기본값) |
|---|---|---|
| `deploy/server-build` | `ORCH_DEPLOY_SHA`가 있고 checkout HEAD와 다르면 `cargo`를 부르지 않고 실패한다. 같으면 공용 `compile.lock`(`git rev-parse --git-common-dir` 아래)을 `flock`으로 잡고 `cargo build --locked --release -p server`를 한다 | `VALLY_CARGO_BIN`(`$HOME/.cargo/bin`): PATH 앞에 더할 cargo 폴더. `VALLY_BUILD_JOBS`(`4`): `CARGO_BUILD_JOBS` |
| `deploy/web-build` | `web/`에서 `pnpm install --frozen-lockfile` 뒤 `pnpm build` | `VALLY_NODE_BIN`(필수): node와 pnpm이 있는 폴더로, `~` 없는 절대 경로다. 없거나 그 폴더에 `pnpm`이 없으면 0이 아닌 코드로 멈추고 찾는 법을 알린다. `VALLY_CARGO_BIN`, `VALLY_BUILD_JOBS`는 위와 같다 |
| `deploy/collector-build` | `server-build`와 같은 방식으로 `ORCH_DEPLOY_SHA`와 checkout HEAD를 대조하고 공용 `compile.lock`을 잡은 뒤 `cargo build --locked --release -p collector`를 한다 | `VALLY_CARGO_BIN`, `VALLY_BUILD_JOBS`: `server-build`와 같다 |
| `deploy/collector-install` | `target/release/collector`를 `~/.local/bin/collector`로, `collector-restart`를 `~/.local/bin/vally-collector-restart`(데몬 유닛의 시작 전 정리)로, 이미 설치된 경보 스크립트(`vally-collector-alert-telegram`)와 유닛(`vally-collector.service`, `vally-collector-alert.service`)을 저장소 판으로 바꾼다. 수집 시간 밖(`collector-restart --check`가 `now`)이면 같은 폴더에 새 파일을 쓰고 rename해 바로 바꾸고(돌고 있는 데몬의 실행 파일이 깨지지 않는다) 남은 `.next`를 지운다. 수집 시간 안이면 제자리 파일은 그대로 두고 `<이름>.next`로만 둔다(위 "수집 데몬 재시작"). 내용이 같으면 건드리지 않는다. 바뀐 유닛이 제자리에 들어갈 때만 `systemctl --user daemon-reload`를 부르고, 실패하면 다음 실행(수집 시간 안의 설치 포함)이 다시 부른다. 수집 시간 밖이면 `.vally-collector-install-verdict`를 남기고 안이면 지운다(위 "수집 데몬 재시작"). 파일을 두는 동안 `.vally-collector-deploy.lock`을 잡는다. `.next`가 같은 내용이어도 모드는 다시 맞춘다. 설치되지 않은 스크립트와 유닛은 만들지 않고 건너뛴다(처음 설치는 [수집기 문서](hoga-collector.md)의 설치 절). 유닛 모드는 저장소 파일 모드와 상관없이 644다. 설치된 유닛이 심볼릭 링크면 링크를 두고 가리키는 파일을 바꾼다. `vally-server.service`는 서버 PC 판이 다르므로 건드리지 않는다. 서버 PC에서 유닛을 고칠 때는 `systemctl --user edit`의 드롭인(`<유닛>.d/`)으로 한다. 유닛 파일 자체를 고치면 이 단계가 저장소 판으로 덮는다 | `VALLY_COLLECTOR_BIN_DIR`(`$HOME/.local/bin`), `VALLY_SYSTEMD_USER_DIR`(`${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user`). 판정에는 재시작 단계와 같은 `VALLY_DATA`, `VALLY_COLLECTOR_SCHEDULE_ARGS`, `VALLY_COLLECTOR_FINALIZE_MINUTES`를 쓴다 |
| `deploy/collector-restart` | 데몬을 재시작해도 되는지 `collector restart-window`(데몬과 같은 달력·시각 설정, 아래 "수집 데몬 재시작")로 판정한다. 수집 시간 밖이거나 쉬는 날이면 바로 재시작하고 `VALLY_COLLECTOR_STABLE_SECONDS`초 동안 active인지 본다. 중간에 active가 아니면 `journalctl` 안내와 함께 실패한다. 수집 시간 안이거나 판정이 불확실하면 재시작하지 않고 `systemd-run --user`의 일회 타이머(`vally-collector-restart`) 하나를 마감 정리 여유가 끝나는 시각에 걸고, 이미 있던 예약은 새 시각으로 바꾼다. 어느 쪽인지 출력에 한 줄로 남는다. 타이머는 `VALLY_COLLECTOR_SERVICE`, `VALLY_COLLECTOR_STABLE_SECONDS`, `VALLY_COLLECTOR_BIN`, `VALLY_SYSTEMD_USER_DIR`를 `--setenv`로 이어받아 `collector-restart --scheduled`를 불러 판정 없이 재시작한다. 재시작 전에는 늘 `.next`를 제자리로 옮기고(유닛이 바뀌면 `daemon-reload`) `systemctl --user restart`를 한다. 수동 인수는 `--check`(판정만 출력), `--promote`(`.next` 옮기기만), `--retry-reload`(남은 reload 표시만 다시), `--before-start`(데몬 유닛의 `ExecStartPre=`가 부르는 정리)가 있다. 설치 단계의 판정 파일이 30분 안의 `now`면 자기 판정을 묻지 않고 재시작한다 | `VALLY_COLLECTOR_SERVICE`(`vally-collector.service`), `VALLY_COLLECTOR_BIN`(`$HOME/.local/bin/collector`), `VALLY_DATA`(`$HOME/vally-data/hoga`): 유닛의 `VALLY_DATA`와 같아야 한다. `VALLY_COLLECTOR_SCHEDULE_ARGS`(비어 있음): 유닛 `ExecStart=`에 `--judge-at`·`--plan-at`·`--launch-at`·`--close-at`을 적었다면 같은 인수. `VALLY_COLLECTOR_FINALIZE_MINUTES`(`120`): 마감 시각 뒤 정리를 기다리는 분. `VALLY_COLLECTOR_STABLE_SECONDS`(`10`, 1 이상 600 이하의 정수이고 아니면 재시작 전에 종료 코드 2로 실패. `00600`처럼 앞의 0은 값으로 센다), `VALLY_SYSTEMD_USER_DIR`(설치 단계와 같다), `VALLY_COLLECTOR_LOCK_SECONDS`(`120`, 설치 단계도 같다. 재시작 잠금의 대기는 여기에 확인 시간을 더한 값이다) |
| `deploy/backup` | `vally.db`를 SQLite backup API로 떠서 `integrity_check`가 `ok`일 때만 fsync 뒤 원자 교체로 남기고, 보관 개수를 넘는 오래된 백업을 지운다. 원본이 없으면 경로를 알리고 실패한다 | `VALLY_DATA_DIR`(`$HOME/vally-data`): 원본 `server/vally.db`, 보관 폴더 `backups/`. `VALLY_BACKUP_KEEP`(`30`): 1 이상 |
| `deploy/restart` | 서비스를 재시작하고, 서비스가 active이고 확인 주소가 응답할 때까지 1초마다 본다. 기다림 안에 안 되면 `journalctl` 안내와 함께 실패한다 | `VALLY_SERVICE`(`vally-server.service`), `VALLY_HEALTH_URL`(`http://127.0.0.1:8080/api/screener/status`), `VALLY_RESTART_WAIT`(`120`초, 1 이상의 정수. 아니면 재시작 전에 멈춘다) |

Node와 pnpm은 fnm으로 깔려 있어 비대화형 ssh의 PATH에 없다. `ls ~/.local/share/fnm/node-versions`로 버전을 찾고 `~/.local/share/fnm/node-versions/v<버전>/installation/bin`을 `VALLY_NODE_BIN`으로 orch 설정의 `env`에 넣는다.

### orch PC별 설정

orch를 돌리는 PC의 `~/.claude/orch/deploy.json`이다. 아래는 서버 PC에 ssh로 배포하는 예이고 `<...>`는 자리 표시 값이다. 항목의 뜻은 orch 저장소 `docs/deploy.md`에 있다.

```json
{"repos": {"vallythevally": {
  "hold": true,
  "source": "<orch PC의 저장소 폴더>",
  "branch": "main",
  "host": "<사용자>@<서버 PC 주소>",
  "cwd": "<서버 PC 홈>/apps/vallythevally",
  "env": {"VALLY_NODE_BIN": "<서버 PC 홈>/.local/share/fnm/node-versions/v<버전>/installation/bin"},
  "steps": [
    {"name": "server-build", "run": ["deploy/server-build"], "timeout": 5400},
    {"name": "web-build", "run": ["deploy/web-build"]},
    {"name": "backup", "run": ["deploy/backup"]},
    {"name": "collector-build", "run": ["deploy/collector-build"], "timeout": 5400},
    {"name": "collector-install", "run": ["deploy/collector-install"], "timeout": 120}
  ],
  "restart": ["deploy/restart"],
  "after": [
    {"name": "collector-restart", "run": ["deploy/collector-restart"], "timeout": 400},
    {"name": "status", "run": ["systemctl", "--user", "is-active", "vally-server.service"]},
    {"name": "logs", "run": ["journalctl", "--user", "-u", "vally-server.service", "-n", "200", "--no-pager"]}
  ],
  "check": {"url": "https://server.<tailnet>.ts.net/api/screener/status", "status": [200], "wait": 30},
  "timeout": 3600
}}}
```

- `collector-restart`의 `timeout`은 최악을 덮어야 한다. 다른 재시작을 기다리는 시간(확인 시간 + `VALLY_COLLECTOR_LOCK_SECONDS`)에 자기 승격(최대 `VALLY_COLLECTOR_LOCK_SECONDS`), `systemctl restart`(데몬 유닛의 `TimeoutStopSec` 120초까지), 확인 시간이 더해진다. 기본값(확인 10초, 잠금 120초)이면 최대 380초라 400으로 둔다. 확인 시간을 늘리면 `2 × 확인 시간 + 2 × 잠금 초 + 120`초보다 길게 올린다.
- 수집 데몬 단계는 앱 서버 단계와 같은 `steps`·`after`에 든다. `collector-build`·`collector-install`은 앱 서버 재시작 전에, `collector-restart`는 앱 서버 재시작 뒤 `after`에서 돈다. `after`의 단계가 실패하면 배포가 실패로 끝난다. 데몬이 재시작 뒤 바로 죽었을 때가 그렇다. 수집 시간 안이라 재시작을 예약한 경우는 성공이다.
- `collector-build`는 `server-build`와 같은 `target/`을 쓰지만 `collector`가 `server`를 기능을 줄여(`default-features = false`) 쓰므로 `server`의 일부를 다시 컴파일한다. 첫 배포는 오래 걸리니 `timeout`을 넉넉히 둔다.
- `host`가 없으면 같은 PC의 checkout에서 돈다. 이때 `cwd`는 그 PC의 경로이고 `VALLY_DATA_DIR`처럼 다른 PC와 다른 값은 모두 `env`에 둔다.
- `run`의 `deploy/...`는 `cwd` 기준이라 대상 SHA의 스크립트가 돈다.
- 서버 PC가 아닌 PC에서도 `env`와 `host`·`cwd`만 바꾸면 같은 스크립트를 쓴다. 서비스 이름과 확인 주소가 다르면 `VALLY_SERVICE`와 `VALLY_HEALTH_URL`을 `env`에 더한다.


### Tailscale SSH 위험

서버 PC는 Tailscale SSH가 켜져 있다. tailnet ACL의 SSH 규칙이 `check`이면 몇 시간마다 브라우저 재인증을 요구해, 사람이 없는 배포의 ssh가 멈춘다. 첫 배포 전에 확인한다.

```sh
ssh -o BatchMode=yes <서버 PC> true
```

바로 끝나면 된다. 인증을 요구하는 안내가 나오거나 실패하면 ACL의 해당 규칙 `action`을 `accept`로 바꿀지 사용자에게 묻는다. 직접 ACL을 바꾸지 않는다.

## 되돌리기

개발 PC 서버를 켜기 전에 서버 PC 서버를 반드시 먼저 끈다. 같은 키움 키로 두 서버가 동시에 붙으면 안 된다.

1. 서버 PC를 끈다.

   ```sh
   systemctl --user disable --now vally-server.service
   tailscale serve --https=443 off
   systemctl --user is-active vally-server.service
   ```

   `is-active`가 `inactive`인 것을 보고 다음으로 간다.

2. 서버 PC에서 생긴 자료(관심종목, 레이아웃, 주문 명령 기록)를 살리려면 서버 PC가 멈춘 뒤 개발 PC로 거꾸로 복사한다. 개발 PC의 기존 파일은 지우지 않고 `*.before-rollback`으로 이름을 바꿔 둔다. 살릴 필요가 없으면 이 단계를 건너뛰고 개발 PC의 정지 시점 자료를 그대로 쓴다.

   ```sh
   cd ~/vally-data/server
   for name in vally.db vally.db-wal vally.db-shm; do [ -e "$name" ] && mv "$name" "$name.before-rollback"; done
   rsync -a --ignore-missing-args <서버 PC>:vally-data/server/vally.db <서버 PC>:vally-data/server/vally.db-wal <서버 PC>:vally-data/server/vally.db-shm ~/vally-data/server/
   ```

   상태 파일도 같은 방식으로 되돌린다. 주문 사용 스위치(`kiwoom-orders.json`)와 토큰이 서버 PC에서 바뀌었을 수 있다.

   ```sh
   cd ~/.local/state/vallythevally
   for name in kiwoom-key.json kiwoom-keys.json kiwoom-orders.json token*.json kiwoom-ip*.json; do [ -e "$name" ] && mv "$name" "$name.before-rollback"; done
   rsync -a --ignore-missing-args <서버 PC>:.local/state/vallythevally/kiwoom-key.json <서버 PC>:.local/state/vallythevally/kiwoom-keys.json <서버 PC>:.local/state/vallythevally/kiwoom-orders.json '<서버 PC>:.local/state/vallythevally/token*.json' '<서버 PC>:.local/state/vallythevally/kiwoom-ip*.json' ~/.local/state/vallythevally/
   stat -c "%a %n" ~/.local/state/vallythevally/*.json
   ```

3. 서버 PC에서 더 새 버전이 돌며 DB를 옮겼다면 개발 PC의 옛 release 바이너리가 그 DB를 못 열 수 있다. 서버 PC에서 돌던 SHA를 확인하고 개발 PC 배포 checkout을 그 SHA로 맞춰 release 빌드를 다시 한다.

   ```sh
   ssh -o BatchMode=yes <서버 PC> 'git -C ~/apps/vallythevally rev-parse HEAD'
   cd ~/apps/vallythevally
   git fetch origin
   git checkout --detach <그 SHA>
   flock "$(git rev-parse --path-format=absolute --git-common-dir)/compile.lock" env CARGO_BUILD_JOBS=4 cargo build --locked --release -p server
   (cd web && pnpm install --frozen-lockfile && pnpm build)
   git checkout main
   ```

   마지막 `git checkout main`은 `orch deploy`가 지정 브랜치를 요구하기 때문이다. 빌드 산출물은 Git이 무시하므로 checkout이 깨끗하게 남는다. 이후 배포 전까지 checkout을 다시 pull하지 않는다.

4. 개발 PC 서버를 켠다.

   ```sh
   systemctl --user enable --now vally-server.service
   curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/api/screener/status
   ```

   `200`이어야 한다.

5. 배포를 되돌린다. `*.local`로 보관한 개발 PC 스크립트를 제자리로 돌리고, orch 저장소의 `deploy.json` 커밋을 되돌린다. 배포 checkout 경로가 같아 배포 장부는 그대로 쓴다.

   ```sh
   cd ~/.local/bin
   for name in server-build web-build backup restart; do mv vally-deploy-$name.local vally-deploy-$name; done
   python3 ~/.claude/skills/orch/orch.py deploy resume --repo vallythevally
   ```

   `resume`은 `deploy.json`을 되돌린 뒤에 한다.

## 모의 서버

개발 PC의 모의 서버(`127.0.0.1:8081`)는 그대로 둔다. 개발과 시험에 쓰고 모의 키라 실서버와 부딪히지 않는다. 띄우는 법은 [키움 모의투자 서버 띄우기](kiwoom-mock-trading.md)에 있다. `mock/` 데이터와 모의 설정은 서버 PC로 옮기지 않는다.
