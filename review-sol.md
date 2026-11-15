# Final independent adversarial review (SOL)

Result: `report-only`; **no verified findings**.

Reviewed HEAD: `d4331706b7f09915026959c81d78ad40584e7b2c`.
Base: `c400e65131dd20e8d05eea2a8c6998c644c2e093`.
Isolated worktree: `target/review-final-sol`.
Scope: the four changed files named in the exact task brief. No application source changes, commits, full suites, nested agents, orchestrator commands, real Kiwoom calls, or external network calls.

Intent: when a contained free position exists, the automatic style bar avoids the moved dock and every displayed selected endpoint handle. Preserve whole-drawing avoidance when feasible, relax spacing before accepting overlap, and preserve saved toolbar positions and window layout. Both original browser cases and the subsequently discovered drawing-bounds fallback are in scope.

## Executed probes

From the isolated worktree:

```sh
git rev-parse HEAD
git status --short
node --max-old-space-size=128 target/final-probe.mjs
```

Node version: `v24.13.1`. Probe: `target/review-final-sol/target/final-probe.mjs`, importing the actual reviewed TypeScript module. The probe was run twice after its final grid alignment adjustment; both runs passed. HEAD printed the reviewed SHA and status printed no changes.

Both previously failing independent endpoint fixtures were rerun using the final required `{ bounds, handles }` interface, with their original caller-derived natural coordinates and independently checked free witnesses:

```json
{"fixture":"sol-original","spot":{"left":281,"top":84},"actual":{"inside":true,"dockClear":true,"endpointClear":[true,true]},"witness":{"left":8,"top":86},"expected":{"inside":true,"dockClear":true,"endpointClear":[true,true]}}
{"fixture":"astra-original","spot":{"left":206,"top":8},"actual":{"inside":true,"dockClear":true,"endpointClear":[true,true]},"witness":{"left":300,"top":8},"expected":{"inside":true,"dockClear":true,"endpointClear":[true,true]}}
{"cases":512,"noBounds":171,"handlesOutsideBounds":243,"selectedBoundsImpossible":172,"dockOnlyFallback":44,"impossibleFallback":24,"naturalUnchanged":8,"halfPixelCases":256,"hierarchy":"pass","containment":"pass","oversizedFallback":"pass"}
```

The deterministic sampled probe independently scans all contained integer or half-pixel top-left positions, matching each case's coordinate lattice, to establish the first feasible obstacle/spacing tier. It checks the returned position against that tier's actual constraints. It exercises zero to four supplied handle boxes, nullable bounds, handle boxes outside bounds, pane-filling bounds, off-pane obstacles, empty preferred-top arrays, all three spacing levels, and dock-only fallback. Every bar that fits remains contained. Natural positions already satisfying the strongest tier remain unchanged. When no tier is feasible, the zero-inset preferred clamp is checked; an explicit oversized-bar case also retains `(0,0)` anchoring. Counts overlap by design. This is sampled geometric evidence, not a universal proof for arbitrary floating-point inputs.

## Source and integration inspection

The strongest tier includes dock, full selection bounds, and all supplied handles. Removing bounds preserves handles; handles are removed only after their spacing tiers are exhausted. `renderItem` produces handles only for selected drawings, so adapting every frame item's handle list supplies the displayed selection handles rather than unrelated drawing points. The saved-position branch remains outside the changed automatic `!saved` placement call. The diff touches no preference storage or window layout implementation.

The final unit additions retain the two proven witnesses and cover no bounds, handles outside bounds, impossible joint placement, spacing relaxation, and oversized bars. The new browser spanning-line case establishes a measured feasible witness and checks containment, both handle regions, dock separation, and actual chart access. I inspected these tests but did not independently rerun Chromium or the repository wrapper suites. The lead separately reports exact-final-HEAD wrapper passes; those are not counted as this reviewer's own executions.

## Dropped and limits

Dropped findings: 0. No run-proven defect survived. The two initial-review findings concern superseded HEAD `ee59ea6eebddd0f3a6119b4dfbfa1e0111563c5d`; the executed final probes above show their required behavior is now satisfied.

This is pre-layout-finish evidence. PR #375 is not part of the reviewed base, and the brief still requires renewed browser checks and independent review on its actual toolbar geometry after integration. This report makes no merge-ready claim.

Instructions followed: exact task brief, `/home/dev/.claude/skills/orch/worker-procedure.md`, project `AGENTS.md` and `docs/web-checks.md`, `pstack:interrogate` adversary procedure and Codex mapping, and TypeScript best-practices/type-system-discipline for source inspection. The parent owns the independent panel; this reviewer spawned no agents.
