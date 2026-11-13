#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
offline="$PWD/scripts/offline.sh"

step() { printf '\n== %s\n' "$1"; }

step "test: offline loopback setup failure propagation"
./scripts/test-offline.sh

step "lint: cargo clippy"
cargo clippy --locked --all-targets --quiet -- -D warnings

step "test: cargo test (offline.sh)"
"$offline" cargo test --locked --quiet

step "test: generated TypeScript matches the commit"
git diff --exit-code web/src/api/generated

cd web

step "pnpm install"
pnpm install --frozen-lockfile --silent

step "wasm: build indicators"
./scripts/build-wasm.sh

step "lint: typecheck"
pnpm -s typecheck

step "test: vitest (offline.sh)"
"$offline" pnpm -s test

step "build"
pnpm -s build

step "wasm: check against the reference values (offline.sh)"
"$offline" node scripts/wasm-smoke.mjs

step "e2e: playwright (offline.sh)"
"$offline" ./node_modules/.bin/playwright test

printf '\n== all checks passed\n'
