#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../../.." && pwd)"
exec "$root/scripts/offline.sh" python3 "$here/vv.py" all "$@"
