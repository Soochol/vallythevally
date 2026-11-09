#!/usr/bin/env bash
# Ubuntu 23.10+는 AppArmor 프로필이 `userns`를 허락한 프로그램만 사용자 이름공간을 만들게 하고,
# Chromium 샌드박스는 사용자 이름공간이 있어야 뜬다. Playwright의 headless shell 하나에만 허락한다.
set -euo pipefail
cd "$(dirname "$0")/.."

install_dir=$(./node_modules/.bin/playwright install --dry-run --only-shell chromium \
  | awk '/chromium-headless-shell/ { found = 1 } found && /Install location:/ { print $3; exit }')
mapfile -t bins < <(find "$install_dir" -type f -name chrome-headless-shell -perm -u+x)
if [ "${#bins[@]}" -ne 1 ]; then
  echo "chrome-headless-shell을 $install_dir 아래에서 하나만 찾아야 하는데 ${#bins[@]}개를 찾았습니다" >&2
  exit 1
fi

name=playwright-chrome-headless-shell
profile="abi <abi/4.0>,
include <tunables/global>

profile $name \"${bins[0]}\" flags=(unconfined) {
  userns,
  include if exists <local/$name>
}"
echo "$profile"
if [ "${1-}" = "--print" ]; then exit 0; fi
echo "$profile" | sudo tee "/etc/apparmor.d/$name" > /dev/null
sudo apparmor_parser -r "/etc/apparmor.d/$name"
