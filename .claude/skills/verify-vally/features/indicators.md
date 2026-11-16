# Indicators and chart settings

## Sub-features
- Indicator picker `지표` (Ichimoku, moving averages, panels), compare `비교`, `차트 설정`, volume overlay.
- Settings are saved per window in the layout (`chartSettings`).

## How to get to it (user POV)
Toolbar buttons `지표`, `비교`, `차트 설정`.

## Driving it with Playwright (not yet in `drive.mjs`)
Selectors from `web/e2e/indicators.spec.ts`, `indicator-command.spec.ts`, `chart-settings.spec.ts`. Evidence: chart `data-*` attributes and the saved layout's `chartSettings.indicators`.

## Gotchas
- WASM indicator code must be built (`build_ui.py` does it); a stale `web/src/wasm/indicators` yields a blank panel.
- 30 fixture bars are too few for long-period indicators (e.g. 120-day averages produce no line). Report that as a precondition, not a pass.
