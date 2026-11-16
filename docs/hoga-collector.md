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
- **끊긴 구간**(`gaps`): 원문의 사건 줄에서 구한다. `down`부터 다음 `live`까지다. `live` 앞에 `down`이 없으면 그 앞 마지막 줄의 시각부터다(그날 첫 줄이 `live`면 끊김이 아니다). 끝나지 않은 끊김은 그날 원문의 마지막 줄 시각까지다. 두 번째 `down`은 첫 `down`의 시작을 바꾸지 않는다. 구간으로 잘라(`[구간 시작, 구간 끝]`) 그 구간의 모든 종목 파일에 `gaps` 흐름으로 담는다. 구간 끝에서 끝나는 끊김은 다음 구간에 넣지 않는다.
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

## serve와 복기 화면

작업 `hoga-serve`가 채운다.

## 실제 수집 절차

작업 `hoga-collect`가 채운다.
