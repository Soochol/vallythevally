# Watchlists

## Sub-features
- Lists (default 기본), groups that are subsets of a list (ADR 0017, 0018), add/remove symbols, reorder, undo.
- Persisted by the server (`/api/watchlists`, SQLite `data/vally.db`), so they survive a reload and a server restart.

## How to get to it (user POV)
Right dock panel `관심종목`. With an empty list, `관심종목에 넣기` opens a symbol search.

## Driving it with Playwright (`drive.mjs watchlist-add`)
`panel = getByRole("complementary", {name: "관심종목"})`; click `관심종목에 넣기`; dialog `관심종목에 넣을 종목 검색`, combobox `종목 검색`, fill `삼성전자`, click option `005930`; expect `li[data-code="005930"]`. Side effect: poll `GET /api/watchlists` until it contains `005930`, `reload`, the row is still there, server body `{"lists":[{"name":"기본","symbols":["005930"]…}]}`. More selectors: `web/e2e/watchlists.spec.ts`, `watchlist-groups.spec.ts`, `watchlist-undo.spec.ts`.

## Gotchas
- Live price columns stay empty: no WebSocket in the sandbox, quotes come only from `ka10095` fixtures.
- Persistence across a server restart is not yet a journey. To prove it, `down` and `up` do not share a data dir (each run is fresh); start the server again by hand with the same `server.env`.
