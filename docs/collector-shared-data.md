# 공용 자료 파일

수집 데몬이 공용 자료를 파일로 쓰고 `vally-server`가 읽는다. 배경과 결정은 [플랜](plans/collector-shared-data.md)(확정 1, 결정 A1~A5)에 있다. 형식 타입과 쓰기 함수는 `crates/server/src/shared_data/`에 있고, 수집기는 그 타입으로 쓴다.

## 서버 설정

| 변수 | 뜻 |
|---|---|
| `VALLY_SHARED_DATA_DIR` | 자료 폴더. 절대 경로여야 한다. 없으면 서버는 아무것도 읽지 않고 동작이 지금과 같다. |
| `VALLY_SHARED_DATA_POLL_MILLIS` | 폴링 간격. 기본 1000. 1 이상의 정수. |

서버는 간격마다 종류 폴더에서 관측일이 가장 늦은 파일을 `stat`으로 보고, 지난번과 바뀐 파일만 블로킹 스레드에서 읽어 메모리 판을 바꿔 끼운다. 요청은 메모리 판만 읽는다. 읽지 못한 파일(깨짐, 모르는 형식 버전, 폴더와 다른 종류)은 이전 판을 두고 종류별 오류 수를 센다. 같은 파일 버전은 오류를 한 번만 센다.

## 파일 형식

한 파일 자료는 `{"header": {...}, "body": {...}}` JSON 하나다. 덧붙이는 자료는 JSONL이고 첫 줄이 머리(`header` 객체 자체), 이후 한 줄에 항목 하나다.

머리 칸(camelCase):

| 칸 | 뜻 |
|---|---|
| `formatVersion` | 형식 버전. 지금 1. 읽는 쪽은 아는 버전만 읽는다. |
| `kind` | 자료 종류(닫힌 열거형). |
| `observationDate` | 관측일 `YYYYMMDD`. |
| `asOf` | 자료의 기준 시각, Unix 초. 판의 나이는 지금 − `asOf`다. |
| `writtenAt` | 쓴 시각, Unix 초. |
| `sources` | 받은 키 이름과 증권사(`kiwoom`·`kis`) 목록. |

## 쓰는 규칙

- 한 파일 자료(`write_snapshot`): 같은 폴더의 임시 파일(`.<이름>.tmp-<pid>`)에 쓰고 `fsync` 뒤 rename한다. 읽는 쪽은 `<YYYYMMDD>.json`만 본다.
- 수집기가 쓰는 JSONL(덧붙이는 자료, `usage/`, 사건 기록)에는 빈 줄을 쓰지 않는다. 줄마다 줄바꿈 하나로 끝난다.
- 덧붙이는 자료(`FeedWriter`): 한 줄을 한 번의 쓰기로 보낸다. 다시 열 때 줄바꿈 없이 끝난 꼬리는 잘라 낸다. 읽는 쪽은 지난번 위치부터 읽고 줄바꿈이 없는 마지막 줄은 다음에 읽는다. 관측일 파일이 바뀌면 처음부터 읽는다. 파일이 줄었어도 처음부터 읽는다.

## 키 배정표

데몬이 어느 `rest` 키가 어느 일을 받을지 정하는 설정 파일이다(`collector supervise --shared-config <경로>`, 기본 `~/.config/vally/collector-shared.json`). 데몬은 매일 07:35 계획 때 다시 읽는다. 읽지 못하거나 검사에 걸리면 직전에 읽은 배정(직전 사본은 `<--data>/plan/shared-assignment.last.json`)을 쓰고 상태 API에 `stage_failed` 경보를 낸다. 직전 배정도 없으면 공용 자료 일을 돌리지 않고 경보한다. 파일이 없으면 경보 없이 공용 자료 일을 돌리지 않는다(이 기능을 쓰지 않는 지금 동작). 바뀐 배정은 다음 관측일 자식부터 쓴다. 장중에는 읽지 않는다.

```json
{"version": 1,
 "keys": {"rest-01": {"total_per_second": 5}},
 "jobs": {"probe": {"keys": ["rest-01", "rest-02"], "period_secs": 30, "options": {"calls_per_tr": 4}}}}
```

- `jobs`의 이름은 닫힌 열거형이다(`crates/collector/src/shared/mod.rs`의 `JobName`). 지금은 시험용 `probe`와 `snapshot`이다. 뒤 작업이 자기 일을 한 줄씩 더한다.
- 일마다 `keys`(순서가 우선순위), `period_secs`(1 이상), `options`(일이 정하는 선택값, 없으면 일의 기본값)를 둔다. `keys`의 키는 모두 활성 `rest` 키여야 하고 그 일이 받는 증권사여야 한다. 같은 키를 두 번 적을 수 없다.
- 같은 일에 키가 여럿이면 일이 나눌 단위를 키 수로 나눠 그 키들이 동시에 부른다. 키 `i`가 단위 `u`를 `u % 키 수 == i`일 때 맡는다. 키 하나가 멈추면(재시작 한도, 8050 등) 남은 키들이 몫을 다시 나눠 갖는다. 마지막 키까지 멈추면 그 일은 서고 상태 API에 경보가 난다.
- `keys.<이름>.total_per_second`(선택)를 적으면 그 키의 `KiwoomRest` 합계 창을 그 값으로 켜서 모든 TR의 1초 전송 합계가 그 값을 넘지 않게 한다. 적지 않으면 TR별 창(5)만 지킨다.
- 모르는 칸, 모르는 일 이름, `rest`가 아닌 키, 키 목록에 없는 키, 0인 주기·한도, 일이 받지 않는 선택값은 읽기 오류다.
- 데몬은 배정표에 든 `rest` 키마다 공용 자료 자식(`collector shared --child`) 하나를 띄운다. 어느 일에도 든 적 없는 `rest` 키는 띄우지 않는다.

## 키별 TR 사용량

공용 자료 자식과 데몬의 REST(예비 키가 아침 목록·마감 뒤 대조에 쓰는 세션)가 1분마다 키·TR별 사용량을 `<--data>/usage/<YYYYMMDD>.jsonl`에 한 줄씩 덧붙인다. 날짜는 그 1분이 시작한 KST 날짜다. 한 줄은 한 번의 쓰기로 가고 빈 줄은 쓰지 않는다. 자식은 1분이 끝나면(키움 REST의 1분 카운터가 닫힐 때) 사건 `usage`로 데몬에 알리고, 파일은 데몬이 쓴다. 보낸 것이 없는 분은 쓰지 않는다. 일을 바꾸는 중이라 끝나지 못한 1분은 남지 않는다.

TR 줄:

```json
{"v":1,"at":"2026-11-18T09:01:00+09:00","key":"rest-01","broker":"kiwoom","scope":"tr","tr":"ka10095","sent":12,"rate_limited":1,"resent":1,"max_wait_ms":1050,"max_per_second":5}
```

키 줄(그 분에 TR 줄이 하나라도 있으면 한 줄):

```json
{"v":1,"at":"2026-11-18T09:01:00+09:00","key":"rest-01","broker":"kiwoom","scope":"key","max_per_second":7}
```

- `sent`는 보낸 요청 수(다시 보낸 것 포함), `rate_limited`는 제한 응답(429 등)을 받은 수, `resent`는 제한 응답 뒤 다시 보낸 수, `max_wait_ms`는 TR 창이 비기를 기다린 가장 긴 시간, `max_per_second`는 최근 1초(창 길이 1.05초) 전송 수의 최댓값이다.
- 키 줄의 `max_per_second`는 모든 TR(토큰 발급 제외)의 최근 1초 전송 합계의 최댓값이다. 합계 창이 꺼져 있어도 센다.
- **한도 확인(플랜 결정 B5)**: ADR 0035의 미확인 사항("초당 5회"가 키 하나의 TR 합계인지)은 `total_per_second` 없이 한 키에 TR이 다른 일 둘을 함께 배정한 관측일 하루의 줄로 가린다.
  - 키 줄 `max_per_second`가 5를 넘은 분에 TR마다 `max_per_second`가 5 이하인데 `rate_limited`가 나면 합계 한도다. 그때는 `rest` 키마다 `total_per_second: 5`를 켜고 일을 키마다 하나씩 둔다.
  - 키 줄이 5를 넘었는데 `rate_limited`가 0이면 TR이 독립이다. 한 키에 TR이 다른 일 여럿을 둘 수 있다.
  - `crates/collector/src/shared/usage.rs`의 `judge_limit`이 이 규칙이다. 확인하기 전에는 `total_per_second: 5`를 켠 배정으로 돈다.

## 오늘 시세 스냅샷 (`snapshot`)

플랜 결정 C1이다. 전 종목 오늘 시세를 거래소마다 한 판씩 받아 최신 하나만 덮어쓴다.

- 시각: 관측일 08:00부터 KST :00·:30에 한 판씩 받는다. 20:00 이전 마지막 판은 19:59:30이다. 20:00 뒤 20:00:30에 한 번 더 받아 마감 시세(`closing: true`)로 두고, 다음 관측일 첫 판까지 그대로 둔다. 일은 데몬이 관측일 자식에게 배정할 때만 돌아서 휴장일·주말에는 받지 않는다. 새 관측일의 첫 판을 쓴 뒤 지난 관측일 파일을 지운다.
- 대상: 그날 데몬이 받은 `ka10099`의 모든 행(ETF·ETN 포함, 서버 종목 목록과 같은 분류). 데몬이 아침 목록을 받을 때 `<--data>/listing/<YYYYMMDD>.json`에 종목 코드와 NXT 거래 여부(`nxtEnable == "Y"`)를 남기고 최근 3일 것만 둔다. 일은 그날 파일을 읽고, 없으면 가장 가까운 이전 날 것을 읽는다. 둘 다 없으면 호출 없이 실패한다. 이 파일은 공용 자료 폴더가 데이터 폴더 바로 아래 `shared`일 때(기본값) 찾는다.
- 호출: 거래소마다 `ka10095`(100종목 묶음, 통합은 `_AL`, NXT는 `_NX` 접미사, NXT는 NXT 거래 종목만)와 코스피·코스닥 종합지수 `ka20003` 각 1회. 호출 수는 판마다 (종목 수 ÷ 100 올림) × 2 + (NXT 종목 수 ÷ 100 올림) + 2다(거래소 셋 기준).
- 키가 여럿이면 거래소 순서로 늘어놓은 묶음(지수 둘은 맨 끝)을 번호 `u`가 `u % 키 수 == 슬라이스`인 키가 맡는다. 키는 서로 다른 프로세스라 각자 `<공용 자료 폴더>/snapshot-parts/<날짜>.<판 시각>.<슬라이스>-<키 수>.json`에 조각을 쓰고, 마지막 조각을 쓴 키가 조각을 모아 거래소별 파일을 쓴다. 두 키가 동시에 모아도 같은 내용이다.
- 한 묶음이라도 실패하면 그 키는 조각을 쓰지 않아 그 판은 만들어지지 않고 이전 판이 남는다. 일의 `failures()`와 일 통계의 마지막 오류에 남는다. 정상 응답에서 일부 종목 행이 빠지거나 읽히지 않으면 본문 `missing`에 센다.
- 선택값: `options.venues`(기본 `["krx","combined","nxt"]`)로 받을 거래소를 고른다. 모르는 칸·중복·빈 목록은 읽기 오류다.
- 본문(`SnapshotBody`): `closing`, `requested`(요청한 종목 수), `missing`, `stocks`(종목 행), `indices`(종합지수 행. 세 파일에 같다). 종목 행은 `code`, `day`(응답 날짜), `currentWon`, `baseWon`, `openWon`, `highWon`, `lowWon`, `volume`, `tradedMillionWon`, `tradedAt`(체결 시각, Unix 초. 없으면 null)이고 가격은 원 단위 양수다. 머리 `asOf`는 마지막 조각을 마친 시각이다.

## 폴더 배치

`<VALLY_SHARED_DATA_DIR>/<종류 폴더>/<관측일>.<확장자>`다. 뒤 작업이 자기 줄을 더한다.

| 종류 | 폴더 | 한 파일(`.json`) | 덧붙임(`.jsonl`) | 본문 |
|---|---|---|---|---|
| `probe` (시험용) | `probe/` | `probe/<YYYYMMDD>.json` | `probe/<YYYYMMDD>.jsonl` | `ProbeBody`, `ProbeItem` |
| `snapshotKrx` | `snapshot-krx/` | `snapshot-krx/<YYYYMMDD>.json` | | `SnapshotBody` |
| `snapshotCombined` | `snapshot-combined/` | `snapshot-combined/<YYYYMMDD>.json` | | `SnapshotBody` |
| `snapshotNxt` | `snapshot-nxt/` | `snapshot-nxt/<YYYYMMDD>.json` | | `SnapshotBody` |
