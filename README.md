# Dock style overlap evidence

Final verified application HEAD d4331706b7f09915026959c81d78ad40584e7b2c. Base c400e65131dd20e8d05eea2a8c6998c644c2e093.

Scoped unit checks passed22 tests. Named browser checks plus existing dock movement passed36 tests. Three regression cases passed30 repeated executions. The attached manifests record the same clean final HEAD. Full tests belong to orchestrator merge validation and were not run directly.

Each case includes before and after PNG and complete geometry JSON. geometry-summary.json contains viewport, actual pane, dock and style coordinates. Before endpoint/handles captures hit a style control instead of chart; before short capture overlaps the dock. All final captures fit their pane, keep the bars apart and reach chart at both endpoints. Each capture includes a free-position witness.

The 1024x330 viewport has an actual646x124 pane. The 1024x768 viewport has a646x474 pane. Both use measured378x36 dock and333x38 style bars.

These are intermediate pre-layout-finish results. PR375 was still open when final base was fetched. Its actual merged toolbar rectangles require another verification and independent-review pass before merge-ready.
