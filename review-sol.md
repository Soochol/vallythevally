# Independent adversarial review on current main (SOL)

Result: `report-only`; **no verified findings**. Dropped findings: 0.

Reviewed HEAD: `8bf2861bd8b801533327e340667ca72f70ad01ea`.
New base: `5578aabc4ead5923f854daf638947fbf974545fa`.
Isolated review worktree: `target/review-main-sol` (HEAD independently checked; `git status --short` empty).
Previous reviewed HEAD/base: `d4331706b7f09915026959c81d78ad40584e7b2c` / `c400e65131dd20e8d05eea2a8c6998c644c2e093`.

Intent (pstack:in-your-own-words): keep the automatic style bar inside its pane and clear of the moved dock and every displayed selected endpoint handle whenever a free position exists. Prefer avoiding the full selection bounds, reduce spacing before accepting overlap, and preserve saved toolbar/window state. This review follows the explicit resumed instruction: verify PR #377 against current main first; future #375 geometry integration belongs to #375 and the parent. The historical #375 waiting gate does not apply.

## Independent patch identity

I ran a Python subprocess comparison of the complete `git diff c400e65131dd20e8d05eea2a8c6998c644c2e093 d4331706b7f09915026959c81d78ad40584e7b2c` bytes against `git diff 5578aabc4ead5923f854daf638947fbf974545fa 8bf2861bd8b801533327e340667ca72f70ad01ea`, and independently resolved each changed path with `git rev-parse SHA:path`. Both complete patches have SHA-256 `e24d77d1153b03a3d0c95107c8223e00aed7a3bddf7948e450105d6aa06fecad`; byte equality is true. All four old/new feature blobs match:

| Path | Blob at both feature HEADs |
| --- | --- |
| `web/src/features/drawings/dockSpot.ts` | `6b0ac761f445e5b4521c7f03c319141924deffa3` |
| `web/src/features/drawings/DrawingOverlay.tsx` | `ed541de461263f3da4b6354787fbf93be14fcce7` |
| `web/src/features/drawings/dockSpot.test.ts` | `a09b02c15676cf7a2088652e4e32a40df3da4ff9` |
| `web/e2e/float-dock.spec.ts` | `2cbdcde106a418ada69928916ae290963f501bf3` |

`git diff --name-only c400e65131dd20e8d05eea2a8c6998c644c2e093 5578aabc4ead5923f854daf638947fbf974545fa -- web` returns only `web/src/api/generated/LayoutWindow.ts` and `web/src/api/generated/WindowContent.ts`. Their inspected changes reorder the same chart fields without changing types or values. Other base changes are server flat-JSON/SQL handling and a plan document. There is no changed web geometry runtime in the new base.

## Executed probe against exact HEAD

From `target/review-main-sol`:

```sh
git rev-parse HEAD
git status --short
node --max-old-space-size=128 target/final-probe.mjs
```

Node `v24.13.1`; probe exit 0. The probe imports `../web/src/features/drawings/dockSpot.ts` from this isolated reviewed tree, rather than a historic build.

```json
{"fixture":"sol-original","spot":{"left":281,"top":84},"actual":{"inside":true,"dockClear":true,"endpointClear":[true,true]},"witness":{"left":8,"top":86},"expected":{"inside":true,"dockClear":true,"endpointClear":[true,true]}}
{"fixture":"astra-original","spot":{"left":206,"top":8},"actual":{"inside":true,"dockClear":true,"endpointClear":[true,true]},"witness":{"left":300,"top":8},"expected":{"inside":true,"dockClear":true,"endpointClear":[true,true]}}
{"cases":512,"noBounds":171,"handlesOutsideBounds":243,"selectedBoundsImpossible":172,"dockOnlyFallback":44,"impossibleFallback":24,"naturalUnchanged":8,"halfPixelCases":256,"hierarchy":"pass","containment":"pass","oversizedFallback":"pass"}
```

The deterministic probe independently scans each integer/half-pixel lattice for the first feasible obstacle/spacing tier and checks the actual returned position against it. It covers nullable/pane-filling bounds, handles outside bounds, zero to four handle obstacles, off-pane obstacles, empty preferred arrays, spacing relaxation, dock-only fallback, natural-position preservation, and oversized bars. This is bounded sampled evidence, not a universal floating-point proof.

## Runtime and current browser evidence

I inspected `DrawingOverlay.tsx`, `DrawingSurface.ts`, `frame.ts`, `Popover.tsx`, and overlay positioning. The follow callback reads the current pane/frame, measures actual toolbar dimensions, and measures dock edges relative to the overlay every animation frame. `renderItem` emits handles only for selected drawings; collecting every frame item's handles therefore includes the displayed selection handles. `HANDLE_HIT_PX` is 6. The obstacle hierarchy retains all handles after selection bounds are relaxed, only dropping handles when all their spacing/containment tiers are impossible. The saved position bypass remains `!saved && dock?.moved`; no persistence or window-layout code is changed. Existing Popover gap compensation is preserved by subtracting `OVERLAY_GAP` from the selected actual top.

I independently read the three current manifests and command logs, all `passed`, exit 0, exact reviewed HEAD, `dirty: false`, source fingerprint `d1ca5826cee16d4c6e798f677b48961138ffab7761ec0fcefc552dfd70b53932`:

- `target/web-runs/check-cthia2ni/manifest.json`: 22 targeted units, types passed.
- `target/web-runs/e2e-7xjdzawj/manifest.json`: 36 specified and moved-dock E2E cases.
- `target/web-runs/e2e-liboger0/manifest.json`: 30 regression repetitions.

Those wrapper runs were executed by the lead, not this reviewer. I independently ran a Python audit over all 33 `style-geometry.json` artifacts under the two current E2E result directories. It asserted exact clean manifest HEAD, artifact counts 3/30, pane containment of dock/style/witness, witness and actual style separation from dock plus both 12px endpoint hit boxes, and every recorded endpoint `elementFromPoint` reaching the chart. Exit 0 printed:

```json
{"exactHead":"8bf2861bd8b801533327e340667ca72f70ad01ea","geometryArtifactsChecked":33,"containment":"pass","freeWitness":"pass","dockClear":"pass","bothHandleRegionsClear":"pass","elementFromPointChartAccess":"pass"}
```

The current 1024×768 artifact has actual pane `(12,106,646,474)`, dock `(146,146,378,36)`, and style `(27.375,190,333,38)`. Both short artifacts use an actual 646×124 pane at `(12,106)` and dock `(146,154,378,36)`: short-line style `(195.421875,116,333,38)` touches above the dock; spanning-line style `(291.875,190,333,38)` touches below it. Both endpoint regions and their measured free witnesses pass in each case, including all repetitions.

## Verdict and scope

No run-proven defect survived. No dropped allegations. No product/test edits, commits, nested agents, orchestrator commands, full-suite runs, main merges, deployment, or other-worker controls were performed. Only this requested audit report was written. Future #375 geometry needs its own integration checks; it is not a prerequisite to this exact-current-main verdict.

Instructions applied: explicit resumed task and worker procedure, repository `AGENTS.md`, `docs/web-checks.md`, `pstack:interrogate` with Codex mapping, `pstack:in-your-own-words`, and TypeScript best-practices/type-system-discipline for inspection. This reviewer is one independent member of the parent's panel and did not spawn agents. CI/PR mutation and merge-ready determination remain with the parent.
