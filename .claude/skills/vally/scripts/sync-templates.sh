#!/usr/bin/env bash
# Write the hc templates vally-<role> from the skill's assets, with @VALLY_SCRIPTS@ set to this folder.
# The source is assets/<role>.md plus each role's line in models.conf. start.sh reruns it before every launch.
source "$(dirname "$0")/lib.sh"

assets=$(cd "$(dirname "$0")/../assets" && pwd)
scripts=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$VALLY_TEMPLATES"
for role in $VALLY_ROLES; do
  command=$(role_command "$role") || exit 1
  body=$assets/$role.md
  [ -f "$body" ] || die "missing $body"
  {
    printf -- '---\nname: vally-%s\ndescription: vallythevally %s, started by the vally lead\ncommand: %s\n---\n\n' "$role" "$role" "$command"
    sed "s|@VALLY_SCRIPTS@|$scripts|g" "$body"
  } > "$VALLY_TEMPLATES/vally-$role.md"
  echo "wrote $VALLY_TEMPLATES/vally-$role.md ($command)"
done
