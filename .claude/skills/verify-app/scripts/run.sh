#!/usr/bin/env bash
# Launch a throwaway fake-Kiwoom + vally-server pair, drive one journey in Chromium, keep the evidence, tear down.
#   .claude/skills/verify-app/scripts/run.sh <journey.mjs> [--clock YYYYMMDDHHMMSS] [--name label]
# Runs itself inside scripts/offline.sh (loopback-only network namespace), so nothing can reach the real Kiwoom.
# Evidence: $VERIFY_OUT (default ~/.vally/state/vallythevally/verify/<stamp>-<name>/), never removed by cleanup.
set -euo pipefail

skill=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$skill/../../.." && pwd)

if [ "${VERIFY_INSIDE_OFFLINE-}" != 1 ]; then
  exec env VERIFY_INSIDE_OFFLINE=1 "$repo/scripts/offline.sh" "$0" "$@"
fi

[ $# -ge 1 ] || { sed -n '2,5p' "$0" >&2; exit 2; }
journey=$(realpath "$1"); shift
clock='' name=$(basename "$journey" .mjs)
while [ $# -gt 0 ]; do
  case $1 in
    --clock) clock=$2; shift 2;;
    --name) name=$2; shift 2;;
    *) echo "unknown option $1" >&2; exit 2;;
  esac
done
[ -f "$journey" ] || { echo "journey not found: $journey" >&2; exit 2; }

bin=${VERIFY_BIN_DIR:-$repo/target/debug}
out=${VERIFY_OUT:-$HOME/.vally/state/vallythevally/verify/$(date +%Y%m%d-%H%M%S)-$name}
mkdir -p "$out"
data=$(mktemp -d "${TMPDIR:-/tmp}/verify-app-XXXXXX")
chmod 700 "$data"
pids=()

cleanup() {
  local code=$?
  for p in "${pids[@]}"; do kill -KILL "$p" 2>/dev/null || true; done
  for p in "${pids[@]}"; do wait "$p" 2>/dev/null || true; done
  rm -rf "$data"
  echo "evidence: $out" >&2
  exit $code
}
trap cleanup EXIT

wait_line() { # <log> <regex> <what>: print the first capture group once the log has it
  local deadline=$((SECONDS + 20)) hit
  while [ $SECONDS -lt $deadline ]; do
    hit=$(sed -nE "s/.*$2.*/\1/p" "$1" | head -1)
    [ -n "$hit" ] && { echo "$hit"; return 0; }
    sleep 0.2
  done
  echo "$3 did not become ready; log: $1" >&2; tail -20 "$1" >&2; return 1
}

"$bin/fake-kiwoom" > "$out/fake-kiwoom.log" 2>&1 & pids+=($!)
fake=http://$(wait_line "$out/fake-kiwoom.log" 'fake-kiwoom listening addr=([^ ]+)' fake-kiwoom)

env -i PATH="$PATH" HOME="$HOME" \
  ${clock:+VALLY_CLOCK_START=$clock} \
  VALLY_KIWOOM_APP_KEY=FAKE-APPKEY-verify VALLY_KIWOOM_APP_SECRET=FAKE-SECRET-verify \
  VALLY_KIWOOM_BASE_URL="$fake" VALLY_KIWOOM_WS_URL="${fake/http/ws}/api/dostk/websocket" \
  VALLY_LOCK_PATH="$data/server.lock" VALLY_DB_PATH="$data/vally.db" VALLY_TOKEN_PATH="$data/token.json" \
  VALLY_BIND=127.0.0.1:0 VALLY_STATIC_DIR="$repo/web/dist" VALLY_LOG=debug \
  "$bin/vally-server" > "$out/vally-server.log" 2>&1 & pids+=($!)
app=http://$(wait_line "$out/vally-server.log" '포트를 열었습니다 addr=([^ ]+)' vally-server)

# Ready means usable: the symbol list has arrived (503 until then), and the page itself is served.
deadline=$((SECONDS + 20))
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$app/api/symbols?q=%EC%82%BC%EC%84%B1")" = 200 ]; do
  [ $SECONDS -lt $deadline ] || { echo "symbol list never arrived" >&2; exit 1; }
  sleep 0.2
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$app/")" = 200 ] || { echo "web/dist not served" >&2; exit 1; }
echo "ready app=$app fake=$fake out=$out" >&2

node "$skill/scripts/drive.mjs" "$journey" "$app" "$fake" "$out"
