#!/usr/bin/env bash
set -euo pipefail
offline="$(cd "$(dirname "$0")" && pwd)/offline.sh"

if ! unshare --map-root-user --net true 2>/dev/null; then
  printf 'SKIP: offline loopback setup tests require network namespaces\n'
  exit 0
fi

fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
for command in bash unshare id cat true; do
  ln -s "$(type -P "$command")" "$fixture/$command"
done

for failure in missing failing; do
  if [[ "$failure" == failing ]]; then
    printf '#!/usr/bin/env bash\nexit 42\n' > "$fixture/ip"
    chmod +x "$fixture/ip"
    expected=42
  else
    expected=127
  fi
  for allow_network in 0 1; do
    status=0
    output=$(PATH="$fixture" VALLY_CHECK_ALLOW_NETWORK="$allow_network" "$offline" \
      bash -c 'printf "COMMAND_RAN\n"' 2>&1) || status=$?
    if [[ "$status" != "$expected" || "$output" == *COMMAND_RAN* ]]; then
      printf 'FAIL: %s ip, allow_network=%s: expected exit %s without child, got exit %s\n%s\n' \
        "$failure" "$allow_network" "$expected" "$status" "$output" >&2
      exit 1
    fi
    printf 'PASS: %s ip, allow_network=%s: exit %s, child not run\n' \
      "$failure" "$allow_network" "$status"
  done
done
