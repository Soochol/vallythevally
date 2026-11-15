# Current-main independent interrogate review

Reviewed by gpt-6-astra. Result: report-only; no verified findings. This is the independently executed Astra arm of the parent's interrogate panel, with no nested agents or source edits.

Intent: keep the automatically placed style bar inside the actual pane and clear of the moved dock and every actual selected handle box whenever a feasible placement exists. Relax optional spacing before allowing overlap; preserve saved toolbar positions and window state.

Reviewed HEAD `8bf2861bd8b801533327e340667ca72f70ad01ea` in isolated `target/review-main-astra`, based on `5578aabc4ead5923f854daf638947fbf974545fa`. Both the isolated checkout and parent checkout were clean. Applied the interrogate procedure and Codex mapping, with TypeScript/type-system guidance for source inspection.

## Executed adversarial probe

From the isolated checkout, ran `node target/geometry-probe.mjs` against its own imported `../web/src/features/drawings/dockSpot.ts`. Exit code 0:

```json
{"fixture":"sol","spot":{"left":281,"top":84},"actual":{"inside":true,"dockClear":true,"endpointsClear":true},"witness":{"left":8,"top":86}}
{"fixture":"astra","spot":{"left":206,"top":8},"actual":{"inside":true,"dockClear":true,"endpointsClear":true},"witness":{"left":300,"top":8}}
{"cases":750,"hierarchy":"pass","stageCounts":[423,58,137,16,0,20,0,0,0,96],"failures":0}
{"fixture":"dock-only","spot":{"left":112,"top":12},"requiredConstraints":"pass"}
{"fixture":"external-handle","spot":{"left":492,"top":120},"requiredConstraints":"pass"}
{"fixture":"no-bounds","spot":{"left":492,"top":120},"requiredConstraints":"pass"}
```

The bounded brute-force oracle finds the first feasible constraint tier independently and checks the real solver's answer against it. Both old failure fixtures now retain endpoint accessibility. The probe also covers absent bounds, handles outside the pane and deterministic dock-only fallback. No candidate findings were dropped; none failed the run.

## Integration and official evidence

Independently compared the complete `git diff c400e65131dd20e8d05eea2a8c6998c644c2e093 d4331706b7f09915026959c81d78ad40584e7b2c` with `git diff 5578aabc4ead5923f854daf638947fbf974545fa 8bf2861bd8b801533327e340667ca72f70ad01ea`. They are byte-identical, SHA-256 `e24d77d1153b03a3d0c95107c8223e00aed7a3bddf7948e450105d6aa06fecad`. Independently checked all four file blob IDs against `.audit/dock-style-overlap-main-comparison.json`; all match. `git merge-base --is-ancestor` confirms the new base is included.

The base-to-base browser source changes are only generated `LayoutWindow.ts` and `WindowContent.ts` property ordering. Both retain the same chart fields and types. The other changes are server files and a plan document; none changes the overlay/dock runtime. The new official type checks pass.

`DrawingOverlay` still samples `surface.frame().pane`, actual toolbar offset dimensions and `dockBox()` DOM rectangles on each animation frame. `dockBox()` translates viewport rectangles into overlay coordinates. `frame.ts:renderItem` supplies handles only for selected items; the overlay expands every such handle by the existing 6px hit radius. The changed code neither persists positions nor modifies the saved-toolbar branch. The avoidance call is still gated by `!saved && dock?.moved`. The bounds/handles contract therefore does not depend on PR375's future default toolbar placement.

Read all three official manifests and command logs. Each records passed/exit0, identical source/source_after, clean HEAD `8bf2861bd8b801533327e340667ca72f70ad01ea`, and source fingerprint `d1ca5826cee16d4c6e798f677b48961138ffab7761ec0fcefc552dfd70b53932`:

- `target/web-runs/check-cthia2ni/manifest.json`: 22 units; scoped dockSpot command.
- `target/web-runs/e2e-7xjdzawj/manifest.json`: 36 browser tests across float-dock, float-surfaces, overlay-input and drawing-dock-move.
- `target/web-runs/e2e-liboger0/manifest.json`: 30 passes, each of three overlap regressions repeated ten times.

Separately recomputed inside/nonoverlap/6px-handle predicates from all 33 `results/*/style-geometry.json` artifacts across the two browser runs. All witnesses and final style rectangles fit the pane and avoid dock and handles; all endpoint hit targets are accessible CANVAS. Actual panes are 646×474 at viewport 1024×768 and 646×124 at viewport 1024×330. Dock is 378×36, style is 333×38. The three scoped-run final style origins are (27.375,190), (195.421875,116), and (291.875,190), in viewport coordinates.

## Limits

This report establishes the reviewed local HEAD and its scoped geometry evidence. It does not establish current remote PR HEAD, CI, conflict or thread state, and is not a merge-ready declaration. The newer explicit t1q0 instruction removes the earlier PR375 waiting order; later PR375 layout integration and the full suite remain with PR375/the parent. No full suite, main merge, deployment or external session was performed.
