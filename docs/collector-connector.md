# 수집 현황판 커넥터

[ADR 0026](adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md) "수집 현황판"의 커넥터(`vally-server`) 쪽이다. 감독 데몬의 unix socket 상태 API([계약](collector-status-api.md))를 읽어 `/api/collector/*`로 내준다. 수집기 코드는 가져다 쓰지 않는다([ADR 0025](adr/0025-collector-stores-closed-days-for-the-app.md)). 타입은 `crates/server/src/collector/wire.rs`에 계약대로 따로 만들었고, `web/src/api/generated/`의 `Collector*.ts`가 ts-rs로 내보낸 같은 타입이다. 응답 필드 이름은 데몬 계약과 같은 snake_case다.

## 설정

| 키 | 뜻 |
|---|---|
| `VALLY_COLLECTOR_SOCKET` | 감독 데몬의 unix socket 경로(`collector supervise --socket`과 같은 값) |
| `VALLY_COLLECTOR_ADMINS` | 수집 관리 계정 허용 목록. `provider:subject`를 쉼표로 나열한다. provider는 `google`이나 `naver`다. subject는 공급자가 정한 계정 번호이고 공백이 없다 |
| `VALLY_COLLECTOR_TELEGRAM` | 텔레그램 설정 파일 경로. 없으면 `~/.config/vally/telegram`. 파일이 없으면 텔레그램 보내기만 꺼진다(아래 "알림") |

형식이 틀린 항목이 있으면 서버가 시작하지 않는다. 허용 목록을 적었는데 소켓 경로가 없어도 시작하지 않는다.

## 꺼짐 조건

아래 중 하나면 현황판은 꺼진다. 라우트는 404이고 감시 태스크도 돌지 않는다. 이 판단은 서버를 켤 때 한 번 정하고, 로그인이 바뀌어도 다시 정하지 않는다.

- 허용 목록이 비었다.
- 계정 서버 없이 도는 로컬 전용 모드다(`VALLY_ACCOUNT_SERVER_URL`이 없다).

`GET /api/collector/access`는 꺼짐에서도 200으로 `{"access":"off"}`를 답한다.

## 인가

커넥터에 지금 로그인한 계정의 `provider:subject`가 허용 목록에 있을 때만 `/api/collector/*`가 응답한다. 판단은 요청을 받을 때와 알림을 보낼 때의 로그인으로 한다. 계정 서버는 관여하지 않는다.

- 허용 목록에 없는 계정과 로그인 없음: 403(`forbidden`).
- `access`: 켜져 있으면 `allowed`나 `denied`다. 웹은 `allowed`일 때만 메뉴를 보인다.

subject는 계정 서버의 `GET /v1/me` 응답의 `subject` 필드에서 온다. 커넥터는 로그인 때 이를 읽어 상태 파일(`account.json`)의 `subject`에 저장한다.

- 상태 파일에 `subject`가 없는 옛 로그인도 읽힌다. 서버가 켜져 있는 동안 커넥터는 subject가 없는 로그인을 보면 `me`를 다시 불러 채운다(시작할 때, 로그인이 바뀔 때, 계정 서버에 닿지 못했으면 30초마다).
- 계정 서버가 `subject`를 내주지 않으면(옛 계정 서버) 로그인 자체는 된다. 그 로그인에는 현황판 권한이 없다. `access`는 `denied`이고 라우트는 403이다. 계정 서버가 `subject`를 내주기 시작하면 다음 채움에서 권한이 생긴다.

## 데몬 감시

현황판이 켜져 있으면 커넥터는 소켓에 연결 하나를 유지하고 `watch` 요청을 보내 `status`와 `heartbeat`를 받는다. 로그인 여부와 관계없이 돈다. 누가 볼 수 있는지는 요청과 알림을 보낼 때 정한다.

| 커넥터가 본 것 | 판단(`judgment`) |
|---|---|
| 소켓이 없거나 연결이 거부됨 | `down`(꺼짐) |
| 연결 직후나 끊긴 직후, 아직 하트비트를 못 받음 | `checking`(확인 중) |
| 연결 뒤 하트비트가 3번 잇달아(15초) 오지 않음 | `unresponsive`(응답 없음) |
| 하트비트가 옴(`phase`가 `off_hours`여도) | `healthy`(정상) |
| 응답의 `v`가 1이 아님 | `version_mismatch`(형식 버전 불일치). 그 응답은 해석하지 않는다. 연결을 다시 맺기 전에는 풀리지 않는다 |

- 하트비트만 센다. `status`가 와도 하트비트를 대신하지 않는다.
- 끊기면 1, 2, 5, 10, 30초 간격으로 다시 붙고 끝 값을 되풀이한다. 하트비트를 받은 연결이 끊긴 뒤에는 1초부터 다시 센다.
- 한 줄은 1MiB까지다. 넘으면 연결을 끊고 다시 붙는다. 모르는 필드는 무시하고 읽을 수 없는 줄은 버린다.
- 커넥터는 읽기 요청(`status`, `coverage`, `disk`, `watch`)만 보낸다. `coverage`와 `disk`는 요청마다 짧은 연결을 따로 열어 물어서 감시 연결의 하트비트 셈을 막지 않는다.

## 알림

판단이 `down`이나 `unresponsive`로 바뀔 때 한 번 알린다. 정상 복귀와 `down` 안에서의 재시도는 알리지 않는다. 알림은 브라우저의 `/api/ws` 연결로 `{"type":"collector_daemon","judgment":"down","at":<unix 초>}`를 보낸다. 보낼 때 로그인한 계정이 허용 목록에 있어야 하고, 아니면 그 연결에는 보내지 않는다. 연결을 연 시점의 로그인은 보지 않는다.

같은 시점(`down`이나 `unresponsive`로 바뀔 때)에 텔레그램 봇으로도 보낸다. 텔레그램 설정 파일(기본 `~/.config/vally/telegram`, `VALLY_COLLECTOR_TELEGRAM`으로 바꾼다)이 있고 현황판이 켜져 있을 때만 보내며, 브라우저 알림과 달리 로그인한 계정과 상관없이 간다. 정상 복귀는 보내지 않는다. 파일이 없으면 텔레그램 보내기만 꺼진다. 권한이 600보다 넓거나 형식이 틀리면 서버가 시작하지 않는다. 보내기가 실패해도 판단과 현황판은 그대로이고 경고 로그만 남는다. 봇 토큰은 로그, 오류, 상태 API 어디에도 나오지 않는다. 자세한 규칙은 [`hoga-collector.md`](hoga-collector.md)의 "텔레그램 경보"를 따른다.

## 라우트

| 경로 | 응답 |
|---|---|
| `GET /api/collector/access` | `access` 필드가 `off`, `denied`, `allowed` 중 하나인 객체 |
| `GET /api/collector/status` | 감시 판단, 마지막으로 받은 `status`와 데몬이 적은 `sent_at`, 커넥터가 받은 시각 `received_at`(unix 초). 데몬이 꺼져 있어도 판단과 마지막 상태를 준다. 받은 것이 없으면 `status`는 `null`이다 |
| `GET /api/collector/coverage` | 데몬의 `coverage` 응답(`sent_at`, `days`) |
| `GET /api/collector/disk` | 데몬의 `disk` 응답(`sent_at`, `disk`) |

`coverage`와 `disk`는 데몬에 물어 옮긴다. 데몬이 꺼져 있거나 답이 없거나 형식 버전이 다르면 503(`collector_unavailable`)이다.
