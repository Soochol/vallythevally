# 기간별 수급 API

`GET /api/symbols/{code}/foreign-holdings`는 ka10008의 외국인 보유주식수와 보유비중을 준다. `GET /api/symbols/{code}/investor-net-shares`는 ka10059의 투자자별 순매수 수량을 준다. 두 경로 모두 `from=YYYY-MM-DD&to=YYYY-MM-DD`를 받고, 경계 날짜를 포함한다.

두 응답은 생성 TypeScript 타입 `DayHistory<T>`를 따른다.

| 필드 | 뜻 |
|---|---|
| `days` | 기간 안에서 날짜와 숫자를 모두 읽은 행. 날짜 오름차순이며 같은 날짜는 하나만 남긴다. |
| `skippedDays` | 날짜는 읽었지만 숫자를 읽지 못한 기간 안의 행. `{day, field, reason}`으로 실패한 응답 필드를 알린다. |
| `undatedRows` | 날짜를 읽지 못한 행. `{dt, reason}`으로 원본 날짜 문자열과 실패 이유를 보존한다. 날짜를 추측하지 않으므로 조회한 페이지의 모든 날짜 오류를 받는 순서대로 담는다. 같은 문자열도 행이 다르면 각각 남긴다. |
| `coverage` | 연속조회에서 읽은 날짜의 범위. 행의 숫자와 날짜가 모두 온전하다는 보장은 아니다. |

`coverage.kind`는 다음 셋 중 하나다.

- `whole_range`는 `from`까지 거슬러 읽었다는 뜻이다.
- `kiwoom_starts_later`는 조회가 끝났을 때 읽은 가장 오래된 날짜가 `from`보다 늦다는 뜻이다. 그 날짜가 `firstDay`다.
- `no_readable_dates`는 행은 받았지만 날짜를 하나도 읽지 못했다는 뜻이다. 시작 날짜를 추측하지 않으며 `firstDay`가 없다.

자료 누락 여부는 `coverage`와 함께 `skippedDays`, `undatedRows`를 확인한다. 정상 빈 기간은 두 실패 목록이 모두 비어 있다. 날짜 없는 행을 전부 빈 문자열로 받은 경우도 `200`과 `undatedRows`로 알린다. 날짜를 못 읽었다는 이유로 `unknown_symbol`을 주지 않는다. 종목 목록에 없는 종목이나 실제로 행이 없는 첫 페이지는 기존처럼 `404 unknown_symbol`이다.

빈 숫자를 0으로 바꾸지 않는다. 날짜를 읽은 숫자 오류는 기존의 `200`과 coverage 정책을 따른다. 도중에 키움 요청 자체가 실패하면 일부 자료 대신 오류를 준다. 다시 요청하면 첫 페이지부터 조회한다.

빈 페이지는 조회를 끝낸다. 행은 있지만 날짜를 전혀 읽지 못한 페이지는 `next-key`가 있으면 계속 받는다. 날짜를 읽은 페이지가 더 오래된 날짜를 주지 않거나, 이미 사용한 연속조회 키 또는 같은 날짜 없는 페이지를 다시 받으면 멈춘다. 날짜 없는 페이지의 반복 여부는 날짜 오류 문자열만으로 정하지 않고 원본 수급 필드를 함께 비교한다. 모든 요청은 기존 Background 대기열과 관문을 지난다.

## 한투가 받을 때

경로는 시세 경계의 같은 메서드(`OverviewSource::stock_investors`·`foreign_holdings`)를 부르고, 한투 구현은 `kis/overview.rs`에 있다.

- 순매수는 `FHPTJ04160001`로 받고, 날짜를 커서로 거슬러 `from`까지 읽는다. 한투 값에 없는 `government`는 0이다.
- 장중(평일 09:00~16:00) 오늘이 범위에 들면 오늘 행을 확정 행 대신 외인기관 추정가집계(`HHPTJ04160200`)의 가장 늦게 채워진 입력 구분으로 채우고, 응답의 `estimatedDays`에 그 날짜를 싣는다. 추정 행의 외국인·기관계만 값이고 나머지 열은 0이다. 추정값을 받지 못하면 오늘 행을 비운다. 16:00부터는 확정 행이고 `estimatedDays`가 없다.
- 외국인 보유는 한투에 일별 이력이 없다. 현재가 응답(`FHKST01010100`)의 `frgn_hldn_qty`·`hts_frgn_ehrt`가 둘 다 있으면 가장 최근 평일 한 행을 주고, 없으면 `days`가 빈 채 `coverage.kind`가 `no_readable_dates`다.
