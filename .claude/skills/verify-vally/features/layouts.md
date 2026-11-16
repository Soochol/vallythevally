# Window layouts and docking

## Sub-features
- Dock, floating and canvas modes (ADR 0019); window tabs, split, link groups; named layouts menu `레이아웃:`.
- Layout persisted at `/api/layouts/<id>`; last layout id in `/api/ui-state`.

## How to get to it (user POV)
Top toolbar `차트 도구 막대` → `레이아웃:` button; `창 더하기`; window tab rail.

## Driving it with Playwright (not yet in `drive.mjs`)
Selectors from `web/e2e/win-journey.spec.ts`: `[role=tab][data-window-id]`, `[data-dock-group]`, `[data-canvas-window]`, `getByRole("menu", {name: "레이아웃", exact: true})`. Observable end state: the `PUT /api/layouts/<id>` body's `placement` and the page after `reload`.

## Gotchas
- `web/e2e` seeds layouts through `scenario.documents`; the real server starts with the default layout from the DB seed. A journey must create layouts through the UI.
