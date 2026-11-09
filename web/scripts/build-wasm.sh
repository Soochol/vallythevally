#!/usr/bin/env bash
# Needs the wasm32-unknown-unknown Rust target and wasm-pack on PATH.
set -euo pipefail
web="$(cd "$(dirname "$0")/.." && pwd)"
out="$web/src/wasm/indicators"
export CARGO_PROFILE_RELEASE_LTO=true CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 CARGO_PROFILE_RELEASE_OPT_LEVEL=s
wasm-pack build "$web/../crates/indicators-wasm" --release --target web --out-name indicators --out-dir "$out" --no-pack
rm -f "$out/.gitignore"
printf 'indicators_bg.wasm: %s bytes, %s bytes gzip\n' "$(wc -c < "$out/indicators_bg.wasm")" "$(gzip -9c "$out/indicators_bg.wasm" | wc -c)"
