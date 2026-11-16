# 구간 파일 형식 v1

구간 파일은 한 종목의 5분 동안의 호가·체결·프로그램매매·거래원을 열 단위 int32 차분으로 담는다. `crates/hoga-format`이 인코더와 디코더를 맡는다. 이 문서만 보고 다른 언어의 디코더를 쓸 수 있어야 한다. 계획은 [`plans/hoga-replay-prototype.md`](plans/hoga-replay-prototype.md)의 "공유 계약"이다.

이 문서가 다루는 것은 압축을 푼 바이트 열이다. brotli q11 압축, 파일 이름, 폴더 배치는 다루지 않는다. 값은 모두 리틀 엔디언이다.

## 바이트 배치

```
머리
  magic        4바이트  "HOGA"
  version      u16     1
  date         u32     YYYYMMDD 십진수 (20260720)
  start_minute u16     구간 시작. KST 자정부터의 분
  length_min   u16     구간 길이(분). 프로토타입은 5
  symbol_len   u8      종목 글자 수 (0~255)
  symbol       ASCII   등록한 글자 그대로 (005930_AL)
  stream_count u8      흐름 수
흐름 목록 (흐름마다, stream_count번)
  kind         u8      흐름 종류
  column_count u8      열 수
  rows         u32     행 수
  body_bytes   u32     본문 바이트 수. rows × column_count × 4
  delta_flags  ceil(column_count / 8)바이트
                       열 i가 차분이면 i/8번째 바이트의 i%8 비트(최하위 비트가 0)가 1. 남는 비트는 0
채움
  흐름 목록이 끝난 위치가 4의 배수가 되도록 0 바이트를 0~3개
본문 (흐름 목록 순서대로)
  열 순서대로, 열마다 rows × i32
```

본문은 4바이트 경계에서 시작하고 흐름마다 크기가 4의 배수라 모든 흐름의 본문이 4바이트 경계에서 시작한다. 압축을 푼 `ArrayBuffer`에서 `new Int32Array(buffer, byteOffset, rows)`로 열을 복사 없이 읽을 수 있다. 본문의 시작 위치는 `전체 길이 − 본문 바이트 수의 합`이다.

흐름 목록 순서는 인코더가 받은 순서다. 같은 종류는 한 번만 들어간다. 행이 0개인 흐름도 목록에 들어가고 본문은 0바이트다. 흐름이 하나도 없는 파일도 형식으로는 올바르다.

## 차분

차분 열은 첫 값을 그대로, 이후 값은 직전 행과의 차를 `i32` 감싸기 연산으로 저장한다.

```
stored[0] = value[0]
stored[r] = (value[r] - value[r-1]) mod 2^32, i32로 해석   (r ≥ 1)
```

디코더는 누적합으로 되돌린다. `value[r] = (value[r-1] + stored[r]) mod 2^32`를 `i32`로 해석한다. 이 과정에서 `i32` 최솟값 다음에 최댓값이 오는 열도 정확히 돌아온다. JS에서는 `(a + b) | 0`이 같은 연산이다. 차분하지 않는 열은 저장한 값이 곧 값이다.

인코더는 값이 `i32` 범위(−2147483648 ~ 2147483647)를 넘으면 흐름·열·행·값을 담은 오류를 돌려주고 바이트를 내지 않는다.

## 흐름 종류와 열

열은 아래 순서로 저장한다. 열 이름은 `crates/hoga-format`의 `StreamKind::columns()`가 같은 순서로 돌려준다.

| 흐름 | kind | 열 (순서대로) | 차분 |
|---|---|---|---|
| `book` | 1 | `recv_ms`, `t_s`, `ask_px1`~`ask_px10`, `bid_px1`~`bid_px10`, `ask_qty1`~`ask_qty10`, `bid_qty1`~`bid_qty10`, `ask_total`, `bid_total` (44열) | 전부 |
| `trades` | 2 | `recv_ms`, `t_s`, `price`, `qty`, `venue` (5열) | `recv_ms`, `t_s`, `price` |
| `program` | 3 | `recv_ms`, `t_s`, `sell_qty`, `sell_amt`, `buy_qty`, `buy_amt` (6열) | 전부 |
| `broker` | 4 | `recv_ms`, `sell_code1`~`5`, `buy_code1`~`5`, `sell_qty1`~`5`, `buy_qty1`~`5` (21열) | `recv_ms` |
| `gaps` | 5 | `from_ms`, `to_ms` (2열) | 없음 |

열 번호는 위 순서의 0부터다. `book`에서 `ask_px1`은 2, `bid_px1`은 12, `ask_qty1`은 22, `bid_qty1`은 32, `ask_total`은 42, `bid_total`은 43이다. `broker`에서 `sell_code1`은 1, `buy_code1`은 6, `sell_qty1`은 11, `buy_qty1`은 16이다.

- `recv_ms`, `from_ms`, `to_ms`는 KST 자정부터의 밀리초다. `t_s`는 키움 `HHmmss`를 자정부터의 초로 바꾼 값이다.
- `trades.qty`는 부호를 그대로 둔다(양수 매수, 음수 매도). `venue`는 `KRX` 1, `NXT` 2, 그 밖 0이다.
- `program`의 금액은 백만원 단위다.
- 행은 `recv_ms` 오름차순이고 같으면 받은 순서다. 형식은 이 순서를 검사하지 않는다.
- 이월 행: `book`, `program`, `broker`의 첫 행은 구간 시작 전 마지막 행일 수 있다. 이때 `recv_ms`가 `start_minute × 60000`보다 작다. 이월 행인지는 이 비교로 안다.
- `gaps`는 끊긴 구간을 이 파일의 구간으로 잘라 담는다.

## 디코더가 확인하는 것

하나라도 어긋나면 오류로 끝낸다. 패닉하지 않고, 행 수가 커도 실제 바이트가 있는 만큼만 메모리를 잡는다.

1. magic이 `HOGA`다.
2. version이 1이다. 다른 버전은 받지 않는다.
3. 종목이 ASCII다.
4. 흐름 종류가 1~5이고 같은 종류가 두 번 들지 않았다.
5. 열 수가 종류의 규격과 같다.
6. 차분 비트가 규격과 같다(남는 비트 포함).
7. `body_bytes`가 `rows × column_count × 4`와 같다.
8. 채움 바이트가 모두 0이다.
9. 본문이 목록이 말한 길이만큼 있고, 그 뒤에 남는 바이트가 없다.

Rust 쪽 오류는 `DecodeError`다. 읽는 도중 파일이 끝나면 `Truncated`다.

## 인코더가 확인하는 것

- 종목이 ASCII이고 255자 이하다.
- 같은 종류의 흐름이 한 번만 있다.
- 열 수가 종류의 규격과 같고, 모든 열의 길이가 같다.
- 모든 값이 `i32` 범위 안이다. 오류가 흐름·열·행·값을 알려 준다.
- 본문 바이트 수가 `u32`에 들어간다.

## 기준 파일

`crates/hoga-format/tests/fixtures/` 아래에 있다. 새 디코더는 이 둘로 확인한다.

- `span-v1.hoga`: 압축하지 않은 v1 구간 파일(1188바이트).
- `span-v1.json`: 같은 내용. 머리 값(`date`, `start_minute`, `length_minutes`, `symbol`)과 `streams` 배열이 있고, 흐름마다 `kind`(흐름 이름)와 `columns` 배열(`name`, `values`)이 있다. 열은 저장 순서다. 값은 차분을 풀고 난 값이다.

기준 파일에는 다섯 흐름이 모두 있고, 음수 값, `i32` 최솟값·최댓값, 차분이 감싸는 열(`book`의 `ask_total`, `bid_total`), 행이 0개인 `gaps`, `book`·`program`·`broker`의 이월 행이 있다. 값은 지어낸 것이다.

Rust 시험(`crates/hoga-format/tests/format.rs`)은 JSON의 값을 인코딩한 바이트가 `.hoga`와 바이트 단위로 같은지, `.hoga`를 디코딩한 값이 JSON과 같은지 확인한다. 기준 파일은 Rust 인코더가 아니라 이 문서의 규격을 따로 구현한 스크립트로 만들어 두 구현이 같은 바이트를 낸다는 것도 확인했다.

## 형식을 바꿀 때

흐름이나 열을 더하거나 바꾸면 version을 올린다. 디코더는 모르는 버전을 받지 않는다.
