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

작업 `hoga-collect`가 채운다.

## build와 verify

작업 `hoga-build`가 채운다.

## serve와 복기 화면

작업 `hoga-serve`가 채운다.

## 실제 수집 절차

작업 `hoga-collect`가 채운다.
