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

## 셋업

테마 문서는 셋업 문서 종류 `heatmap_themes`(id `main`)다. `GET /api/setup/export`에 들어가고, 계정 동기화가 다른 문서와 같은 규칙으로 주고받는다. 테마 문서가 없는 예전 묶음을 가져오면 테마는 빈 문서가 된다.

## 시험

- `python3 scripts/dev.py cargo test -p server --lib heatmap_theme`: 경로의 왕복·검사별 거절·revision 충돌(`http::tests`), 마이그레이션이 동기화 기록을 보존하는지(`userdata::tests`).
- `python3 scripts/dev.py cargo test -p server --test setup_bundle --test setup_sync`: 내보내기·가져오기와 두 PC 사이 동기화에 테마가 함께 가는지.
