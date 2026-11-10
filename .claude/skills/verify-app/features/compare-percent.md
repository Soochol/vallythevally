# Compare symbols and the percent axis

## Sub-features
- Up to three compare symbols per cell, added and removed from the indicator dialog's `비교 종목` tab. The fourth, a duplicate, and the cell's own symbol are refused with a reason next to the add button.
- The price axis shows % change from the left-edge bar. It is on while any compare exists; without compares the top-bar `%` button or the tab's `가격축을 % 변화로` switch turns it on (`chartSettings.scale = "percent"`).
- Each compare line moves with its own trades. Its legend row (`[data-compare-row="<code>"]`) shows the % at the hovered bar.
- Price-pane indicators (MA, Bollinger, Ichimoku) and drawings stay on the candles in % mode.
- Compare symbols and the axis are saved in the cell's `chartSettings` and survive a reload.

## How to get to it (user POV)
Top bar `지표` → tab `비교 종목` → type in `비교할 종목 찾기` → pick an option → `<name> 추가`. Remove from the tab's list (`<name> 지우기`) or the legend row's ✕ (`<name> 비교 종목 지우기`).

## Driving it with verify-app
Journey `compare-percent.mjs`, with `--clock 20261109100000` (market hours, for the trades). Proof:
- chart `data-price-scale` is `percent` while compares exist, and back to the saved scale after removing them;
- each compare row's `data-last-close` changes after `ctx.fake.pushReal("0B", "<code>_AL", …)`;
- `ctx.api("/api/layouts/<id>")` shows `cells[0].chartSettings.compare` and `scale`.

## Gotchas
- The fake Kiwoom answers every stock with the 005930 fixture and every index with the KOSPI fixture. Two stock compares draw the same line as the main symbol until trades move them apart.
- A compare point is drawn only at a time the main series has. Push a main trade in the same minute (or day) first, then the compare trade.
- The server drops trades while it seeds a new key. Retry a key's first trade inside `expect(...).toPass()`, as `web/e2e/compare.spec.ts` does.
- The dialog's accessible name changes with the tab (`지표 추가` / `비교 종목`). Locate it without a name after switching tabs.
