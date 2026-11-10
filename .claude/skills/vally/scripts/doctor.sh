#!/usr/bin/env bash
# Check that this PC can run the vally pipeline. Prints one line per check; exits 1 if any fails.
source "$(dirname "$0")/lib.sh"

failed=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1: $3"; failed=1; fi; }

check "hc core" "hc server status --json" "herdr-core is not answering; open Herdr"
for r in $VALLY_ROLES; do
  check "template vally-$r" "hc templates --json | jq -e '.templates[] | select(.name == \"vally-$r\")'" "run $(dirname "$0")/sync-templates.sh"
done
check "pstack for Claude" "jq -e '.enabledPlugins[\"pstack@pstack\"] == true' $HOME/.claude/settings.json" "run: claude plugin enable pstack@pstack --scope user"
check "AppArmor profile" "test -f /etc/apparmor.d/herdr-core" "install the herdr-core profile (see SKILL.md, Setup)"

probe=vally-doctor-$$
if out=$(hc run --json --name "$probe" --timeout 30 -- unshare --map-root-user --net true 2>/dev/null) \
   && [ "$(jq -r '.wait.exit_code' <<<"$out")" = 0 ]; then
  echo "ok   network sandbox in hc terminals (check.sh can run)"
else
  echo "FAIL network sandbox in hc terminals: check.sh and pushes will fail. the hc holder that starts terminals is older than the AppArmor profile; a holder started after the profile carries it (unverified: close every terminal it hosts, or log in again)"
  failed=1
fi
hc rm "$probe" >/dev/null 2>&1 || true
exit $failed
