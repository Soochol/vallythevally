#!/usr/bin/env bash
# CI's network namespace and AppArmor profile need sudo, so this local copy of the CI jobs leaves them to CI.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

step() { printf '\n== %s\n' "$1"; }

step "lint: cargo clippy"
cargo clippy --locked --all-targets --quiet -- -D warnings

step "test: cargo test"
cargo test --locked --quiet

step "test: generated TypeScript matches the commit"
git diff --exit-code web/src/api/generated

cd web

step "pnpm install"
pnpm install --frozen-lockfile --silent

step "lint: typecheck"
pnpm -s typecheck

step "test: vitest"
pnpm -s test

step "build"
pnpm -s build

step "e2e: build server and fake Kiwoom"
cargo build --locked --quiet -p server -p fake-kiwoom

step "e2e: playwright"
./node_modules/.bin/playwright test

printf '\n== all checks passed\n'
