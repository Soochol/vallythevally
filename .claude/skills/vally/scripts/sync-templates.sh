#!/usr/bin/env bash
# Write the hc templates vally-worker, vally-reviewer, vally-gardener from the skill's assets.
# The source is assets/<role>.md plus each role's line in models.conf. start.sh reruns it before every launch.
source "$(dirname "$0")/lib.sh"

assets=$(cd "$(dirname "$0")/../assets" && pwd)
mkdir -p "$VALLY_TEMPLATES"
for role in $VALLY_ROLES; do
  command=$(role_command "$role") || exit 1
  body=$assets/$role.md
  [ -f "$body" ] || die "missing $body"
  {
    printf -- '---\nname: vally-%s\ndescription: vallythevally %s, started by the vally lead\ncommand: %s\n---\n\n' "$role" "$role" "$command"
    cat "$body"
  } > "$VALLY_TEMPLATES/vally-$role.md"
  echo "wrote $VALLY_TEMPLATES/vally-$role.md ($command)"
done
