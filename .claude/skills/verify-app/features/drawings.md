# Drawings on the chart

## Sub-features
- Trendline (key `T` with the cell focused) and other tools from the left toolbar; handles, Shift for 45°, clone, clipboard, undo/redo.
- Style toolbar `드로잉 스타일` (e.g. `선 굵기`), magnet (`자석 세기`), lock (`잠금`), hide all (`모든 드로잉 숨기기`), object list (`개체 목록 열기` → region `개체 목록`).
- Drawings are saved per symbol and keep their time/price anchors across periods.

## How to get to it (user POV)
Focus a cell, press `T` (or pick the tool), drag on the chart.

## Driving it with verify-app
Focus `region "칸 1: …"`, press `T`, drag inside `[data-bar-count]`'s bounding box from (0.76, 0.35) to (0.86, 0.25) of its width/height. Proof: `.drawing-mirror[data-drawings]` JSON has one entry, `ctx.api("/api/drawings?symbol=IDX%3A001")` (the default 코스피 cell) returns one drawing with the same points, and it is still there after `page.reload()`. Worked paths: `web/e2e/drawing-engine.spec.ts`.

## Gotchas
- The symbol key in the drawings API is the cell's symbol id (`IDX:001` for 코스피), URL-encoded.
- Wait for `data-bar-count` to be non-zero before drawing; a drag on an empty chart places nothing.
