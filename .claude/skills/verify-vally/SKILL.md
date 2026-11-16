---
name: verify-vally
description: Launch and drive the real vally app (Rust `vally-server` serving the built `web/` chart UI) in an isolated, offline, loopback-only sandbox, drive it like a user with Playwright Chromium, and capture screenshots plus server-side evidence. Use to prove a change to the chart UI, watchlists, screener, layouts, or the server API works end to end, not just in unit tests.
---

# verify-vally

Primary surface: the browser UI in `web/` (search, chart, watchlists, screener, window layouts) served by `crates/server` (`vally-server`). Secondary surfaces `crates/collector` and the hoga replay screen do not exist yet. When they land, add a `features/` file for each.

Hard rules (AGENTS.md and the task that created this skill):
- Never contact real Kiwoom or real DART. The sandbox server gets `VALLY_KIWOOM_BASE_URL`/`VALLY_KIWOOM_WS_URL` on loopback only (the server refuses `VALLY_CLOCK_START` with real Kiwoom, and Doctor fails if a non-loopback address appears). No `OPENDART_API_KEY`, no `VALLY_ENV_FILE` of the user.
- Never touch the user's long-running server (`127.0.0.1:8080`, `/home/dev/code/vallythevally/data/`, `~/.local/state/vallythevally/token.json` and the lock). Every run uses a free port, a fresh data dir under `target/verify-vally/runs/<run-id>/`, and its own token and lock paths.
- Kill only processes this skill started (pids in the run's `state.json`), never by name.
- Do not run a second server in the user's checkout. This skill needs no write access outside `target/`.

The server cannot run without a Kiwoom peer, so `scripts/verification_loopback_kiwoom.py` is a VERIFICATION-ONLY loopback stand-in. It replays `crates/server/tests/fixtures/kiwoom/*.json` (read-only reuse) by the `api-id` header. Realtime WebSocket is not provided: the server logs a WebSocket connect failure and retries; that is expected and means no live ticks.

## Launch

Prerequisites (once per checkout or after code changes, from the repo root):

```sh
python3 scripts/dev.py build                                   # target/dev/bin/vally-server (reuses the shared cache)
python3 .claude/skills/verify-vally/scripts/build_ui.py target/verify-vally/ui   # frozen pnpm install, WASM, tsc, vite build; can wait a long time on the shared cargo compile lock when other sessions build
```

Start one sandbox (prints a JSON state line with `base_url`, `dir`, pids; ready means `/api/symbols?q=005930` returns the loaded symbol, not merely that the port answers):

```sh
python3 .claude/skills/verify-vally/scripts/vv.py up
```

State lives in `target/verify-vally/runs/<run-id>/` (`state.json`, `server.env`, `server.log`, `data/`, `evidence/`). The server uses the debug clock `VALLY_CLOCK_START=20261109090000` so fixture bars are "today".

One-shot, strongest isolation (a network namespace where only loopback exists, so nothing could leave the machine even by mistake; needs `unshare --map-root-user --net`, see `scripts/offline.sh`):

```sh
.claude/skills/verify-vally/scripts/offline-all.sh search-chart watchlist-add
```

It runs up, Doctor, each journey, a connection check, and down inside the namespace. If `unshare` is refused (AppArmor on ordinary terminals; hc terminals work), use the Launch/Drive/Cleanup steps by hand. Loopback-only config plus Doctor is then the guard.

## Doctor

Read-only. Run first, and whenever something looks off:

```sh
python3 .claude/skills/verify-vally/scripts/vv.py doctor [run-dir]    # default: newest run; exit 1 on any problem
```

Checks: Kiwoom URLs are `127.0.0.1`, no `kiwoom.com` in the env file, our server and fake pids are alive, the port is owned by our server pid (and is not 8080), our server has no non-loopback TCP connection, `GET /` is 200, `/api/symbols/005930` is loaded. Failure of "symbol not loaded" usually means the fake did not serve `ka10099`; read `server.log`.

## Drive

Playwright (`web/node_modules/@playwright/test`, Chromium) through one script. Stable handles are ARIA roles and names, as in `web/e2e`:

```sh
node .claude/skills/verify-vally/scripts/drive.mjs <base_url> <run-dir>/evidence <journey>
```

Journeys: `search-chart` (search button `title="종목 검색 (/ 또는 Ctrl+K)"`, dialog `종목 검색`, combobox `종목 검색`, option text `005930`, then `region` named `칸 1: …` with `data-bar-count`), `watchlist-add` (complementary `관심종목`, button `관심종목에 넣기`, `li[data-code]`). Each journey asserts its fresh-start precondition (코스피 cell, empty 기본 list), so run one `up` per journey set and never reuse a run for a second pass; a reused run fails with the precondition error. Run journeys one at a time per evidence dir; two concurrent `drive.mjs` runs into the same dir can pick the same tag and overwrite each other. A journey exits 1 on a failed expectation, a console error, a page error, or any request to a host other than the sandbox. Add journeys to `drive.mjs` per `features/*.md`.

The existing repo harnesses are for mocked responses, not this skill: `python3 scripts/web.py e2e <spec>` (ADR 0016: Playwright against synthetic responses; no server) and `python3 scripts/web.py doctor` (Chromium check). Reuse their selectors; use them for broad regression, and this skill for "does the real server plus real UI work".

## Evidence

Everything goes to `target/verify-vally/runs/<run-id>/evidence/` and survives `down`: `<journey>.json` (a rerun writes `<journey>-2.json`, never overwrites; steps, every response status/path, `foreignHosts`, console errors), screenshots, `kiwoom-requests.jsonl` (each fixture the server asked the fake for), and screenshots named `<journey>-NN-….png` (a rerun uses `<journey>-2-…`) and `<journey>-failure.png` on failure, and in `all` mode `server-connections.txt` (the server's TCP connections sampled every 0.2 s while the browser runs) and `network-interfaces.txt`. Proof standards:
- Drive the real user path (click, type); do not call internal setters or test-only endpoints.
- Capture the action and the resulting state, and check the side effect on the server (`/api/watchlists`, `/api/ui-state`, `server.log`, `data/vally.db`) as well as the screen.
- A journey that cannot reach its precondition reports failure, with the reason in that feature's Gotchas. Never weaken it.
- State what is stubbed: the Kiwoom side (fixtures), the clock, no realtime ticks, no DART data.

## Cleanup

```sh
python3 .claude/skills/verify-vally/scripts/vv.py down <run-dir>      # SIGTERM then SIGKILL the pids in state.json only, and only when the process start time matches the one recorded at launch; the run dir is required (use the `dir` printed by `up`)
```

It stops the server and the fake and keeps the run directory including `evidence/`. Run it after every failed attempt. Old runs under `target/verify-vally/runs/` may be deleted by hand when no longer needed. Do not delete `evidence/` you still need.

## Helpers

| Script | Use |
|---|---|
| `scripts/vv.py up\|doctor\|down\|all` | run lifecycle (above) |
| `scripts/offline-all.sh [journey...]` | `vv.py all` inside the offline namespace |
| `scripts/drive.mjs <base> <evidence> <journey>` | Playwright journeys |
| `scripts/build_ui.py <out-dir>` | UI build via `scripts/web.py` internals |
| `scripts/verification_loopback_kiwoom.py` | loopback Kiwoom stand-in, started by `vv.py` (VERIFICATION-ONLY) |

Feature map: `features/README.md`.
