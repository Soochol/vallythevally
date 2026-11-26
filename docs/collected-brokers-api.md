# 수집 거래원 API

앱 서버가 수집기의 과거일 저장소(`store/`)와 당일 종목 흐름(`shared/symbol-flow/`)에서 거래원(`0F`) 이력을 읽어 브라우저에 내주는 REST API다. 배경과 결정은 [ADR 0025](adr/0025-collector-stores-closed-days-for-the-app.md), [ADR 0028](adr/0028-server-streams-book-program-and-broker-for-the-symbols-new-windows-open.md), [ADR 0043](adr/0043-collector-makes-shared-data-and-the-server-only-reads-it.md)을 따른다.

## 설정

`VALLY_HOGA_DATA_DIR` 환경 변수로 수집 데이터 폴더를 지정한다(절대 경로). 공용 자료(당일 종목 흐름) 폴더는 `VALLY_SHARED_DATA_DIR`이 설정돼 있으면 그 폴더를 쓰고, 없으면 `<VALLY_HOGA_DATA_DIR>/shared`를 쓴다. 두 설정이 모두 없으면 서버는 오류를 내지 않고 두 경로 모두 `200`에 `source: "none"`·빈 목록으로 답해 화면이 기존 실시간 구독으로 돌아가게 한다.

- 정리된 날 저장소: `<VALLY_HOGA_DATA_DIR>/store/<YYYYMMDD>/`
- 공용 자료(종목 흐름): `<VALLY_SHARED_DATA_DIR 또는 VALLY_HOGA_DATA_DIR/shared>/symbol-flow/<YYYYMMDD>/`

## 경로

### `GET /api/symbols/{code}/brokers?date=YYYYMMDD[&after=<cursor>][&fallback=latest]`

지정한 종목(`{code}`, 6자리 주식 코드)과 날짜(`date`, KST `YYYYMMDD`)의 거래원 스냅샷을 돌려준다. 지수 코드나 잘못된 `date`·`fallback`은 `400 bad_request`다. `fallback=latest`를 주고 `after`가 없을 때 요청일에 저장소·흐름 스냅샷이 비어 있으면, 그 종목의 `date` 이전 마감 저장소 가운데 스냅샷이 있는 가장 최근 날을 찾아 응답의 `date`에 그 날짜를 담아 돌려준다.

응답 `BrokerDay` (camelCase):

| 필드 | 형 | 뜻 |
|---|---|---|
| `symbol` | `string` | 종목 코드(예: `"005930"`) |
| `date` | `string` | 실제 반환한 날짜(`YYYYMMDD`, `fallback=latest`로 이전 날을 읽었으면 그 날짜) |
| `source` | `"store" \| "flow" \| "none"` | 읽은 원천 |
| `snapshots` | `FeedBrokers[]` | 시각 순 거래원 스냅샷(같은 초의 행도 받은 순서대로 모두 전송, 이름은 앞뒤 공백 제거, 빈 자리는 제외) |
| `gaps` | `[number, number][]` | 수집이 끊긴 구간 `[fromSec, toSec]`(Unix 초) |
| `live` | `boolean` | 지금 수집이 이어지고 있는지(`store`·`none`은 `false`) |
| `cursor` | `string` | 다음 요청의 `after`에 넘기는 커서(`none`이면 `""`) |
| `reset` | `boolean` | `snapshots`가 그날 전체면 `true`, `after` 뒤의 증분만이면 `false` |

`after` 커서는 원천 세대와 행 자리를 담는다. 세대가 다르거나(예: 당일 흐름에서 마감 저장소로 전환, 키 파일 교체·재정렬) 해석할 수 없는 커서가 오면 오류를 내지 않고 `200`에 `reset: true`로 그날 전체를 돌려준다.

### `GET /api/symbols/{code}/brokers/days`

그 종목의 거래원 이력을 읽을 수 있는 날짜 목록을 오름차순으로 돌려준다. 지수 코드는 `400 bad_request`다.

응답 `BrokerDays` (camelCase):

```json
{"symbol": "005930", "days": ["20261123", "20261124"]}
```

- `store/<YYYYMMDD>/complete.json`이 있고 그 종목을 수집(`registered && received`)한 날과, 오늘(KST) 그 종목의 흐름 파일이 있으면 오늘을 합쳐 오름차순으로 돌려준다.

## 원천 규칙

`(종목, 날짜)`마다 원천은 하나다.

1. `store/<날짜>/complete.json`이 있고 그 종목을 수집했으면 `store`에서 읽는다. `store/<날짜>/0F/<버킷>.parquet`에서 해당 종목의 행을 DuckDB로 읽고, 끊김은 `complete.json`의 `gaps`를 초 단위로 바꿔 쓴다.
2. 그렇지 않고 날짜가 오늘(KST)이며 `<공용 자료 폴더>/symbol-flow/<오늘>/0F/<종목>/*.flow` 파일이 있으면 `flow`에서 읽는다. 한 종목에 키 파일이 여럿이면 시각 순으로 합친다.
3. 둘 다 아니면 `none`이다.

오늘이 장 마감 뒤 정리되어 `store/<오늘>/complete.json`이 생기면 다음 요청부터 원천이 `store`로 바뀌며, 옛 흐름 커서를 받아도 `reset: true`로 전체를 돌려준다.

### 흐름 끊김(`gaps`)과 `live` 판정

그 종목의 `.flow` 파일이 있는 키의 `links/<키>.jsonl`만 본다.

- 시각 순으로 `live`부터 `down`·`end`까지를 수집 구간으로 본다. `live` 상태에서 `start`가 나오면(자식 비정상 종료 뒤 재시작) 직전 줄 시각까지를 수집 구간으로 끊는다.
- 마지막 줄이 `live`·`alive`이고 현재 시각(`AppState.clock`)이 그 시각보다 90초 넘게 지났으면 마지막 줄 시각부터 현재까지가 끊김이고 `live`는 `false`다.
- 한 종목에 키 파일이 여럿이면 가장 먼저 행이 기록된 키 외의 키(인계 키)는 그 키 파일의 첫 행 시각부터 수집 구간으로 본다.
- 당일 08:00(KST)부터 현재 시각까지 가운데 어느 키도 수집하지 않은 구간을 `gaps`로 돌려준다(첫 `live` 전 구간 포함).

## 캐시와 동시성

- 모든 파일 I/O와 DuckDB 조회는 `tokio::task::spawn_blocking`에서 실행한다.
- **저장소(`store`)**: 종목·날짜별 응답을 최근 16개까지 메모리 LRU 캐시에 두고, `complete.json`의 파일 크기·수정 시각이 바뀌면 무효화한다. DuckDB 동시 조회는 세마포어로 최대 2개로 제한한다.
- **흐름(`flow`)**: 요청이 온 종목만 `FlowCursor` 꼬리를 메모리에 두고, 상주 폴링은 하지 않는다. 마지막 읽기에서 1초(`AppState.clock`)가 지났을 때만 새로 덧붙은 블록을 읽으므로 같은 종목을 여러 창이 동시에 요청해도 파일은 1초에 한 번만 읽는다. 60초 동안 요청이 없는 꼬리는 메모리에서 버린다.
