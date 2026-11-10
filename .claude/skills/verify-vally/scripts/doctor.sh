#!/usr/bin/env bash
# Read-only: is this checkout worth driving? Prints ok/FAIL per check with the fix. Exit 1 on any FAIL.
#   .claude/skills/verify-vally/scripts/doctor.sh
set -uo pipefail
repo=$(cd "$(dirname "$0")/../../../.." && pwd)
bin=${VERIFY_BIN_DIR:-$repo/target/debug}
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1: $3"; fail=1; fi; }
newer() { [ -e "$1" ] && [ "$(stat -c %Y "$1")" -ge "$(git -C "$repo" log -1 --format=%ct -- "$2")" ]; }

check "fake-kiwoom binary" "test -x '$bin/fake-kiwoom'" "cargo build -p server -p fake-kiwoom"
check "vally-server binary" "test -x '$bin/vally-server'" "cargo build -p server -p fake-kiwoom"
check "server binary is newer than the last crates/ commit" "newer '$bin/vally-server' crates" "cargo build -p server -p fake-kiwoom"
check "wasm indicators built" "test -d '$repo/web/src/wasm/indicators'" "bash web/scripts/build-wasm.sh"
check "web/dist built" "test -f '$repo/web/dist/index.html'" "pnpm --dir web build"
check "web/dist is newer than the last web/src commit" "newer '$repo/web/dist/index.html' web/src" "pnpm --dir web build"
check "playwright chromium launches" "cd '$repo/web' && node -e 'require(\"@playwright/test\").chromium.launch({chromiumSandbox:true}).then(b=>b.close())'" "pnpm --dir web exec playwright install chromium"
check "offline namespace (scripts/offline.sh)" "'$repo/scripts/offline.sh' true" "run inside an hc terminal; see docs/dev-environment.md"
exit $fail
