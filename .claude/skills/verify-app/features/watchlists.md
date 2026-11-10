# Watchlists

## Sub-features
- Add a symbol to the current list; reorder (drag, or Alt+↑/↓).
- Several lists: create (`새 목록`), switch, move a symbol to another list.
- Choose visible columns (e.g. `거래량`).
- Everything survives reload and server restart.

## How to get to it (user POV)
Right panel, tab `관심종목` (`complementary "관심종목"`). `관심종목에 넣기` (+) opens dialog `관심종목에 넣을 종목 검색`. The list menu is the button named `관심종목 목록: <name>`.

## Driving it with verify-app
Click `관심종목에 넣기`, fill the dialog's `종목 검색` combobox, click the option with the code. Proof: `li[data-code="<code>"]` appears in the panel, `ctx.api("/api/watchlists")` contains the code, and both survive `page.reload()`. Worked paths: `web/e2e/watchlists.spec.ts`.

## Gotchas
- A fresh DB has one empty list `기본` (`기본에 종목이 없습니다`).
- Moving to another list opens a menu whose items repeat the list name; `web/e2e/watchlists.spec.ts` picks `.nth(1)`.
