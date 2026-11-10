# vally feature map

Each file: what the feature is, how a user reaches it, how to drive it with `run.sh` + a journey, and what end state proves it. Journeys live in `../journeys/`.

| Feature | File | Journey |
|---|---|---|
| Symbol search and opening a chart | [search-open-chart.md](search-open-chart.md) | `search-open-chart.mjs` (proven 2026-11-10) |
| Realtime bars | [realtime-bars.md](realtime-bars.md) | none yet |
| Watchlists | [watchlists.md](watchlists.md) | none yet |
| Drawings on the chart | [drawings.md](drawings.md) | none yet |
| Venue, period, theme and their restore | [chart-settings.md](chart-settings.md) | none yet |

Not mapped yet: snapshot (차트 이미지), fundamentals panel (종목 정보), indicators, multi-cell layouts, journal/completion controls. `web/e2e/` covers them: `snapshot.spec.ts`, `fundamentals.spec.ts`, `journal-controls.spec.ts`, `completion-controls.spec.ts`.
