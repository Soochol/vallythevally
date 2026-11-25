# Market overview expansion plan

## What changes

The `/market` page expands from a single-market 5-card screen into a 2-layer hybrid market command screen with a 3rd layer of derived and macro modules.

1. Layer 1 shows KOSPI and KOSDAQ side by side with a joint summary, 5-axis health scores, futures basis, VKOSPI, USD/KRW, and global macro tickers. Clicking either market card focuses Layer 2 on that market. Clicking again returns Layer 2 to the combined Korean market view.
2. Layer 2 covers spot and futures cumulative flow, 11 institutional categories, program arbitrage balance, 9-bucket return distribution, KRX vs NXT turnover share, 52-week high and low counts, sector and Kiwoom theme rotation, liquidity and VI pulses, turnover pace, and an expanded stock table.
3. Layer 3 adds index point attribution, percentage of stocks above 5, 20, 60, and 200-day moving averages, sector and theme RRG rotation, option PCR and expiry calendar, 08:00 to 20:00 session DNA, foreign brokerage and orderbook pressure, and filtered OpenDART disclosure alerts.

Grounding against `HEAD` (`a0030905`) confirmed that `JobName::Overview` and `JobName::IntradaySamples` already run in `crates/collector/src/shared/overview/` and publish to `OverviewBody` and `SampleBoard`. This plan builds on those existing boards instead of recreating them.

## PR ids in landing order

1. [x] `MKT-01` (`7f84daf0`) Derived market breadth, point attribution, and MA thrust from existing snapshots and daily bars (zero new external API calls).
2. [x] `MKT-02` (`32fea100`) Existing Kiwoom collector extensions: intraday `ka90001` theme returns, `ka10054` VI feed, and `/api/market-overview/themes` + `/vi` (`crates/server` TRs already implemented).
3. [x] `MKT-03` (`a21e5633`) Two-layer hybrid `/market` UI shell and Layer 1/2 cards wired to existing + `MKT-01` + `MKT-02` endpoints (review-gated interaction change).
4. [x] `MKT-04` (`b3ab18f2`) KIS shared-data child execution path resolving `Market::Kis(None)` in `crates/collector/src/shared/child.rs` under ADR 0043 Option C.
5. [x] `MKT-05` (`aae1d7a9`) Live wire fixture capture CLI probe (`collector probe-tr`) for unverified Kiwoom and KIS TRs (operator-run tool producing sanitized fixtures under `crates/server/tests/fixtures/`).
6. [ ] `MKT-06` KIS global macro, FX, holiday calendar, and domestic futures/options collector jobs (`FHKST03030100`, `FHMIF10000000`, `FHPTJ04030000` derivatives, `FHPIF05030000`, `CTCA0903R`) — awaits operator `collector probe-tr` fixtures.
7. [ ] `MKT-07` Kiwoom institutional detail, program arbitrage, events, and lending/short collector jobs (`ka10063`, `ka10066`, `ka90006`, `ka90007`, `ka10010`, `ka10016`, `ka10017`, `ka10036`, `ka10037`, `ka10068`, `ka90012`, `ka40004`) plus KIS market funds and short-sale rank (`FHKST649100C0`, `FHPST04820000`, `FHPST01390000`) — awaits operator `collector probe-tr` fixtures.
8. [x] `MKT-08` (`7130274f` backend, `59d5d5da` UI) Derived RRG rotation, 08:00 to 20:00 session DNA, brokerage/book pressure, and filtered OpenDART disclosure endpoints and Layer 3 UI cards.
9. [ ] `MKT-09` Remaining Layer 3 macro ribbon, derivatives/PCR card, and 11-institution/arbitrage/risk tabs wired to `MKT-06` and `MKT-07` (review-gated interaction change) — awaits `MKT-06` and `MKT-07`.

## Dependency graph

```text
trunk (main)
├── MKT-01 (independent, derived snapshot/bar endpoints) ──┐
├── MKT-02 (independent, existing Kiwoom TRs in collector) ┼──▶ MKT-03 (Layer 1+2 /market UI, review-gated) ──┐
├── MKT-04 (independent, KIS shared child path, ADR gate) ─┤                                                  │
└── MKT-05 (independent, fixture capture probe tool) ──────┼──▶ MKT-06 (KIS macro + derivatives) ─────────────┤
                                                           ├──▶ MKT-07 (Kiwoom + KIS flow/risk/events) ───────┼──▶ MKT-09 (Layer 3 + macro UI, review-gated)
                                                           └──▶ MKT-08 (RRG + DNA + broker + DART derived) ───┘
```

### Independent trunk branches and file ownership

| PR id | Branches from | Waits for | Allowed file scope | Review gate |
| :--- | :--- | :--- | :--- | :--- |
| `MKT-01` | `main` | None | `crates/server/src/market_overview/{mod.rs,dto.rs,derived.rs,cards.rs}`, `crates/server/tests/market_overview*.rs`, `web/src/api/generated/*` | No |
| `MKT-02` | `main` | None | `crates/collector/src/shared/{mod.rs,themes/*,events/*,overview/*}`, `crates/server/src/shared_data/{mod.rs,format.rs,themes.rs,events.rs}`, `crates/server/src/market_overview/{mod.rs,dto.rs,shared.rs}` | No |
| `MKT-03` | `MKT-01` + `MKT-02` | `MKT-01`, `MKT-02` | `web/src/features/market-page/*`, `web/src/api/marketOverview.ts`, `web/e2e/market-page.spec.ts`, `web/e2e/fixtures/market-data.ts`, `docs/market-overview-api.md` | Yes (UI interaction) |
| `MKT-04` | `main` | None | `crates/collector/src/shared/{child.rs,job.rs,kis_proxy.rs}`, `crates/collector/src/supervise/shared.rs`, `docs/adr/0043-*.md` or new ADR | Yes (ADR 0043 boundary) |
| `MKT-05` | `main` | None | `crates/collector/src/probe_tr.rs`, `crates/collector/src/main.rs`, `crates/server/tests/fixtures/{kis,kiwoom}/README.md` | No |
| `MKT-06` | `MKT-04` + `MKT-05` | `MKT-04`, `MKT-05` | `crates/server/src/kis/{api.rs,macro_data.rs,derivatives.rs}`, `crates/collector/src/shared/{macro_job.rs,derivatives_job.rs,mod.rs}`, `crates/server/src/shared_data/{macro_data.rs,derivatives.rs,mod.rs,format.rs}`, `crates/server/tests/fixtures/kis/*` | No |
| `MKT-07` | `MKT-04` + `MKT-05` | `MKT-04`, `MKT-05` | `crates/server/src/kiwoom/api.rs`, `crates/server/src/kis/api.rs`, `crates/collector/src/shared/{detail_flow.rs,risk.rs,events/*,etf.rs,mod.rs}`, `crates/server/src/shared_data/*`, `crates/server/tests/fixtures/{kiwoom,kis}/*` | No |
| `MKT-08` | `MKT-02` | `MKT-02` | `crates/server/src/market_overview/{rrg.rs,session_dna.rs,broker_book.rs,disclosures.rs,dto.rs,mod.rs}`, `crates/server/tests/market_overview_pro.rs`, `web/src/api/generated/*` | No |
| `MKT-09` | `MKT-03` + `MKT-06` + `MKT-07` + `MKT-08` | `MKT-03`, `MKT-06`, `MKT-07`, `MKT-08` | `web/src/features/market-page/*`, `web/src/api/marketOverview.ts`, `web/e2e/market-page.spec.ts`, `web/e2e/market-page-pro.spec.ts`, `docs/market-overview-api.md`, `GLOSSARY.md` | Yes (UI interaction) |

---

## MKT-01 Derived breadth, point attribution, and MA thrust

- [ ] Depends on: none (branches from `main`).
- [ ] Files edited: `crates/server/src/market_overview/derived.rs`, `crates/server/src/market_overview/dto.rs`, `crates/server/src/market_overview/mod.rs`, `crates/server/tests/market_overview_derived.rs`, regenerated `web/src/api/generated/*`.
- [ ] One change built: add pure server derivation from `SharedData` snapshots (`SnapshotCombined`, `SnapshotKrx`, `SnapshotNxt`), listing share counts, and the daily bar store to expose `GET /api/market-overview/derived?scope=all|kospi|kosdaq`. Core typed shape is `MarketOverviewDerived` containing `histogram: [u32; 9]`, `venueShare: { krxRatio, nxtRatio }`, `attribution: { topPositive, topNegative, topTwoConcentrationPct }`, and `maThrust: { above5Pct, above20Pct, above60Pct, above200Pct, history20d }`. Zero new external broker calls.
- [ ] Visible result: `GET /api/market-overview/derived` returns deterministic JSON for `all`, `kospi`, and `kosdaq`, and degrades cleanly to `MarketOverviewPart::Failed` per sub-block when snapshots or daily bars are absent.
- [ ] Unit verification: `python3 scripts/dev.py cargo test -p server --test market_overview_derived` and `python3 scripts/dev.py cargo clippy -p server --all-targets -- -D warnings`.
- [ ] Live verification: boot loopback test server with populated `SnapshotCombined`, `SnapshotKrx`, `SnapshotNxt`, and 200-day bar fixture; fetch `/api/market-overview/derived?scope=all`; assert sum of 9 histogram buckets equals listed stock count, `krxRatio + nxtRatio == 1.0`, and top-2 attribution matches manual hand calculation.
- [ ] Perf verification: metric is p95 computation time for `derive_market_snapshot` over 2,600 stocks. Probe is a Rust criterion or release-profile timing test (`cargo test --release -p server --test market_overview_derived -- --ignored --nocapture`). Trunk baseline is measured on an empty stub first; fail threshold is p95 > 15 ms per 30-second snapshot tick.

## MKT-02 Existing Kiwoom TRs in collector shared data

- [ ] Depends on: none (branches from `main`).
- [ ] Files edited: `crates/collector/src/shared/themes/mod.rs`, `crates/collector/src/shared/events/mod.rs`, `crates/collector/src/shared/mod.rs`, `crates/server/src/shared_data/{format.rs,mod.rs,themes.rs,events.rs}`, `crates/server/src/market_overview/{dto.rs,mod.rs,shared.rs}`.
- [ ] One change built: extend `KiwoomThemesJob` to capture intraday `ka90001` theme return snapshots every 180 seconds during 09:00 to 15:30 while keeping `ka90002` member catalog once daily at 08:30; add a `ViEventsJob` polling already-implemented `ApiId::Ka10054` every 60 seconds and publishing `DataKind::ViEvents`; expose `GET /api/market-overview/themes` and `GET /api/market-overview/vi`.
- [ ] Visible result: collector writes `<shared>/themes-intraday/<YYYYMMDD>.json` and `<shared>/vi-events/<YYYYMMDD>.json` atomically; server serves both endpoints from shared files with zero per-request broker calls.
- [ ] Unit verification: `python3 scripts/dev.py cargo test -p collector` and `python3 scripts/dev.py cargo test -p server` using synthetic Kiwoom transports.
- [ ] Live verification: run `collector shared` synthetic harness across a simulated 08:30 to 15:30 clock (`Clock` jumps); verify `ka90002` fires once at 08:30, `ka90001` updates on 180-second ticks, `ka10054` publishes VI rows, and `vally-server` returns updated JSON after `SharedData::poll_once`.
- [ ] Perf verification: metric is Kiwoom `rest` key requests per second reported in `<data>/usage/<YYYYMMDD>.jsonl`. Measure trunk baseline on existing `overview + rankings + snapshot` assignment; fail threshold is peak `key_max_per_second > 5` or any `rate_limited > 0` under synthetic 5 req/s cap.

## MKT-03 Two-layer hybrid `/market` UI shell (review-gated)

- [ ] Depends on: `MKT-01`, `MKT-02`.
- [ ] Files edited: `web/src/features/market-page/{MarketPage.tsx,DualIndexHero.tsx,BreadthXrayCard.tsx,ThemeRotationTab.tsx,FlowCard.tsx,SectorCard.tsx,TurnoverCard.tsx,StockTabs.tsx,marketPage.css}`, `web/src/api/marketOverview.ts`, `web/e2e/market-page.spec.ts`, `web/e2e/fixtures/market-data.ts`, `docs/market-overview-api.md`.
- [ ] One change built: replace the single-market top toggle with Layer 1 dual KOSPI and KOSDAQ cards plus joint diagnosis and 5-axis health radar; add Layer 2 `scope` state (`all | kospi | kosdaq`) synced to URL `?scope=` and clickable from the KOSPI and KOSDAQ cards; add the 9-bucket histogram, KRX vs NXT bar, intraday Kiwoom themes tab, and VI tab inside StockTabs.
- [ ] Visible result: `/market` loads both KOSPI and KOSDAQ simultaneously at `1440x900` with zero layout shift while loading, allows clicking a market card to focus Layer 2 and clicking again to return to `all`, and keeps per-card error isolation.
- [ ] Unit verification: `python3 scripts/web.py check src/features/market-page/`.
- [ ] Live verification: `python3 scripts/web.py e2e e2e/market-page.spec.ts e2e/market-source.spec.ts` covering dual-card click focus, URL reload persistence, 4.5:1 contrast check on sector tiles, partial 503 error isolation, and symbol click-to-chart handoff; operator visual review required before merge.
- [ ] Perf verification: metric is Playwright DOM content and main-thread layout shift (CLS) plus initial render time on `1440x900` viewport. Capture baseline from `main` on `e2e/market-page.spec.ts`; fail threshold is CLS > 0.01 or initial card-ready render regression > 100 ms.

## MKT-04 KIS shared-data child execution path under ADR 0043 (Option C approved)

- [ ] Depends on: none (branches from `main`). Operator selected Option C on 2026-11-25: amend ADR 0043 so KIS `rest` shared children receive `appkey` and `appsecret` once over stdin while keeping token issuance exclusively in the supervisor daemon.
- [ ] Files edited: `crates/collector/src/protocol.rs`, `crates/collector/src/shared/{child.rs,job.rs}`, `crates/collector/src/supervise/shared.rs`, `crates/server/src/kis/{auth.rs,rest.rs}`, `crates/collector/tests/shared_kis.rs`, `docs/adr/0043-collector-makes-shared-data-and-the-server-only-reads-it.md`.
- [ ] One change built: add a non-issuing `KisAuth::keyless_with_headers(app_key, app_secret)` (or equivalent `issue_disabled` mode) and a stdin `Command::KisToken` (or `credentials` field on `Command::Token`) so `crates/collector/src/shared/child.rs` constructs a real `KisRest` for `Broker::Kis` without ever writing secrets to argv, env, disk, or logs and without allowing the child to issue tokens.
- [ ] Visible result: a `collector shared --child --broker kis` process executes `OverviewJob` and `IntradaySamplesJob` via `KisRest`, records per-TR usage in `usage/<YYYYMMDD>.jsonl`, and emits `token_invalid` when a token expires instead of issuing tokens itself.
- [ ] Unit verification: `python3 scripts/dev.py cargo test -p collector` and `python3 scripts/dev.py cargo test -p server kis::` plus `clippy --all-targets -- -D warnings`.
- [ ] Live verification: spawn supervisor + KIS shared child against a synthetic loopback KIS HTTP server; verify upstream receives `appkey`, `appsecret`, and `authorization` headers, child rejects self-issuance on 401 and sends `token_invalid`, and child argv/env contain neither secret.
- [ ] Perf verification: metric is per-request overhead of `KisRest` inside the shared child vs direct `KisRest`. Fail threshold is added p95 overhead > 1 ms or missing per-TR usage accounting.

## MKT-05 Operator fixture capture tool for unverified TRs

- [ ] Depends on: none (branches from `main`).
- [ ] Files edited: `crates/collector/src/probe_tr.rs`, `crates/collector/src/main.rs`, `crates/server/tests/fixtures/{kis,kiwoom}/README.md`.
- [ ] One change built: add an explicit operator-only subcommand (`collector probe-tr --broker kiwoom|kis --tr <TR> --out <dir>`) that calls one named TR once using existing local credentials, scrubs tokens and account identifiers, and writes the raw JSON payload to a fixture file for offline parser development. Never runs in automated tests.
- [ ] Visible result: operator runs the probe once during market hours to capture real wire responses for the unverified TR list (`FHKST03030100`, `FHMIF10000000`, `FHPTJ04030000` with `F001`/`OC01`/`OP01`, `FHPIF05030000`, `FHKST649100C0`, `FHPST04820000`, `FHPST01390000`, `CTCA0903R`, and Kiwoom `ka10063`, `ka10066`, `ka90006`, `ka90007`, `ka10010`, `ka10016`, `ka10017`, `ka10036`, `ka10037`, `ka10068`, `ka90012`, `ka40004`).
- [ ] Unit verification: `python3 scripts/dev.py cargo test -p collector probe_tr` verifying scrubber removes `authorization`, `appkey`, `appsecret`, and account numbers on loopback server responses.
- [ ] Live verification: operator runs `collector probe-tr` on one safe read-only TR (such as `CTCA0903R`) and inspects the output file to confirm zero secret leakage and valid JSON structure.
- [ ] Perf verification: metric is single-shot invocation duration and memory footprint; baseline N/A (manual operator CLI); fail threshold is non-zero secret leak or > 1 request sent per invocation.

## MKT-06 KIS global macro, FX, holiday calendar, and domestic derivatives jobs

- [ ] Depends on: `MKT-04`, `MKT-05` (requires captured KIS wire fixtures).
- [ ] Files edited: `crates/server/src/kis/{api.rs,macro_data.rs,derivatives.rs}`, `crates/collector/src/shared/{macro_job.rs,derivatives_job.rs,mod.rs}`, `crates/server/src/shared_data/{macro_data.rs,derivatives.rs,format.rs,mod.rs}`, `crates/server/src/market_overview/{dto.rs,mod.rs,shared.rs}`, `crates/server/tests/fixtures/kis/*`, `crates/server/tests/kis_macro_derivatives.rs`.
- [ ] One change built: add typed `KisApiId` variants and parsers grounded on `MKT-05` fixtures for global indices/FX/bonds (`FHKST03030100`), domestic futures price/basis (`FHMIF10000000`), futures/options investor flow (`FHPTJ04030000` with `F001`/`OC01`/`OP01`), options board PCR (`FHPIF05030000`), and holiday calendar (`CTCA0903R`); publish `DataKind::GlobalMacro`, `DataKind::Derivatives`, and `DataKind::Calendar` from `collector shared`; expose `/api/market-overview/macro`, `/api/market-overview/derivatives`, and `/api/market-overview/calendar`.
- [ ] Visible result: server serves global indices, USD/KRW, futures basis, foreigner futures/options flow, option PCR, and holiday flags from `<shared>/` without touching Kiwoom quota.
- [ ] Unit verification: `python3 scripts/dev.py cargo test -p server --test kis_macro_derivatives` and `python3 scripts/dev.py cargo test -p collector` against captured fixtures.
- [ ] Live verification: run KIS shared child against loopback fixture server over a simulated trading day; verify front-month futures code roll logic, holiday gate skip on closed days, and server endpoint parity with fixture values.
- [ ] Perf verification: metric is KIS `rest` key requests per second across `global_macro` (180s) + `derivatives` (60s). Baseline is 0 req/s on KIS shared child; fail threshold is `key_max_per_second > 5` (budget is 15 req/s) or cycle overrun > 0.

## MKT-07 Kiwoom and KIS flow, risk, events, and ETF jobs

- [ ] Depends on: `MKT-04`, `MKT-05` (requires captured Kiwoom and KIS wire fixtures).
- [ ] Files edited: `crates/server/src/kiwoom/api.rs`, `crates/server/src/kis/api.rs`, `crates/collector/src/shared/{detail_flow.rs,risk.rs,events/*,etf.rs,mod.rs}`, `crates/server/src/shared_data/{detail_flow.rs,risk.rs,etf.rs,format.rs,mod.rs}`, `crates/server/src/market_overview/{dto.rs,mod.rs,shared.rs}`, `crates/server/tests/fixtures/{kiwoom,kis}/*`.
- [ ] One change built: add typed `ApiId` and `KisApiId` variants and collector jobs for 11-institution intraday/after-close flow (`ka10063`, `ka10066`), program arbitrage balance (`ka90006`, `ka90007`, `ka10010`), new high/low and limits (`ka10016`, `ka10017`), foreign brokerage/exhaustion (`ka10036`, `ka10037`), securities lending (`ka10068`, `ka90012`), ETF market summary (`ka40004`), KIS market funds (`FHKST649100C0`), short-sale rank (`FHPST04820000`), and KIS VI fallback (`FHPST01390000`).
- [ ] Visible result: server exposes `/api/market-overview/detail-flow`, `/api/market-overview/risk`, `/api/market-overview/events`, and `/api/market-overview/etf-summary` from `<shared>/` with independent per-section failure isolation.
- [ ] Unit verification: `python3 scripts/dev.py cargo test -p server` and `python3 scripts/dev.py cargo test -p collector` with fixture-backed parsers covering sign conventions, unit scaling (million won to eok), and empty after-close arrays.
- [ ] Live verification: replay a full simulated day (`08:00` to `19:00` clock jumps) with `collector-shared.json` assigning 2 Kiwoom `rest` keys and 1 KIS `rest` key; verify intraday jobs stop at `15:30` and after-close jobs run once at `16:10` and `18:35`.
- [ ] Perf verification: metric is combined Kiwoom `rest-2` key usage per second and total daily call count from `usage/<YYYYMMDD>.jsonl`. Baseline is `MKT-02` usage; fail threshold is `key_max_per_second > 4` on `kw-rest-2` or any `rate_limited > 0`.

## MKT-08 Derived RRG rotation, session DNA, brokerage/book pressure, and OpenDART radar

- [ ] Depends on: `MKT-02` (needs intraday/daily theme archive; `MKT-07` enriches brokerage data when present).
- [ ] Files edited: `crates/server/src/market_overview/{rrg.rs,session_dna.rs,broker_book.rs,disclosures.rs,dto.rs,mod.rs}`, `crates/server/tests/market_overview_pro.rs`, `web/src/api/generated/*`.
- [ ] One change built: compute 4-quadrant RRG trajectories from `ka20006` sector daily bars and archived `kiwoom_themes` returns; aggregate 08:00 to 20:00 6-window session DNA from `SampleBoard` and NXT snapshots; summarize foreign brokerage concentration and orderbook buy/sell balance from `symbol_flow`, `quote_minutes`, and rankings; filter OpenDART/KIND filings into 4 market-moving categories joined with live snapshot returns. Expose `/api/market-overview/pro`.
- [ ] Visible result: `GET /api/market-overview/pro?scope=all|kospi|kosdaq` returns typed `MarketOverviewProCard` with independent `MarketOverviewPart<T>` blocks for RRG, session DNA, brokerage/book, and disclosures.
- [ ] Unit verification: `python3 scripts/dev.py cargo test -p server --test market_overview_pro` verifying RRG math determinism, 6-window KST session bucketing, and OpenDART event classification.
- [ ] Live verification: boot loopback server with 20-day sector bars, sample JSONL, and DART disclosure fixture DB; assert `/api/market-overview/pro` returns 5-point RRG tails, active session window matching fake `Clock`, and joined stock return on each disclosure row.
- [ ] Perf verification: metric is p95 response latency of `/api/market-overview/pro` on cached `SharedData`. Baseline is `/api/market-overview/index` latency on `main`; fail threshold is p95 > 25 ms.

## MKT-09 Layer 3 pro intelligence UI, macro ribbon, and derivatives panels (review-gated)

- [ ] Depends on: `MKT-03`, `MKT-06`, `MKT-07`, `MKT-08`.
- [ ] Files edited: `web/src/features/market-page/{MacroRibbon.tsx,PointAttributionCard.tsx,MaThrustCard.tsx,RrgQuadrantCard.tsx,DerivativesCard.tsx,SessionDnaCard.tsx,BrokerBookCard.tsx,DisclosureRadarCard.tsx,MarketPage.tsx,FlowCard.tsx,marketPage.css}`, `web/src/api/marketOverview.ts`, `web/e2e/market-page.spec.ts`, `web/e2e/market-page-pro.spec.ts`, `docs/market-overview-api.md`, `GLOSSARY.md`.
- [ ] One change built: wire the global macro causal ribbon, futures flow overlay and 11-institution/arbitrage tabs inside `FlowCard`, liquidity/risk sentinel card, and Layer 3's 7 pro cards to live DTOs, hiding or showing clean unavailable notes per section when only Kiwoom or only KIS is configured.
- [ ] Visible result: `/market` renders all 3 layers matching the approved HTML prototype (`market-page-next-ux-proposal.html`), degrades cleanly per broker capability, and routes every clicked stock, theme leader, attribution bar, and disclosure row to the linked chart cell.
- [ ] Unit verification: `python3 scripts/web.py check src/features/market-page/`.
- [ ] Live verification: `python3 scripts/web.py e2e e2e/market-page.spec.ts e2e/market-page-pro.spec.ts e2e/market-source.spec.ts` verifying Kiwoom-only degradation, full Kiwoom+KIS rendering, RRG mode toggle, disclosure category filter, and chart handoff; operator visual review required before merge.
- [ ] Perf verification: metric is Playwright paint time and SVG interaction frame budget on `1440x900` with full 3-layer payload. Baseline is `MKT-03` Playwright render timing; fail threshold is main-thread blocking > 50 ms on scope switch or FPS drop below 50 during flow crosshair hover.

## Open decisions and unproven items

1. **ADR 0043 choice (`MKT-04`)**: resolved on 2026-11-25 — operator approved Option C (amend ADR 0043 so KIS `rest` shared children receive `app_key`/`app_secret` over stdin `Command::Token` for per-request headers only while keeping token issuance strictly daemon-only). Implemented in `b3ab18f2`.
2. **Unverified wire schemas (`MKT-05` gate)**: exact field names, sign conventions, and units for 20 external TRs (`FHKST03030100`, `FHMIF10000000`, `FHPTJ04030000` with `F001`/`OC01`/`OP01`, `FHPIF05030000`, `FHKST649100C0`, `FHPST04820000`, `FHPST01390000`, `CTCA0903R`, and Kiwoom `ka10063`/`ka10066`/`ka90006`/`ka90007`/`ka10010`/`ka10016`/`ka10017`/`ka10036`/`ka10037`/`ka10068`/`ka90012`/`ka40004`) stay unproven until the operator runs `collector probe-tr` (`crates/server/tests/fixtures/README.md`) to capture sanitized real wire fixtures. `MKT-06`, `MKT-07`, and the macro/derivatives parts of `MKT-09` remain intentionally blocked on those fixtures so no parser guesses wire fields.
3. **Current branch**: `bolt/collector-api-audit` holds the verified commits (`b3ab18f2`..`59d5d5da`). Follow `chute --skill` before opening or merging a PR.
