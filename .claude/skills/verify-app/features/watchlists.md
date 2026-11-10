# Watchlists

## Sub-features
- Add a symbol to the current list; reorder (drag, or Alt+↑/↓).
- Several lists: create (`새 목록`), switch, move a symbol to another list.
- Choose visible columns (e.g. `거래량`).
- Each row's price, change, change rate and volume move with every trade (realtime `quotes`); REST (`/api/quotes`) is called once, when a symbol first enters the list (#66).
- Past the 200 realtime slots (open cells first, then the list from the top), rows without a slot keep their first value and show `실시간 아님`.
- Everything survives reload and server restart.

## How to get to it (user POV)
Right panel, tab `관심종목` (`complementary "관심종목"`). `관심종목에 넣기` (+) opens dialog `관심종목에 넣을 종목 검색`. The list menu is the button named `관심종목 목록: <name>`.

## Driving it with verify-app
Click `관심종목에 넣기`, fill the dialog's `종목 검색` combobox, click the option with the code. Proof: `li[data-code="<code>"]` appears in the panel, `ctx.api("/api/watchlists")` contains the code, and both survive `page.reload()`. Worked paths: `web/e2e/watchlists.spec.ts`.

Realtime rows: run with `--clock 20261109100000`, push a `0B` trade for the row's `<code>_AL` item with `ctx.fake.pushReal` (fields `10`, `11`, `13` as in `realtime-bars.md`), and expect the `li[data-code="<code>"]` values to change. To pass the 200-slot limit, export `FAKE_KIWOOM_EXTRA_STOCKS=<n>` before `run.sh`: the fake appends `<n>` synthetic KOSPI stocks (`합성종목000`…, codes `950000`, `950010`, …) to the symbol list. Worked paths: `web/e2e/watchlist-realtime.spec.ts`.

## Gotchas
- A fresh DB has one empty list `기본` (`기본에 종목이 없습니다`).
- A row with `실시간 아님` is not a bug: the server gave its slot to an open cell or a row higher in the list. It is not re-fetched.
- Moving to another list opens a menu whose items repeat the list name; `web/e2e/watchlists.spec.ts` picks `.nth(1)`.
