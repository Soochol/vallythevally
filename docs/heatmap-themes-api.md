# 히트맵 테마 API

히트맵 페이지(`/heatmap`)가 보여 줄 **테마**를 저장하는 경로다. 테마는 사용자가 직접 고른 종목 묶음이고 관심종목과 따로 저장한다. 결정은 [ADR 0037](adr/0037-heatmap-themes-are-a-setup-document-apart-from-watchlists.md), 전체 설계는 [히트맵 테마 플랜](plans/heatmap-themes.md)이다.

## `GET /api/heatmap/themes`

`HeatmapThemes`(`web/src/api/generated/HeatmapThemes.ts`)를 준다. 처음에는 `{"themes": [], "revision": 0}`이다.

```json
{
  "themes": [
    { "id": "T1", "name": "반도체 소부장", "symbols": ["042700", "403870"] },
    { "id": "T2", "name": "AI 반도체", "symbols": ["005930", "042700"] }
  ],
  "revision": 7
}
```

`themes`는 표시 순서이고, 각 `symbols`도 저장한 순서다.

## `PUT /api/heatmap/themes`

본문은 `GET`과 같은 모양이고 문서 전체를 바꾼다. 성공하면 받은 문서를 그대로 돌려준다.

| 검사 | 값 | 어기면 |
|---|---|---|
| `revision` | 저장된 값보다 커야 한다 | 409 `stale_revision` |
| 테마 수 | 100개까지(`MAX_HEATMAP_THEMES`) | 400 `bad_request` |
| `id` | 1~64바이트, 문서 안에서 고유 | 400 |
| `name` | 앞뒤 공백 없이 1~40자, 테마끼리 고유 | 400 |
| `symbols` | 테마당 60개까지(`MAX_HEATMAP_THEME_SYMBOLS`, 흐름 비교 상한과 같다) | 400 |
| 종목 코드 | 주식·ETF 코드. 지수(`IDX:`)는 받지 않는다. 종목 목록에 없는 코드는 받는다 | 400 |
| 같은 테마 안 중복 | 없어야 한다. 테마끼리는 겹쳐도 된다 | 400 |
| 본문 크기 | `HEATMAP_THEMES_LIMIT`(145,236바이트)까지 | 413 `payload_too_large` |

거절한 PUT은 저장된 테마를 바꾸지 않는다.

## `GET /api/heatmap/board?venue=combined&order=rate`

히트맵 보드다. 서버가 테마마다 종목 시세를 모으고 테마 요약을 계산해 한 응답으로 준다. 응답은 `HeatmapBoard`(`web/src/api/generated/HeatmapBoard.ts`)다.

| 인수 | 뜻 |
|---|---|
| `venue` | `combined`(기본), `krx`, `nxt`. `/api/quotes`와 같다 |
| `order` | 테마 순서. `rate`(가중 평균 등락률 높은 순, 기본), `custom`(저장 순서), `traded`(거래대금 합 큰 순). 값이 같으면 저장 순서를 따르고, 값이 없는 테마는 맨 뒤다. 다른 값은 400이다 |
| `source` | `mine`(내 테마, 기본) 또는 `kiwoom`(서버가 저장한 **키움 테마** 구성종목, [ADR 0040](adr/0040-heatmap-adds-kiwoom-themes-as-a-second-source.md)). 다른 값은 400이다 |

| 칸 | 뜻 |
|---|---|
| `revision` | 계산에 쓴 테마 문서의 revision. 키움 테마는 0 |
| `source` | 적용한 출처 |
| `catalog` | `source=kiwoom`일 때 저장된 구성종목의 날(`date`), 받은 시각(`collectedAt`), 테마 수(`themes`), 상태(`state`: `ready` 파일이 있다, `collecting` 없고 받는 중, `empty` 없고 받고 있지 않다). 내 테마면 `null` |
| `order` | 적용한 순서 |
| `asOf` | 받은 시세 가운데 가장 늦은 시각(Unix 초). 시세가 하나도 없으면 `null` |
| `themes[].id` | 내 테마는 저장한 id, 키움 테마는 `kiwoom-<테마코드>` |
| `themes[].members` | 시세를 받은 종목, 테마 안 저장 순서. `symbol`, `name`(종목 목록의 이름, 없으면 코드), `changeRate`(%), `tradedMillionWon`(당일 누적 거래대금, 백만원. 없으면 빠진다) |
| `themes[].missing` | 시세를 받지 못한 종목. 요약에서 빠진다 |
| `themes[].summary` | 테마 요약. 시세를 받은 종목이 없으면 `null` |

요약의 칸:

- `weightedRate`: 거래대금 가중 평균 등락률, Σ(등락률 × 거래대금) / Σ거래대금이다. 소수 넷째 자리에서 반올림한다. 거래대금이 없는 종목은 평균에 들지 않는다. 거래대금 합이 0이면 `null`이다. 흐름 비교와 같은 정의다([히트맵 흐름 비교 API](heatmap-flow-api.md)).
- `tradedMillionWon`: 거래대금 합(백만원).
- `rising`, `flat`, `falling`: 상승·보합·하락 종목 수.
- `leader`: 등락률이 가장 높은 종목. 같으면 테마 안에서 앞선 종목이다.

시세는 `/api/quotes`와 같은 `ka10095`로 받는다. 모든 테마의 종목을 중복 없이 모아 100종목씩 묻는다. 받은 시세는 종목·거래소마다 서버 메모리에 45초(`FRESH_SECS`) 둔다. 그래서 테마를 고친 뒤에는 새로 든 종목만 키움에 묻는다. 웹은 60초마다 다시 부르므로 45초는 매번 새로 받는 값이다. 상한(테마 100개 × 60종목)이 모두 다른 종목이어도 `ka10095` 60건이다. 이는 새로 고침 간격의 3분의 1 안에 끝난다. `heatmap_board::tests`가 이 관계를 확인한다. 키움 호출이 실패하면 `/api/quotes`와 같은 오류를 준다.

## 셋업

테마 문서는 셋업 문서 종류 `heatmap_themes`(id `main`)다. `GET /api/setup/export`에 들어가고, 계정 동기화가 다른 문서와 같은 규칙으로 주고받는다. 테마 문서가 없는 예전 묶음을 가져오면 테마는 빈 문서가 된다.

## 시험

- `python3 scripts/dev.py cargo test -p server --lib heatmap_theme`: 경로의 왕복·검사별 거절·revision 충돌(`http::tests`), 마이그레이션이 동기화 기록을 보존하는지(`userdata::tests`).
- `python3 scripts/dev.py cargo test -p server --test setup_bundle --test setup_sync`: 내보내기·가져오기와 두 PC 사이 동기화에 테마가 함께 가는지.
- `python3 scripts/dev.py cargo test -p server --lib heatmap_board`: 요약과 순서 계산, 호출 예산.
- `python3 scripts/dev.py cargo test -p server --test heatmap_board`: 합성 transport로 손 계산한 요약, `order`, 시세 캐시와 새 종목만 묻기, 테마가 없을 때 키움을 부르지 않음.
