# 호가 복기 수집기

`crates/collector`의 실행 파일 `collector`는 하위 명령 다섯(`collect`, `build`, `verify`, `serve`, `finalize`)을 가진다. 계획은 [`plans/hoga-replay-prototype.md`](plans/hoga-replay-prototype.md), 구간 파일 형식은 [`hoga-format.md`](hoga-format.md)에 있다. 이 문서는 절마다 채우는 작업이 다르다.

상시 운영(감독 데몬을 systemd 사용자 서비스로 돌리는 것)은 [운영](#운영) 절을 따른다. "실제 수집 절차"는 프로토타입(`collect --items`) 절차로 남긴다.

## 데이터 폴더

`--data <폴더>`로 받고 기본은 `data/hoga`다. 모든 하위 명령이 같은 인수를 쓴다.

```
data/hoga/
  raw/<YYYYMMDD>/<HHMM>-<NNN>.jsonl.zst          원문 파일
  spans/<YYYYMMDD>/index.json                     그날의 구간 파일 목록
  spans/<YYYYMMDD>/<종목>/<HHMM>-r<N>.hoga.br     구간 파일
  spans/<YYYYMMDD>/verified.json                  대조 결과
  store/<YYYYMMDD>.tmp/<타입>/<버킷>.parquet       finalize가 쓰는 중인 수집 저장소
  store/<YYYYMMDD>.tmp/verify.json                finalize의 원문 대조 결과
  store/<YYYYMMDD>/complete.json                  정리 완료 표시. 앱은 이 파일이 있는 날만 읽는다
  store/prune.log.jsonl                           원문 지우기 기록
  plan/<YYYYMMDD>.json                            그날의 수집 계획
```

날짜와 `HHMM`은 수신 시각의 KST 날짜와 5분 구간 시작이다. `<종목>`은 등록한 글자 그대로다(`005930_AL`).

명령줄 인수는 `collector::args`가 읽는다. `--이름 값`과 값 없는 `--이름`만 있고, 모르는 인수·빠진 값·두 번 적은 인수는 오류다. 하위 명령마다 `ArgSpec`으로 자기 인수를 적는다. `--data`는 언제나 받는다.

## 원문 파일

장중에 받은 키움 WS 프레임을 해석하지 않고 쓴 파일이다. `collector::raw_write`가 쓰고 `collector::raw_read`가 읽는다.

- zstd level 3 스트림 하나다. 풀면 UTF-8 줄들이고 줄마다 JSON 객체 하나다. `zstdcat`으로 바로 읽힌다.
- 줄의 종류는 셋이다.

| 종류 | 모양 | 쓰는 함수 |
|---|---|---|
| 프레임 | `{"recv_ms":<유닉스 ms>,"msg":<받은 글자 그대로>}` | `RawLine::Frame` |
| 사건 | `{"recv_ms":…,"event":"live"}`, `{"recv_ms":…,"event":"down","reason":"…"}` | `RawLine::Live`, `RawLine::Down` |
| JSON이 아닌 글자 | `{"recv_ms":…,"text":"<JSON 문자열로 감싼 글자>"}` | `RawLine::Text` |

- 프레임의 글자는 `{"recv_ms":…,"msg":`와 `}` 사이에 그대로 들어간다. 줄바꿈 바이트(`\n`, `\r`)만 지운다. 글자가 JSON인지는 부르는 쪽이 `Frame`과 `Text`로 알려 준다. 읽을 때 `msg` 앞뒤 공백은 사라진다.
- PING 프레임은 쓰지 않는다. LOGIN·REG 응답은 쓴다. 보낸 LOGIN은 쓰지 않는다.
- 줄의 `recv_ms`가 날짜 폴더와 5분 구간 파일을 고른다. 구간이 바뀌면 앞 파일을 마무리하고 새 파일을 연다.
- `<NNN>`은 000부터다. 구간 파일을 새로 열 때마다 아직 없는 가장 작은 번호를 쓰고, 있는 파일에 이어 쓰지 않는다.
- `RawWriter::flush`를 부르면 그때까지 쓴 줄이 풀리는 상태가 된다. `close`가 스트림을 마무리한다. 부르는 쪽이 1초에 한 번 이상 flush한다.
- 시계가 5분 구간 경계를 넘어 뒤로 가면 앞 구간을 다시 열어 다음 번호 파일에 쓴다. 읽기는 파일 이름 순이라 이 줄들은 쓴 순서가 아니라 파일 순서로 나온다. 줄마다 `recv_ms`가 있어 읽는 쪽이 정렬할 수 있다.
- 끊긴 구간은 `down`부터 다음 `live`까지다. `live` 앞에 `down`이 없으면(프로세스가 죽은 경우) 그 앞 마지막 줄의 시각부터다. 그날 앞에 실시간(REAL) 프레임이 하나도 없었다면(처음 시작해 LOGIN·REG 응답만 있었다면) 끊김이 아니다.

- 자식 모드(`collect --child --key <이름>`)는 `raw/<YYYYMMDD>/<키 이름>/` 아래에 같은 이름 규칙으로 쓴다. `--items` 모드는 `raw/<YYYYMMDD>/`에 쓴다.

읽기는 `read_day(데이터 폴더, 날짜)`가 그날의 파일을 이름 순으로, 파일 안에서는 줄 순으로 `RawItem`을 준다. 날짜 폴더 바로 아래의 파일과 키 폴더(날짜 폴더 아래 한 단계) 안의 파일을 모두 읽는다. 파일은 파일 이름(`HHMM-NNN.jsonl.zst`) 순으로 늘어서고 이름이 같으면 경로 순이다. 같은 종목이 인계로 두 키 폴더에 나뉘면 그 줄들은 쓴 순서가 아니라 이 순서로 나온다. 줄마다 `recv_ms`가 있어 읽는 쪽이 정렬할 수 있다.

| `RawItem` | 뜻 |
|---|---|
| `Record` | 줄 하나. `RawContent`는 `Frame`(글자), `Text`, `Live`, `Down` |
| `BadLine` | 줄 하나가 깨졌다. 그 줄만 알리고 다음 줄을 읽는다 |
| `Truncated` | 파일 끝이 잘렸거나 아직 닫히지 않았다. 풀리는 데까지 읽은 뒤 잘린 줄을 버리고 알린다 |
| `Unreadable` | 파일을 열거나 풀 수 없다 |

## 원문 해석

`collector::parse::parse_frame`이 REAL 프레임의 글자를 받아 `data` 항목마다 결과 하나를 준다.

- `Item::Row`: 종목(등록한 글자 그대로), 흐름 종류(`hoga_format::StreamKind`), 열 값. 열 값은 `StreamKind::columns()` 순서에서 `recv_ms`를 뺀 것이다.
- `Item::NotTrade`: `0B`의 `15`가 0이다. 행이 아니고 오류도 아니다.
- `Item::Unsupported`: `0D`·`0B`·`0w`·`0F`가 아닌 종류(`0E` 등). 오류가 아니다.
- `ItemError`: 그 항목만의 읽기 오류다. 같은 프레임의 다른 항목은 읽힌다.
- LOGIN·REG 응답처럼 REAL이 아닌 프레임은 항목이 없다. JSON이 아닌 글자는 `FrameError`다.
- `0F` 행은 `members`에 회원사 코드와 이름의 짝을 싣는다(매도 5, 매수 5 순서). 코드나 이름이 빈 칸은 뺀다. 이름은 양끝 공백만 뗀다.

| 흐름 | 원문 종류 | 열 ← FID |
|---|---|---|
| `book` | `0D` | `t_s` ← 21, `ask_px`i ← 40+i, `bid_px`i ← 50+i, `ask_qty`i ← 60+i, `bid_qty`i ← 70+i, `ask_total` ← 121, `bid_total` ← 125 |
| `trades` | `0B` | `t_s` ← 20, `price` ← 10, `qty` ← 15, `venue` ← 9081 |
| `program` | `0w` | `t_s` ← 20, `sell_qty` ← 202, `sell_amt` ← 204, `buy_qty` ← 206, `buy_amt` ← 208 |
| `broker` | `0F` | `sell_code`i ← 145+i, `buy_code`i ← 155+i, `sell_qty`i ← 160+i, `buy_qty`i ← 170+i. 이름은 `sell` 140+i, `buy` 150+i |

읽기 규칙:

- 가격(`10`, `41`~`60`)은 앞의 `+`·`-`·공백을 떼고 절댓값으로 읽는다.
- 수량·금액·회원사 코드는 부호를 포함한 정수로 읽는다(`"002"`는 2).
- 빈 값과 없는 FID는 0이다.
- `20`·`21`은 `HHmmss` 여섯 자리 숫자다. 자정부터의 초로 바꾼다. 없거나 숫자가 아니거나 시 0~23, 분·초 0~59를 벗어나면 그 항목의 오류다.
- `venue`는 `KRX` 1, `NXT` 2, 그 밖 0이다.
- 숫자 자리에 글자가 섞이면 그 항목의 오류다.

`collector::kst::KstTime::from_unix_ms`가 유닉스 ms를 KST 날짜(`YYYYMMDD`)와 자정부터의 ms로 바꾼다. `span_start_minute`은 5분 구간 시작(자정부터의 분)이다.

### 시험 입력

`crates/collector/tests/fixtures/raw/20260720/`에 hoga-ops 채록을 원문 파일로 옮겨 커밋했다. 만든 방법과 내용은 그 폴더의 `README.md`에 있다. 읽어서 해석하면 `0D` 2,382행, `0B` 6,880건, `0w` 205행, `0F` 24행이고 오류가 없다. 이 입력은 `_AL` 등록이 아니다. 종목은 채록에 적힌 글자(`005930_NX`, `005930`)로 읽는다.

## collect

`collector collect --data <폴더> --items <코드,코드,…>`가 수집기 전용 키로 키움 WebSocket에 붙어 원문 파일을 쓴다. 받은 프레임을 해석하지 않는다. 같은 세션 코어를 감독 데몬이 부리는 자식 모드(`collect --child --key <이름>`)로도 쓴다. 이 절의 나머지는 `--items` 모드를 설명하고, 자식 모드는 [자식 모드](#자식-모드)에 있다.

### 설정

프로세스 환경변수가 `VALLY_COLLECTOR_ENV_FILE`이 가리키는 파일보다 먼저다. 파일은 절대 경로여야 하고 앱 서버의 `VALLY_ENV_FILE`과 같은 규칙(`KEY=VALUE` 줄, `export` 접두, 값을 감싼 따옴표 한 쌍, `#` 줄)으로 읽는다. 빈 값은 없는 것으로 본다.

| 변수 | 뜻 | 기본 |
|---|---|---|
| `VALLY_COLLECTOR_APP_KEY` | 수집기 전용 앱키. 꼭 있어야 한다 | 없음 |
| `VALLY_COLLECTOR_APP_SECRET` | 그 시크릿. 꼭 있어야 한다 | 없음 |
| `VALLY_COLLECTOR_TOKEN_PATH` | 토큰 파일 | `$XDG_STATE_HOME/vallythevally/collector/token.json`(`XDG_STATE_HOME`이 없으면 `~/.local/state`) |
| `VALLY_COLLECTOR_LOCK_PATH` | 잠금 파일 | 토큰 파일과 같은 폴더의 `collector.lock` |
| `VALLY_COLLECTOR_ENV_FILE` | 위 값을 적은 파일 | 없음 |

- 없는 필수 변수는 이름을 적어 알리고 끝난다.
- 앱 서버의 `VALLY_KIWOOM_APP_KEY`(프로세스 환경이나 `VALLY_ENV_FILE`이 가리키는 파일)가 수집기 키와 같으면 시작하지 않는다. 같은 키를 두 곳에서 쓰면 서로 연결을 끊는다. hoga-ops 키와 같은지는 알 수 없으니 사용자가 확인한다.
- 키와 시크릿은 `server::config::Secret`에 담긴다. 설정의 Debug 출력과 로그에 값이 나오지 않는다.
- 키움 주소는 코드의 상수(`https://api.kiwoom.com`, `wss://api.kiwoom.com:10000/api/dostk/websocket`)다. 바꾸는 설정은 없다.

### 인수

- `--data <폴더>`: 기본 `data/hoga`.
- `--items <코드,코드,…>`: 종목코드 1~200개. 코드는 `domain::StockCode` 규칙(6자리 영숫자 대문자)이고 겹치면 오류다. 종목마다 `_AL`을 붙여 등록한다(`005930` → `005930_AL`).

### 시작 순서

1. 인수와 설정을 모두 확인한다. 틀리면 잠금·토큰 파일·데이터 폴더·네트워크를 건드리지 않고 끝난다.
2. 잠금을 잡는다. 이미 잡혀 있으면 바로 끝난다.
3. 데이터 폴더의 `raw/`를 만든다. 못 만들면 토큰 요청과 연결 전에 끝난다(종료 코드 1).
4. 그 잠금으로 토큰 파일을 열고 `KiwoomAuth`와 `KiwoomRest`를 만든다. 토큰 발급 규칙(발급 간격 10분, 8050 전체 멈춤, 토큰 파일 기록, ADR 0004·0009)은 `server` 크레이트의 것을 그대로 쓴다.

### 세션이 하는 일

끊김 → 토큰 → 연결 → LOGIN → REG → 수신 순으로 돈다.

- **토큰.** 토큰 파일에 쓸 수 있는 토큰이 있으면 그것을 쓰고 au10001을 부르지 않는다. 없을 때만 `issue_token`으로 받는다. 발급 간격에 걸리면 그 시각까지 기다린다.
- **LOGIN.** 연결과 LOGIN·REG 응답은 5초까지 기다린다. 토큰 무효로 거절되면 그 토큰을 버리고 발급 간격을 지킨 뒤 한 번만 다시 받아 붙는다. 또 거절되면 멈춘다. 그 밖의 LOGIN 거절도 멈춘다.
- **REG.** 한 메시지로 모든 종목을 등록한다.

```json
{"trnm":"REG","grp_no":"1","refresh":"1","data":[{"item":["005930_AL","000660_AL"],"type":["0B","0D","0w","0F"]}]}
```

  유량 제한으로 거절되면 1초 뒤 한 번 다시 보낸다. 그 밖의 거절(등록 한도 등)과 두 번째 거절은 멈춘다. 같은 입력으로 다시 접속하지 않는다.
- **받은 글자.** `trnm`만 읽는다. `REAL`이면 값을 해석하지 않고 프레임 줄로 쓴다. `PING`이면 받은 글자를 그대로 돌려보내고 쓰지 않는다. 그 밖(LOGIN·REG 응답 등)은 프레임 줄로 쓰고 응답을 판정한다. JSON이 아니면 글자 줄로 쓴다. 보낸 LOGIN은 쓰지 않는다. `recv_ms`는 프레임을 받은 때의 유닉스 ms다.
- **사건 줄.** REG 응답을 받으면 `live`를 쓴다. 닫힘, 전송 오류, 30초 동안 아무 메시지도 없음, 응답 시간 초과로 연결이 끝나면 까닭과 함께 `down`을 쓰고 다시 붙는다. 이미 `down` 상태에서 연결이 또 실패하거나 종료가 오면 `down`을 더 쓰지 않는다. 다음 `live`까지가 한 구간이다. 멈춤은 까닭을 남기려고 항상 쓴다. `down`은 쓰는 즉시 flush한다. 연결 자체가 안 되거나 토큰을 못 받아 기다리는 동안도 `down`을 더 쓰지 않는다.
- **다시 붙기.** 쉬는 시간은 1, 2, 5, 10, 30초이고 끝 값을 계속 쓴다. `live` 뒤 60초 넘게 열려 있었으면 1초로 돌아간다. 다시 붙으면 LOGIN과 REG를 처음부터 한다.
- **flush.** 쓸 줄이 있으면 1초에 한 번 원문 파일을 flush한다.
- **현황 로그.** 1분마다 그 1분 동안 받은 프레임 수와 받은 글자의 바이트 수(압축 전, PING 제외), 시작 뒤 합계를 로그에 적는다.

### 끝나는 경우와 종료 코드

| 경우 | 하는 일 | 종료 코드 |
|---|---|---|
| SIGINT·SIGTERM | `down`(까닭 `종료`, 이미 `down` 상태면 생략)을 쓰고 원문 파일과 연결을 닫는다 | 0 |
| 인수·설정 오류 | 까닭을 표준 오류에 적는다 | 2 |
| 잠금을 못 잡음, 데이터 폴더를 못 만듦, 실행 환경 오류 | 까닭을 표준 오류에 적는다 | 1 |
| 멈춤 | `down`(까닭은 `… 멈춥니다: …` 꼴의 설명. 이미 `down` 상태여도 멈춘 까닭을 남기려고 쓴다)을 쓰고 원문 파일을 닫은 뒤 까닭과 할 일을 표준 오류에 적는다. 스스로 다시 시도하지 않는다 | 1 |

멈추는 경우와 할 일:

| 멈춤 | 할 일 |
|---|---|
| 토큰 발급이 8050(지정단말기 인증 실패)으로 거절됨 | 키움 포털에서 지금 공인 IP가 등록돼 있는지, 반복 발급 잠금이 풀렸는지 확인한다 |
| 그 밖의 인증 차단, 토큰 파일 오류 | 앱키·시크릿과 계정 상태를 확인한다. 토큰 파일은 권한 600, 폴더는 700이어야 한다 |
| LOGIN 거절(토큰을 한 번 다시 받은 뒤에도 무효인 경우 포함) | 수집기 전용 키가 다른 프로세스와 겹치지 않는지 확인한다 |
| REG 거절(등록 한도, 두 번째 유량 제한 등) | `--items`의 종목 수와 코드를 확인한다 |
| 원문 파일을 쓰지 못함 | 디스크 공간과 권한을 확인한다 |

멈춘 뒤에는 고치고 `collector collect`를 다시 실행한다. 토큰 발급 간격은 토큰 파일에 남아 있어 다시 실행해도 지켜진다.

### 자식 모드

`collector collect --child --key <이름> [--data <폴더>]`는 감독 데몬(ADR 0026)이 수집 키마다 하나씩 띄우는 자식이다. 토큰도 종목도 스스로 정하지 않고 데몬이 stdin으로 준다. 데몬 쪽 코드는 `supervise-core` 작업이 만든다. 형식 타입은 `collector::protocol` 한 곳에 있어 데몬과 자식이 함께 쓴다.

두 모드는 세션 코어(`collect::session`)를 함께 쓴다. 다른 것은 토큰을 얻는 길, 등록 목록을 받는 길, 사건을 내는 곳, 원문 위치뿐이다.

| | `--items` | `--child` |
|---|---|---|
| 토큰 | 토큰 파일과 `au10001`(키 잠금을 잡는다) | stdin의 `token` 명령. `au10001`을 부르지 않고 토큰 파일과 키 잠금을 잡지 않는다 |
| 키·시크릿 설정 | 필요 | 필요 없다. 환경변수를 읽지 않는다(아래 시험용 주소 하나만 예외) |
| 등록 | 인수의 종목 전부를 한 REG로, 타입은 `0B`·`0D`·`0w`·`0F` | `register` 명령 하나를 50종목씩 나눈 REG들 |
| REG 거절 | 멈춘다 | 그 묶음만 거절로 알리고 계속한다. 거절된 묶음은 다시 붙을 때 다시 보내지 않는다 |
| LOGIN 토큰 무효 | 토큰을 한 번 다시 받고, 또 거절되면 멈춘다 | `token_invalid`를 내고 새 `token`을 기다린다 |
| 사건 | 로그뿐 | stdout의 줄 단위 JSON |
| 원문 위치 | `raw/<날짜>/` | `raw/<날짜>/<키 이름>/` |

#### 인수

- `--key <이름>`: 영문자·숫자·`-`·`_` 64자까지. 원문 폴더 이름이 된다. `--child`와 함께만 쓴다.
- `--child`는 `--items`를 받지 않는다. 틀린 인수는 stdout에 아무것도 쓰기 전에 stderr에 적고 종료 코드 2로 끝난다.
- `VALLY_COLLECTOR_WS_URL`: 시험용으로만 키움 WebSocket 주소를 바꾼다. `ws://127.0.0.1…`, `ws://localhost…`, `ws://[::1]…`만 받고 그 밖의 주소는 종료 코드 2로 끝난다. 토큰을 밖으로 보내지 않으려는 제한이다. 정해지지 않았으면 키움 주소(`wss://api.kiwoom.com:10000/api/dostk/websocket`)다.

#### 시작과 부모 종료

1. 인수를 확인한다.
2. `PR_SET_PDEATHSIG`(SIGTERM)를 건다(`rustix`). 거는 사이에 부모가 바뀌었으면 아무것도 하지 않고 종료 코드 0으로 끝난다. 부모가 죽으면 SIGTERM을 받아 아래 종료 절차를 밟는다. 리눅스는 이 신호를 부모를 만든 스레드가 끝날 때 보낸다. 그래서 데몬은 자식을 오래 사는 스레드에서 띄워야 한다(tokio 작업 스레드면 된다).
3. stdout에 `hello`를 쓰고 stdin을 읽기 시작한다. stdin이 닫히면(데몬이 죽었거나 닫았으면) `shutdown` 명령과 같다.
4. `token` 명령이 올 때까지 연결하지 않는다.

#### 프로토콜(버전 1)

stdin은 명령을, stdout은 사건을 준다. 줄마다 JSON 객체 하나이고 `"v":1`이 있다. 사람이 읽는 로그는 stderr로만 쓴다.

명령(데몬 → 자식). 모양은 `{"v":1,"cmd":"<이름>",…}`다.

| `cmd` | 필드 | 뜻 |
|---|---|---|
| `token` | `token`(글자), `generation`(정수) | LOGIN에 쓸 토큰과 데몬이 매긴 세대. 새 `token`은 앞의 것을 대체한다. 이미 붙은 세션은 끊지 않고 다음 LOGIN부터 쓴다 |
| `register` | `id`(글자), `items`(글자 배열), `types`(글자 배열) | 등록. `items`를 50개씩 나눠 REG로 보낸다. 붙어 있지 않으면 받아 두었다가 LOGIN 뒤 보낸다 |
| `unregister` | `register`와 같다 | 해제. 50개씩 나눠 REMOVE로 보내고 다시 붙을 때 보낼 목록에서 뺀다 |
| `shutdown` | 없음 | 종료 |

- `types`는 `0B`·`0D`·`0w`·`0F`·`1h`·`0H`·`0E`·`0g`(종목 단위) 또는 `0J`·`0U`·`0s`(시장 단위) 가운데 하나 이상이다. 한 명령에 두 갈래를 섞을 수 없다. 같은 타입을 두 번 적을 수 없다.
- 종목 단위 타입의 `items`는 종목코드(6자리 영숫자 대문자)이고 자식이 `_AL`을 붙인다. 시장 단위 타입의 `items`는 글자 그대로 REG의 `item`에 간다(업종 코드, 빈 글자 `""` 등). 이 세 타입의 항목 형식은 키움 공식 명세(`kiwoom_api_spec.json`, [ADR 0012](adr/0012-quarterly-bars-from-kiwoom-monthly-bars.md)가 링크한 고정본)에도, `docs/research/2026-11-15-kiwoom-al-realtime-types.md`에도 적혀 있지 않다. 명세는 `item`을 "거래소별 종목코드, 업종코드"라고만 적는다. 그래서 자식은 항목을 검사하지 않고 데몬이 정한 대로 보낸다. 어떤 항목이 실제로 받아들여지는지는 실제 접속으로 확인해야 하고, 거절은 `registered`의 `ok:false`로 보인다.
- `items`는 비면 안 되고 같은 항목이 두 번 있으면 안 된다. 같은 (항목, 타입)을 다시 등록하면 한 벌만 남는다.

사건(자식 → 데몬). 모양은 `{"v":1,"event":"<이름>",…}`다.

| `event` | 필드 | 언제 |
|---|---|---|
| `hello` | `key`, `pid` | 시작하자마자 한 번 |
| `heartbeat` | `frames`, `bytes`, `state` | 5초마다. 직전 하트비트 뒤 받은 프레임 수와 글자 바이트 수(원문 현황과 같은 세기), 세션 상태(`waiting_for_token`·`backoff`·`connecting`·`logging_in`·`registering`·`live`). 세션 루프와 따로 도는 작업이 내므로 토큰을 기다리거나 쉬는 동안에도 온다 |
| `registered` | `id`, `part`, `parts`, `items`, `ok`, `replay`, `rejection`(거절일 때) | `register`의 묶음 하나(`part`는 0부터)가 REG 응답을 받을 때마다. 다시 붙어 보낸 묶음은 `replay:true`다 |
| `unregistered` | `id`, `part`, `parts`, `items`, `ok`, `rejection` | `unregister`의 묶음 하나가 REMOVE 응답을 받을 때마다 |
| `live` | 없음 | LOGIN 뒤 묶음 하나 이상이 등록돼 수집이 시작된 때. 다시 붙을 때마다 다시 낸다 |
| `down` | `reason` | 끊기거나 멈추거나 종료할 때. 원문의 `down` 줄과 같은 때에 낸다 |
| `token_invalid` | `generation` | LOGIN이 토큰 무효로 거절됨. 거절된 `token`의 세대를 싣는다. 새 `token`이 올 때까지 다시 LOGIN하지 않는다 |
| `market_open` | `recv_ms`, `values` | `0s` 프레임을 받을 때마다. `values`는 그 항목의 값 객체(`"215"` 장운영구분, `"20"` 시각, `"214"` 장시작예상잔여시간) 그대로고 `recv_ms`는 받은 때의 유닉스 ms다. 어느 값이 장 시작인지는 데몬이 판단한다 |
| `halted` | `reason`, `action` | 멈출 때. 까닭과 할 일 |

- `rejection`은 `{"reason":"<키움 오류 분류>","return_code":…,"detail":…}`다. 값이 없으면 `null`이다.
- 모르는 명령, 버전이 다른 줄(`v`가 없거나 1이 아님), 깨진 줄(JSON 객체가 아님, 빈 줄, UTF-8이 아님, 필드가 맞지 않음)은 `down`과 `halted`를 내고 종료 코드 1로 끝난다. 조용히 넘기지 않는다.
- 토큰 값은 stdin으로만 받는다. 로그, 사건, 원문, 오류 문구(깨진 `token` 줄을 읽다 난 오류 포함)에 나오지 않는다.

#### 끝나는 경우

`shutdown` 명령, stdin 닫힘, SIGTERM·SIGINT(부모 종료 포함)는 `down`(까닭 `종료`)을 내고 원문을 닫고 종료 코드 0으로 끝난다. 멈춤은 `down`과 `halted`를 내고 종료 코드 1이다. 인수 오류는 종료 코드 2다.

### 시험

`crates/collector/src/collect/`의 시험은 모두 합성 전송(`Transport`)과 채널로 만든 합성 연결을 쓰고, 멈춘 tokio 시간과 `Clock::fake`로 돌린다. 실제 키움에는 접속하지 않는다. 실제 WebSocket 어댑터는 루프백(`ws://127.0.0.1`) 시험 서버 하나로 LOGIN → REG → REAL 한 프레임 → 원문 파일까지 확인한다. 자식 모드의 세션 코어 시험은 `collect/child_tests.rs`, 프로토콜 타입 시험은 `protocol.rs`에 있다. 실제 `collector` 실행 파일을 `--child`로 띄워 루프백 시험 서버에 붙이는 시험은 `tests/child_protocol.rs`다. 토큰 무효, 깨진 줄, 토큰 비노출, 부모 종료(중간 `sh`를 죽여 확인)를 다룬다.

## build와 verify

`build`가 원문 파일을 해석해 종목마다 5분 구간 파일과 그날의 `index.json`을 만들고, `verify`가 구간 파일을 다시 풀어 원문과 행 단위로 대조한다. 코드는 `collector::build`와 `collector::verify`다.

### 명령

```sh
collector build  [--data <폴더>] [--date YYYYMMDD] [--follow]
collector verify [--data <폴더>]  --date YYYYMMDD
```

| 종료 코드 | 뜻 |
|---|---|
| 0 | `build`는 읽기 오류·범위 초과·쓰기 오류가 없다. `verify`는 통과했다 |
| 1 | `build`에 위 오류가 있다. `verify`가 통과하지 못했거나 대조할 수 없다. 원문 폴더가 없다 |
| 2 | 인수 오류. `verify`에 `--date`가 없다, 날짜가 `YYYYMMDD`가 아니다, `--follow`와 `--date`를 함께 적었다 |

`build`는 `--date`가 없으면 지금의 KST 날짜를 쓴다. 지금 시각은 함수 인수(`build_day(데이터 폴더, 날짜, 지금의 유닉스 ms)`)로 주입되어 시험이 고정한다. 요약은 표준 출력에 적는다.

- 종목·흐름별 원문 행 수와 `gaps` 구간 수
- 새로 쓴 파일 수와 바이트 합, 그대로 둔 파일 수, `index.json`을 새로 썼는지
- 종목별 구간당 `book` 행 수의 최댓값(이월 행 제외)
- 건너뛴 것: 체결 아님(`0B`의 `15`가 0), 받지 않는 종류, JSON이 아닌 줄
- 잘린 원문 파일, 읽기 오류와 처음 몇 개의 내용, 범위 초과, 쓰기 오류

### 구간 만들기

- `build`는 그날의 원문 파일을 모두 읽어(`collector::raw_read::read_day`) 해석하고(`collector::parse`) 종목과 흐름별로 행을 모은다. 행의 `recv_ms`는 KST 자정부터의 ms다. 행 순서는 원문 줄 순서다. 원문 줄은 `recv_ms`가 시각으로 읽을 수 없거나(음수, 9999년 이후) 자기 날짜 폴더의 날이 아니면 읽기 오류다. 같은 종목·흐름의 행이 앞 행보다 이른 구간으로 거꾸로 오면(원문 파일 이름 순서가 시각 순서와 어긋난 손으로 만든 파일) 그 행을 읽기 오류로 센다.
- 종목 이름은 영문자·숫자·`_`만 받는다. 다른 글자가 든 종목은 폴더 이름으로 쓸 수 없어 그 항목을 읽기 오류로 센다.
- **끝난 구간만** 만든다. 구간 끝에서 10초가 지난 구간(지금 시각이 구간 끝 + 10초 이상)부터다. 지난 날짜는 전부, 오늘 날짜는 끝난 구간까지, 앞날은 하나도 만들지 않는다.
- 종목마다 그날 첫 행(네 흐름 중 가장 이른 것)이 든 구간부터 마지막 행이 든 구간(끝난 구간 안에서)까지 빠짐없이 만든다. 새 행이 없는 구간은 이월 행만 담는다. 행이 없는 흐름은 파일에 넣지 않는다.
- **이월 행**: `book`·`program`·`broker`는 구간 시작 전 마지막 행이 있으면 `recv_ms`를 바꾸지 않고 구간의 첫 행으로 싣는다. `trades`와 `gaps`에는 없다. 이월 행의 `recv_ms`는 언제나 구간 시작보다 작다. 이월 행에 `i32`를 넘는 값이 있으면 그 값을 이월하는 구간 모두가 범위 초과다.
- **끊긴 구간**(`gaps`): 원문의 사건 줄에서 구한다. `down`부터 다음 `live`까지다. `live` 앞에 `down`이 없으면 그 앞 마지막 줄의 시각부터다(그날 `live` 앞에 REAL 프레임이 없었으면 끊김이 아니다. 첫 시작의 LOGIN·REG 응답이 `live`보다 먼저 쓰이기 때문이다). 끝나지 않은 끊김은 그날 원문의 마지막 줄 시각까지다. 두 번째 `down`은 첫 `down`의 시작을 바꾸지 않는다. 구간으로 잘라(`[구간 시작, 구간 끝]`) 그 구간의 모든 종목 파일에 `gaps` 흐름으로 담는다. 구간 끝에서 끝나는 끊김은 다음 구간에 넣지 않는다.
- 파일은 `hoga-format`으로 인코딩하고 바로 디코딩해 넣은 값과 같은지 확인한 뒤 brotli q11(창 22비트)로 감싸 `spans/<날짜>/<종목>/<HHMM>-r<N>.hoga.br`에 쓴다. 같은 폴더의 임시 파일에 쓰고 이름을 바꾼다.
- **판 번호**: 그 구간에 파일이 없으면 `r1`이다. 가장 큰 번호의 파일을 풀어 새 내용과 같으면 아무것도 쓰지 않는다. 다르면 번호를 하나 올린 새 이름으로 쓰고 앞 판은 그대로 둔다. 원문 줄이 더해지거나 앞 구간의 마지막 행이 바뀌면(이월 행) 판이 올라간다.
- 오류: 읽기 오류가 난 항목은 행에서 빼고 건수를 요약과 `index.json`의 `read_errors`에 적는다. 값이 `i32`를 넘는 구간은 파일을 쓰지 않고 종목·구간·흐름·열을 요약에 적는다. 다른 구간은 계속 만든다. 둘 중 하나나 쓰기 오류가 있으면 종료 코드가 1이다. 잘린 원문 파일(아직 닫히지 않은 파일)은 요약에 적지만 종료 코드를 바꾸지 않는다. `verify`는 잘린 파일을 통과로 보지 않는다.

### `--follow`

`collector build --follow`는 오늘 날짜(KST)로 위 일을 되풀이한다. 시작하자마자 한 바퀴를 돌고, 그 뒤 5분 경계에서 15초 지난 때마다 돈다. 날짜가 바뀐 바퀴는 앞 날짜를 먼저 한 번 더 만든다(앞 날의 마지막 구간을 놓치지 않으려는 것이다). 한 바퀴의 오류는 적고 다음 바퀴를 계속한다. SIGINT·SIGTERM이 오면 돌던 한 바퀴를 마치고 종료 코드 0으로 끝난다. `--date`와 함께 쓸 수 없다.

### `index.json`

`spans/<날짜>/index.json`이다. 임시 파일에 쓰고 이름을 바꾸며, 내용이 같으면 다시 쓰지 않는다. 시각을 담지 않아 같은 입력이면 바이트가 같다. 이 문서의 모양이 `hoga-serve`가 읽는 계약이다.

```json
{
  "version": 1,
  "date": 20260720,
  "span_minutes": 5,
  "read_errors": { "items": 0, "frames": 0, "lines": 0, "unreadable_files": 0, "truncated_files": 0 },
  "members": { "003": "한국투자증권", "030": "삼  성" },
  "symbols": {
    "005930": {
      "spans": [
        {
          "start": "1025",
          "file": "1025-r1.hoga.br",
          "rows": { "book": 0, "trades": 1015, "program": 24, "broker": 2, "gaps": 0 },
          "bytes": 4117
        }
      ]
    }
  }
}
```

- `version`은 구간 파일 형식 버전(`hoga_format::VERSION`)이고 `span_minutes`는 구간 길이다.
- `members`는 그날 `0F`에서 본 회원사 코드 → 이름이다. 같은 코드에 이름이 여럿이면 마지막 것이다. 이름은 양끝 공백만 뗀다(`"삼  성"`의 가운데 공백은 그대로다).
- `symbols`는 종목 글자 순서이고 `spans`는 `start` 순서다. 파일이 하나도 없는 종목은 적지 않는다. 구간 파일 경로는 `spans/<날짜>/<종목>/<file>`이다.
- `start`는 구간 시작 `HHMM`, `file`은 지금 판(가장 큰 번호)의 이름이다.
- `rows`는 그 **파일에 든** 흐름별 행 수다. 이월 행을 포함한다. 원문 행 수가 아니다.
- `bytes`는 압축 후 파일 크기다.
- `read_errors`는 원문을 읽다 센 건수다(`items` 항목, `frames` 프레임, `lines` 줄, `unreadable_files`, `truncated_files`).
- 끝난 구간만 적힌다. 범위 초과로 못 쓴 구간은 적히지 않는다.

### `verify`

구간 나누기 코드를 거치지 않고 대조한다. 원문을 다시 읽어 해석한 종목·흐름별 전체 행 열과, `index.json`이 가리키는 지금 판의 구간 파일을 구간 순서로 풀어 이월 행(`book`·`program`·`broker` 파일에서 `recv_ms`가 구간 시작보다 작은 첫 행)을 뺀 뒤 이어 붙인 행 열이 행 단위로 같은지 본다. 함께 확인한다.

- 이월 행이 이어 붙인 열에서 바로 앞 행과 같다.
- 이월 행이 아닌 모든 행의 `recv_ms`가 그 파일의 구간 안(`[시작, 시작 + 5분)`)에 있다.
- 파일 머리의 날짜·종목·구간 시작·길이가 놓인 경로와 같다.
- 종목마다 `index.json`의 구간이 첫 행의 구간부터 마지막 행의 구간까지 빠짐없이 있고 그 밖의 구간은 없다(행 없이 이월 행만 담은 구간도 빠지면 안 된다). 파일을 읽을 수 있다. 원문에 행이 없는 종목이나 폴더 이름으로 쓸 수 없는 종목이 `index.json`에 있으면 안 된다.
- 앞 구간에 같은 흐름의 행이 있으면 `book`·`program`·`broker`는 구간 파일이 이월 행으로 시작한다.
- `gaps`가 원문의 사건 줄에서 구한 끊긴 구간을 그 구간으로 자른 것과 같다.
- `index.json`의 날짜·형식 버전·구간 길이·`read_errors`·`members`, 항목마다 파일 이름의 번호가 그 구간의 가장 큰 번호인지, `rows`와 `bytes`가 파일과 같은지.
- 원문에 읽기 오류나 잘린 파일이 있으면 통과하지 못한다.

`verify`는 끝난 날을 대조한다. 오늘 날짜처럼 끝나지 않은 구간이 있거나 아직 `build`가 만들지 않은 구간이 있으면 통과하지 못한다. `build`를 먼저 돌린다.

`spans/<날짜>/verified.json`에 결과를 쓴다(임시 파일에 쓰고 이름을 바꾼다). 통과하지 못해도 쓴다.

```json
{
  "passed": false,
  "date": 20260720,
  "verified_at_ms": 1794804363686,
  "rows": { "005930": { "book": 0, "trades": 2920, "program": 43, "broker": 4 } },
  "gap_intervals": 0,
  "read_errors": { "items": 0, "frames": 0, "lines": 0, "unreadable_files": 0, "truncated_files": 0 },
  "problem_count": 1,
  "problems": [
    { "symbol": "005930", "stream": "book", "row": 1, "column": "ask_qty1", "expected": 2, "actual": 99, "message": "값이 다르다" }
  ]
}
```

- `rows`는 원문 행 수다. `gap_intervals`는 원문에서 구한 끊긴 구간 수다.
- `verified_at_ms`는 확인한 유닉스 ms다.
- `problems`는 처음 20개만 싣고 `problem_count`가 전체 수다. 항목의 `symbol`·`stream`·`row`(원문 행 열의 0부터 센 번호)·`column`·`expected`(원문)·`actual`(구간 파일)은 해당할 때만 있고 `message`는 늘 있다. 흐름마다 처음 다른 곳 하나만 적는다.
- 원문을 지우는 명령은 없다. 원문은 `verify`가 통과한 날 사용자가 손으로 지운다.

## finalize

`finalize`가 그날 원문을 관측일·타입별 Parquet으로 정리하고, Parquet을 다시 읽어 원문과 대조한다. 코드는 `collector::finalize`이고 파일 형식은 [`collector-store-format.md`](collector-store-format.md)가 계약이다. 대조를 통과하면 커버리지를 모아 정리 완료 표시(`complete.json`)를 쓰고, 폴더를 `store/<YYYYMMDD>/`로 갈아 끼우고, `--prune`이면 조건을 모두 만족한 날의 원문을 지운다.

### 명령

```sh
collector finalize [--data <폴더>] --date YYYYMMDD [--threads 4] [--buckets 64] [--verify-only] [--prune [--keep-early 7] [--keep 1] [--early-period 10]]
```

| 종료 코드 | 뜻 |
|---|---|
| 0 | 정리했고 원문 대조가 통과했다. 정리 못 한 줄이 있어도 0이다. 그 수는 `verify.json`에 있다 |
| 1 | 원문 대조가 실패했다, 원문 폴더가 없다, 읽기·쓰기 오류가 났다 |
| 2 | 인수 오류. `--date`가 없거나 `YYYYMMDD`가 아니다, `--threads`가 1~64가 아니다, `--buckets`가 1~999가 아니다, `--keep-early`·`--keep`이 1 이상 정수가 아니다, `--prune` 없이 지우기 인수를 줬다 |

- 시작할 때 두 이름 바꾸기 사이에 끊긴 흔적(`store/<YYYYMMDD>.old-*`)이 있으면 고친다. 결과는 `store/<YYYYMMDD>.tmp/`에 쓴다. 폴더가 남아 있으면 지우고 처음부터 쓴다. 대조가 통과하면 `complete.json`을 맨 마지막에 쓰고 `store/<YYYYMMDD>/`로 바꾼다. 대조가 실패하면 `complete.json` 없이 `.tmp`를 남기고 1로 끝난다.
- `--verify-only`는 쓰지 않고 원문 줄만 다시 세어 Parquet과 대조한다. `.tmp`가 있으면 그것을, 없으면 `store/<YYYYMMDD>/`를 대조한다. `verify.json`을 새로 쓰고 `complete.json`은 건드리지 않는다. 지우기는 하지 않는다.
- `--prune`은 대조가 통과한 뒤 `raw/` 아래 모든 날을 따져 지울 수 있는 날의 원문을 지운다. 조건과 기록은 [`collector-store-format.md`](collector-store-format.md)의 "원문 지우기"를 따른다. 오늘은 `--date`다. `complete.json`에 적힌 원문 지문(`raw_files`)과 지금 원문이 다른 날, 정리가 읽지 않는 파일이 든 날은 지우지 않는다. 지우기 직전에 한 번 더 확인한다. 지우다 실패한 날이 있으면 1이다.
- `--threads`는 원문을 해석하는 스레드와 버킷을 정렬해 쓰는 스레드의 수다. 상한은 이 값이다. 원문은 `raw_read::read_day` 하나가 읽고 스레드들이 줄 묶음을 나눠 받는다. 줄에 번호를 매겨 정렬 기준에 넣으므로 스레드 수가 달라도 파일이 같다.

### 하는 일

1. 원문을 읽는 스레드들이 프레임을 해석해 행을 종목 해시 버킷별로 모은다. 모은 양이 스레드당 128MiB를 넘으면 `store/<날짜>.tmp/.spill/`에 zstd 1로 압축해 흘린다. 하루치를 메모리에 올리지 않는다.
2. 타입·버킷마다 흘린 조각을 모아 종목·시각 순으로 정렬하고 Parquet으로 쓴다. 버킷 하나(한 타입)가 메모리에 오른다. 메모리를 줄이려면 `--buckets`를 늘린다.
3. 흘린 폴더를 지우고, Parquet 파일을 다시 읽어 종목·타입별 행 수와 첫·끝 `recv_ms`를 원문에서 센 값과 견준다. 종목·시각 순과 종목의 버킷도 확인한다. 결과를 `verify.json`에 쓴다.

열 목록은 원문을 훑어 정하지 않고 키움 명세로 정한다. 명세에 없는 FID는 버리지 않고 타입·FID별로 센다. 원문 줄을 정리됨·제어·정리 못 함으로 나눈 개수도 `verify.json`에 늘 쓴다. 뜻은 [`collector-store-format.md`](collector-store-format.md)의 "verify.json"을 본다.

### 시험

`crates/collector/tests/finalize.rs`가 합성 원문(열한 타입, 종목 48개, 버킷 여럿)을 정리해 DuckDB로 읽은 행이 원문 프레임과 같은지, 스레드 1과 4의 결과 파일이 같은지, `verify.json`의 줄 수 구분, 원문에서 줄 하나를 뺀 Parquet이 대조에서 실패하는지, 이미 있는 `store/<날짜>/`를 갈아 끼우는지, 문서의 열 표가 코드의 열 정의와 같은지를 고정한다.

`crates/collector/tests/finalize_complete.rs`는 합성 원문·계획·사건 기록으로 종목별 커버리지(계획, 등록 실패, 받지 못함, 끊긴 구간, 제외, 거래정지, 인계)와 처음 정리, 다시 정리(열린 옛 파일이 끝까지 읽힘), 끊긴 이름 바꾸기 회복, 대조 실패 때 `complete.json`이 없는 것을 확인한다. `finalize_prune.rs`는 지울 날을 가르는 조건과 보관 기간, 설정값, 휴장일, `raw/` 밖 경로 거부를 확인한다. `python3 scripts/dev.py cargo test -p collector --test finalize_complete`, `--test finalize_prune`.

## 수집 종목 목록

`collector::universe`가 아침에 `ka10099`로 받아 `<데이터 폴더>/universe/`에 쓴다. 대상과 규칙은 [ADR 0026](adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md)을, 용어는 `GLOSSARY.md`의 **수집 종목 목록**을 따른다. 07:20에 부르는 일은 감독 데몬의 몫이고, 이 모듈은 `KiwoomRest` 하나를 받아 받기·가르기·검사·쓰기만 한다.

```
universe/<YYYYMMDD>.json            그날의 수집 종목 목록(계획의 입력)
universe/<YYYYMMDD>.rejected.json   쓰지 않기로 한 목록(진단용)
universe/<YYYYMMDD>.after.json      마감 뒤 목록과 아침 목록의 차이
```

모든 파일은 임시 파일에 쓴 뒤 이름을 바꿔 놓는다. 같은 날짜로 다시 돌려 정상 목록을 받으면 그날 파일을 새로 쓰고 그날의 `rejected.json`을 지운다(지우지 못하면 오류가 아니라 경고다). 전날 목록은 그날보다 이른 날짜 가운데 가장 늦은 `<YYYYMMDD>.json`이고, 내용이 깨졌거나 형식 버전이 달라 읽을 수 없는 파일은 지우거나 고치지 않고 건너뛰어 그보다 앞선 읽히는 파일을 쓴다. 입출력 오류(권한 등)로 열리지 않는 이전 날 파일은 건너뛰지 않는다. 내용을 알 수 없어 대체 근원과 3% 검사의 비교 대상이 오래된 날로 바뀔 수 있으므로, 그 파일 경로가 있는 오류로 아침 단계를 끝내고 파일은 건드리지 않는다. 건너뛴 파일과 까닭은 `collect_morning`의 결과(`Morning::skipped`)와 로그에 남고, 대신 쓸 이전 목록이 없어 `NoFallback`으로 끝날 때도 그 오류(`skipped`)에 들어 있다. 3% 검사의 비교 대상도 같은 목록이다.

### 받기와 가르기

`mrkt_tp` 0과 10을 연속조회 끝까지 부른다(`server::symbols::fetch_listing_rows`, 서버의 `fetch_directory`와 같은 호출이다). 시장마다 쪽 수 상한(`MAX_LIST_PAGES`)에 닿았는데 다음 쪽이 남아 있으면 끊긴 목록이다. 행은 `domain::classify`로 가른다.

- 보통주와 우선주를 남긴다. 스팩(`ListingRow::is_spac`)은 종류 `spac`으로 남는다.
- ETF·리츠·ETN·인프라투자금융·뮤추얼펀드 행은 넣지 않는다. 규칙에 없는 `marketCode` 행도 넣지 않고 `warnings`에 적는다. 모르는 `auditInfo` 상태와 겹치는 종목코드도 `warnings`에 적는다.
- `auditInfo`에 거래정지가 있으면 목록에는 두고 `registered`를 `false`로 한다. 관리종목·투자경고 같은 다른 상태는 `registered`가 `true`다. 계획이 쓸 "등록할 종목"은 `UniverseFile::registrable()`이다. 목록을 읽는 함수는 `read_universe`다.

### 그날 목록 파일

| 필드 | 뜻 |
|---|---|
| `format_version` | 형식 버전. 지금은 1이고 다른 값은 읽지 않는다 |
| `date`, `fetched_at` | 목록 날짜(`YYYYMMDD`)와 받은 시각(KST, `+09:00`) |
| `stocks` | 종목코드 순. 종목마다 `code`, `name`, `market`(`kospi`·`kosdaq`), `kind`(`common`·`preferred`·`spac`), `status`(`auditInfo`의 낱말 그대로), `registered` |
| `warnings` | 위 가르기 경고 |
| `diff` | 전날 목록과의 차이: `added`, `removed`, `renamed`(`code`·`from`·`to`), `halt_started`, `halt_lifted`. 전날 목록이 없으면 비어 있다 |
| `replaced` | 대체됐을 때만 있다: `reason`, `detail`, `source_date` |

### 검사

아래 경우에는 받은 목록을 그날 목록으로 쓰지 않는다. 그날 목록 파일이 이미 있으면 그대로 둔다. 그날 파일이 있는데 내용이 깨졌거나 형식 버전이 달라 읽을 수 없고 받은 목록도 쓰지 못하면, 그 파일을 지우지 않고 `<YYYYMMDD>.unreadable-<HHMMSS>.json`으로 옮겨 두고(같은 이름이 있으면 `-2`부터 번호를 붙인다) 가장 최근의 읽히는 이전 목록으로 그날 파일을 새로 써서 수집을 이어 간다. 이때 `replaced`는 위 대체와 같고, 결과의 `Morning::moved_aside`가 옮긴 파일 경로와 읽지 못한 까닭을 알리며 `skipped`에 그날 파일이 들어가고 경고 로그를 남긴다. 감독 데몬은 `stage_failed` 경보를 낸다. 읽히는 이전 목록도 없으면 파일을 그대로 둔 채 `UniverseError::TodayListUnreadable`로 끝낸다(`stage_failed` 경보가 되고 그날 수집은 사람이 그 파일을 고치거나 지운 뒤 다시 돌려야 한다). 옮기지 못하면 덮어쓰지 않고 오류로 끝난다. 옮긴 뒤 대체 목록을 쓰지 못하면 `UniverseError::ReplacementNotWritten`으로 끝난다. 이 오류 문장에 옮긴 파일 경로가 있어 `stage_failed` 경보에 실린다. 옮긴 파일은 그대로 남고, 다시 돌리면 그날 파일이 없는 경우로 이어진다. 그날 경로가 끊어진 심볼릭 링크이면 없는 파일로 보지 않고 아래 입출력 오류와 같이 그 경로가 있는 오류로 끝내며 링크는 지우거나 옮기지 않는다. 파일을 열거나 읽다 입출력 오류(권한 등)가 나면 내용을 알 수 없다. 이때는 그 파일을 옮기지도 바꾸지도 않고, 받은 목록이 정상이어도 쓰지 않으며, 그 파일 경로가 있는 오류로 끝난다(`stage_failed` 경보). 그날 파일을 새로 받은 정상 목록으로 바꾸는 것은 막지 않는다. 그날 파일이 없을 때만 가장 최근 읽히는 이전 목록의 `stocks`를 그날 파일에 쓰고(`diff`는 비고 `warnings`는 그 목록의 것이다) `replaced`에 까닭을 적는다. 받은 목록은 `<YYYYMMDD>.rejected.json`에 남긴다(`reason`, `detail`, `previous_count`, `stocks`, `warnings`). 결과의 `Morning::written`이 새 목록(`NewList`), 대체(`ReplacementList`), 그대로 둠(`LeftAsIs`, 거부 까닭 포함) 중 무엇을 했는지 알린다.

| `reason` | 경우 |
|---|---|
| `fetch_failed` | 조회가 실패했다 |
| `shrunk` | 종목 수가 가장 최근 목록보다 3% 넘게 줄었다. 정확히 3%는 쓴다 |
| `cut_off` | 연속조회가 쪽 수 상한에 닿았는데 다음 쪽이 남았다 |

대신 쓸 이전 목록이 없으면 `rejected.json`만 쓰고 `UniverseError::NoFallback`을 낸다. `rejected.json`을 쓰지 못해도 오류로 끝내지 않는다. 경고(`Morning::warnings`와 로그)로 남기고 위 결과를 그대로 낸다.

### 마감 뒤 목록

`collect_after_close`가 같은 호출로 한 번 더 받아 아침 목록과의 차이만 `<YYYYMMDD>.after.json`(`morning_count`, `after_close_count`, `warnings`, `diff`)에 쓴다. 그날 목록 파일은 바꾸지 않고 계획에도 쓰지 않는다. 조회가 실패하거나 끊기면 파일을 쓰지 않고 오류를 낸다.

### 시험

`crates/collector/tests/universe.rs`가 합성 `Transport`로 여러 쪽 응답을 주고 가르기, 차이 다섯 종류, 3% 경계, 조회 실패·끊긴 목록의 대체와 `rejected.json`, 같은 날 재실행이 좋은 목록을 덮지 않는 것, 내용이 깨진 최근 파일을 건너뛰는 것, 열리지 않는 이전 날 파일과 끊어진 링크인 그날 경로가 오류로 끝나는 것, 정상 재실행이 `rejected.json`을 지우는 것, 읽을 수 없는 그날 파일이 조회 실패 뒤에도 그대로 남는 것, `NoFallback`에 건너뛴 파일이 들어 있는 것, `rejected.json` 쓰기 실패가 경고인 것, 마감 뒤 목록이 그날 파일을 바꾸지 않는 것을 고정한다.

## serve와 복기 화면

`serve`가 구간 파일과 복기 화면을 `127.0.0.1`에서 내보내고, 브라우저가 종목과 날짜를 골라 시간 막대를 움직이거나 재생하면서 그 시각의 호가 10단계, 최근 체결, 프로그램 순매수, 거래원 상위 5를 본다. 코드는 `collector::serve`(서버)와 `crates/collector/page/`(화면)다.

### 명령

```sh
collector serve [--data <폴더>] [--bind 127.0.0.1:8090]
```

- 루프백 주소(127.0.0.0/8, `::1`)에만 묶인다. 다른 주소면 시작하지 않고 종료 코드 2다. `--bind`의 기본은 `127.0.0.1:8090`이고 포트 0이면 빈 포트를 쓴다.
- 묶은 뒤 표준 출력에 `http://127.0.0.1:<포트>` 한 줄을 적는다.
- 데이터 폴더가 없으면 종료 코드 1이다. SIGINT·SIGTERM에 끝난다.
- 화면 파일(`crates/collector/page/`)은 실행 파일에 들어 있다. 화면과 자료가 같은 출처라 CORS 헤더는 없다.

### 길

| 길 | 응답 |
|---|---|
| `GET /`, `/style.css`, `/main.js`, `/worker.js`, `/decode.js`, `/seek.js`, `/latest.js`, `/replay.js`, `/view.js` | 화면 파일. `Cache-Control: no-cache` |
| `GET /data/dates.json` | `spans/` 아래 `index.json`이 있는 날짜를 오름차순으로 담은 JSON 문자열 배열(`["20260720"]`). `no-store` |
| `GET /data/<날짜>/index.json` | `spans/<날짜>/index.json` 그대로. `no-store` |
| `GET /data/<날짜>/<종목>/<HHMM>-r<N>.hoga` | `spans/<날짜>/<종목>/<HHMM>-r<N>.hoga.br`의 내용 |

- 구간 파일: 요청의 `Accept-Encoding`에 `br`(`q=0`이 아닌 것)이 있으면 디스크의 바이트를 그대로 `Content-Encoding: br`로 보낸다. 없으면 풀어서 보낸다. `Content-Type: application/octet-stream`, `Vary: Accept-Encoding`, `Cache-Control: public, max-age=31536000, immutable`(판 이름이 바뀌지 않는다).
- 날짜는 숫자 8자리, 종목은 영문·숫자·밑줄, 파일 이름은 위 모양(`.hoga`)만 받는다. 그 밖의 길, 없는 파일, `..`이 든 길, `.hoga.br`를 직접 부르는 길은 404다. 데이터 폴더 밖은 읽지 않는다. 경로를 정규화해 데이터 폴더 안인지 확인하므로 폴더 밖을 가리키는 심볼릭 링크도 404다. `Accept-Encoding`의 `q` 값은 대소문자를 가리지 않고 읽는다.

### 화면

- 주소 인자: `/?date=20260720&item=005930_NX&t=19:58:00.000`. 없으면 가장 최근 날짜, 첫 종목, 첫 구간 시작이다. `t`는 `HH:MM[:SS[.mmm]]`다. 날짜·종목·시각을 바꾸거나 멈추면 주소의 인자가 갱신된다.
- 위쪽: 날짜, 종목, 재생·멈춤, 배속(1배·5배·10배), 커서 시각(`HH:MM:SS.mmm`). 시간 막대는 그 종목의 첫 구간 시작부터 마지막 구간 끝까지이고 끌거나 눌러 옮긴다. 수집 끊김 구간이 막대에 붉게 표시된다.
- 키보드(시간 막대에 초점이 있을 때): ←·→ 1초, Shift+←·→ 10초, PageDown·PageUp 1분, Home·End 처음·끝.
- 호가창: 고정 20줄(매도 10단계에서 1단계, 이어 매수 1단계에서 10단계)과 매도·매수 총잔량. 매수 1호가가 매도 1호가 이상이면 받은 값 그대로 보이고 "교차"가 켜진다. 커서가 수집 끊김 안이면 "수집 끊김"이 켜진다.
- 최근 체결: 커서 시각까지의 최신 20건(시각, 가격, 수량, 매수·매도, 거래소). 받아 둔 앞 구간이 있으면 이어서 보인다.
- 프로그램매매: 순매수 수량(`buy_qty − sell_qty`)과 순매수 금액(백만원), 누적 매수·매도.
- 거래원: 매도 상위 5와 매수 상위 5의 이름(`index.json`의 `members`, 없으면 세 자리 코드)과 누적 수량.
- 그 시각까지 행이 없는 흐름은 `—`다. 구석의 "프레임 p95"는 재생 중 최근 300프레임의 프레임 간격 p95(ms)다. 10배속에서 60fps가 유지되는지(약 16.7ms) 실제 수집 날 재는 데 쓴다.
- 움직이는 방식:
  - 화면은 커서가 있는 구간의 파일부터 받고, 앞 1개·뒤 2개 구간을 미리 받는다. 받은 구간은 24개까지 쥔다.
  - Web Worker가 파일을 받아 열마다 누적합으로 되돌리고 `Int32Array`를 transferable로 넘긴다.
  - 시각으로 행을 찾을 때는 `recv_ms` 열을 이진 탐색한다(그 시각 이하의 마지막 행).
  - `requestAnimationFrame` 루프 하나가 프레임마다 최신 시각을 한 번 그린다. 보이는 행 번호가 바뀐 흐름만 글자를 바꾼다.
  - 재생은 흐른 시간 × 배속만큼 커서를 올리고 마지막 구간 끝에서 멈춘다.

### 확인 스크립트가 읽는 자리

화면이 DOM의 `data-*`로 내놓는다.

| 자리 | 뜻 |
|---|---|
| `#replay[data-ready]` | `true`면 `data-cursor-ms`의 시각 화면이 다 그려졌다. 커서를 옮기면 바로 `false`가 된다 |
| `#replay[data-cursor-ms]` | 그려진 커서 시각(KST 자정부터의 ms). `data-date`, `data-item`도 있다 |
| `[data-book-row]` | 호가 줄 20개. `data-side`(`ask`·`bid`), `data-level`(1~10), `data-price`, `data-qty`(행이 없으면 빈 글자) |
| `#book-ask-total`, `#book-bid-total` | 총잔량. `data-value` |
| `#book-cross`, `#gap-banner` | `data-on`이 `true`면 "교차"와 "수집 끊김"이 켜져 있다 |
| `[data-trade-row]` | 체결 줄 20개. `data-time`(`HH:MM:SS`), `data-price`, `data-qty`(절댓값), `data-side`(`buy`·`sell`), `data-venue`(`KRX`·`NXT`). 빈 줄은 값이 빈 글자 |
| `#program-net-qty`, `#program-net-amt`, `#program-buy-qty`, `#program-buy-amt`, `#program-sell-qty`, `#program-sell-amt` | 프로그램매매. `data-value` |
| `[data-broker-row]` | 거래원 줄. `data-side`(`sell`·`buy`), `data-rank`(1~5), `data-name`, `data-qty` |
| `#frame-stat[data-p95]` | 프레임 간격 p95(ms) |
| `#bar` | 시간 막대(`input[type=range]`, 값은 KST 자정부터의 ms) |
| `#play`, `#speed`, `#clock` | 재생 단추(`data-playing`), 배속 선택, 커서 시각 |

### 시험

```sh
python3 scripts/dev.py cargo test -p collector
python3 scripts/dev.py cargo clippy -p collector --all-targets -- -D warnings
python3 scripts/dev.py cargo build -p collector
node --test crates/collector/page-tests/
node scripts/test-hoga-replay.mjs
```

- `cargo test -p collector`의 `tests/serve/`가 길, 압축 협상, 404, 화면 파일의 `Content-Type`, 루프백이 아닌 주소 거절을 고정한다.
- `crates/collector/page-tests/`는 DOM 없이 Node 내장 시험 실행기로 디코더(기준 파일 `crates/hoga-format/tests/fixtures/`)와 시각 → 행 계산을 시험한다. 실행 파일에는 들어가지 않는다.
- `scripts/test-hoga-replay.mjs`는 `target/debug/collector`가 필요하고(`cargo build -p collector`), `web/`의 의존성(`cd web && pnpm install --frozen-lockfile`)과 Chromium을 쓴다. CI에는 없다. `target/hoga-replay-tests/run-<고유값>/`에 고정 입력을 복사해 `build`로 구간 파일을 만들고(수집 끊김 사건 두 줄을 더해 `gaps`도 확인한다) `serve --bind 127.0.0.1:0`을 띄운다. 기대값은 원문(`zlib.zstdDecompressSync`)에서 직접 구한다. 결과는 `result.json`과 스크린샷으로 남고 실패하면 종료 코드가 1이다. 띄운 서버만 끈다.

## 관측일 판단

`collector::calendar`가 그날이 관측일인지, 개장 시각이 언제인지, 그 근거가 무엇인지 정한다. 입력은 주말, 한국천문연구원 특일정보 API(`SpcdeInfoService/getRestDeInfo`)의 공휴일, KRX 고정 휴장일(5월 1일, 12월 31일), 수정 파일이다. 12월 31일이 쉬는 날(주말·공휴일)이면 그 직전 관측일이 쉰다. 새해 첫 관측일은 개장이 10:00이다. 하나라도 쉰다고 하면 쉬는 날이고, 쉰다고 한 입력이 없는데 알 수 없는 입력이 있으면 판단은 "모름"이다.

```
data/hoga/calendar/
  holidays-<YYYY>.json   특일정보 캐시(version, year, fetched_at_unix_ms, holidays[{date, name}])
  overrides.json         사람이 적는 수정 파일. 없으면 수정이 없는 것이다
```

- 특일정보는 올해와 지난해를 받고 12월에는 내년도 받는다. 올해(와 내년) 캐시는 받은 달이 이번 달이 아니면 다시 받고, 지난해 캐시는 다시 받지 않는다. 받기가 실패하면 캐시를 쓰고 근거에 그렇게 적는다. 캐시도 없으면 그 해의 날짜는 "모름"이다. 공휴일이 0건인 응답은 잘못된 응답으로 보고 캐시에 쓰지 않는다.
- 서비스 키는 파일 한 개에 적고 `read_service_key`가 `Secret`으로 읽는다. 캐시, 근거, 오류 문구에 나오지 않는다. 실제 HTTP는 `ReqwestHolidayTransport`(`calendar/http.rs`)가 한다. 기본 주소는 `https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService`이고 `with_base_url`로 바꿔 시험 서버에 붙인다. 요청은 `getRestDeInfo`에 `solYear`, `_type=json`, `numOfRows=100`, `ServiceKey`를 쿼리로 보낸다(`solMonth`는 보내지 않아 한 해를 한 번에 받는다). 키가 든 URL은 오류 문구와 로그에 남기지 않는다(reqwest 오류에서 URL을 떼고, 리다이렉트는 따라가지 않는다). 키 파일에는 공공데이터포털의 Decoding 키를 적는다. 요청을 만들 때 값을 URL 인코딩하므로 Encoding 키를 적으면 이중으로 인코딩돼 서비스 오류가 난다. 실제 HTTP를 구현해 주입할 수도 있다(`HolidayTransport`).
- 수정 파일 형식이다. `date`는 YYYYMMDD 숫자, `reason`은 근거에 그대로 보인다. 같은 날을 두 번 적을 수 없다. 형식이 틀리면 쉬는 날이 아닌 날의 판단이 "모름"이다.

  ```json
  {"version": 1, "days": [
    {"kind": "closed", "date": 20261118, "reason": "임시 휴장"},
    {"kind": "open_at", "date": 20261119, "time": "10:00", "reason": "수능"}
  ]}
  ```

- `Calendar::judge`는 `Judgment`(관측일 여부, 개장 분, 근거 목록)를 낸다. `next_observation_day`, `observation_days_after`, `observation_days_before`가 관측일을 센다. `cross_check`는 지수 일봉의 날짜 목록과 그날 판단을 대조한다. 목록이 비었거나 그날이 목록의 가장 이른 날짜보다 앞이면 판단하지 않는다. 마지막 일봉 뒤의 날은 일봉이 없는 것으로 보므로 마감 뒤에 부른다.
- 시험은 `python3 scripts/dev.py cargo test -p collector --test calendar`와 `--lib calendar`다. 합성 응답만 쓴다.

## 특일정보 첫 실제 호출 확인

`ReqwestHolidayTransport`의 응답 해석(`response.body.items.item`, `locdate`, `isHoliday`, `dateName`, `totalCount`)은 공공데이터포털 관례를 가정한 것이고 실제 응답으로 확인한 적이 없다. 처음 켜기 전에 사람이 한 번 직접 불러 아래를 비교한다. 자동 시험과 자동 작업은 이 호출을 하지 않는다.

1. **키를 파일에 둔다.** 공공데이터포털이 주는 키 가운데 **Decoding 키**를 넣는다. Encoding 키는 다시 인코딩돼 `SERVICE_KEY_IS_NOT_REGISTERED_ERROR`(403)가 난다. 화면에 찍히거나 셸 기록에 남지 않게 입력 없이 읽는다. 폴더 권한은 700, 파일 권한은 600이고 저장소 밖에 둔다.

   ```sh
   install -d -m 700 ~/.config/vally
   install -m 600 /dev/null ~/.config/vally/holiday-service-key
   read -rs HOLIDAY_KEY && printf '%s' "$HOLIDAY_KEY" > ~/.config/vally/holiday-service-key; unset HOLIDAY_KEY
   ```
2. **한 해를 한 번 부른다.** 키는 `curl`이 파일에서 읽어 인코딩하므로 명령줄에도 남지 않는다. 응답은 `-o`로 파일에만 쓰고 화면에 찍지 않는다. 오류 출력에 URL이 나올 수 있으니 `-sS` 대신 `-s`를 쓰고 상태 코드만 본다.

   ```sh
   curl -s -G -o holidays-2026.json -w '%{http_code}\n' \
     --data-urlencode 'solYear=2026' --data-urlencode '_type=json' --data-urlencode 'numOfRows=100' \
     --data-urlencode 'ServiceKey@'"$HOME"/.config/vally/holiday-service-key \
     https://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo
   ```

   `200`이 아니거나 파일이 JSON이 아니면 여기서 멈춘다. 파일에 키가 들어 있지 않은지 `grep -cF -f ~/.config/vally/holiday-service-key holidays-2026.json`으로 확인하고, 서비스 오류 응답이 키를 되돌려 보냈다면 파일을 지운다. 파일은 저장소 밖이나 작업 폴더의 무시되는 위치에 둔다.
3. **모양을 비교한다.** `jq '.response.header, .response.body.totalCount, (.response.body.items.item | type)' holidays-2026.json`로 아래를 확인한다.
   - `header.resultCode`가 `"00"`이다.
   - `items.item`이 배열이고 `totalCount`가 배열 길이와 같다. 한 해에 1건뿐인 경우는 없으므로 객체가 나오면 가정과 다른 것이다.
   - 각 항목의 `locdate`가 `YYYYMMDD` 숫자(문자열이어도 읽는다), `isHoliday`가 `"Y"`, `dateName`이 문자열이다.
   - 날짜가 모두 2026년이고, 1월 1일·삼일절 대체공휴일 등 알려진 날이 있다. 달력과 대조한다.
   - 같은 날이 두 항목으로 나오면(공휴일이 일요일과 겹칠 때) 판단 모듈이 이름을 `, `로 합친다.
4. **한 항목과 0건 모양을 확인한다.** `solMonth`를 더해 공휴일이 하나뿐인 달(예: `solMonth=01`)과 없는 달(예: `solMonth=07`)을 부르고 `items.item`이 객체, `items`가 빈 문자열(또는 비었음)로 오는지 본다. 가정과 다르면 `parse_holiday_response`와 이 문서를 고친다.
5. **수집 쪽에서 확인한다.** 가정과 같으면 `collector`가 받은 뒤 `data/hoga/calendar/holidays-2026.json`의 `holidays`가 위 응답의 `isHoliday`가 `Y`인 항목과 같은지 본다. 로그에 키나 URL이 없는지도 한 번 훑는다.

2026-11-18에 사람이 한 번 불러 확인했다. 한 해 조회는 `items.item`이 배열이고 `totalCount`가 배열 길이와 같았다. 한 건인 달은 `items.item`이 객체, 0건인 달은 `items`가 `""`, `locdate`는 숫자로 위 가정과 같았다.

다르면 키와 URL을 어디에도 붙여 넣지 말고 달라진 필드 이름과 타입만 적어 알린다. 확인이 끝나면 `holidays-2026.json`과 키 파일 안의 값이 남아 있지 않게 정리한다.

## 키 목록 설정

`collector::keys::KeyList::load`가 저장소 밖 JSON 파일 하나에서 수집 키 목록을 읽는다. 비밀값은 이 파일에 없고 키마다 비밀값 파일을 가리킨다. 아래 값은 모두 가짜다.

```json
{"version": 1, "keys": [
  {"name": "collect-01", "active": true, "spare": false,
   "app_key_hash": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
   "secret_file": "/etc/vally/collect-01.env"},
  {"name": "spare-01", "active": true, "spare": true,
   "app_key_hash": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
   "secret_file": "/etc/vally/spare-01.env",
   "token_path": "/var/lib/vally/spare-01/token.json",
   "lock_path": "/var/lib/vally/spare-01/collector.lock"}
]}
```

- `name`은 `a-z0-9-`다. `app_key_hash`는 토큰 파일이 쓰는 `sha256:<소문자 16진수 64자>`다. 모든 경로는 절대 경로다.
- 비밀값 파일은 `collect`의 env 파일과 같은 형식이다(`VALLY_COLLECTOR_APP_KEY`, `VALLY_COLLECTOR_APP_SECRET`). 읽는 것은 활성 키뿐이라 아직 없는 키는 `active: false`로 적어 둘 수 있다.
- `token_path`와 `lock_path`를 적지 않으면 상태 폴더 아래 키 이름 폴더(`<상태 폴더>/<키 이름>/token.json`, `collector.lock`)다.
- 읽을 때 다음이 하나라도 틀리면 오류다. 이름이 겹침, `spare: true`가 정확히 하나가 아님, 비밀값 파일 권한에 그룹·다른 사용자 비트가 있음(600이어야 한다), 비밀값 파일의 앱키 해시가 설정과 다름, 두 키의 앱키 해시가 같음, 앱 서버 키(`VALLY_KIWOOM_APP_KEY`)와 같음.
- 오류 문구에는 키 이름과 경로만 나온다. 비밀값은 `Secret`에 담긴다.

## 수집 계획

`collector::plan::build_plan`이 그날의 수집 계획을 정하는 순수 함수다. 입력은 활성 키(`KeyList::identities`), 그날의 수집 종목 목록(`UniverseFile`), `종목 → 전날 메시지 수` 맵이다. 읽어 오는 일과 부르는 시각은 호출하는 쪽이 정한다. 같은 입력이면 입력 순서와 상관없이 같은 계획이 나온다.

- 키 하나의 몫은 190종목이다(`KEY_CAPACITY`). 예비 키에는 종목, 시장 단위 타입, REST 작업을 맡기지 않는다.
- 등록할 종목이 수집 키 수 × 190보다 많으면 종목코드 순으로 채우고 나머지는 `excluded`에 남기며 `alerts`에 적는다.
- 전날 메시지 수가 큰 종목부터 합이 가장 작은 키(같으면 종목 수가 적은 키, 같으면 키 이름 순)에 넣는다. 전날 값이 없는 종목은 부하 0으로 보고 마지막에 종목 수가 가장 적은 키에 넣는다.
- 시장 단위 타입 `0J`·`0U`·`0s`는 종목을 나눈 뒤 부하가 가장 작은 수집 키(같으면 종목 수가 적은 키, 같으면 키 이름 순) 하나에 건다.
- 거래정지로 등록하지 않는 종목은 `unregistered`에 남고 어느 키에도 들지 않는다.
- `rest_jobs`는 지금 빈 목록이다.

`plan/<YYYYMMDD>.json`의 최상위 값이다.

| 값 | 뜻 |
|---|---|
| `format_version`, `date`, `created_at` | 형식 버전(1), 날짜, 만든 KST 시각 |
| `input` | `active_keys`(활성 키 수, 예비 키 포함), `universe_replaced`(종목 목록이 이전 목록으로 대체됐으면 그 까닭과 원래 날짜) |
| `keys[]` | `name`, `role`(`collecting`·`spare`), `app_key_hash`, `stocks`, `market_types`, `rest_jobs`, `load`(몫의 전날 메시지 수 합) |
| `excluded`, `unregistered`, `alerts` | 제외한 종목코드, 등록하지 않는 종목코드, 경보 문구 |

`check_plan`이 한 종목이 정확히 한 키에만 드는지(와 키마다 190 이하, 예비 키가 비어 있는지, 시장 단위 타입이 수집 키 하나에만 있는지)를 확인한다. `write_plan`이 쓰기 전에 부르고, 인계 때 데몬이 다시 부른다. `write_plan`은 임시 파일에 쓴 뒤 이름을 바꾸고, 파일이 이미 있으면 덮어쓰지 않고 오류를 낸다. 그날의 기록이고 `finalize`의 입력이기 때문이다. `read_plan`은 형식 버전을 확인하고 읽는다.

시험은 `python3 scripts/dev.py cargo test -p collector --test plan`이다. 가짜 키와 비밀값 파일만 쓴다.

## supervise

`collector supervise --date YYYYMMDD --keys <키 목록 설정> [--state <폴더>] [--data <폴더>]`는 감독 데몬([ADR 0026](adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md))이다. 그날 계획(`plan/<YYYYMMDD>.json`)을 받아 수집 키마다 `collect --child` 자식을 띄우고, 토큰을 발급하고, 감시하고, 다시 띄우고, 인계한다. 이 입구(`--date`)는 그날 하나를 돌리는 시험용이다. 운영은 `--date` 없이 계속 도는 [감독 데몬](#감독-데몬)이 하루 일정 안에서 같은 `Supervisor`를 부른다. 코드는 `collector::supervise`다.

`--socket`은 읽기 전용 상태 API의 unix socket 경로다(기본은 `--state` 폴더 아래 `supervise.sock`, 계약은 [수집 감독 데몬 상태 API](collector-status-api.md)). `collector status`는 그 소켓에 한 번 물어 표로 찍는다.

`--state`는 키마다 기본 토큰·잠금 파일 경로의 바탕 폴더다. 없으면 `collect`와 같은 규칙(`$XDG_STATE_HOME` 또는 `$HOME/.local/state` 아래 `vallythevally/collector`)이다. 종료 코드는 0(SIGTERM·SIGINT 또는 종료 시각으로 끝남), 1(시작하지 못함), 2(인수·설정 오류)다.

### 시작

시작할 때 하나라도 어긋나면 자식을 띄우기 전에 멈춘다.

- 계획 파일의 `date`가 `--date`와 같고 `check_plan`을 통과해야 한다. `read_plan`은 이 둘을 확인하지 않으므로 데몬이 부른다.
- 계획의 키와 키 목록 설정의 활성 키가 이름, 역할, 앱키 해시까지 같아야 한다. 한쪽에만 있는 키가 있으면 멈춘다.
- 키마다 `token_path`와 `lock_path`가 서로 달라야 한다. 키 하나의 토큰을 쥐는 프로세스는 하나다(ADR 0004).
- 키마다 잠금 파일(`InstanceLock`)을 잡는다. 잠금은 풀지 않는다. 데몬이 끝나면 프로세스와 함께 놓인다.

### 토큰

- 키마다 `KiwoomAuth`·`KiwoomRest` 하나를 쓴다. 토큰 파일에 아직 쓸 수 있는 토큰이 있으면 새로 발급하지 않고 그것을 쓴다. 한 키의 발급 사이는 10분(`KiwoomAuth`), 만료 10분 전에는 다시 받는다.
- 키 사이 발급 간격은 설정값 `token_spacing`이고 기본 5초다. 발급 요청은 한 줄(`IssueLane`)로 세워 이 간격을 지킨다. 예비 키 토큰도 장 시작에 미리 받는다.
- 자식의 `token_invalid`를 받으면 그 세대를 무효로 하고 10분 간격이 지난 뒤 새 토큰을 보낸다. 그 사이 자식은 `waiting_for_token`으로 하트비트를 계속 낸다. 이미 더 새 토큰이 있으면 그것을 다시 보낸다.
- `Control::reissue_token_at(키, 시각)`이 장중에 키마다 다른 시각에 재발급하는 입구다. 마감 뒤 재발급의 엇갈림은 이 입구가 아니라 상주 계층이 자기 `KeyTokens`로 한다(감독 데몬 절).
- 8050이나 그 밖의 발급 정지(앱키 거절, 토큰 파일을 읽을 수 없음)를 받은 키는 멈춤이다. 8050은 사건 기록에 `8050`이 든 까닭으로 남는다.
- 토큰 값과 앱키는 사건 기록과 로그에 쓰지 않는다.

### 자식과 재시작

- 자식은 같은 실행 파일을 `collect --child --key <이름> --data <폴더>`로 띄운다. 환경변수는 비우고 `VALLY_COLLECTOR_WS_URL`, `RUST_LOG`만 넘긴다. stdin·stdout은 프로토콜 줄이고 stderr는 데몬 로그(`자식: …`)로 잇는다. 띄우는 부분은 `Launcher` trait이고 실제 구현은 `tokio::process`(`TokioLauncher`)다.
- `PR_SET_PDEATHSIG`는 자식이 건다. 리눅스는 이 신호를 부모를 만든 스레드가 끝날 때 보내므로, 데몬은 자식을 tokio 런타임의 작업 스레드(`spawn_blocking`이 아님)에서 띄운다.
- `hello`가 오면 토큰과 계획의 몫을 `register`로 보낸다. 자식이 다시 뜨면 토큰과 등록을 처음부터 다시 보낸다.
- 하트비트가 `heartbeat_timeout`(15초) 동안 오지 않거나 자식이 끝나면 그 자식을 SIGTERM으로 끝내고, `shutdown_grace`(10초) 안에 끝나지 않으면 SIGKILL로 끝낸 뒤 같은 키로 다시 띄운다.
- 재시작 간격은 `restart_delays`(1, 2, 5, 10, 30초이고 끝 값을 계속 쓴다), 그날 재시작 한도는 `restart_limit`(5회)다. 한도를 넘어 끝난 키는 멈춤이다.
- `hello`가 틀린 키를 말하거나 줄이 프로토콜에 맞지 않으면 그 자식을 끝내고 다시 띄운다. 형식 버전이 다른 줄이면 다시 띄워도 같으므로 그 키를 멈춤으로 한다.
- 등록 결과(`registered`)는 `(id, part, parts)`가 같으면 하나로 센다. 쪼개진 묶음이 재전송되면 같은 묶음의 결과가 두 번 오기 때문이다. 나중 결과가 앞의 것을 대체하고, 등록 실패 수는 마지막 결과가 거절인 묶음 수다.
- 등록 명령은 키의 `stocks`를 한 묶음(`<키>-stocks`, 타입은 `0B`·`0D`·`0w`·`0F`·`1h`·`0H`·`0E`·`0g`)으로, 시장 단위 타입을 타입마다 하나(`<키>-market-<타입>`, 항목은 빈 글자 하나)로 보낸다. 시장 단위 타입의 항목 형식은 아직 실접속으로 확인하지 않았다. 거절은 `registered`의 `ok:false`로 보이고 사건 기록에 남는다.

### 인계

- 수집 키가 멈춤이 되면(재시작 한도를 넘음, 8050, 버전 불일치) 그 키의 몫(종목과 시장 단위 타입)을 예비 키 자식에게 `register`로 보낸다. id는 `handoff-<키>-…`다. 원래 키는 `HandedOff`가 되고 그날 다시 띄우지도 등록하지도 않는다.
- 예비 키는 멈춘 키 하나의 몫만 받는다. 두 번째로 멈춘 키는 인계하지 않고 수집 끊김(`Stopped`)으로 남으며 `handoff_skipped`가 기록된다. 예비 키가 멈췄거나 몫이 없는 키는 인계하지 않는다.
- 인계 전후에 `check_plan`을 부른다. 인계 뒤의 모양은 `effective_plan`이 만든다. 멈춘 키는 비워 예비 역할로, 받는 키는 그 몫을 쥔 수집 역할로 바꾼 계획이다. 어느 쪽이든 틀리면 인계하지 않고 이유를 기록한다.
- 예비 키 자식은 장 시작부터 띄워 두고(등록 없이 LOGIN까지) 토큰도 미리 받아 둔다. 예비 키 자식이 다시 뜨면 받은 몫을 다시 등록한다.

### 사건 기록 `plan/<YYYYMMDD>.events.jsonl`

사건 하나가 한 줄이고 데이터 폴더의 계획 파일 옆에 덧붙는다. 모든 줄에 `v`(형식 버전, 지금 1), `at`(KST 시각 `YYYY-MM-DDTHH:MM:SS+09:00`), `event`가 있다. `finalize-complete`가 이 기록으로 커버리지에 인계를 반영한다. 데몬이 기록을 열 때 파일이 비어 있지 않고 끝에 줄바꿈이 없으면(`kill -9` 직후처럼 쓰다 끊긴 줄) 먼저 줄바꿈을 써서 새 사건이 잘린 줄에 붙지 않게 한다. 읽는 쪽은 JSON으로 읽히지 않는 줄을 건너뛴다.

| `event` | 필드 | 뜻 |
|---|---|---|
| `child_started` | `key`, `pid`, `restarts` | 자식을 띄웠다. `restarts`는 그 키의 그날 재시작 수 |
| `child_exited` | `key`, `code` | 자식이 끝났다. 신호로 끝나면 `code`가 `null` |
| `heartbeat_lost` | `key`, `silent_secs` | 하트비트가 끊겼다 |
| `child_rejected` | `key`, `reason` | 띄우지 못했거나 프로토콜에 맞지 않는 줄을 보냈다 |
| `restart` | `key`, `restart`, `delay_secs` | 다시 띄우기로 했다. `restart`는 1부터 센 번호 |
| `key_stopped` | `key`, `reason` | 키가 멈췄다. 이 키의 수집은 그 시각부터 끊긴다(인계가 없으면 그날 끝까지) |
| `handoff` | `from`, `to`, `stocks`, `market_types` | `from`의 몫을 `to`로 옮겼다. 이 시각 이후 `stocks`는 `to` 키의 원문에 들어간다 |
| `handoff_skipped` | `key`, `reason` | 인계하지 않았다 |
| `register_failed` | `key`, `id`, `part`, `parts`, `items`, `reason`, `return_code`, `detail` | 등록 묶음이 거절됐다. 같은 묶음의 재전송 거절은 한 번만 적는다 |
| `token_issued` | `key`, `generation` | 토큰을 새로 받았다(값은 적지 않는다) |
| `token_invalid` | `key`, `generation` | 자식이 그 세대의 토큰이 무효라고 알렸다 |
| `observation_judged` | `day`, `verdict`(`observed`·`closed`·`unknown`), `open_minute`, `treated_as`(`observed`·`closed`), `evidence` | 상주 계층의 그날 관측일 판단. 판단은 07:20과 데몬을 다시 띄울 때마다 다시 하므로 여러 줄이면 마지막이 맞다 |
| `market_open_seen` | `key`, `deadline` | 처음 온 `market_open`. `deadline`은 대조 마감 시각 |
| `market_open_missing` | `deadline` | 마감 시각까지 `market_open`이 없었다 |
| `market_open_not_checked` | `reason` | 개장 뒤에 시작해 대조하지 않았다 |
| `index_checked` | `result`(`agrees`·`disagrees`·`undetermined`·`failed`), `mismatch`, `detail` | 마감 뒤 코스피 지수 일봉 대조 |

### 상태 모양과 로그

`Supervisor::status()`가 `watch` 수신기로 `DaemonStatus`(`date`, 키마다 `KeyStatus`)를 준다. 상태 API 작업이 이것을 내보낸다. 키 상태는 `waiting`(대기), `connecting`(연결 중), `receiving`(받는 중), `disconnected`(끊김), `stopped`(멈춤), `handed_off`(인계됨)이고, 키마다 맡은 종목 수(`stocks`, 예비 키는 받은 몫, 인계한 키는 0), 직전 하트비트의 초당 메시지(`messages_per_second`), 등록 실패 수(`register_failures`), 그날 재시작 수(`restarts`)가 있다. 이 작업은 1분마다(`housekeeping_every`) 로그 한 줄로만 찍는다.

### 끝내기

SIGTERM·SIGINT나 종료 시각(`end_at`, 기본 20:05 KST, 계획 파일의 날짜 기준)이면 모든 자식에 `shutdown`을 보낸다. 시작한 시각이 이미 종료 시각 뒤이면 토큰도 요청하지 않고 자식도 띄우지 않고 곧장 끝난다(`--date` 입구도 같다). `shutdown_grace`(10초) 뒤에도 남은 자식은 SIGTERM, 다시 10초 뒤 SIGKILL로 끝낸다. 데몬을 SIGKILL로 죽여도 자식의 `PR_SET_PDEATHSIG`가 자식을 끝낸다.

### 시험

- `tests/supervise.rs`: 가짜 자식(`Launcher`·`ChildProcess`를 구현한 in-process 가짜), 합성 `Transport`, 멈춘 tokio 시간과 `Clock::fake`로 토큰 간격, 재시작, 인계, 8050, `token_invalid`, 종료, 시작 확인, 사건 기록과 로그의 토큰 비노출을 확인한다. `python3 scripts/dev.py cargo test -p collector --test supervise`.
- `tests/supervise_status.rs`: 상태 소켓 권한(600), 남은 소켓 파일, 응답이 `tests/fixtures/status/` 예시와 같은 모양인지, 감시 연결의 5초 하트비트와 단계 변경 즉시 전송, 읽지 않는 연결 끊기, 요청 없이 붙은 연결 정리, 파일 요청이 밀려도 `status` 답하기, 두 데몬이 동시에 낡은 소켓을 열 때 하나만 얻는 것, 명령 거절, 비밀값 비노출, `collector status` 표와 "데몬 꺼짐"을 확인한다. 소켓 경로 길이 한도(SUN_LEN) 때문에 소켓만 `/tmp` 아래 짧은 임시 폴더에 둔다. `python3 scripts/dev.py cargo test -p collector --test supervise_status`.
- `tests/supervise_process.rs`: 실제 `collector supervise`가 실제 `collect --child` 자식 둘을 루프백 WebSocket 시험 서버에 붙여 LOGIN과 REG까지 가고, 데몬을 끝내면(SIGTERM) 자식도 끝나고, 데몬을 SIGKILL로 죽여도 자식이 끝남을 확인한다. 토큰은 토큰 파일에 미리 넣어 두고 `VALLY_COLLECTOR_REST_URL`(`http://127.0.0.1…`만 받는다)을 닫힌 포트로 돌려 키움에는 아무것도 보내지 않는다. `python3 scripts/dev.py cargo test -p collector --test supervise_process`.

## 감독 데몬

`collector supervise --keys <키 목록 설정> [--data <폴더>] [--state <폴더>] [--socket <경로>]`(`--date` 없이)는 날마다 정해진 순서로 일하며 계속 돈다. 하루짜리 `Supervisor`는 그대로 두고 그 위에 상주 계층(`supervise::Daemon`)이 하루를 단계 열로 돌린다. 상태 소켓은 데몬 하나가 평생 하나를 열어 장 밖에도 열려 있다. 시각 판단은 모두 주입한 `Clock`으로 한다.

### 하루 순서

각 단계는 이미 끝났는지 파일과 사건 기록으로 알아내므로 데몬이 중간에 떠도 같은 상태로 모인다. 시각은 설정값이고 아래가 기본이다.

| 시각 | 단계(상태 `phase`) | 하는 일 | 이미 끝난 것으로 보는 조건 |
|---|---|---|---|
| 07:20 | 판단(`off_hours`) | 특일정보와 수정 파일로 그날 관측일을 판단하고 `observation_judged`를 적는다 | 항상 다시 한다 |
| 07:20 뒤 | 종목 목록(`morning_prep`) | 예비 키 토큰으로 `ka10099`를 받아 `universe/<날짜>.json`을 쓴다 | 그 파일이 있다 |
| 07:35 | 계획(`morning_prep`) | 직전 관측일 `store/<날짜>/complete.json`의 종목별 `messages` 합을 부하로 계획을 세워 `plan/<날짜>.json`을 쓴다(없으면 빈 부하) | 그 파일이 있다. 있으면 읽어 쓰고 다시 쓰지 않는다 |
| 07:55 | 장중(`collecting`) | `Supervisor`로 자식 띄우기, 토큰, 등록, 감시, 인계 | 20:05가 지났으면 건너뛴다 |
| 20:05 | 마감 뒤 처리(`after_close`) | 자식을 끄고 마감 뒤 목록(`universe/<날짜>.after.json`)을 받는다 | 그 파일이 있다 |
| 목록 직후 | 〃 | 예비 키로 코스피 지수 일봉(`ka20006`) 한 쪽을 받아 그날 봉이 있는지 판단과 견준다(`index_checked`) | 사건 기록에 `index_checked`가 있다 |
| 대조 직후 | 〃 | 키를 이름순으로 한 줄로 세워 i번째 키를 (대조가 끝난 시각 + i × `reissue_spacing`)에 재발급한다 | |
| 재발급 뒤 | 정리(`finalizing`) | `finalize --prune` 자식을 `nice -n 10 ionice -c 3`로 띄운다. 정리 완료 표시와 원문 지우기를 한다 | `store/<날짜>/complete.json`이 있다 |

`phase`가 `off_hours`인 때는 쉬는 날, 07:20 전, 정리가 끝난 뒤다. 하루가 끝나면 다음 날 00:00까지 기다린 뒤 새 하루를 시작한다. 데몬이 뜰 때와 새 하루를 시작할 때마다 먼저 밀린 날을 정리한다. 원문은 있는데 `complete.json`이 없는 과거 날짜를 모두 오래된 순으로 한 번씩 정리하고, 오늘은 뺀다. 금요일 저녁에 죽은 데몬이 월요일에 뜨면 금요일분을 정리한다. 밀린 날 정리는 아침 일정과 겹치지 않게 시각으로 끊는다. 07:20 판단 전에 뜬 데몬은 07:20 전까지만 새 날을 시작하고, 07:20 이후(장중)에 뜬 데몬은 밀린 날을 시작하지 않고 수집을 먼저 한다. 마감 뒤에 뜬 데몬은 다음 날 07:20 전까지 한다. 밀린 날을 정리하다 07:20에 닿으면 그날(마감 뒤에 뜬 날) 정리도 시작하지 않고 다음 정리 기회(다음 날 시작이나 다음 데몬 시작)에 밀린 날로 정리한다. 끊긴 날은 다음 날 00:00 시작이나 다음 데몬 시작 때 이어서 정리한다. 이미 시작한 정리 한 건은 끊지 않으므로 그 한 건이 끝나는 시각만큼 늦을 수 있다. 대조에 실패한 날은 그 시작에서 한 번만 시도하고 넘어가므로 같은 시작 안에서 되풀이하지 않는다. 다만 `complete.json`이 생기지 않는 날은 다음 시작마다 다시 시도하고 경보(`stage_failed`)를 다시 낸다.

REST용 키는 키 목록의 예비 키이고, 예비 키가 없으면 첫 활성 키를 쓰며 경보(`plan_note`)를 남긴다. 토큰은 `IssueLane`으로 받고 재시도는 세 번까지다. 상주 계층이 연 `KeyTokens`는 `Supervisor`를 띄우기 전에 놓는다(키마다 잠금이 하나이기 때문이다). 토큰 파일이 이어 주므로 아침에 받은 토큰을 `Supervisor`가 그대로 쓴다.

### 관측일이 아닌 날, 판단 모름

- 판단이 쉬는 날이면 그날 단계를 돌리지 않는다. 상태는 `off_hours`이고 `observation_day.reasons`에 근거가 보이며 자식, `ka10099`, 계획·목록 파일이 없다.
- 판단이 모름이면 관측일로 보고 돈다. 경보 `observation_unknown`에 근거 문장을 담고 사건 기록의 `treated_as`에 `observed`를 적는다. `observation_day.verdict`는 `unknown` 그대로이고 `reasons` 끝에 "관측일로 보고 돌린다"가 붙는다.
- 특일정보 서비스 키 파일(`--holiday-key`)을 읽지 못해도 데몬은 뜬다. 그날은 캐시만 쓰고 경보(`stage_failed`)를 낸다.

### `0s` 대조

관측일로 본 날 `Supervisor`가 자식의 `market_open`을 기다린다. 마감 시각은 판단의 개장 시각(수정 파일로 바뀐 날은 그 시각)에 `market_open_grace`(기본 10분)를 더한 시각이다. 처음 온 `market_open`은 `market_open_seen`으로, 마감 시각까지 못 받으면 `market_open_missing`과 경보로 남긴다. 개장 시각 뒤에 `Supervisor`가 시작하면(11:00에 뜸 같은 경우) 그 개장의 `market_open`은 받을 수 없으므로 `market_open_not_checked`만 적고 경보는 내지 않는다.

### 중간에 뜬 데몬

- 오늘 계획 파일이 있으면 다시 쓰지 않고 그것을 쓴다. 이때 종목 목록은 받지 않는다. 장중이면(`launch_at`을 넘었고 `close_at` 전이면) 바로 자식을 띄운다.
- 마감 뒤(`close_at` 이후)에 뜨면 그날 수집(자식, 토큰, 계획 만들기, 마감 뒤 목록, 지수 대조, 재발급)을 하지 않는다. `complete.json`이 없고 그날 원문이 있으면 정리부터 한다. `complete.json`이 있으면 아무것도 하지 않는다.
- 종목 목록을 받지 못했고 이전 목록도 없으면(`NoFallback`) 그날 수집을 접고 경보(`stage_failed`)를 남긴다. 계획을 세우지 못해도 같다.
- 정리가 0이 아닌 종료 코드로 끝나면 경보(`stage_failed`)를 남기고 그 시작 안에서는 다시 하지 않는다. 다음 날 시작이나 다음 데몬 시작 때 정리가 안 끝난 날을 모두 다시 시도한다. 일정 시각이 이미 지났으면 기다리지 않고 바로 이어 간다.
- 종료 신호는 모든 기다림, 장중 `Supervisor`, 정리 자식에 닿고 어느 단계에서든 깨끗이 끝난다.

### 설정

| 설정 | 기본 | 옵션 |
|---|---|---|
| `judge_at` | 07:20 | `--judge-at HH:MM` |
| `plan_at` | 07:35 | `--plan-at HH:MM` |
| `launch_at` | 07:55 | `--launch-at HH:MM` |
| `close_at` | 20:05 | `--close-at HH:MM` |
| `market_open_grace` | 10분 | `--open-grace-minutes N` |
| `reissue_spacing` | 30초 | `--reissue-spacing-secs N` |
| `finalize_threads` | 2 | `--finalize-threads N` |
| 서비스 키 파일 | `~/.config/vally/holiday-service-key` | `--holiday-key <경로>` |
| 원문 보관, 처음 기간 | 7관측일 | `--keep-early N`(1 이상) |
| 원문 보관, 그 뒤 | 1관측일 | `--keep N`(1 이상) |
| 처음 기간의 길이 | 10관측일 | `--early-period N`(0 이상) |

시각은 `judge_at < plan_at < launch_at < close_at`이어야 한다. 보관 옵션 세 개는 `finalize --prune`에 그대로 넘어가 원문을 지울 날을 가른다(조건은 [`collector-store-format.md`](collector-store-format.md)의 "원문 지우기"). 잘못된 값은 시작 오류(종료 코드 2)다. 이 옵션들은 `--date`와 함께 쓸 수 없다.

### 시험

`tests/supervise_day.rs`: 가짜 자식, 합성 `Transport`(`au10001`, `ka10099`, `ka20006`), 합성 `HolidayTransport`, 실제 `finalize::run`을 같은 인수로 부르는 `FinalizeRunner`, 멈춘 tokio 시간과 `Clock::fake`로 하루를 몇 초에 돌린다. 평일 하루의 순서와 시각, 쉬는 날, 판단 모름, `0s`가 오지 않음, 지수 일봉 어긋남과 실패, 개장 시각이 바뀐 날, 11:00과 21:00에 뜬 데몬, 마감 뒤에 직접 시작한 `Supervisor`, 상태 소켓의 단계별 응답과 계약 예시 모양, 종료 신호, 정리 실패와 다음 날 다시 하기, 월요일에 뜬 데몬이 금요일을 포함해 밀린 날을 오래된 순으로 정리하는 것, 밀린 날이 길면 07:20 앞에서 멈추고 나머지를 다음 날 시작에 정리하는 것, 마감 뒤에 뜬 데몬이 밀린 날 때문에 07:20에 닿으면 그날 정리를 시작하지 않는 것, 보관 옵션이 지우기 판단에 닿는 것, 끝 줄바꿈 없이 잘린 사건 기록 뒤의 판단이 `complete.json`에 나오는 것을 확인한다. `python3 scripts/dev.py cargo test -p collector --test supervise_day`.

## 운영

감독 데몬 `collector supervise`를 systemd 사용자 서비스로 올려 날마다 돌리는 절차다. systemd 사용자 서비스는 데몬 하나뿐이고 자식(`collect`, `finalize`)은 데몬이 띄운다. 유닛 파일은 [`deploy/systemd/`](../deploy/systemd/)에 있다.

| 파일 | 하는 일 |
|---|---|
| [`vally-collector.service`](../deploy/systemd/vally-collector.service) | `collector supervise`를 띄운다. `Restart=on-failure`, 30초 뒤 다시 뜬다. 인수 오류(종료 코드 2)는 다시 띄우지 않는다. 1시간에 5번 넘게 죽으면 멈춘다 |
| [`vally-collector-alert.service`](../deploy/systemd/vally-collector-alert.service) | 데몬이 뜻하지 않게 끝나면 `OnFailure=`와 `ExecStopPost=`가 부른다. journal에 `crit` 줄 하나를 남기고, 텔레그램 설정 파일이 있으면 텔레그램으로도 보낸다 |
| [`vally-collector-alert-telegram`](../deploy/systemd/vally-collector-alert-telegram) | 경보 유닛이 부르는 `curl` 스크립트. 봇 토큰을 파일에서 읽어 명령줄과 로그에 남기지 않는다 |

- 경보처는 journal의 `vally-collector-alert` 줄과 텔레그램이다(아래 "텔레그램 경보"). 메일 같은 다른 경보처는 아직 정하지 않았다([ADR 0026](adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md) "아직 정하지 않은 것").
- `OnFailure=`만으로는 한 번 죽고 다시 뜬 경우를 알릴 수 없다. systemd는 `Restart=`로 다시 뜨는 동안 유닛을 failed로 보지 않고 재시작 한도를 넘긴 뒤에야 `OnFailure=`를 부른다. 그래서 `ExecStopPost=`가 비정상 종료마다 같은 경보 유닛을 부른다. 한도를 넘기면 두 경로가 모두 불러 경보 줄이 두 번 나올 수 있다.
- 유닛은 자식에 `nice`·`ionice`를 거는 데몬의 동작을 막지 않는다. `finalize` 자식은 `nice -n 10 ionice -c 3`로 뜨므로 `nice`와 `ionice`(util-linux)가 `PATH`에 있어야 한다. 없으면 데몬이 경보를 남기고 그대로 띄운다.
- `OOMPolicy=continue`는 정리 자식이 메모리 부족으로 죽어도 데몬과 다른 자식을 함께 내리지 않게 한다.
- 시각은 모두 KST다. PC의 시간대와 상관없다.
- 원문 보관 기간(기본: 처음 10관측일은 7관측일, 그 뒤는 1관측일)은 `ExecStart=` 줄 끝에 `--keep-early 7 --keep 1 --early-period 10` 꼴로 더해 바꾼다. 유닛은 기본 값을 쓰므로 그대로 둬도 된다. 바꾸면 `systemctl --user daemon-reload` 뒤 데몬을 다시 띄운다. 값이 틀리면 데몬은 종료 코드 2로 뜨지 않고, 유닛은 이를 다시 띄우지 않는다.

### 설치

1. **빌드한다.** 사용자가 직접 실행할 파일은 일반 Cargo로 만든다. DuckDB가 함께 빌드된다. 처음 빌드는 길다.

   ```sh
   cargo build --locked --release -p collector
   install -D -m 755 target/release/collector ~/.local/bin/collector
   ```

2. **저장소 밖 설정을 만든다.** 아래 "키 목록 설정과 비밀값 파일", "공공데이터포털 서비스 키"를 따른다.
3. **유닛을 복사한다.** 유닛의 `Environment=` 줄이 사용자가 고치는 자리다.

   | 변수 | 뜻 | 기본 |
   |---|---|---|
   | `VALLY_KEYS` | 키 목록 설정 파일 | `~/.config/vally/collector-keys.json` |
   | `VALLY_DATA` | 데이터 폴더(원문, 저장소, 계획, 달력) | `~/vally-data/hoga` |
   | `VALLY_STATE` | 상태 폴더(토큰, 잠금, 상태 소켓 `supervise.sock`) | `~/.local/state/vallythevally/collector` |
   | `VALLY_HOLIDAY_KEY` | 특일정보 서비스 키 파일 | `~/.config/vally/holiday-service-key` |

   실행 파일을 `~/.local/bin/collector`가 아닌 곳에 두었으면 `ExecStart=`의 경로를 고친다. 데이터 폴더가 큰 디스크에 있어야 한다("저장 위치와 디스크").

   ```sh
   mkdir -p ~/.config/systemd/user
   cp deploy/systemd/vally-collector.service deploy/systemd/vally-collector-alert.service ~/.config/systemd/user/
   install -D -m 755 deploy/systemd/vally-collector-alert-telegram ~/.local/bin/vally-collector-alert-telegram
   systemctl --user edit --full vally-collector.service
   systemd-analyze --user verify ~/.config/systemd/user/vally-collector.service
   ```

4. **켠다.** 사용자가 로그아웃해도 서비스가 돌도록 linger를 켠다. 켜기 전에 아래 "키 목록 설정과 비밀값 파일"의 점검 명령으로 설정이 읽히는지 본다.

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now vally-collector.service
   loginctl enable-linger "$USER"
   ```

   07:20 전에 켜면 그날 일정을 처음부터 돈다. 장중에 켜는 것도 되지만(계획이 있으면 그것을 쓴다) 위 "중간에 뜬 데몬"을 읽고 한다. 켜는 것은 아래 "데몬 재시작 규칙"을 따른다.

### 키 목록 설정과 비밀값 파일

비밀값은 유닛에 적지 않는다. 유닛은 키 목록 설정 파일과 서비스 키 파일의 경로만 가리킨다. 키 목록 설정의 형식과 읽을 때의 검사는 위 "키 목록 설정"을 따른다.

1. **키마다 비밀값 파일을 만든다.** 저장소 밖에 두고 권한은 600이다. 권한에 그룹·다른 사용자 비트가 있으면 데몬이 읽지 않는다.

   ```sh
   install -d -m 700 ~/.config/vally
   install -m 600 /dev/null ~/.config/vally/collect-01.env
   printf '%s\n' 'VALLY_COLLECTOR_APP_KEY=<앱키>' 'VALLY_COLLECTOR_APP_SECRET=<시크릿>' >> ~/.config/vally/collect-01.env
   ```

   이 키는 주문도 넣을 수 있는 실계좌 키다. 저장소, 이슈, 로그에 적지 않는다. 앱 서버의 키(`VALLY_KIWOOM_APP_KEY`), hoga-ops의 키와 겹치면 안 된다. 같은 키를 두 곳에서 쓰면 서로 연결을 끊고 발급이 겹치면 계정 단위 잠금(8050)이 걸린다. 수집기는 hoga-ops의 키를 알 수 없으니 직접 대조한다.
2. **앱키 해시를 구한다.** 해시는 앱키의 SHA-256이다. 파일에서 바로 구해 앱키가 화면과 셸 기록에 남지 않게 한다.

   ```sh
   printf 'sha256:%s\n' "$(sed -n 's/^VALLY_COLLECTOR_APP_KEY=//p' ~/.config/vally/collect-01.env | tr -d '\n' | sha256sum | cut -d' ' -f1)"
   ```

3. **키 목록 설정 `~/.config/vally/collector-keys.json`에 키를 적는다.** 예비 키가 정확히 하나여야 한다. 필요한 키 수는 [ADR 0026](adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md)의 "키"를 따른다(등록할 종목 수 ÷ 190을 올림한 수에 예비 키 하나). 아직 없는 키는 `"active": false`로 적어 둘 수 있다. 권한은 600을 권한다.
4. **설정이 읽히는지 점검한다.** 데몬의 시작 단계는 인수와 키 목록을 먼저 읽는다. 날짜를 주면 그날 계획 파일이 없어 끝나지만 키 목록 검사는 그 앞에서 끝난다. 키 목록이 틀리면 `supervise:` 뒤에 키 이름과 이유가 나온다(비밀값은 나오지 않는다). `plan/19990104.json를 읽을 수 없습니다`에서 멈추면 설정은 읽힌 것이다(종료 코드 2). 키움에는 아무것도 보내지 않는다.

   ```sh
   collector supervise --keys ~/.config/vally/collector-keys.json --data ~/vally-data/hoga --state ~/.local/state/vallythevally/collector --date 19990104
   ```

5. **키움 포털에 지금 공인 IP를 등록한다.** 수집 키 모두가 대상이다. 미등록이면 토큰 발급이 8050으로 거절돼 그 키가 멈추고 몫이 예비 키로 넘어간다([ADR 0004](adr/0004-dedicated-kiwoom-app-key.md)). 공인 IP가 바뀌면(공유기 재시작, 회선 갱신) 모든 키를 다시 등록해야 한다.

### 공공데이터포털 서비스 키

데몬은 한국천문연구원 특일정보로 휴장일을 판단한다. 공공데이터포털에서 "특일 정보" 활용 신청을 해 서비스 키를 받는다. 키 파일에는 **Decoding 키**를 적는다(Encoding 키는 이중으로 인코딩돼 서비스 오류가 난다).

```sh
install -m 600 /dev/null ~/.config/vally/holiday-service-key
read -rs HOLIDAY_KEY && printf '%s' "$HOLIDAY_KEY" > ~/.config/vally/holiday-service-key; unset HOLIDAY_KEY
```

- 키 파일을 읽지 못해도 데몬은 뜬다. 그날은 캐시만 쓰고 경보(`stage_failed`)를 낸다. 캐시도 없는 해의 날짜는 판단이 "모름"이라 관측일로 보고 돈다.
- 처음 켜기 전에 응답 모양을 한 번 직접 확인한다. 절차는 위 "특일정보 첫 실제 호출 확인"이다.
- 임시공휴일, 임시 휴장, 개장 시각이 바뀌는 날(수능일)은 `<데이터 폴더>/calendar/overrides.json`에 적는다. 형식은 위 "관측일 판단"이다. 데몬은 07:20에 이 파일을 읽으므로 그날 아침 전에 고쳐 두면 재시작이 필요 없다.

### 키를 더하는 절차

키는 필요할 때 확보해 목록에 더한다. 키 목록은 데몬이 시작할 때만 읽으므로 반영하려면 데몬을 다시 켜야 하고, 그 재시작은 아래 "데몬 재시작 규칙"을 따른다. 오늘 장중에는 더하지 않는다.

1. 키움 포털에서 키를 확보하고 공인 IP를 등록한다.
2. 위 "키 목록 설정과 비밀값 파일"의 1~2로 비밀값 파일과 해시를 만들고, 키 목록 설정에 `"active": true`로 더한다. 예비 키는 그대로 하나다.
3. 위 점검 명령(4번)으로 목록이 읽히는지 본다.
4. 오늘 정리가 끝난 뒤 "데몬 재시작 규칙"으로 재시작한다.
5. 새 키는 **다음 날 아침 계획(07:35)부터** 든다. 오늘 이미 만든 계획에 끼지 않는다. 다음 날 `collector status`의 키 표에 새 키가 보이고 맡은 종목 수가 0이 아닌지 확인한다.

키를 빼거나 비활성으로 바꾸는 것도 같은 절차다.

### 데몬 재시작 규칙

설정을 바꾸거나 새 버전을 올리는 재시작은 **장이 끝나고 `finalize`가 끝난 뒤에만** 한다. 데몬이 꺼지면 자식이 함께 꺼져(`PR_SET_PDEATHSIG`) 모든 키의 수집이 끊기고, 정리 중이면 정리도 끊긴다.

1. `collector status`로 단계를 본다. 첫 줄의 단계가 `장 밖 대기`여야 한다. `장중 수집`, `마감 뒤 처리`, `정리 중`, `아침 준비`이면 기다린다.
2. 오늘이 관측일이었다면 정리가 끝났는지 확인한다. `<데이터 폴더>/store/<오늘 YYYYMMDD>/complete.json`이 있고 `store/<오늘>.tmp/`가 없어야 한다. 정리가 실패해 `complete.json`이 없으면 재시작해도 다음 날 시작이나 데몬 시작 때 정리를 다시 한다. 그래도 먼저 원인을 본다(위 "상태 보기").
3. 다음 날 07:20 전에 재시작한다. 07:20~07:55의 아침 준비 중에도 하지 않는다.

   ```sh
   systemctl --user restart vally-collector.service
   collector status --state ~/.local/state/vallythevally/collector
   ```

4. 새 버전을 올릴 때는 재시작 전에 실행 파일을 바꾼다(`install`로 덮어쓴다. 돌고 있는 파일을 덮어쓰는 것이므로 `cp`가 아니라 `install`을 쓴다).
5. 유닛 파일을 바꿨으면 `systemctl --user daemon-reload` 뒤에 재시작한다.

장중에 데몬이 뜻하지 않게 죽었을 때는 이 규칙의 예외다. systemd가 30초 뒤 다시 띄우고, 데몬은 오늘 계획 파일이 있으면 그것을 써서 자식을 다시 띄운다. 죽은 동안의 끊긴 구간은 사건 기록과 커버리지에 남는다.

### 텔레그램 경보

텔레그램 봇 설정을 두면 경보가 PC 앞에 없거나 앱 탭이 닫혀 있어도 텔레그램으로 온다. 실제 텔레그램으로 보내는 시험은 없다. 모든 시험은 루프백 가짜 텔레그램 서버로 돈다. 전송은 Bot API `sendMessage`(`POST <API 기준 주소>/bot<토큰>/sendMessage`, JSON 본문 `chat_id`와 `text`, 링크 미리보기 끔, `parse_mode` 없음)이고 글은 4096자로 자른다.

- **설정 파일.** `~/.config/vally/telegram`에 아래 두 줄을 적고 `chmod 600`으로 둔다. `bot_token`은 BotFather가 준 토큰, `chat_id`는 받을 대화의 번호(음수 가능)나 `@채널이름`이다.

  ```
  bot_token=123456:ABC-DEF
  chat_id=-1001234567890
  ```

  키 둘은 한 번씩만 나와야 하고(첫 값이 비어도 두 번 나오면 오류) 다른 키나 `키=값`이 아닌 줄은 오류다(빈 줄과 줄·키·값 끝의 ASCII 공백(스페이스, 탭, 수직 탭, 폼 피드, CR)은 무시한다. NBSP 같은 유니코드 공백, 값 속의 CR·NUL은 오류다). 토큰은 영문·숫자·`:`·`_`·`-`만 256자까지, `chat_id`는 128자까지 받는다(텔레그램의 실제 값보다 훨씬 넉넉한 상한이고, 데몬과 스크립트가 같은 값을 같게 거부한다). 데몬은 `--telegram <경로>`, 앱 서버(커넥터)는 `VALLY_COLLECTOR_TELEGRAM`, 경보 유닛은 `Environment=VALLY_TELEGRAM=`로 경로를 바꾼다. 경보 스크립트만 `VALLY_TELEGRAM_API`로 API 기준 주소(기본 `https://api.telegram.org`)를 바꿀 수 있고 시험이 가짜 서버를 가리킬 때 쓴다. 파일이 정말 없을 때만(ENOENT. 가리키는 곳이 없는 심볼릭 링크 포함) 텔레그램 보내기만 꺼지고 나머지는 그대로 돈다. 권한이 없거나(파일 권한 000) 심볼릭 링크가 고리를 이루거나 경로 중간이 파일이어서 열 수 없으면 꺼짐이 아니라 오류다. `-`로 시작하는 상대 경로도 그대로 파일 이름으로 읽는다. 권한이 600보다 넓거나(그룹·다른 사용자 비트가 있으면. 심볼릭 링크면 가리키는 파일의 권한을 본다) 형식이 틀리거나 열 수 없으면 데몬과 앱 서버는 시작하지 않고(데몬은 종료 코드 2) 경보 스크립트는 보내지 않고 실패한다. 오류 문구에는 파일 경로와 이유만 나오고 토큰은 나오지 않는다.
- **토큰은 어디에도 남기지 않는다.** 토큰이 들어간 요청 주소 전체가 비밀값이다. 로그, 오류 문구, 상태 API, 커밋에 나오지 않는다. `reqwest` 오류는 주소를 떼고 남기고, 경보 스크립트는 주소를 `curl`의 명령줄이 아니라 표준입력의 `--config -`로 넘긴다.
- **세 경로.**

  | 경로 | 보내는 곳 | 보내는 때 |
  |---|---|---|
  | 데몬 프로세스가 죽음 | 경보 유닛의 `vally-collector-alert-telegram` | 유닛이 불릴 때마다. 앱 서버가 함께 멈춰 있어도 간다 |
  | 데몬은 살아 있는데 응답 없음 | 앱 서버의 커넥터 | 판단이 `down`이나 `unresponsive`로 바뀔 때. 브라우저 알림과 같은 시점이고 정상 복귀는 보내지 않는다 |
  | 데몬의 일반 경보 | 감독 데몬 | 상태의 `alerts`에 새 경보가 생길 때 |

- **데몬 경보를 시끄럽지 않게 하는 규칙.** KST 하루에 같은 종류(`AlertKind`)는 한 번만 보낸다. 그날 같은 종류가 더 나면 개수만 세어 다음에 보내는 메시지 끝에 "같은 종류 경보가 더 있었습니다: 키 멈춤 2건"으로 붙이고, 남은 것은 그날 일정이 끝난 뒤(정리 다음) 한 번에 보낸다. 상태의 `alerts`와 현황판에는 모두 그대로 남는다. 정보성인 `excluded`와 `plan_note`는 바로 보내지 않고 모아 두었다가 장중 수집이 시작될 때(계획이 선 뒤) 한 메시지로 보낸다. 날짜별로 텔레그램이 받아 준 종류와 계획 메모 문구는 `--state` 폴더(기본 `default_state_folder`)의 `telegram-ledger.json`에 남기고, 데몬이 같은 날 다시 시작하면 읽어서 같은 종류와 같은 계획 메모를 또 보내지 않는다. 기록은 보내기에 성공한 뒤에 하므로, 종료 때 큐에 남았거나 보내지 못한 경보는 재시작하면 다시 나간다. 재시작 뒤에 새로 생긴 계획 메모는 보낸 적 없는 문구라 마감 메시지로 나간다. 파일에는 그날 한 날짜만 담아 날짜가 바뀌면 덮어쓴다. 읽거나 쓰지 못하거나 깨져 있으면 경고만 남기고 처음부터 보낸다(알림을 잃는 것보다 중복이 낫다). 같은 종류의 더 난 개수는 파일에 남기지 않아 재시작하면 그 개수는 잃는다.
- **보내기 실패.** 텔레그램 서버가 없거나 오류를 내도 수집과 정리는 막히지 않는다. 경고 로그 한 줄만 남기고 그 메시지는 버린다. 텔레그램의 429는 응답의 `parameters.retry_after`(없으면 `Retry-After` 헤더)만큼 기다린 뒤 다시 보내고, 한 메시지에 네 번까지 시도한다. 기다릴 시간이 60초를 넘거나 `Duration` 범위를 넘으면 포기한다. 경보 스크립트도 응답 코드로 판정해 끝내 보내지 못하면(예: `Retry-After: 9999`인 429) 0이 아닌 종료 코드로 끝나고, 메시지의 개행·탭·제어 문자는 JSON에서 이스케이프한다. 앱 서버의 알림 큐가 밀려 알림을 건너뛰면 건너뛴 개수를 경고 로그로 남긴다. 보내기는 따로 도는 작업이 차례로 하므로 기다리는 동안에도 데몬은 일을 계속한다.
- **메시지 모양.** `[수집 경보] 09:00:05 KST · 키 멈춤 · collect-01를 멈췄습니다: ...` 한 줄이다. 앱키나 해시, 비밀값은 넣지 않는다. 링크 미리보기는 끄고 서식(`parse_mode`)은 쓰지 않는다.
- **범위.** `collector supervise --date`로 하루만 돌리는 시험용 실행은 텔레그램으로 보내지 않는다.
- **시험.** `tests/supervise_day.rs`(데몬 경보, 하루 한 번, 429, 서버 없음·오류, 로그에 토큰 없음, 계획 메모 묶음, 같은 날 재시작·깨진 기록), `tests/alert_unit.rs`(경보 유닛 스크립트를 가짜 서버로 확인하고, 같은 설정 파일을 Rust와 스크립트가 같게 받아들이거나 거부하는지 견준다), 서버의 `tests/collector_board.rs`(커넥터).

### 상태 보기

| 보려는 것 | 명령 |
|---|---|
| 오늘 단계, 키마다 상태, 경보 | `collector status --state <상태 폴더>` |
| 서비스가 떠 있는지 | `systemctl --user status vally-collector.service` |
| 데몬 로그 | `journalctl --user -u vally-collector -f` |
| 경보 | `journalctl --user -t vally-collector-alert` |
| 하루 일정, 인계, 재시작 기록 | `<데이터 폴더>/plan/<YYYYMMDD>.events.jsonl` |
| 정리 결과, 대조 | `<데이터 폴더>/store/<YYYYMMDD>/complete.json`, `verify.json` |

- `collector status`는 데몬의 상태 소켓을 읽는다. 소켓이 없으면 "데몬 꺼짐", 연결됐는데 5초 안에 답이 없으면 "데몬 응답 없음"이고 종료 코드는 1이다. 응답 모양은 [`collector-status-api.md`](collector-status-api.md)를 따른다.
- 앱 브라우저의 수집 현황판은 커넥터가 같은 상태를 읽어 보여 준다. 수집 관리 계정 허용 목록에 든 계정만 본다. 데몬 꺼짐이나 응답 없음이면 맨 위에 경고가 뜬다. 현황판은 읽기 전용이다.
- 경보는 상태의 `alerts`와 현황판에 나온다. 종류는 `observation_unknown`(관측일 판단 모름), `market_open_missing`(관측일인데 `0s`가 오지 않음), `stage_failed`(한 단계가 실패), `plan_note`(예비 키 없음 등)다.

### 저장 위치와 디스크

원문, 정리 결과, 계획, 달력은 모두 데이터 폴더 아래에 있다(위 "데이터 폴더", [`collector-store-format.md`](collector-store-format.md)). 토큰, 잠금, 상태 소켓은 상태 폴더에 있다. 둘 다 저장소 밖에 둔다.

**원문 지우기.** 하루 원문이 수십 GB라 사람이 지우지 않는다. `finalize --prune`이 두 조건을 **모두** 만족한 날의 원문만 지운다.

- 그날 `complete.json`이 있고 원문과 Parquet의 대조를 통과했다.
- 그날 원문에 든 모든 종류가 Parquet으로 정리됐다(`verify.json`의 `lines.unfinalized.total`이 0).

둘 중 하나라도 아니거나 판단할 수 없으면 지우지 않는다. 보관 기간은 지우기를 도는 날로 센다. 처음 정리 완료 표시를 쓴 날을 포함한 첫 10관측일은 7관측일이고 그 뒤는 1관측일이다. 설정 이름은 `finalize`의 인수다.

| 설정 | 뜻 | 기본 |
|---|---|---|
| `--keep-early` | 운영 첫 기간의 보관 관측일 | 7 |
| `--keep` | 그 뒤의 보관 관측일 | 1 |
| `--early-period` | 첫 기간의 관측일 수 | 10 |

- 감독 데몬은 이 세 값을 기본으로 `finalize`를 부르고 이를 바꾸는 데몬 옵션은 아직 없다. 값을 바꾸려면 코드(`ScheduleSettings`의 `retention`)가 바뀌어야 한다. 사람이 한 번 지우는 것은 `collector finalize --data <데이터 폴더> --date <오늘> --prune --keep-early N`처럼 직접 부른다.
- 지워지지 않고 남은 날과 그 까닭은 결과 파일 `<데이터 폴더>/store/prune.log.jsonl`에서 본다. `action`이 `kept`인 줄의 `reason`이 까닭이다(`no_complete`, `complete_unreadable`, `verification_failed`, `unfinalized_count_missing`, `unfinalized`, `within_retention`, `observation_unknown`).

  ```sh
  tail -n 20 ~/vally-data/hoga/store/prune.log.jsonl
  grep '"action":"kept"' ~/vally-data/hoga/store/prune.log.jsonl | grep -v within_retention | tail
  ```

- `observation_unknown`은 달력 캐시가 없어 관측일을 못 센 것이다. 서비스 키 파일을 점검하고 캐시(`calendar/holidays-<YYYY>.json`)가 채워지면 풀린다. 원문을 잃는 쪽이 아니라 남기는 쪽으로 실패한 것이다.
- 지울 수 있는 조건을 채우지 못한 날의 원문을 손으로 지우지 않는다. 그 날의 원문은 다시 정리할 유일한 근거다.

**하루 양 어림.** 종목 약 2,600개 기준으로 [ADR 0026](adr/0026-collector-supervisor-collects-common-and-preferred-stocks.md)의 "하루 원문 양과 회선"은 원문(zstd 9)이 하루 19~34GB, 모든 FID Parquet이 15~28GB라고 어림한다. 소형주가 많아 실제는 더 작을 것이고 정규장 하루를 재서 확인해야 한다. 첫 기간(7관측일 보관)에는 원문이 최대 약 240GB까지 쌓이고, Parquet은 지우지 않으므로 관측일마다 15~28GB씩 는다(1년 약 250관측일이면 4~7TB). 원문 지우기는 Parquet을 줄이지 않는다.

**디스크가 모자랄 때.**

1. `collector status`의 디스크 사용량과 `df -h <데이터 폴더>`로 어디가 찼는지 본다. 원문(`raw/`)인지 정리 결과(`store/`)인지 `du -sh <데이터 폴더>/*`로 가른다.
2. 원문이 쌓였으면 `prune.log.jsonl`에서 지워지지 않은 까닭을 본다. `unfinalized`나 `verification_failed`가 까닭이면 `collector finalize --data <데이터 폴더> --date <그날> --verify-only`로 대조를 다시 확인하고, 원인을 고쳐 그날을 다시 정리한 뒤 지우기가 돌게 한다. 정리 중 `store/<날짜>.tmp/.spill/`도 임시로 크게 쓴다.
3. 정리 결과가 차면 오래된 `store/<YYYYMMDD>/` 폴더를 다른 디스크로 옮긴다. 앱이 읽는 곳이므로 옮긴 날을 앱이 못 읽게 된다는 점을 알고 한다. 데이터 폴더 전체를 옮길 때는 데몬을 "데몬 재시작 규칙"대로 끄고 `VALLY_DATA`를 바꾼다.
4. 장중에 디스크가 차면 원문 쓰기가 실패해 수집이 끊길 수 있다. 그 전에 정리하려고 오늘 원문이나 `store/<오늘>.tmp/`를 지우지 않는다.

### 실측

한 공인 IP에서 WebSocket 세션 15개가 되는지, 토큰 발급을 키 여럿에 잇달아 불러도 되는지는 아직 재 보지 않았다. 사용자가 장중에 직접 재는 절차는 [`collector-session-probe.md`](collector-session-probe.md)에 있다. 정규장 하루의 원문 양과 회선, 정리 시간도 실제 운영 첫 날에 재서 위 어림을 고친다.

## 실제 수집 절차

사용자가 장중에 직접 따라 한다. 자동 시험과 자동 작업은 실제 키움에 접속하지 않는다. 한 IP에서 세션 여러 개와 연속 토큰 발급을 재는 절차는 [`collector-session-probe.md`](collector-session-probe.md)에 있다.

1. **수집기 전용 키를 저장소 밖 파일에 둔다.** 권한은 600이다.

   ```sh
   install -m 600 /dev/null ~/.config/hoga-collector.env
   printf '%s\n' 'VALLY_COLLECTOR_APP_KEY=<수집기 전용 앱키>' 'VALLY_COLLECTOR_APP_SECRET=<그 시크릿>' >> ~/.config/hoga-collector.env
   export VALLY_COLLECTOR_ENV_FILE=$HOME/.config/hoga-collector.env
   ```

   이 키는 주문도 넣을 수 있는 실계좌 키다. 저장소, 이슈, 로그에 적지 않는다.
2. **키가 겹치지 않는지 확인한다.** 앱 서버의 `VALLY_KIWOOM_APP_KEY`와 같으면 `collect`가 시작하지 않는다. 돌고 있는 hoga-ops의 키(`KIWOOM_APP_KEY_2`~`5`)와 같은지는 수집기가 알 수 없으니 직접 대조한다. 같은 키를 두 곳에서 쓰면 서로 연결을 끊고, 발급이 겹치면 계정 단위 잠금(8050)이 걸린다.
3. **키움 포털에 지금 공인 IP가 등록돼 있는지 확인한다.** 미등록이면 토큰 발급이 8050으로 거절되고 수집기가 멈춘다.
4. **실행 파일을 빌드한다.** 사용자가 직접 실행할 파일은 일반 Cargo로 만든다. DuckDB가 함께 빌드돼 `libduckdb.so` 없이 돈다. 처음 빌드는 길다.

   ```sh
   cargo build --locked -p collector
   ```

   `python3 scripts/dev.py cargo build -p collector`는 빠르지만 DuckDB를 따로 둔 빌드라 `$PWD/target/debug/libduckdb.so`가 있어야 실행된다.
5. **수집을 켠다.** 07:55쯤 켜고 20:00 뒤에 끈다. 종목은 20개 이하로 하고, KRX에만 상장된 종목 1~2개와 ETF를 섞는다(플랜 문서의 결정 2).

   ```sh
   target/debug/collector collect --data data/hoga --items 005930,000660,069500
   ```

   로그에 `수집을 시작합니다`가 나오면 REG까지 끝난 것이다. 1분마다 받은 프레임 수와 바이트 수가 찍힌다. 끄려면 SIGINT(Ctrl-C)나 SIGTERM을 보낸다. 멈췄다는 메시지와 함께 0이 아닌 코드로 끝나면 위 "끝나는 경우와 종료 코드"의 할 일을 한다.
6. **구간 파일을 함께 만들고 화면을 띄운다.** 다른 터미널에서 같은 `--data`로 켠다. 자세한 인수는 [build와 verify](#build와-verify), [serve와 복기 화면](#serve와-복기-화면)을 본다.

   ```sh
   target/debug/collector build --data data/hoga --follow
   target/debug/collector serve --data data/hoga
   ```

   브라우저에서 `serve`가 알려 주는 `127.0.0.1` 주소를 연다.
7. **장이 끝난 뒤.** `collect`를 끄고 구간 파일을 마저 만든 다음 원문과 대조한다. 원문은 지우지 않는다.

   ```sh
   target/debug/collector build --data data/hoga
   target/debug/collector verify --data data/hoga
   ```

8. **그날 재 볼 것.**
   - 정규장 `0D` 초당 메시지 수와 구간 파일 크기: `build` 요약과 `spans/<날짜>/index.json`의 행 수·바이트 수.
   - 10배속 재생에서 60fps 유지 여부: 화면 구석의 프레임 간격 p95.
   - KRX에만 상장된 종목을 `_AL`로 등록했을 때의 `0D`·`0E` 동작: 원문 파일.
   - 네 흐름(호가·체결·프로그램매매·거래원)이 한 화면에 함께 보이는지.
   - 끊긴 구간이 있었다면 원문의 `down`·`live` 줄과 화면의 "수집 끊김" 표시가 맞는지.
