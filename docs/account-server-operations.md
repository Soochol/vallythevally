# 계정 서버 운영

계정 서버(`vally-account`)와 계정 모드 커넥터를 실제로 띄우는 절차다. 구조와 결정은 [ADR 0023](adr/0023-connector-and-account-server.md), 용어는 [GLOSSARY](../GLOSSARY.md)를 본다. 호스팅과 도메인, IdP 앱 등록은 사람이 콘솔에서 하는 일이고, 아래는 그 사람이 따라 할 절차와 코드가 기대하는 설정이다.

비밀값(client secret, 커넥터 토큰, env 파일 내용)은 저장소, 이슈, PR, 댓글에 적지 않는다. 이 문서의 `<…>`는 자리 표시다.

## 빌드

```sh
flock "$(git rev-parse --path-format=absolute --git-common-dir)/compile.lock" env CARGO_BUILD_JOBS=4 cargo build --locked --release -p account-server
```

결과는 `target/release/vally-account`다. 가짜 IdP(`vally-fake-idp`)는 `fake-idp` 기능 뒤에 있어 이 명령에 들어가지 않는다. 빌드 규칙은 [개발 빌드](development-builds.md#배포용-빌드)를 따른다. 계정 서버는 키움 코드와 DuckDB에 의존하지 않는다.

## 설정

계정 서버는 환경변수 `VALLY_ACCOUNT_*`와 선택적 env 파일에서 설정을 읽는다. 프로세스 환경변수가 env 파일 값을 덮는다. 필수 값이 없거나 형식이 틀리면 시작하지 못하고 이유를 stderr에 낸다.

| 이름 | 필수 | 기본값 | 뜻 |
|---|---|---|---|
| `VALLY_ACCOUNT_PUBLIC_URL` | 예 | 없음 | 사용자가 보는 출처. `https://<도메인>` 형식이고 경로·질의 없이 출처만 적는다. 루프백 IP의 `http`도 허용한다. callback 주소가 여기서 만들어진다 |
| `VALLY_ACCOUNT_BIND` | 아니오 | `127.0.0.1:8090` | 묶을 주소 |
| `VALLY_ACCOUNT_DB_PATH` | 아니오 | `data/account.db` | SQLite 파일. 상위 폴더가 없으면 만든다. 상대 경로는 작업 폴더 기준이다 |
| `VALLY_ACCOUNT_GOOGLE_CLIENT_ID` | 예 | 없음 | Google OAuth 클라이언트 ID |
| `VALLY_ACCOUNT_GOOGLE_CLIENT_SECRET` | 예 | 없음 | Google OAuth 클라이언트 secret |
| `VALLY_ACCOUNT_NAVER_CLIENT_ID` | 예 | 없음 | 네이버 애플리케이션 Client ID |
| `VALLY_ACCOUNT_NAVER_CLIENT_SECRET` | 예 | 없음 | 네이버 애플리케이션 Client Secret |
| `VALLY_ACCOUNT_PENDING_LOGIN_LIMIT` | 아니오 | `10000` | 만료되지 않은 대기 로그인 수의 한도 |
| `VALLY_ACCOUNT_GOOGLE_AUTHORIZE_URL` | 아니오 | `https://accounts.google.com/o/oauth2/v2/auth` | IdP 주소 바꾸기(시험용) |
| `VALLY_ACCOUNT_GOOGLE_TOKEN_URL` | 아니오 | `https://oauth2.googleapis.com/token` | 같음 |
| `VALLY_ACCOUNT_NAVER_AUTHORIZE_URL` | 아니오 | `https://nid.naver.com/oauth2.0/authorize` | 같음 |
| `VALLY_ACCOUNT_NAVER_TOKEN_URL` | 아니오 | `https://nid.naver.com/oauth2.0/token` | 같음 |
| `VALLY_ACCOUNT_NAVER_PROFILE_URL` | 아니오 | `https://openapi.naver.com/v1/nid/me` | 같음 |
| `VALLY_ACCOUNT_ENV_FILE` | 아니오 | 없음 | 위 값을 `이름=값` 줄로 적은 파일 경로 |
| `VALLY_ACCOUNT_LOG` | 아니오 | `info` | 로그 수준(`tracing` 필터 형식) |

- 빈 값은 없는 것으로 본다. IdP 주소 5개는 운영에서 건드리지 않는다. https이거나 루프백 IP의 http만 받고, 시험이 가짜 IdP를 가리킬 때 쓴다.
- env 파일은 한 줄에 `이름=값`이고, `#`로 시작하는 줄과 빈 줄은 무시하며, 값은 큰따옴표나 작은따옴표로 감쌀 수 있다. 파일 권한이 다른 사용자에게 열려 있으면(`group`·`other` 비트가 하나라도 있으면) 시작하지 않는다. `chmod 600 <env 파일>`로 만든다.
- 처음 만들 때: `install -m 600 /dev/null /etc/vally-account.env`를 한 뒤 편집기로 채운다. secret을 셸 기록이나 명령 인자에 남기지 않는다.

```
VALLY_ACCOUNT_PUBLIC_URL=https://<도메인>
VALLY_ACCOUNT_DB_PATH=/var/lib/vally-account/account.db
VALLY_ACCOUNT_GOOGLE_CLIENT_ID=<Google client id>
VALLY_ACCOUNT_GOOGLE_CLIENT_SECRET=<Google client secret>
VALLY_ACCOUNT_NAVER_CLIENT_ID=<Naver client id>
VALLY_ACCOUNT_NAVER_CLIENT_SECRET=<Naver client secret>
```

공개 주소가 `https`이면 로그인 흐름 쿠키 이름은 `__Host-vally_login_<idp state>`이고 `Secure`가 붙는다. 루프백 `http`이면 `vally_login_<idp state>`이고 `Secure`가 없다.

## 앞단: TLS 리버스 프록시

계정 서버는 TLS를 끝내지 않는다. 기본 묶음 주소 `127.0.0.1:8090`을 그대로 두고, 앞에 TLS 리버스 프록시를 둔다. 계정 서버 포트를 외부에 직접 열지 않는다. Caddy를 권장한다. 인증서를 자동으로 받고 갱신한다.

```
<도메인> {
    reverse_proxy 127.0.0.1:8090
}
```

IP별 요청 제한은 계정 서버가 아니라 프록시가 맡는다. 계정 서버는 프록시 뒤에서 클라이언트 IP를 알 수 없기 때문이다. 권장은 `/v1/auth/*/start`를 IP당 분당 10회 안팎으로 제한하는 것이다. Caddy 기본 배포에는 속도 제한이 들어 있지 않아 [`caddy-ratelimit`](https://github.com/mholt/caddy-ratelimit) 같은 플러그인을 넣은 빌드가 필요하다. 플러그인 문법은 버전에 따라 다르니 쓰는 버전의 문서로 확인한다. 예:

```
<도메인> {
    @start path /v1/auth/*/start
    rate_limit @start {
        zone start_per_ip {
            key    {remote_host}
            events 10
            window 1m
        }
    }
    reverse_proxy 127.0.0.1:8090
}
```

nginx를 쓰면 `limit_req_zone $binary_remote_addr zone=start:10m rate=10r/m;`와 `location ~ ^/v1/auth/[^/]+/start$ { limit_req zone=start burst=5 nodelay; proxy_pass http://127.0.0.1:8090; }`가 같은 일을 한다.

### 계정 서버 안의 대기 로그인 한도

인증 없는 `start`는 호출마다 대기 로그인 한 건을 DB에 더한다. 만료되지 않은 대기 로그인(10분 동안 유효) 수가 `VALLY_ACCOUNT_PENDING_LOGIN_LIMIT`(기본 10,000)에 닿으면 새 행을 더하지 않고 IdP로 보내지 않고 `503`과 `Retry-After: 60`, HTML 안내("로그인 요청이 많아 잠시 받지 않습니다")를 낸다. 한도는 동시 요청에서도 넘지 않는다. 한도가 채워진 동안 정상 사용자도 최대 10분 안에 다시 시도해야 하므로, 한도에 자주 닿으면 프록시의 IP별 제한을 먼저 의심한다. 이 한도는 DB가 끝없이 자라는 것을 막는 상한이고 남용을 막는 수단이 아니다.

## IdP 앱 등록

IdP 콘솔 화면은 바뀌므로 아래 항목명은 실제 콘솔에서 확인한다.

**Google Cloud**: 프로젝트에서 OAuth 클라이언트 ID를 "웹 애플리케이션" 유형으로 만든다. 승인된 리디렉션 URI에 `https://<도메인>/v1/auth/google/callback`을 등록한다. 받는 범위는 `openid`뿐이다. 이메일과 프로필은 요청하지 않는다. 계정 서버는 id_token의 `sub`만 쓴다. 로그인 때 `prompt=select_account`로 계정 고르기 화면이 보인다. 본인 외 사용자가 로그인하려면 OAuth 동의 화면의 게시 상태나 검수가 필요할 수 있다. 실제 콘솔에서 확인한다.

**네이버 개발자센터**: 애플리케이션을 만들고 "네이버 로그인" API를 쓴다. 서비스 URL과 Callback URL에 `https://<도메인>/v1/auth/naver/callback`을 등록한다. 받는 정보는 회원 고유 번호(프로필 API 응답의 `response.id`)뿐이다. 이름, 이메일 등 다른 제공 정보는 필수로 받지 않게 둔다. 본인 외 사용자가 로그인하려면 검수나 멤버 등록이 필요할 수 있다. 실제 콘솔에서 확인한다.

발급된 Client ID와 secret은 env 파일에만 둔다.

## 서비스로 띄우기

systemd 단위 예(`/etc/systemd/system/vally-account.service`):

```ini
[Unit]
Description=vally account server
After=network-online.target
Wants=network-online.target

[Service]
User=vally-account
WorkingDirectory=/var/lib/vally-account
Environment=VALLY_ACCOUNT_ENV_FILE=/etc/vally-account.env
ExecStart=/opt/vally-account/vally-account
Restart=on-failure
KillSignal=SIGINT
RestartSec=5
StateDirectory=vally-account

[Install]
WantedBy=multi-user.target
```

env 파일은 서비스 사용자가 소유하고 권한 600이어야 한다(`chown vally-account /etc/vally-account.env`). `StateDirectory`가 `/var/lib/vally-account`를 만들어 주므로 `VALLY_ACCOUNT_DB_PATH`를 그 아래로 둔다. 계정 서버는 SIGINT(Ctrl+C)에만 진행 중인 요청을 마치고 멈춘다. systemd의 기본 종료 신호는 SIGTERM이라 `systemctl stop`은 프로세스를 바로 끝낸다. 요청은 짧고 저장은 SQLite 트랜잭션이라 데이터는 유지되지만, 위 단위는 `KillSignal=SIGINT`로 이를 피한다. 시작하면 로그에 `계정 서버 시작`과 묶은 주소가 나온다.

```sh
systemctl daemon-reload && systemctl enable --now vally-account
journalctl -u vally-account -f
```

## 백업과 복원

DB는 SQLite WAL 모드다. 파일을 그냥 복사하면 `-wal` 파일의 내용이 빠질 수 있으니 SQLite의 백업 기능을 쓴다. 서비스를 멈추지 않아도 된다.

```sh
install -d -m 700 /var/backups/vally-account
sqlite3 /var/lib/vally-account/account.db ".backup '/var/backups/vally-account/account-$(date +%F).db'"
```

이것을 cron이나 systemd timer로 매일 돌리고 오래된 백업은 정리한다. 백업 파일에는 계정 identity와 셋업 문서가 들어 있으므로 DB와 같은 수준으로 보호한다(커넥터 토큰은 SHA-256 해시만 저장되어 있다).

복원:

```sh
systemctl stop vally-account
cp /var/backups/vally-account/account-<날짜>.db /var/lib/vally-account/account.db
rm -f /var/lib/vally-account/account.db-wal /var/lib/vally-account/account.db-shm
chown vally-account /var/lib/vally-account/account.db
systemctl start vally-account
```

복원 뒤 사용자는 백업 이후의 셋업 변경을 잃는다. 커넥터는 로컬 사본을 가지고 있으므로 다시 동기화할 수 있다.

## 커넥터

커넥터(`vally-server`)는 다음 값으로 계정 모드가 된다.

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `VALLY_ACCOUNT_SERVER_URL` | 없음 | 계정 서버 출처(`https://<도메인>`, 경로 없음. 루프백 IP의 http도 허용). 비어 있거나 없으면 **로컬 전용 모드**로 로그인 화면 없이 돈다 |
| `VALLY_ACCOUNT_STATE_PATH` | `$XDG_STATE_HOME/vallythevally/account.json` | 커넥터 토큰을 두는 상태 파일. 폴더 700, 파일 600으로 만든다. `XDG_STATE_HOME`이 없으면 `$HOME/.local/state` 아래다 |

이 이름들은 커넥터 설정이다. 계정 서버의 `VALLY_ACCOUNT_*`와 접두어가 같으므로 한 env 파일에 섞어 쓰지 않는다. 커넥터는 `VALLY_ENV_FILE`로 자기 설정 파일을 읽는다. 주소가 있으면 로그인해야 화면을 쓸 수 있다.

## 출시 전 확인

1. 가짜 IdP로 전 과정을 확인한다. [`verify-vally` 스킬](../.claude/skills/verify-vally/SKILL.md)의 "Account mode"가 정한 명령이다. 커넥터, 계정 서버, 가짜 IdP, 키움 대역이 모두 실제 프로세스로 뜨고 실제 Google·네이버·키움은 호출하지 않는다.

```sh
python3 scripts/dev.py cargo build -p account-server --all-targets
python3 .claude/skills/verify-vally/scripts/vv.py up --account
python3 .claude/skills/verify-vally/scripts/vv.py doctor <run-dir>
node .claude/skills/verify-vally/scripts/drive.mjs <base_url> <run-dir>/evidence account-login
python3 .claude/skills/verify-vally/scripts/vv.py down <run-dir>
```

2. 배포한 계정 서버로 실제 Google 로그인을 한 번, 네이버 로그인을 한 번 직접 한다. 커넥터를 `VALLY_ACCOUNT_SERVER_URL=https://<도메인>`으로 띄우고 랜딩에서 로그인 단추를 눌러 `/auth/complete`를 거쳐 로그인 상태가 되는지 본다. 가짜 IdP 확인은 실제 IdP의 앱 등록, callback 주소, 범위를 확인하지 못하므로 이 단계를 대신할 수 없다.
3. 로그인한 계정으로 로그아웃해 상태 파일이 지워지는지 확인한다.

## 받아들인 한계

루프백 로그인 흐름에서 같은 PC의 악성 프로그램이 자기 포트로 일회용 코드를 받을 수 있다는 한계는 막지 않는다. 이유는 [ADR 0023](adr/0023-connector-and-account-server.md)의 로그인 절에 있다.
