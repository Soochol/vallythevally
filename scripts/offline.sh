#!/usr/bin/env bash
# Chromium's sandbox refuses uid 0, so after bringing loopback up as namespace root the inner namespace maps the caller's uid back.
set -euo pipefail

if ! unshare --map-root-user --net true 2>/dev/null; then
  if [[ "${VALLY_CHECK_ALLOW_NETWORK:-}" == 1 ]]; then
    cat >&2 <<'EOF'
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
경고: VALLY_CHECK_ALLOW_NETWORK=1로 외부 네트워크를 허용합니다.
외부 TCP, DNS, 실제 키움(Kiwoom) 접속은 차단되지 않습니다.
실수로 보낸 요청이 실제 키움 서버에 도달할 수 있습니다.
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
EOF
    exec "$@"
  fi
  cat >&2 <<'EOF'
offline: 외부 네트워크 없는 이름공간을 만들지 못했습니다.
  이 PC의 일반 터미널은 AppArmor(kernel.apparmor_restrict_unprivileged_userns = 1) 때문에 만들 수 없습니다. hc 터미널에서 돌리세요(herdr-core AppArmor 프로필 필요).
  외부 네트워크를 명시적으로 허용하려면 VALLY_CHECK_ALLOW_NETWORK=1을 설정하세요.
  자세한 내용: docs/dev-environment.md "시험은 외부 네트워크 없이 돈다"
EOF
  exit 1
fi

exec unshare --map-root-user --net -- bash -euo pipefail -c '
  ip link set lo up
  uid=$1 gid=$2
  shift 2
  exec unshare --user --map-user="$uid" --map-group="$gid" -- "$@"
' offline "$(id -u)" "$(id -g)" "$@"
