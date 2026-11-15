# 호가 복기 최소 프로토타입 (2026-11-15)

작성일 2026-11-15. 승인 시점의 기록이며 구현 중 바뀐 것은 반영하지 않는다.

## 사용자가 풀려는 문제

사용자의 말(그대로): "그럼 최소 수집기에서 데이터를 브라우저에 보이는 과정을 최소 프로토타입으로 만들어보자."

최종 목표는 "호가 복기"다. 키움 REST·WS로 KRX·NXT 전 종목의 호가, 체결, 프로그램매매, 거래원을 모아 두고, 어느 종목이든 그날 그 초의 호가창을 바로 훑어보거나 다시 재생한다. 흐름은 `키움 WS → 저장 → 브라우저 → 보여주기`로 사용자가 확정했다.

이 플랜은 그 흐름 전체를 가장 작은 크기로 한 번 잇는다. 키 1개, 10~20종목, 종목마다 `_AL`(통합) 등록 하나에 `0B` 체결·`0D` 호가·`0w` 프로그램매매·`0F` 거래원을 함께 받는다.

```
collector collect   키움 WS → 원문 파일 (받은 JSON 그대로 + 수신 시각, zstd 3, 5분마다 새 파일)
collector build     원문 파일 → 구간 파일 (5분, 열 단위 int32 차분 + brotli q11)
collector verify    구간 파일을 다시 풀어 원문과 행 단위로 대조
collector serve     구간 파일과 복기 화면을 127.0.0.1에서 띄움 (Content-Encoding: br)
브라우저            종목·날짜 선택 → 시간 막대 이동·재생 → 호가 10단계, 최근 체결, 프로그램 순매수, 거래원 상위 5
```

## 지금 상태 (코드와 자료에서 확인한 것)

| 항목 | 상태 | 근거 |
|---|---|---|
| 워크스페이스 | 크레이트 넷(`domain`, `indicators`, `indicators-wasm`, `server`). `members`가 한 줄이다 | `Cargo.toml` |
| 키움 WS 세션 | 받은 프레임을 바로 해석하고 `0B`·`0J`만 다룬다. 연결을 주입하는 `Connector`는 비공개다 | `crates/server/src/kiwoom/stream.rs`, `crates/server/src/kiwoom/wire.rs`의 `RealType` |
| 토큰 발급 규칙 | `KiwoomRest::issue_token`이 발급 간격 10분, 8050 전체 멈춤, 토큰 파일 기록을 모두 지킨다. `KiwoomAuth`, `TokenFile`, `InstanceLock`, `Transport`는 공개다 | `crates/server/src/kiwoom/rest.rs`, `auth.rs`, `token_file.rs`, `transport.rs`, `crates/server/src/instance.rs` |
| 시험용 가짜 전송 | `rest::testing::FakeTransport`는 `#[cfg(test)]`라 다른 크레이트에서 못 쓴다. `Transport` trait을 직접 구현해야 한다 | `crates/server/src/kiwoom/rest.rs` |
| 개발 명령 | `python3 scripts/dev.py cargo …`가 `--locked --no-default-features`를 붙이고 준비된 DuckDB를 쓴다. `domain`·`indicators`가 아닌 패키지는 모두 DuckDB 환경을 받는다 | `scripts/dev.py`의 `cargo_command`, `needs_duckdb` |
| 병합 검사 | CI가 워크스페이스 전체에 `cargo clippy --all-targets -- -D warnings`와 루프백만 열린 `cargo test`를 돌린다. 새 크레이트의 시험도 여기에 든다 | `.github/workflows/ci.yml` |
| 브라우저 진단 선례 | `scripts/test-dart-ui.mjs`가 `web/package.json` 기준으로 Playwright를 불러 Chromium을 띄운다. `web/e2e` 밖이라 CI의 Playwright 실행에 들지 않는다 | `scripts/chromium.mjs`, `scripts/test-dart-ui.mjs` |
| 저장 위치 | `data/`는 이미 git에서 빠져 있다 | `.gitignore` |
| brotli·zstd | `brotli` 9.1.1은 `Cargo.lock`에 있다(`tower-http` 경유). `zstd`는 없다 | `Cargo.lock` |
| 실제 원문 채록 | `0D`는 2026-07-20 19:56:20~20:00:00 `005930_NX`·`000660_NX` 2,382건(항목 단위 줄). `0B`·`0w`·`0F`는 같은 날 10:27:55~10:32:55 다섯 종목(접미사 없음) 6,880·205·24건(WS 프레임 단위 줄, 프레임 하나에 항목 1~13개) | `/home/dev/.local/share/hoga-ops/data/research_capture/20260720/` |
| 채록에 없는 것 | `_AL` 등록 원문과 정규장 `0D` 원문은 어디에도 없다. 한 종목의 네 흐름이 같은 시각에 있는 원문도 없다 | 위 채록 |
| `_AL` 조사 문서 | 브랜치 `worktree-orderbook-collection-design`의 로컬 커밋 `40f33fb`에만 있다. `main`에는 없다 | `git branch -v` |

## 확정된 결정

- 흐름은 `키움 WS → 저장 → 브라우저 → 보여주기`다.
- 프로토타입은 키 1개, 10~20종목, `_AL` 등록 하나에 네 종류를 함께 받는다.
- 장중 원문은 해석하지 않고 수신 시각과 함께 zstd level 3으로 쓴다. 5분마다 새 파일이다.
- 복기에 쓰는 파일은 5분 단위, 열 단위 int32 차분, brotli q11이다. Parquet은 두지 않는다. 측정 근거는 아래 "측정으로 정한 것"에 있다.
- 파일 머리에 형식 버전을 둔다. 값이 int32를 넘으면 오류로 멈춘다. 다시 풀어 원문과 행 단위로 대조한 날만 원문을 지울 수 있다.
- 기존 웹 앱(`web/`)과 앱 서버(`vally-server`)의 동작은 바꾸지 않는다.
- hogaplay 데이터는 쓰지 않는다. 시험에는 hoga-ops가 키움에서 받아 둔 원문 채록을 쓴다(실제 키움 응답은 커밋할 수 있다, ADR 0008).
- 자동 시험과 자동 작업은 실제 키움에 접속하지 않는다. 실제 수집 하루는 사용자가 정한 뒤 직접 실행한다.

### 측정으로 정한 것

hoga-ops의 hogaplay 가공본 네 종목(2026-07-16)을 Chrome 157에서 처리해 고른 조합이다. 네트워크 시간은 계산값이다.

| 항목 | 정한 것 | 근거 (005930 하루) |
|---|---|---|
| 단위 | 5분. 호가·체결·프로그램·거래원을 한 파일에 | 파일 하나 압축 후 약 13KB. 첫 화면이 왕복 한 번 |
| 배치 | 열 단위 | 행 단위보다 압축 후 20~40% 작다 |
| 값 변환 | int32 차분. 들쭉날쭉한 열은 차분하지 않는다 | 하루치 복원 1.4ms, CPU 4배 감속 18ms. 가변길이 정수는 20% 작지만 감속 때 206ms |
| 압축 | brotli q11 | 가장 작고 최신 브라우저가 모두 푼다. 해제 0~8ms(하루치) |
| 크기 | 압축 없음 15.7MB → 차분+brotli 1.4MB | 호가+체결 |

## 스스로 정한 결정과 이유

1. **이름을 "구간 파일"과 "원문 파일"로 둔다.** 요청의 "묶음 파일"은 용어집의 **묶음**(도킹에서 탭으로 쌓인 창들)과 겹친다. 5분 단위 파일은 구간 파일(코드 이름 `span`), 장중에 쓰는 파일은 원문 파일(코드 이름 `raw`)이라 부른다. 용어집에 "호가 복기" 절을 더한다.
2. **새 크레이트는 둘이다.** `crates/hoga-format`(구간 파일 형식, 의존성 없음)과 `crates/collector`(실행 파일 `collector`, 하위 명령 `collect`·`build`·`verify`·`serve`). 요청의 제안과 같고 `verify`만 더했다. 대조를 `build`와 따로 돌릴 수 있어야 "대조한 날만 원문 삭제"를 지킬 수 있다.
3. **`collector`가 `server` 크레이트를 라이브러리로 쓴다.** 토큰 발급을 `KiwoomRest::issue_token`으로 하면 발급 간격 10분, 8050 전체 멈춤, 토큰 파일 규칙(ADR 0004·0009)을 새로 짜지 않는다. 반복 발급은 계정 단위 잠금을 부르므로 이 규칙은 베끼지 않고 그대로 쓴다. 대가로 `collector`가 DuckDB 빌드 설정을 따라간다. `collector`에 `bundled-duckdb` 기능과 빌드 스크립트(`libduckdb.so`를 찾는 rpath)를 `server`와 같은 모양으로 두어 개발 명령(`--no-default-features`)과 일반 Cargo가 모두 동작하게 한다. `kiwoom`을 따로 크레이트로 빼는 일은 프로토타입 뒤로 미룬다.
4. **WS 세션은 `collector` 안에 새로 쓴다.** 기존 세션은 프레임을 해석하고 `0B`·`0J`만 다룬다. 수집기는 `trnm`만 읽어 PING에 답하고 LOGIN·REG 응답을 가린 뒤, REAL 프레임은 받은 글자 그대로 쓴다. LOGIN 글자와 응답 판정은 `server::kiwoom::wire`의 공개 함수를 쓴다.
5. **수집기 설정은 앱 서버와 다른 이름을 쓴다.** 요청은 기존 `VALLY_TOKEN_PATH`·`VALLY_LOCK_PATH`에 다른 경로를 주자고 했다. 그러면 값을 빼먹었을 때 수집기가 앱 서버의 잠금과 토큰 파일을 잡는다. `VALLY_COLLECTOR_APP_KEY`, `VALLY_COLLECTOR_APP_SECRET`, `VALLY_COLLECTOR_TOKEN_PATH`, `VALLY_COLLECTOR_LOCK_PATH`, `VALLY_COLLECTOR_ENV_FILE`로 두고, 토큰과 잠금의 기본 경로를 `$XDG_STATE_HOME/vallythevally/collector/` 아래로 정한다. 환경에 `VALLY_KIWOOM_APP_KEY`가 보이고 수집기 키와 같으면 시작하지 않는다. 수집기와 앱 서버를 동시에 켤 수 있고, 같은 키를 두 곳에서 쓰는 실수를 시작할 때 막는다.
6. **원문 파일 형식을 한 줄 한 JSON으로 정한다.** 아래 "원문 파일" 절이 계약이다. 받은 글자를 `{"recv_ms":…,"msg":`와 `}` 사이에 그대로 끼워 넣으므로 값을 해석하지 않는다. hoga-ops 채록과 모양이 같아 채록을 그대로 시험 입력으로 옮길 수 있고, `zstdcat`으로 바로 읽힌다.
7. **끊긴 구간을 원문과 구간 파일에 모두 남긴다.** 수집기는 세션이 열릴 때와 끊길 때 사건 줄을 쓴다. `build`는 이를 구간 파일의 `gaps` 흐름으로 옮기고, 화면은 시간 막대와 호가창에 "수집 끊김"을 보인다. 표시가 없으면 끊긴 동안이 "호가가 그대로였다"로 보인다.
8. **구간 파일은 혼자서 그 구간의 화면을 그릴 수 있게 한다(이월 행).** `book`·`program`·`broker` 흐름은 구간 시작 전 마지막 행을 첫 행으로 싣는다. 5분 넘게 호가가 안 바뀐 종목도 파일 하나로 첫 화면이 나온다. 이 규칙이 없으면 화면이 앞 구간을 몇 개나 거슬러 받을지 알 수 없다. 그날 그 종목의 첫 행이 든 구간부터 마지막 행이 든 구간까지는 새 행이 없어도 빠짐없이 만든다.
9. **수량 0인 `0B`는 행으로 만들지 않는다.** 동시호가에서만 오고 체결이 아니다(용어집의 **체결**, 기존 `wire.rs`의 `AuctionOnly`와 같은 규칙). 건수는 `build` 요약에 적는다.
10. **예상체결가·예상체결량(`0D`의 `23`·`24`)과 `0E`는 구간 파일에 넣지 않는다.** 요청의 열 목록에 없다. 원문에는 남으므로 나중에 형식 버전을 올려 더할 수 있다.
11. **종목은 등록한 글자 그대로 다룬다(`005930_AL`).** 채록의 `005930_NX`와 `005930`도 서로 다른 종목으로 읽는다. 채록을 `_AL`인 것처럼 고치지 않는다. 그래서 자동 시험은 호가(`005930_NX`, 19:55 구간)와 체결·프로그램·거래원(`005930`, 10:25·10:30 구간)을 따로 확인한다. 네 흐름이 한 화면에 함께 보이는 것은 실제 수집에서 처음 확인한다.
12. **구간 파일은 장중 5분마다 확정한다(사용자 결정 4의 권장안).** `build`는 끝난 구간만 만들고 몇 번을 돌려도 결과가 같다. `--follow`가 이를 되풀이한다. 다시 만든 내용이 앞 판과 다르면 덮어쓰지 않고 판 번호를 올린 새 이름(`-r2`)으로 쓴다. 나중에 CDN에서 바뀌지 않는 파일로 다룰 수 있다.
13. **원문 삭제 명령은 만들지 않는다.** `verify`가 대조 결과 파일을 남기는 데까지다. 지우는 일은 사용자가 손으로 한다.
14. **복기 화면은 빌드 단계 없는 HTML·JS다.** `collector` 실행 파일에 넣어 내보낸다. React와 번들러를 쓰지 않고 외부 주소를 부르지 않는다. 기존 웹 앱과 파일이 겹치지 않는다.
15. **`serve`는 요청에 `br`이 없으면 풀어서 보낸다.** Chrome은 `http://127.0.0.1`에는 `br`을 알리지만 `curl`과 일부 환경은 알리지 않는다. 화면이 깨지는 대신 느린 길로 돌아간다.
16. **브라우저 확인은 `scripts/test-hoga-replay.mjs`로 하고 CI에는 넣지 않는다.** `web/e2e`에 넣으면 CI의 E2E가 Rust 실행 파일을 빌드해야 한다. 형식·해석·생성·내보내기·세션의 시험은 `cargo test`라 CI에 든다. 화면 확인을 CI에 넣는 일은 프로토타입을 제품으로 올릴 때 한다.
17. **조사 문서는 별도 PR로 `main`에 올린다.** 작업 `al-research-doc`가 로컬 커밋 `40f33fb`를 옮긴다. 다른 작업의 지시서는 필요한 FID를 직접 적어 두어 이 PR을 기다리지 않는다.
18. **명령줄 인수는 직접 읽는다.** 하위 명령 넷과 `--이름 값` 몇 개라 새 의존성(clap)을 들이지 않는다.
19. **ADR은 프로토타입 결과를 본 뒤에 쓴다(사용자 결정 5의 권장안).** 이 플랜 문서가 그동안의 기록이다. 아래 "ADR과의 관계"에 어긋나는 점을 적었다.

## 공유 계약

여러 작업이 함께 쓰는 형식이다. 작업 `hoga-format`이 `docs/hoga-format.md`에, 작업 `raw-parse`가 `docs/hoga-collector.md`에 옮겨 적고, 구현하다 바꾼 것은 그 문서에 남긴다.

### 데이터 폴더

`--data`로 받고 기본은 `data/hoga`다.

```
data/hoga/
  raw/<YYYYMMDD>/<HHMM>-<NNN>.jsonl.zst          원문 파일
  spans/<YYYYMMDD>/index.json                     그날의 구간 파일 목록
  spans/<YYYYMMDD>/<종목>/<HHMM>-r<N>.hoga.br     구간 파일
  spans/<YYYYMMDD>/verified.json                  대조 결과
```

날짜와 `HHMM`은 수신 시각의 KST 날짜와 5분 구간 시작이다. `<종목>`은 등록한 글자 그대로다.

### 원문 파일

- zstd level 3 스트림 하나다. 풀면 UTF-8 줄들이고 줄마다 JSON 객체 하나다.
- 줄의 종류는 셋이다.
  - 프레임: `{"recv_ms":<유닉스 ms>,"msg":<받은 글자 그대로>}`. 받은 글자에 줄바꿈 바이트가 있으면 지우고 쓴다(JSON 문자열 안에는 날것 줄바꿈이 올 수 없어 뜻이 같다).
  - 사건: `{"recv_ms":<유닉스 ms>,"event":"live"}` 또는 `{"recv_ms":…,"event":"down","reason":"…"}`. `live`는 LOGIN과 REG가 끝난 때, `down`은 세션이 끊기거나 수집기가 끝나는 때다.
  - JSON이 아닌 프레임: `{"recv_ms":…,"text":"<JSON 문자열로 감싼 글자>"}`.
- PING 프레임은 쓰지 않는다. LOGIN·REG 응답은 쓴다(비밀값이 없다). 보낸 LOGIN은 쓰지 않는다.
- 줄은 받은 순서다. 줄은 자기 `recv_ms`의 날짜 폴더와 5분 구간 파일에 들어간다.
- `<NNN>`은 000부터다. 프로세스가 어떤 구간 파일을 새로 열 때마다 아직 없는 가장 작은 번호를 쓴다. 있는 파일에 이어 쓰지 않는다.
- 1초에 한 번 이상 flush해서 그때까지 쓴 줄이 풀리게 한다. 읽는 쪽은 끝이 잘린 파일을 풀리는 데까지 읽고 잘린 줄을 버린 뒤 잘렸다고 알린다.
- 끊긴 구간은 `down`부터 다음 `live`까지다. `live` 앞에 `down`이 없으면(프로세스가 죽은 경우) 그 앞 마지막 줄의 시각부터다.

### 구간 파일 v1

brotli q11로 감싼 파일이다. 푼 내용은 모두 리틀 엔디언이다.

```
머리
  magic "HOGA" (4) · version u16 = 1 · 날짜 u32 (YYYYMMDD 십진수)
  구간 시작 u16 (KST 자정부터의 분) · 구간 길이 u16 (분, 5)
  종목 글자 수 u8 · 종목 ASCII · 흐름 수 u8
흐름 목록 (흐름마다)
  종류 u8 · 열 수 u8 · 행 수 u32 · 본문 바이트 수 u32 · 차분 여부 비트 (열 i는 i/8번째 바이트의 i%8 비트)
채움
  본문이 4바이트 경계에서 시작하도록 0으로 채운다
본문 (흐름 목록 순서, 흐름 안에서는 열 순서)
  열마다 행 수 × i32. 차분 열은 첫 값 그대로, 이후는 직전 행과의 차(넘치면 2^32로 돈다)
```

디코더는 magic, 버전, 종류별 열 수, 길이의 합, 남는 바이트를 확인하고 어긋나면 오류로 끝낸다.

| 흐름 | 종류 | 열 (순서대로) | 차분 |
|---|---|---|---|
| `book` | 1 | `recv_ms`, `t_s`, `ask_px1`~`10`, `bid_px1`~`10`, `ask_qty1`~`10`, `bid_qty1`~`10`, `ask_total`, `bid_total` (44열) | 전부 |
| `trades` | 2 | `recv_ms`, `t_s`, `price`, `qty`, `venue` (5열) | `recv_ms`, `t_s`, `price` |
| `program` | 3 | `recv_ms`, `t_s`, `sell_qty`, `sell_amt`, `buy_qty`, `buy_amt` (6열) | 전부 |
| `broker` | 4 | `recv_ms`, `sell_code1`~`5`, `buy_code1`~`5`, `sell_qty1`~`5`, `buy_qty1`~`5` (21열) | `recv_ms` |
| `gaps` | 5 | `from_ms`, `to_ms` (2열) | 없음 |

- `recv_ms`, `from_ms`, `to_ms`는 KST 자정부터의 밀리초다. `t_s`는 키움 `HHmmss`를 자정부터의 초로 바꾼 값이다.
- 행은 `recv_ms` 오름차순이고 같으면 받은 순서다.
- 이월 행: `book`·`program`·`broker`의 첫 행은 구간 시작 전 마지막 행일 수 있다. 이때 `recv_ms`가 구간 시작보다 작다. 같은 날 안에서만 넘긴다.
- `gaps`는 끊긴 구간을 이 파일의 구간으로 잘라 담는다.

### 키움 FID와 열

| 흐름 | 원문 종류 | 열 ← FID |
|---|---|---|
| `book` | `0D` | `t_s` ← `21`. `ask_px`i ← `40+i`. `bid_px`i ← `50+i`. `ask_qty`i ← `60+i`. `bid_qty`i ← `70+i`. `ask_total` ← `121`. `bid_total` ← `125` |
| `trades` | `0B` | `t_s` ← `20`. `price` ← `10`. `qty` ← `15`(부호 그대로: 양수 매수, 음수 매도). `venue` ← `9081`(`KRX` 1, `NXT` 2, 그 밖 0) |
| `program` | `0w` | `t_s` ← `20`. `sell_qty` ← `202`. `sell_amt` ← `204`. `buy_qty` ← `206`. `buy_amt` ← `208`. 금액은 백만원 |
| `broker` | `0F` | `sell_code`i ← `145+i`. `buy_code`i ← `155+i`. `sell_qty`i ← `160+i`. `buy_qty`i ← `170+i` |

- 가격(`10`, `41`~`60`)은 앞의 `+`·`-`·공백을 떼고 절댓값으로 읽는다. 부호는 등락 표시다.
- 수량과 금액은 부호를 포함한 정수로 읽는다.
- 빈 값과 없는 FID는 0으로 읽는다(hoga-ops 파서와 같다). 시각(`20`, `21`)이 없거나 숫자가 아닌 글자가 있으면 읽기 오류다.
- 거래원 이름(`141`~`145`, `151`~`155`)은 구간 파일에 넣지 않고 `index.json`의 `members`(회원사 코드 → 이름)에 모은다.
- `0B`의 `15`가 0이면 행을 만들지 않는다. 네 종류가 아닌 항목(`0E` 등)은 세고 넘어간다.

### `index.json`

날짜마다 하나다. 종목마다 구간의 시작(`HHMM`), 지금 판의 파일 이름, 흐름별 행 수, 압축 후 바이트 수를 적는다. `members`와 형식 버전도 여기에 둔다. 정확한 모양은 작업 `hoga-build`가 정해 `docs/hoga-collector.md`에 적는다.

## ADR과의 관계

프로토타입은 지금 ADR 두 개의 범위를 벗어난다. 승인하면 아래를 알고 진행하는 것이다.

- **ADR 0003(시세는 수집하지 않고 디스크에 남기지 않는다).** 수집기는 시세를 디스크에 모은다. ADR 0003의 적용 범위는 "차트, 현재가처럼 화면에 보여 주는 시세"이고 스크리너 저장소는 ADR 0010으로 따로 뺐다. 호가 복기도 같은 식의 새 범위가 필요하다.
- **ADR 0004(실계좌 앱키 하나).** 수집기는 두 번째 키를 쓴다. "토큰을 가진 프로세스는 언제나 하나"는 키마다 지킨다(수집기 전용 잠금과 토큰 파일).
- **ADR 0001(운영자 한 명만 쓴다).** 프로토타입은 `127.0.0.1`에서만 열려 이 결정을 지킨다. 사용자가 말한 대중 서비스는 키움 약관 제5조③(시세의 제3자 제공 금지) 때문에 시세 원천을 정식 계약 원천으로 바꾸기 전에는 할 수 없다. 이 플랜의 범위 밖이다.

## 작업 나누기

| 순서 | 작업 ID | 내용 | 기다리는 작업 |
|---|---|---|---|
| 1 | `al-research-doc` | `_AL` 실시간 조사 문서를 `main`에 올린다 (`minor-fix`) | 없음 |
| 1 | `hoga-format` | `crates/hoga-format`: 구간 파일 인코더·디코더, 범위 초과 오류, 왕복 시험, 기준 파일. `docs/hoga-format.md`, 용어집 "호가 복기" 절 | 없음 |
| 2 | `raw-parse` | `crates/collector` 뼈대(하위 명령 넷, 의존성 전부), 원문 파일 쓰기·읽기, 원문 → 행 해석, 채록에서 옮긴 고정 입력, `docs/hoga-collector.md` 뼈대 | `hoga-format` |
| 3 | `hoga-build` | `build`·`verify`: 구간 나누기, 이월 행, 끊긴 구간, 판 번호, `index.json`, 대조 | `raw-parse` |
| 3 | `hoga-collect` | `collect`: 설정, 잠금·토큰, WS 세션(LOGIN, REG, PING 응답, 재연결, 사건 줄). 합성 연결로만 시험 | `raw-parse` |
| 4 | `hoga-serve` | `serve`와 복기 화면, 브라우저 확인 스크립트 | `hoga-build` |

병렬·순차:

- `al-research-doc`는 나머지 모두와 병렬이다. 겹치는 파일이 없다.
- `hoga-format` → `raw-parse`: 순차. `raw-parse`가 `hoga-format`의 흐름·열 정의로 행을 만들고(한쪽이 다른 쪽의 결과를 쓴다), 둘 다 루트 `Cargo.toml`의 `members` 한 줄을 고친다.
- `raw-parse` → `hoga-build`, `raw-parse` → `hoga-collect`: 순차. 둘 다 `raw-parse`가 만든 원문 파일 읽기·쓰기를 쓴다.
- `hoga-build` → `hoga-serve`: 순차. 화면이 `build`가 만든 구간 파일과 `index.json`을 읽는다.
- `hoga-build`와 `hoga-collect`, `hoga-serve`와 `hoga-collect`: 병렬. `raw-parse`가 하위 명령마다 파일을 나눠 두고 의존성을 미리 다 적어 두므로 각자 자기 파일만 채운다. `docs/hoga-collector.md`는 `raw-parse`가 절마다 자리를 만들어 두고 각 작업이 자기 절만 채운다.

진행 중인 다른 작업(레이아웃, 드로잉)과는 겹치는 파일이 없다. `GLOSSARY.md`는 `hoga-format`만 고치고 맨 끝에 절 하나를 더한다.

## 실제 수집 하루 (자동 작업 아님)

사용자 결정 1~3이 정해지고 여섯 작업이 병합된 뒤, 사용자가 장중에 직접 실행한다. 자세한 명령은 `docs/hoga-collector.md`에 작업들이 적는다.

1. 수집기 전용 키를 `VALLY_COLLECTOR_ENV_FILE`이 가리키는 파일에 둔다. 키움 포털에 지금 공인 IP가 등록돼 있는지 확인한다.
2. `collector collect --items …`를 07:55쯤 켜고 20:00 뒤에 끈다. `collector build --follow`를 함께 켠다.
3. `collector serve`를 켜고 브라우저로 장중 복기를 확인한다.
4. 장이 끝나면 `collector build`와 `collector verify`를 한 번 더 돌린다.

이 하루로 "아직 모르는 것"을 잰다.

- 정규장 `0D` 초당 메시지 수와 구간 파일 크기: `build` 요약과 `index.json`의 행 수·바이트 수
- 10배속 재생에서 60fps 유지 여부: 화면 구석의 프레임 간격 p95
- KRX에만 상장된 종목을 `_AL`로 등록했을 때의 `0D`·`0E` 동작: 원문 파일
- 네 흐름이 한 화면에 함께 보이는지

## 위험

- **키 겹침.** 수집기 키가 앱 서버나 hoga-ops의 키와 같으면 서로 연결을 끊고, 발급이 겹치면 계정 단위 잠금이 걸릴 수 있다. 앱 서버 키와 같은지는 시작할 때 막지만 hoga-ops 키와 같은지는 수집기가 알 수 없다.
- **정규장 `0D` 양을 모른다.** 5분 구간 파일이 측정값(약 13KB)보다 훨씬 클 수 있다. 실제 수집 하루 전에는 구간 길이를 바꾸지 않는다.
- **자체 형식.** 인코더가 틀리면 자료가 망가진다. 인코딩 직후 다시 풀어 비교하고, `verify`로 원문과 대조하고, 원문은 지우지 않는다.
- **`collector`의 DuckDB 의존.** `server`를 라이브러리로 쓰는 대가다. 사용자가 직접 실행할 파일은 일반 Cargo(`cargo build --locked -p collector`)로 빌드해야 `libduckdb.so` 없이 돈다. 처음 빌드가 길다.
- **`br`을 알리지 않는 브라우저 환경.** 풀어서 보내는 길로 돌아가므로 화면은 나오지만 측정한 속도와 다르다.
- **화면 확인이 CI에 없다.** 화면이 깨져도 병합 검사가 잡지 못한다.

## 범위 밖

- 여러 키로 200종목을 넘겨 수집하기, 전 종목 수집, 수집기 상시 운영(여러 날 연속, 20:05 토큰 재발급, 자동 재시작).
- 원문 삭제, 보관 기간, 원격 저장소·CDN 올리기.
- 예상체결가·예상체결량, `0E` 시간외 잔량, 외국계 거래원 필드.
- KRX·NXT를 따로 등록해 호가를 거래소별로 나누기.
- 기존 웹 앱 안의 호가 복기 창, 차트와의 연동.
- 지난 날 채우기(`ka90008` 등 REST).
- `kiwoom` 모듈을 따로 크레이트로 빼기.
- 대중 서비스와 그에 필요한 시세 계약.
- 화면 확인을 CI에 넣기.

## 사용자가 정해야 하는 결정

1~3은 실제 수집 하루에만 필요하다. 답이 없어도 여섯 작업은 진행한다. 4·5는 권장안을 적용해 두었다.

1. **수집기에 쓸 키.** 앱 서버 키(`VALLY_KIWOOM_APP_KEY`)와도, 돌고 있는 hoga-ops 키(`KIWOOM_APP_KEY_2`~`5`)와도 겹치지 않는 키 하나. 정해지면 `VALLY_COLLECTOR_ENV_FILE`이 가리키는 저장소 밖 파일에 둔다.
2. **종목.** 권장: 005930, 000660, 중간 규모 몇 개, KRX에만 상장된 종목 1~2개(`_AL` 동작 확인), ETF 069500. 모두 20개 이하.
3. **실제 수집 하루를 언제 누가 실행할지.** 권장: 사용자가 직접, 가장 빠른 날은 2026-11-16(월) 장중이다. 다만 작업이 그때까지 다 병합되지 않을 수 있다.
4. **구간 파일을 언제 확정할지.** 권장(적용): 장중 5분마다. 원문은 남기고 장이 끝난 뒤 다시 만들어 대조한다. 내용이 바뀐 파일은 판 번호를 올린 새 이름으로 쓴다. 다른 선택지: 장이 끝난 뒤 한 번에 만든다(`--follow`를 쓰지 않으면 된다).
5. **ADR 0003·0004와의 관계.** 권장(적용): 프로토타입 결과를 본 뒤 호가 복기 수집의 ADR 하나를 쓴다. 다른 선택지: 프로토타입 전에 범위 예외 ADR을 먼저 둔다(작업 하나가 더 든다).

## 검사 명령

저장소 루트에서 실행한다. 자세한 절차는 `docs/development-builds.md`와 `docs/web-checks.md`에 있다.

```sh
python3 scripts/dev.py cargo test -p hoga-format
python3 scripts/dev.py cargo test -p collector
python3 scripts/dev.py cargo clippy -p hoga-format -p collector --all-targets -- -D warnings
python3 scripts/dev.py cargo build -p collector
node --test crates/collector/page-tests/
node scripts/test-hoga-replay.mjs
```
