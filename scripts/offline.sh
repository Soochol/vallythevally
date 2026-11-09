#!/usr/bin/env bash
# Chromium refuses to start as root, so after bringing loopback up as namespace root the inner namespace maps the caller's uid back.
set -euo pipefail

if ! unshare --map-root-user --net true 2>/dev/null; then
  cat >&2 <<'EOF'
offline: 외부 네트워크 없는 이름공간을 만들지 못했습니다.
  이 PC의 일반 터미널은 AppArmor(kernel.apparmor_restrict_unprivileged_userns = 1) 때문에 만들 수 없습니다. Orca 안에서 돌리세요.
  자세한 내용: docs/dev-environment.md "시험은 외부 네트워크 없이 돈다"
EOF
  exit 1
fi

exec unshare --map-root-user --net -- bash -c '
  ip link set lo up
  uid=$1 gid=$2
  shift 2
  exec unshare --user --map-user="$uid" --map-group="$gid" -- "$@"
' offline "$(id -u)" "$(id -g)" "$@"
