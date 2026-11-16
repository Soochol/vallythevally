# Screener

## Sub-features
- Condition sentences (`web/e2e/sentence-editor.ts`), run against the KRX daily store, result table, open a result on the chart.
- Update band and store status line (`KRX 일봉 · <date>까지`).

## How to get to it (user POV)
Window rail tab `스크리너` (`windowTabs(page).getByRole("tab", {name: /^스크리너/})`, complementary `스크리너`).

## Driving it with Playwright (not yet in `drive.mjs`)
Selectors from `web/e2e/screener-page.ts`: `panel`, `runButton` (`실행`), `results` region `결과`, `tr[data-code]`. A journey would open the tab and click `실행`, then read `GET /api/screener/status`.

## Gotchas
- The sandbox sets `VALLY_SCREENER_UPDATE_ON_START=off`; the store is empty and the loopback fake has no KRX daily-collection fixtures wired (`crates/server/tests/support/krx.rs` builds them in code). A run would report an empty store. Do not weaken the journey: add the fixtures or report the precondition missing.
