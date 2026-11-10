# Symbol search and opening a chart

## Sub-features
- Search by code (`005930`), name (`삼성전자`), or 초성 (`ㅇㅋㅍㄹ` → 에코프로 086520).
- Open a result in the active cell by click or Enter; the chart loads 500 bars, and dragging toward the past loads older pages (1000, then 1200 for the fake's 에코프로).
- The opened symbol is saved to the layout and restored after reload.

## How to get to it (user POV)
Top bar search box (title `종목 검색 (/ 또는 Ctrl+K)`), or press `/` or `Ctrl+K`. A dialog `종목 검색` opens with a combobox of the same name; results are `option`s showing the code.

## Driving it with verify-vally
`run.sh journeys/search-open-chart.mjs`. Proof: cell 1's `aria-label` becomes `칸 1: 에코프로 통합 일`, `[data-bar-count]` is `500`, a `PUT /api/layouts/…` succeeds, `GET /api/layouts/01900000-0000-7000-8000-000000000001` contains `086520`, and both survive `page.reload()`. Older pages: see `dragTowardPast` in `web/e2e/harness.ts`.

## Gotchas
- `GET /api/layouts` lists layouts without cells; read the single layout to see the symbol.
- Options are `aria-disabled="true"` until the results for the current query arrive; wait for `"false"` before clicking or pressing Enter.
- The fresh DB starts on 코스피 (`칸 1: 코스피 일`).
