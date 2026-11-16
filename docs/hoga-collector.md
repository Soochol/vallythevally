# 호가 복기 수집기

`crates/collector`의 실행 파일 `collector`는 하위 명령 넷(`collect`, `build`, `verify`, `serve`)을 가진다. 계획은 [`plans/hoga-replay-prototype.md`](plans/hoga-replay-prototype.md), 구간 파일 형식은 [`hoga-format.md`](hoga-format.md)에 있다. 이 문서는 절마다 채우는 작업이 다르다.

## 데이터 폴더

`--data <폴더>`로 받고 기본은 `data/hoga`다. 네 하위 명령이 같은 인수를 쓴다.

```
data/hoga/
  raw/<YYYYMMDD>/<HHMM>-<NNN>.jsonl.zst          원문 파일
  spans/<YYYYMMDD>/index.json                     그날의 구간 파일 목록
  spans/<YYYYMMDD>/<종목>/<HHMM>-r<N>.hoga.br     구간 파일
  spans/<YYYYMMDD>/verified.json                  대조 결과
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
- 끊긴 구간은 `down`부터 다음 `live`까지다. `live` 앞에 `down`이 없으면(프로세스가 죽은 경우) 그 앞 마지막 줄의 시각부터다.

읽기는 `read_day(데이터 폴더, 날짜)`가 그날의 파일을 이름 순으로, 파일 안에서는 줄 순으로 `RawItem`을 준다.

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

`collector collect --data <폴더> --items <코드,코드,…>`가 수집기 전용 키로 키움 WebSocket에 붙어 원문 파일을 쓴다. 받은 프레임을 해석하지 않는다.

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
- **사건 줄.** REG 응답을 받으면 `live`를 쓴다. 닫힘, 전송 오류, 30초 동안 아무 메시지도 없음, 응답 시간 초과로 연결이 끝나면 까닭과 함께 `down`을 쓰고 다시 붙는다. 이미 `down` 상태에서 연결이 또 실패하거나 종료·멈춤이 오면 `down`을 더 쓰지 않는다(다음 `live`까지가 한 구간이다). `down`은 쓰는 즉시 flush한다. 연결 자체가 안 되거나 토큰을 못 받아 기다리는 동안도 `down`을 더 쓰지 않는다.
- **다시 붙기.** 쉬는 시간은 1, 2, 5, 10, 30초이고 끝 값을 계속 쓴다. `live` 뒤 60초 넘게 열려 있었으면 1초로 돌아간다. 다시 붙으면 LOGIN과 REG를 처음부터 한다.
- **flush.** 쓸 줄이 있으면 1초에 한 번 원문 파일을 flush한다.
- **현황 로그.** 1분마다 그 1분 동안 받은 프레임 수와 받은 글자의 바이트 수(압축 전, PING 제외), 시작 뒤 합계를 로그에 적는다.

### 끝나는 경우와 종료 코드

| 경우 | 하는 일 | 종료 코드 |
|---|---|---|
| SIGINT·SIGTERM | `down`(까닭 `종료`, 이미 `down` 상태면 생략)을 쓰고 원문 파일과 연결을 닫는다 | 0 |
| 인수·설정 오류 | 까닭을 표준 오류에 적는다 | 2 |
| 잠금을 못 잡음, 데이터 폴더를 못 만듦, 실행 환경 오류 | 까닭을 표준 오류에 적는다 | 1 |
| 멈춤 | `down`(까닭 `멈춤: …`, 이미 `down` 상태면 생략)을 쓰고 원문 파일을 닫은 뒤 까닭과 할 일을 표준 오류에 적는다. 스스로 다시 시도하지 않는다 | 1 |

멈추는 경우와 할 일:

| 멈춤 | 할 일 |
|---|---|
| 토큰 발급이 8050(지정단말기 인증 실패)으로 거절됨 | 키움 포털에서 지금 공인 IP가 등록돼 있는지, 반복 발급 잠금이 풀렸는지 확인한다 |
| 그 밖의 인증 차단, 토큰 파일 오류 | 앱키·시크릿과 계정 상태를 확인한다. 토큰 파일은 권한 600, 폴더는 700이어야 한다 |
| LOGIN 거절(토큰을 한 번 다시 받은 뒤에도 무효인 경우 포함) | 수집기 전용 키가 다른 프로세스와 겹치지 않는지 확인한다 |
| REG 거절(등록 한도, 두 번째 유량 제한 등) | `--items`의 종목 수와 코드를 확인한다 |
| 원문 파일을 쓰지 못함 | 디스크 공간과 권한을 확인한다 |

멈춘 뒤에는 고치고 `collector collect`를 다시 실행한다. 토큰 발급 간격은 토큰 파일에 남아 있어 다시 실행해도 지켜진다.

### 시험

`crates/collector/src/collect/`의 시험은 모두 합성 전송(`Transport`)과 채널로 만든 합성 연결을 쓰고, 멈춘 tokio 시간과 `Clock::fake`로 돌린다. 실제 키움에는 접속하지 않는다. 실제 WebSocket 어댑터는 루프백(`ws://127.0.0.1`) 시험 서버 하나로 LOGIN → REG → REAL 한 프레임 → 원문 파일까지 확인한다.

## build와 verify

작업 `hoga-build`가 채운다.

## serve와 복기 화면

작업 `hoga-serve`가 채운다.

## 실제 수집 절차

사용자가 장중에 직접 따라 한다. 자동 시험과 자동 작업은 실제 키움에 접속하지 않는다.

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
