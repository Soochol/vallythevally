#!/bin/sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ -z "${DISPLAY:-}" ]; then
    echo "desktop/scripts/smoke.sh는 xvfb-run -a 아래에서 실행합니다" >&2
    exit 2
fi
python3 "$here/cargo.py" build
exec unshare --map-root-user --net python3 -I "$here/smoke.py"
