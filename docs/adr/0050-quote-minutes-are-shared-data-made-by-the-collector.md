# 분 호가는 수집기가 공용 자료로 만들고 서버는 요청한 종목만 읽는다

차트 보조지표(총잔량, 호가 잔량 히트맵)는 1분마다의 10호가 요약이 필요하다. [ADR 0022](0022-hoga-replay-collects-quotes-on-disk.md)와 [ADR 0025](0025-collector-stores-closed-days-for-the-app.md)는 정리가 끝난 날만 수집 저장소에서 읽고 오늘은 앱 서버가 자기 키로 받아 당일 저장소에 쓰기로 했다. 그러나 [ADR 0043](0043-collector-makes-shared-data-and-the-server-only-reads-it.md)으로 공용 자료는 감독 데몬(수집기)이 만들고 서버는 읽기만 하는 구조가 자리 잡았다. 이 ADR은 오늘의 호가 지표도 앱 서버가 따로 모으지 않고 수집기가 공용 자료 **분 호가**로 만들어 내며, 서버는 장중·닫힌 날 모두 공용 자료 폴더에서 요청한 종목만 읽기로 정한다.

## 결정

- **수집기가 장중과 닫힌 날 분 호가를 모두 만든다.** 앱 서버는 호가 지표를 위해 자기 키로 호가를 모으거나 디스크에 쓰지 않는다. 10호가의 총잔량은 실데이터에서 10단 합과 같고 KRX 몫 + NXT 몫 = 통합 몫이므로, 거래소(`combined`·`krx`·`nxt`)마다 사다리 세 가지(`close`, `peak`, `priceMax`)만 남긴다.
- **장중은 종목별 덧붙임과 진행 중 스냅샷으로 나눈다.** `<공용 자료 폴더>/quote-minutes-live/<YYYYMMDD>/<키 이름>/` 아래에 끝난 분은 `<종목>.jsonl`(`FeedWriter`, 처음 쓸 때 열기), 끊긴 구간은 `_gaps.jsonl`, 진행 중인 분은 `_current.json`(`write_snapshot_at`)으로 쓴다. 모든 분을 5초마다 다시 쓰면 하루 10GB를 넘기 때문이다.
- **닫힌 날은 종목별 gzip JSON으로 바꾸고 폴더 rename으로 게시한다.** `<공용 자료 폴더>/quote-minutes/<YYYYMMDD>/<종목>.json.gz`(`Envelope<ClosedQuotes>`)에 쓰고, `.tmp` 폴더에 다 만든 뒤 날짜 폴더로 이름을 바꾼다. 닫힌 날 폴더가 생기면 서버는 그날에 대해 닫힌 날 폴더만 본다.
- **서버는 요청한 날짜·종목만 읽는다.** `DataKind::QuoteMinutes`(`quote-minutes`)를 두되 `SharedData::poll_once`에는 넣지 않는다. 760종목 하루치를 메모리에 상주시키지 않고 요청이 온 종목 파일과 키별 `_current.json`만 연다.
- **단일가 호가는 종가에만 남기고 최댓값에서는 뺀다.** 가격이 0이 아닌 단이 양쪽 모두 3개 이하(빈 호가 포함)인 호가는 `singlePrice: true`로 표시하고 `peak`와 `priceMax` 집계에서 제외한다.

## Considered Options

아래는 검토했지만 **고르지 않은 안**이다. 다시 꺼내려면 새 ADR로 이 결정을 바꾼다.

- **ADR 0025대로 오늘은 앱 서버가 당일 저장소에 쓰기**: 앱 서버가 실시간 자리를 호가 집계에 나눠 써야 하고, 공용 서버·데스크톱 앱 구조(ADR 0043·0045)와 어긋난다.
- **장중 분 호가를 `minute`처럼 키당 하나의 JSONL에 5초마다 덧붙이기**: 10호가 사다리 세 벌이 매 5초마다 전 종목에 대해 다시 쓰이면 하루 용량이 10GB를 넘고, 서버가 한 종목을 읽으려고 키 파일 전체를 훑어야 한다.
- **서버가 `SharedData::poll_once`로 전 종목 분 호가를 메모리에 올리기**: 760종목 하루치 사다리를 모두 메모리에 두면 메모리와 폴링 비용이 크고, 차트 요청은 소수 종목만 본다.

## Consequences

- ADR 0025의 "정리가 끝나지 않은 오늘은 앱 서버가 당일 저장소에 쓴다"는 호가 지표에 적용되지 않는다. 오늘과 지난 날 모두 수집기 공용 자료를 읽는다.
- 형식·집계·파일 입출력은 `crates/server/src/shared_data/quote_minutes/` 한 곳에 두고, 수집기(장중·마감 정리)와 서버 HTTP 경로가 같은 타입과 함수를 쓴다.
- 상세 파일 배치와 JSON 형식은 [`docs/collector-shared-data.md`](../collector-shared-data.md)의 "분 호가" 절을 따른다.
