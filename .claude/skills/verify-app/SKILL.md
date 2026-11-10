---
name: verify-app
description: Drive the real vallythevally web app (Rust vally-server + React chart UI) in sandboxed Chromium against a fake Kiwoom, and capture screenshots, a trace, server logs and API state as proof. Use when a change needs to be shown working in the real app, not only in unit tests, or when asked to verify, reproduce, or screenshot an app feature. It checks the app, not the vally lead skill (that one has its own scripts/test/test.sh).
---

# verify-app

One command launches a throwaway **fake-kiwoom** and **vally-server** pair with its own temp data dir, drives one journey in sandboxed Chromium, keeps the evidence, and tears the pair down. It never touches the real server (the `vally-server` hc terminal on 127.0.0.1:8080), its DB (`data/vally.db`), its lock, or its Kiwoom token, and never reaches the real Kiwoom: the whole run sits inside `scripts/offline.sh`, a loopback-only network namespace, with fake app keys.

Paths below are relative to the repo root. Run from any checkout or worktree; the scripts use the checkout they live in.

## Doctor

Run first, and whenever anything looks off. Read-only.

```sh
.claude/skills/verify-app/scripts/doctor.sh
```

Each `FAIL` line names its fix. It checks: `fake-kiwoom` and `vally-server` binaries exist and are newer than the last `crates/` commit, the wasm indicators and `web/dist` are built and newer than the last `web/src` commit, Chromium launches with its sandbox on, and `scripts/offline.sh` can create the namespace (it can inside hc terminals; a plain terminal on this PC cannot, see `docs/dev-environment.md`).

A fresh worktree needs, in order: `pnpm --dir web install`, `bash web/scripts/build-wasm.sh`, `pnpm --dir web build`, `cargo build -p server -p fake-kiwoom`. Rebuild `web/dist` and the binaries after editing their sources; the run serves whatever is built.

## Launch, drive, clean up

```sh
.claude/skills/verify-app/scripts/run.sh .claude/skills/verify-app/journeys/<journey>.mjs [--clock YYYYMMDDHHMMSS] [--name label]
```

- **Launch**: `run.sh` starts `fake-kiwoom` (ready at `fake-kiwoom listening addr=`), then `vally-server` on `127.0.0.1:0` with `VALLY_DB_PATH`, `VALLY_LOCK_PATH`, `VALLY_TOKEN_PATH` in a new `mktemp -d` dir (ready at `포트를 열었습니다 addr=`). Ready means usable: it waits until `/api/symbols` stops answering 503 (the symbol list arrived from the fake) and `/` serves `web/dist`. An empty data dir is fine; the server runs its migrations on start. The real server can keep running alongside: ports, lock, DB and token are all separate.
- **`--clock`**: sets `VALLY_CLOCK_START` (KST). The server drops trades outside market hours, so any realtime journey needs a market-hours clock such as `20261109100000` (Monday 10:00).
- **Drive**: `scripts/drive.mjs` opens Chromium (sandbox on, 1440×900, `ko-KR`, `Asia/Seoul`), records a trace, collects page errors and console errors, and calls the journey.
- **Cleanup**: on any exit, `run.sh` kills only the two PIDs it started and removes the temp data dir. Chromium is closed by `drive.mjs`. Nothing is killed by name. The evidence dir is never removed.
- Exit code 0 means the journey passed with its assertions; 1 means it failed (see `result.json`).

### Writing a journey

A journey is an ES module in `journeys/` exporting `default async function (page, ctx)`, returning an object of observations. `ctx` has:

- `expect`: Playwright's `expect` (auto-retrying locator assertions).
- `screenshot(label)`: numbered PNG in the evidence dir. Take one before the action and one after.
- `api(route)`: GET JSON from the app server, for side effects (`/api/layouts/<id>`, `/api/watchlists`, `/api/drawings?symbol=<code>`, `/api/ui-state`).
- `fake.pushReal(type, item, values)`, `fake.registered()`: push a realtime trade through the fake Kiwoom WebSocket, list what the server has REG'd.
- `appUrl`, `out`.

Use the app's stable handles, the same ones `web/e2e/` uses: ARIA roles and names (`region "칸 1: …"`, `dialog "종목 검색"`, `toolbar "차트 도구 막대"`, `complementary "관심종목"`), and the chart's data attributes (`[data-bar-count]`, `data-last-close`, `data-last-bar-t`, `.drawing-mirror[data-drawings]`). Never coordinates for anything but drags on the chart canvas, and then as fractions of the chart's bounding box. `web/e2e/*.spec.ts` holds a worked path for almost every feature; copy from there.

## Evidence

Default location: `~/.vally/state/vallythevally/verify/<YYYYmmdd-HHMMSS>-<name>/`, or `VERIFY_OUT=<dir>`. For a PR that checked a real screen, copy what proves it into `docs/verification/issue-<n>/` (allowed by `docs/agents/document-policy.md`; add files only).

Each run leaves: numbered screenshots, `trace.zip` (open with `pnpm --dir web exec playwright show-trace <file>`), `vally-server.log`, `fake-kiwoom.log`, and `result.json` with `ok`, `error`, `pageErrors` and the journey's observations.

Proof standards:

- Drive the real user path: the buttons, dialogs and keys a user presses. Not internal setters, not `window` hooks, not test-only endpoints of the app. The fake Kiwoom is the one mock, and it sits where production already has a boundary (the Kiwoom REST/WebSocket).
- Capture the action and the result: a screenshot before and after, plus the attribute or text that changed.
- Check the side effect, not only the screen: the saved layout, watchlist or drawing through `ctx.api`, and that it survives `page.reload()`.
- `pageErrors` must be empty unless the journey expects an error.
- A run with the real Kiwoom is a different thing: it needs the user's explicit yes and the coordinator's token rule (AGENTS.md, ADR 0004). This skill never does it.

## Features

The map of user-facing features and how to prove each one is in [features/README.md](features/README.md). A proof that drives one convenient entry point is incomplete when the feature's file lists others.
