# Final independent adversarial review

Intent: keep the automatic style bar inside the pane and clear of the moved dock and selected handles whenever a free placement exists. Reduce optional spacing before accepting overlap. Preserve saved toolbar positions and window layout.

Result: report-only, no verified findings. Reviewed by gpt-6-astra against HEAD `d4331706b7f09915026959c81d78ad40584e7b2c`, base `c400e65131dd20e8d05eea2a8c6998c644c2e093`, in isolated `target/review-final-astra`. This supersedes the defect verdict on `ee59ea6`; it is not a merge-ready verdict. The layout-finish PR #375 integration gate remains open.

## Executed adversarial checks

Run from the task worktree root with Node v24.13.1:

```sh
node target/review-final-astra/target/geometry-probe.mjs
```

The script imports the real final `dockSpot.ts`. Exit 0; output retained in `target/review-final-astra/target/geometry-probe.log`:

```json
{"fixture":"sol","spot":{"left":281,"top":84},"actual":{"inside":true,"dockClear":true,"endpointsClear":true},"witness":{"left":8,"top":86}}
{"fixture":"astra","spot":{"left":206,"top":8},"actual":{"inside":true,"dockClear":true,"endpointsClear":true},"witness":{"left":300,"top":8}}
{"cases":750,"hierarchy":"pass","stageCounts":[423,58,137,16,0,20,0,0,0,96],"failures":0}
{"fixture":"dock-only","spot":{"left":112,"top":12},"requiredConstraints":"pass"}
{"fixture":"external-handle","spot":{"left":492,"top":120},"requiredConstraints":"pass"}
{"fixture":"no-bounds","spot":{"left":492,"top":120},"requiredConstraints":"pass"}
```

The first two cases replay the independently proven failures with the new required `{ bounds, handles }` argument and the caller's actual natural-position inputs. Both return contained, dock-clear and endpoint-clear placements. The 750 deterministic bounded integer cases use an exhaustive grid witness to identify the earliest feasible obstacle/spacing tier and assert that the implementation satisfies that tier. Cases include absent bounds, up to three handles, out-of-pane obstacles, and oversized bars. Extra fixtures directly exercise dock-only fallback, handles outside drawing bounds, and handles with no bounds. This is bounded evidence, not a proof for all continuous geometry.

## Integration and existing evidence

The final diff is limited to the four authorized files. `SelectionObstacles` requires both fields. The overlay uses displayed frame handles; `frame.ts:36` only populates those handles for selected drawings. Bounds and handle boxes use the existing six-pixel hit radius. The solver keeps all handles in the full-bounds tier, then tries handles plus dock, then dock alone, exhausting gap/inset relaxation within each tier. The `!saved && dock?.moved` guard and saved-position branch preserve saved-coordinate behavior. No storage or window-layout source changed.

I inspected the final run manifests, logs and geometry attachments rather than launching duplicate browser builds:

- `target/web-runs/check-6yatmc7x/manifest.json`: `python3 scripts/web.py check src/features/drawings/dockSpot.test.ts`; 22 tests passed (`command-2.log`).
- `target/web-runs/e2e-u5ttdw8v/manifest.json`: `python3 scripts/web.py e2e e2e/float-dock.spec.ts e2e/float-surfaces.spec.ts e2e/overlay-input.spec.ts e2e/drawing-dock-move.spec.ts`; 36 passed (`command-3.log`).
- `target/web-runs/e2e-oo5ysf1a/manifest.json`: `python3 scripts/web.py e2e e2e/float-dock.spec.ts --grep 'style bar keeps|style bar fits' --repeat-each=10`; 30 passed (`command-3.log`).

All three manifests report clean final HEAD `d433170`, source fingerprint `a0722d971df334170d05d2762587fe2815351e6ae06a8aaadb6494054d76de11`, passed status, and exit code 0. The repeat pattern now includes the additional fallback regression, giving three tests times ten executions.

The final attachments show a 1024×768 viewport with a 646×474 pane and a 1024×330 viewport with a 646×124 pane. Dock size is 378×36; style size is 333×38. All captured endpoint hit tests reach CANVAS. The added fallback case previously failed in `e2e-hm835znk`: its upper endpoint hit the style grip while a free witness existed. In `e2e-vqwnkbe4` and final `e2e-u5ttdw8v`, both endpoint hits reach CANVAS and the style bar is contained below the dock. The dirty precommit success and clean final success have the same source fingerprint; they are still recorded separately.

## Findings, dropped hypotheses, and limits

No verified findings. Zero new defect findings were dropped. The two old endpoint fixtures now pass and their prior finding is resolved. The bounded search found no candidate-completeness or fallback-order failure. I make no claim of exhaustive fractional-coordinate or performance coverage.

The brief requires repeating these checks and independent review after layout-finish #375 lands on main, using its actual toolbar rectangles. This review establishes the current pre-layout implementation only. No application files, full suite, external service, real Kiwoom transport, hc/orch process, or nested agent were used. Repro artifacts stay under this review worktree's target directory.

Procedure followed: pstack:interrogate independent adversary; Codex platform mapping; repository web-check instructions; TypeScript best-practices and type-system-discipline. The parent owns the panel and final rerun of reviewer commands.
