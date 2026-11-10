# Realtime bars

## Sub-features
- Each trade moves the current daily bar (close, volume).
- Minute bars: a trade in the next minute closes the bar and appends a new current bar.
- Reconnect after the Kiwoom WebSocket drops; footer (`contentinfo`) shows `키움에 다시 연결하는 중`, then clears.
- If REG is refused, realtime stops (`실시간 멈춤: 서버를 다시 켜야 합니다`) while the queried chart stays usable.
- Theme change while a frame is pending keeps price and volume coherent (#58).

## How to get to it (user POV)
Open any symbol during market hours; the chart updates by itself. Footer shows `실시간 연결됨`.

## Driving it with verify-vally
Run with `--clock 20261109100000` (market hours). Open 삼성전자 005930, wait until `await ctx.fake.registered()` has `"0B"` containing `005930_AL`, then push trades: `ctx.fake.pushReal("0B", "005930_AL", { "20": "100001", "10": "+201000", "15": "+1", "13": "1000", "9081": "KRX", "11": "+0", "12": "+0.00", "25": "2" })` (`20` = HHMMSS, `10` = price, `15` = qty). Proof: chart `data-last-close` and `data-last-bar-t` change; for minute bars `data-bar-count` grows by one at the minute boundary. Retry the push inside `expect(...).toPass()` as `web/e2e/realtime.spec.ts` does.

## Gotchas
- Without `--clock` the server drops trades outside market hours and nothing moves; that is not a bug.
- The fake ignores trades for a minute ahead of the server clock; new-minute pushes need long `toPass` timeouts (about 45 s), as in `pending-frame-series.spec.ts`.
- Item codes carry the venue suffix (`_AL` for 통합).
