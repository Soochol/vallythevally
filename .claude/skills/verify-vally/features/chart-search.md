# Symbol search and chart

## Sub-features
- Search by name, code or initial consonants (`ㅇㅋㅍㄹ`); NXT-unavailable symbols appear disabled.
- Chart for the selected symbol: periods (분/일/주/월/분기/연), venue 통합/KRX/NXT, pan into the past loads older bars.
- Header legend shows OHLC and change.

## How to get to it (user POV)
Open `/`. Click the search button (top right, title `종목 검색 (/ 또는 Ctrl+K)`, or press `/`), type, pick a result. The default cell shows 코스피 일봉.

## Driving it with Playwright (`drive.mjs search-chart`)
`cell = getByRole("region", {name: /^칸 1: /})`; wait `aria-busy="false"`; search dialog `getByRole("dialog", {name: "종목 검색"})` with combobox `종목 검색`; click the `option` containing `005930`; expect the cell `aria-label` to match `삼성전자` and `[data-bar-count]` nonzero. Proof of end state: label `칸 1: 삼성전자 통합 일`, 30 bars from the Kiwoom fixture, `/api/bars?symbol=005930…` 200 in the journey's request list, `PUT /api/ui-state`, no console errors. Past panning: `dragTowardPast` in `web/e2e/harness.ts` (needs more fixture pages than the loopback serves; see Gotchas).

## Gotchas
- Bars come from `ka10081` fixtures: 30 daily bars (to 2026-11-06). The fake returns an empty page for continuation requests, so panning into the past stops after the first page. Other periods/venues map to the fixtures in `verification_loopback_kiwoom.py`; an unmapped api-id answers 404 and shows in `kiwoom-requests.jsonl`.
- Only symbols in `ka10099` fixtures exist (삼성전자, 에코프로 and a few more).
- The server clock is fixed at 2026-11-09 09:00 KST; the status bar says "키움에 다시 연결하는 중" because no WebSocket exists. That is expected here.
