# Layout finish — final verification

The goal is polished docking and canvas layouts with existing information, actions and keyboard access preserved on small screens.

Validated product HEAD: `01a2934d9508fcf8130c4e51fe68eb77115249bf`. Integrated main: `1e5f03ea51d5f3553d52dc46384b3df034708234` (includes #377, #379 and #380). This evidence-only commit does not change that product HEAD.

## Checks and independent reviews

439 unit tests in 29 files and TypeScript passed. The named 27 affected E2E specs passed all 291 cases with four workers. The three #377 style-bar regressions passed ten times each (30 passes). [Exact commands and source identities](final-manifests.json) show clean identical pre/post source, fingerprint `f715de4093c521fa80ce9e546d166f30dc5afebc555accc1ddc75add2add1ae1`.

Two fresh independent reviewers (GPT-6 Astra and GPT-6.1 Sol) reviewed this exact HEAD and actually drove the browser in separate isolated worktrees. Neither verified a new product finding. Astra passed nine focused cases, the exact four-chart case and two fresh recovery probes. Sol passed 27 pristine selected cases and two fresh probes, including nine active-toolbar ownership transitions. Reviewer driver/preparation mistakes were preserved separately and corrected without product changes or relaxed assertions. A separate comments/trail reviewer found no added comments, suppressions or concrete dead workaround. The complete reports and traces remain in the worker's `.audit/layout-finish/` and isolated review worktrees.

## Before and after

The historical [before manifest](before-manifest.json) records clean `1ba1077f19e059935439f643cb38f18a1e8a67e5` and an intentionally failing readability diagnostic. It is not a final success result. Final after images come from the clean 291-case run on 01a. [Image provenance and hashes](screenshots.json), [before rectangles](before-rectangles.json), [after rectangles](readability-rectangles.json), [large-chart control](tall-normal-rectangles.json) and [native boundary frames](minimal-frames.json) distinguish text/control containment from document overflow.

| Size | Before | Final |
|---|---|---|
| 1440×900 | [PNG](before-1440x900.png) | [PNG](readability-1440x900.png) |
| 1024×768 | [PNG](before-1024x768.png) | [PNG](readability-1024x768.png) |
| 1024×920 | [PNG](before-1024x920.png) | [PNG](readability-1024x920.png) |

The exact four-chart fixture preserves name/code/venue/period, price/change/time/status, OHLC and volume, actual 24px venue and 18px indicator actions. Native 1015→1016 fixed-pointer frames and real help, width changes/restoration, pinned/scroll/focus/move/cancel/reload, large normal chart, 300px and mobile checks pass. Original twelve docking/canvas journey captures are included beside this file. Canvas overlap is intentional.

## Cost and interaction observations

Five alternating production-build trials per exact baseline4806/candidate01a, identical synthetic four-chart500-bar and single3000-bar fixtures, contain 160 real operation collections with zero work-proof or runtime errors. The complete exclusive source/format/fit boundary includes previously omitted legacy geometry preparation. Four-chart resize1440 median is 146.8→71.6ms (candidate69.2–73.7ms). Single3000 reset is118.7→40.0ms (39.4–41.2ms). Native hover paints only, with zero source/geometry/projection/reservation work. Measured projection nodes remain bounded by rows/fields, not history length; text volume still scales with data.

All candidate renderer rows meet the parent's100ms median/250ms observed-max review guidance; these are not user absolute requirements or permanent CI assertions. Actual four-chart help click-to-visible median remains142.2ms (60.1–147.6), search fill-to-value105.0ms (40.2–127.3), including Playwright overhead. Genuine-work frame intervals reached83.5ms; native hover max16.8ms. This is bounded evidence, not a universal smoothness or latency guarantee. Independent profiles still locate native text-width reads as a limiter. Shared host load and coarse sampling cannot rule out external interference. Full protocol, all observations, source proofs, errors, profiles and previous failed measurements are preserved locally in `hover-cost-v4-report.md` and `hover-cost-v4/`; earlier partial measurements are not substituted for this boundary.

## Limits and handoff

Basic four-chart readability passed three sizes. Separately, existing initial/shrunken docking bodies125–126px/158–159px remain below declared160px (parent follow-up ask11). Extra15–16px panes cannot physically hold18px controls. Arbitrary extra rows or narrower panes are not promised full intrinsic text containment; the approved narrow fallback preserves original help, grip, pins, venue and saved movement rather than hiding data or raising minima. Stored toolbar placement, pane stretch, chart settings and server placement meanings are preserved; automatic density does not save new values.

The final attempt succeeded in its bounded scope; no further product patch or issue was initiated. The parent owns combined full-suite validation and merge. Deployment is held and was not attempted. The canceled toolbar preview is excluded.
