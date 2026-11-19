# 실서버를 서버 PC로 옮기고 Tailscale 망에서 접속하기

작성일: 2026-11-19. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 풀려는 문제

실서버(`vally-server`, 키움 실계좌, 포트 8080)는 지금 개발 PC의 systemd 사용자 서비스로 돈다. 사용자는 이 서버를 Tailscale 망에 있는 별도 PC("서버 PC")로 옮기고, 같은 Tailscale 망의 기기(개발 PC, 폰)에서 브라우저로 쓰려 한다. 공개 인터넷에서의 접속(로그인 운영이 필요한 방식)은 이번 범위가 아니다.

지금 서버는 루프백만 받는다. `crates/server/src/config.rs`의 `BindAddr`는 127.0.0.0/8과 `::1`만 허용하고, `crates/server/src/write_guard.rs`의 `check_host`는 Host가 `127.0.0.1:<포트>`, `localhost:<포트>`, `[::1]:<포트>`, 연 주소가 아니면 거절한다. 같은 검사가 `/api/system/*`, `/api/system/orders*`, `/api/trading/*`, `/api/account/*`, `/api/setup/*`의 쓰기와 계좌번호 조회(`GET /api/trading/account-number`, #688), 로그인 완료(`GET /auth/complete`)를 막는다. DNS rebinding을 막는 장치다. 그래서 다른 기기의 브라우저는 서버에 닿을 수 없고, 닿더라도 쓰기는 모두 거절된다.

### 조사에서 나온 사실 (2026-11-19 확인)

- 두 PC의 공인 IP가 같다(같은 회선). 키움 포털의 IP 등록은 바꾸지 않아도 된다.
- 이 tailnet은 HTTPS 인증서 기능이 켜져 있다(`tailscale status`의 `CertDomains`에 개발 PC 이름이 있다). 서버 PC의 Tailscale은 1.104.7이고 serve 설정이 없으며 operator가 지정되지 않았다. 서버 PC의 `sudo`는 암호를 묻는다.
- 개발 PC에서 서버 PC로 키 기반 `ssh -o BatchMode=yes`가 된다. 서버 PC는 Tailscale SSH가 켜져 있다.
- 서버 PC의 Node·pnpm은 fnm으로 깔려 있어 비대화형 ssh의 PATH에 없다(`bash -lc`에서만 보인다). cargo·chute는 `~/.cargo/bin`에 있다.
- 실서버 데이터는 77GB다. `financials.db`가 거의 전부이고 `screener.duckdb` 269MB, `vally.db` 약 4MB(WAL 포함)다. 서버 PC의 남은 디스크는 294GB다.
- 비밀값과 상태는 `~/.config/vally/server.env`만이 아니다. 실전 키는 `~/.local/state/vallythevally/kiwoom-key.json`에 있고, 같은 폴더에 주문 사용 스위치 `kiwoom-orders.json`과 `token.json`이 있다. `server.env`에는 실전 키가 없다.
- 웹 화면은 `crypto.randomUUID()`를 주문 명령 ID(`web/src/features/order/commandLedger.ts`), 관심종목, 레이아웃, 그리기 등 15곳 넘게 쓴다. 이 함수와 `navigator.clipboard`는 보안 문맥(https, localhost)에서만 있다. `http://100.x.x.x:8080`으로 연 페이지는 보안 문맥이 아니라서 이 함수들이 없다. 주문, 관심종목 추가, 레이아웃 저장이 예외로 멈춘다.
- 화면의 WebSocket 주소는 페이지가 https면 `wss`를 쓴다(`web/src/api/socket.ts`).
- 주문 쓰기는 `X-Vally-Order: 1` 헤더를 요구해 브라우저가 항상 preflight를 보낸다. 서버에는 CORS 응답 헤더가 없다. 그래서 남의 웹 페이지가 주문을 보낼 수 없다.

## 구성도

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
 공인 IP·LAN 주소로 오는 접속: 8080은 루프백에만 열려 있어 닿지 않는다. 443은 Tailscale 인터페이스에만 열린다.
```

## 확정된 결정

- 접속 범위는 내 Tailscale 망의 기기다(사용자가 B로 확정). 공개 인터넷 접속은 범위 밖이다.
- 실서버만 서버 PC로 옮긴다. 개발 PC의 실서버 서비스는 끄고 지우지 않는다(되돌리기 대비).
- 같은 키움 키로 두 서버가 동시에 붙지 않는다. 개발 PC 서버를 멈춘 뒤에 서버 PC 서버를 켠다.
- `server.env`와 상태 파일은 내용을 출력하지 않고 파일째 복사한다. 커밋하지 않는다.
- 보안 결정은 ADR로 남긴다. 시험은 합성 transport만 쓰고 실제 키움을 부르지 않는다.

## 스스로 정한 결정

- **원격 접속은 `tailscale serve`가 받는다(추천, 아래 "사용자가 정해야 하는 결정" 1).** 서버는 지금처럼 루프백만 받고, 서버 PC의 `tailscale serve`가 tailnet에서 HTTPS(Let's Encrypt 인증서)로 받아 `http://127.0.0.1:8080`으로 넘긴다. 이유는 셋이다. 페이지가 https라 보안 문맥이 되어 `crypto.randomUUID`·클립보드가 그대로 돈다. 서버의 바인드 규칙(루프백만)이 바뀌지 않아 공인·LAN 주소가 구조적으로 막힌 채 남는다. 서버 코드 변경이 Host·Origin 허용 목록 하나로 줄어든다. 서버 주소에 100.x를 직접 바인드하는 원안은 화면 전체의 UUID 대체 작업이 따로 필요하다.
- **허용하는 이름은 설정한 정확한 이름만이다.** 새 설정 `VALLY_TAILNET_HOSTS`(쉼표로 구분)에 `server.<tailnet>.ts.net` 같은 MagicDNS 전체 이름을 적는다. `.ts.net`으로 끝나지 않는 이름, 포트가 붙은 값, 와일드카드, IP는 설정 오류로 시작하지 않는다. `*.ts.net` 전체를 받지 않는 이유는 남의 tailnet 이름도 `.ts.net`이기 때문이다. 이름을 비우면 지금과 같다(루프백 Host만).
- **Origin은 Host와 짝을 맞춘다.** Host가 설정한 이름이면 Origin은 없거나 정확히 `https://<그 이름>`이어야 한다. Host가 루프백이면 지금처럼 `http://<Host>`다. `tailscale serve`가 Host를 원래 이름 그대로 넘기는지는 운영 단계에서 확인한다(아래 O5). 다르게 넘기면 그 사실을 보고하고 규칙을 고친다.
- **가드 밖의 쓰기 라우트는 이번에 넓히지 않는다.** `PUT`/`DELETE` 라우트(관심종목, 스크린, 레이아웃, 화면 상태, 그리기)는 preflight가 필요해 남의 페이지가 보낼 수 없다. 남는 것은 가드 없는 `POST` 네 개(`/api/screener/update`, `/api/screener/update/cancel`, `/api/screener/run`, `/api/rankings`)다. 이 위험은 지금 `127.0.0.1:8080`에서도 같아 tailnet 공개가 넓히지 않는다. 그래서 따로 둔다(범위 밖).
- **배포는 orch.py를 고치지 않고 스크립트가 ssh로 원격에서 돈다.** `orch deploy`는 개발 PC의 배포 checkout(`/home/dev/apps/vallythevally`)을 pull해 대상 SHA를 고정하는 일을 그대로 한다. 개발 PC의 `~/.local/bin/vally-deploy-*`는 그 checkout의 HEAD를 읽어 서버 PC의 같은 이름 스크립트를 ssh로 부르는 얇은 래퍼가 된다. 서버 PC 스크립트는 지금 스크립트와 같은 `$HOME` 기준 경로를 쓰고, 빌드 전에 원격 checkout을 그 SHA로 맞추고 다르면 멈춘다. `deploy.json`은 `status`, `logs`, `http_url` 세 값만 바뀐다(아래 "orch 저장소 범위").
- **데이터는 미리 복사하고 정지 뒤에 차이만 보낸다.** 77GB라 정지 중에 통째로 보내면 오래 멈춘다. 서버가 도는 동안 `rsync`로 미리 보내고, 정지 뒤 같은 `rsync`를 다시 돌려 바뀐 부분만 맞춘다. 정지 상태의 SQLite(`vally.db`와 `-wal`, `-shm`)와 DuckDB 파일은 파일 복사로 일관된다.
- **운영 문서는 저장소에 남긴다.** 이전·배포·되돌리기 절차를 `docs/server-operations.md`로 쓴다. tailnet 이름, Tailscale IP, 공인 IP는 저장소에 적지 않고 `<tailnet>`, `<서버 PC>` 같은 자리표시로 쓴다(공개 저장소).

## 작업

| ID | 내용 | 방식 | 이유 | 순서 |
|---|---|---|---|---|
| `tailnet-host` | `VALLY_TAILNET_HOSTS` 설정, Host·Origin 검사가 설정한 이름을 받음, ADR 0036 | `poteto` | 보안(쓰기 보호와 DNS rebinding 방어의 규칙을 바꾼다) | 먼저. tr-optimize 플랜의 `tr-usage-panel`과는 병렬이다. 그 작업은 `system_routes.rs`에 경로 하나와 `tests/system_api.rs`에 시험을 더하고, 이 작업도 두 파일에 필드·함수·시험만 더하므로 두 파일을 `shared`로 두고 최소 변경으로 한다 |
| `server-ops-doc` | `docs/server-operations.md`: 서버 PC 준비, 이전, 원격 배포 스크립트, 확인, 되돌리기 | `basic` | 문서만 | `tailnet-host` 뒤. 문서가 그 작업이 정한 설정 이름과 규칙을 적는다 |

두 작업이 병합된 뒤 아래 운영 단계를 오케스트레이터가 사용자와 함께 진행한다. 운영 단계는 `tasks.json`의 작업이 아니다.

## 운영 단계 (병합 뒤, ★는 사용자 승인 필요)

| 단계 | 누가 | 내용 | 운영 영향 |
|---|---|---|---|
| O1 | 사용자 | 서버 PC에서 한 번 `sudo tailscale set --operator=server`. 이후 `tailscale serve`를 sudo 없이 쓴다 | 없음 |
| O2 | 오케스트레이터 | 서버 PC에 배포 checkout `~/apps/vallythevally`(main) clone, release 빌드, web 빌드, 서버 PC용 `~/.local/bin/vally-deploy-*` 설치, systemd 사용자 서비스 파일 설치(`VALLY_TAILNET_HOSTS` 포함, enable·start 하지 않음) | 없음 |
| O3 | 오케스트레이터 | 데이터 미리 복사: 개발 PC 서버가 도는 동안 `~/vally-data/server/`를 `rsync`로 서버 PC에 보냄 | 없음(읽기만) |
| O4 ★ | 오케스트레이터 | 전환. 장이 끝난 뒤(평일 20시 이후나 주말): `orch deploy hold` → 개발 PC 서비스 `stop`·`disable` → `vally-deploy-backup` → 최종 `rsync`(DB 파일과 `-wal`·`-shm`) → `server.env`와 `kiwoom-key.json`·`kiwoom-orders.json`·`token.json`을 `scp`(내용 출력 없음, 권한 600 유지) → 서버 PC 서비스 `enable --now` → `tailscale serve --bg --https=443 http://127.0.0.1:8080` | 실서버가 수 분 멈춘다 |
| O5 | 오케스트레이터 | 확인: 서버 PC 서비스 active, 키움 연결됨(`/api/system/kiwoom`), 주문 사용 상태가 전환 전과 같음(`/api/system/orders`), 개발 PC 브라우저와 폰에서 `https://server.<tailnet>.ts.net` 열림, 계좌번호 조회가 Host로 거절되지 않음, 공인·LAN·100.x 주소의 8080은 연결 거부. 주문은 넣지 않는다 | 없음 |
| O6 ★ | 오케스트레이터 | 배포를 원격으로: 개발 PC `~/.local/bin/vally-deploy-*`를 래퍼로 바꾸고(기존 것은 `*.local`로 보관), orch 저장소 `deploy.json`을 고쳐 커밋, `orch deploy resume`, 첫 `orch deploy run` | 서버 PC 서버 재시작 |
| O7 | 오케스트레이터 | 메모리의 실서버 배포 항목을 새 구성으로 고침 | 없음 |

### orch 저장소 범위 (이 플랜의 PR이 아님)

`/home/dev/.claude/skills/orch`는 별도 저장소다. O6에서 오케스트레이터가 고친다.

- `deploy.json`의 `vallythevally`: `status`와 `logs`를 `ssh -o BatchMode=yes <서버 PC> systemctl --user is-active vally-server.service`, `... journalctl --user -u vally-server.service -n 200 --no-pager`로, `http_url`을 `https://server.<tailnet>.ts.net/api/screener/status`로 바꾼다. `cwd`, `source`, `branch`, 다른 명령 경로는 그대로다.
- `docs/deploy.md`의 "운영 명령 제안과 미확인 값" 표에서 재시작 호스트를 "서버 PC, 스크립트가 ssh로 실행"으로 적는다.
- `orch.py`는 고치지 않는다.

## 되돌리기

1. 서버 PC: `systemctl --user disable --now vally-server.service`, `tailscale serve --https=443 off`. 개발 PC 서버를 켜기 전에 반드시 먼저 끈다(같은 키 동시 연결 금지).
2. 서버 PC에서 생긴 자료(관심종목, 레이아웃, 주문 명령 기록)를 살리려면 서버 PC가 멈춘 뒤 DB 파일과 상태 파일을 개발 PC로 거꾸로 복사한다. 개발 PC의 기존 파일은 지우지 않고 `*.before-rollback`으로 이름을 바꿔 둔다. 살릴 필요가 없으면 개발 PC의 정지 시점 자료를 그대로 쓴다.
3. 서버 PC에서 더 새 버전이 돌며 DB를 옮겼다면 개발 PC의 옛 release 바이너리가 그 DB를 못 열 수 있다. 그때는 개발 PC 배포 checkout을 서버 PC에서 돌던 SHA로 맞춰 release 빌드를 다시 한다.
4. 개발 PC: `systemctl --user enable --now vally-server.service`, `http://127.0.0.1:8080/api/screener/status` 200 확인.
5. 배포: `*.local`로 보관한 개발 PC 스크립트를 제자리로 돌리고 orch 저장소의 `deploy.json` 커밋을 되돌린다. 배포 checkout 경로가 같아 배포 장부는 그대로 쓴다.

## 범위 밖

- 공개 인터넷 접속(Tailscale Funnel, 공인 포트 열기, 로그인 운영).
- 서버가 100.x나 다른 주소에 직접 바인드하는 것.
- 가드 밖의 `POST` 네 개(`/api/screener/update`, `/api/screener/update/cancel`, `/api/screener/run`, `/api/rankings`)에 쓰기 가드를 거는 것.
- 원격 브라우저에서의 계정 로그인. 로그인 완료 주소가 `http://127.0.0.1:<포트>`로 고정이라 다른 기기에서는 끝나지 않는다. 계정 서버 운영이 보류라 지금은 로컬 전용 모드다.
- 시스템 설정 화면에 허용 이름을 보여 주는 것.
- Tailscale 사용자 신원 헤더(`Tailscale-User-Login`)로 사람을 가리는 것.
- 수집 데몬과 그 상태 폴더(`~/.local/state/vallythevally/collector`)의 이전. 개발 PC에 서비스로 돌고 있지 않다.

## 사용자가 정해야 하는 결정

1. **접속 방법** (추천: 가)
   - 가. `tailscale serve`(추천): 주소는 `https://server.<tailnet>.ts.net`. 서버는 루프백만 받고 코드 변경이 작다. 화면 기능이 모두 돈다. 서버 PC에서 sudo 한 번(O1)이 필요하다. 인증서를 받으면 기기 이름과 tailnet 이름이 공개 인증서 기록(CT 로그)에 남는다.
   - 나. 서버가 100.x 주소에 직접 바인드(원안): 주소는 `http://100.x.x.x:8080`. 보안 문맥이 아니어서 주문·관심종목·레이아웃 저장이 멈춘다. 고르면 화면의 `crypto.randomUUID`를 대체하는 작업(웹 15곳 넘게, e2e 포함)과 바인드 설정을 여러 주소로 넓히는 작업이 플랜에 더해지고, 클립보드 복사는 원격에서 안 된다.
2. **모의 서버(8081)** (추천: 개발 PC에 남김): 개발과 시험에 쓰고 모의 키라 실서버와 부딪히지 않는다. 옮기려면 같은 절차를 한 번 더 한다.
3. **전환 시각**(O4): 장이 끝난 뒤(평일 20시 이후)나 주말 중 언제 할지. 실서버가 수 분 멈춘다.
4. **O4·O6 승인**: 실서버를 멈추고 옮기는 단계와 배포를 원격으로 바꾸는 단계는 사용자가 승인한 뒤에 한다.

확인이 필요한 위험 하나: 서버 PC는 Tailscale SSH가 켜져 있다. tailnet ACL의 SSH 규칙이 `check`면 몇 시간마다 브라우저 재인증을 요구해 무인 배포의 ssh가 멈춘다. O6 전에 오케스트레이터가 `ssh -o BatchMode=yes`로 확인하고, 막히면 사용자에게 ACL을 `accept`로 바꿀지 묻는다.

검증을 약하게 하는 변경은 없다.
