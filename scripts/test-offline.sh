#!/usr/bin/env bash
set -euo pipefail
offline="$(cd "$(dirname "$0")" && pwd)/offline.sh"

fixtures=$(mktemp -d)
trap 'rm -rf "$fixtures"' EXIT
policy_fixture="$fixtures/policy"
fixture="$fixtures/loopback"
mkdir -p "$policy_fixture" "$fixture"
for command in bash id cat true; do
  ln -s "$(type -P "$command")" "$policy_fixture/$command"
done
cat > "$policy_fixture/unshare" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == '--map-root-user --net true' ]]; then
  [[ "$OFFLINE_TEST_UNSHARE_MODE" != probe-fail ]]
  exit
fi
if [[ "$OFFLINE_TEST_UNSHARE_MODE" == probe-success-launch-fail ]]; then
  exit 42
fi
while [[ "$1" != -- ]]; do shift; done
shift
exec "$@"
EOF
printf '#!/usr/bin/env bash\nexit 0\n' > "$policy_fixture/ip"
cat > "$policy_fixture/child" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'run\n' >> "$OFFLINE_TEST_RECORD"
printf '%s\0' "$@" > "$OFFLINE_TEST_ARGV"
printf 'child stdout\n'
printf 'child stderr\n' >&2
exit "$OFFLINE_TEST_EXIT"
EOF
chmod +x "$policy_fixture/unshare" "$policy_fixture/ip" "$policy_fixture/child"
: > "$policy_fixture/match.literal"
child_args=('with spaces' '' '*.literal' '한국어' $'line one\nline two' '-leading' '$(echo no)')
printf '%s\0' "${child_args[@]}" > "$policy_fixture/expected-argv"
printf 'run\n' > "$policy_fixture/expected-record"
printf 'child stdout\n' > "$policy_fixture/expected-stdout"
printf 'child stderr\n' > "$policy_fixture/expected-stderr"

run_policy() {
  local mode=$1 allow=$2 child_exit=$3
  rm -f "$policy_fixture/record" "$policy_fixture/argv"
  status=0
  (
    cd "$policy_fixture"
    unset VALLY_CHECK_ALLOW_NETWORK
    if [[ "$allow" != unset ]]; then
      export VALLY_CHECK_ALLOW_NETWORK="$allow"
    fi
    PATH="$policy_fixture" OFFLINE_TEST_UNSHARE_MODE="$mode" \
      OFFLINE_TEST_RECORD="$policy_fixture/record" OFFLINE_TEST_ARGV="$policy_fixture/argv" \
      OFFLINE_TEST_EXIT="$child_exit" "$offline" "$policy_fixture/child" "${child_args[@]}"
  ) > "$policy_fixture/stdout" 2> "$policy_fixture/stderr" || status=$?
}

assert_no_child() {
  if [[ -e "$policy_fixture/record" || -e "$policy_fixture/argv" || -s "$policy_fixture/stdout" ]]; then
    printf 'FAIL: %s ran the child or wrote child stdout\n' "$1" >&2
    exit 1
  fi
}

assert_child_once() {
  if ! cmp -s "$policy_fixture/expected-record" "$policy_fixture/record" ||
    ! cmp -s "$policy_fixture/expected-argv" "$policy_fixture/argv" ||
    ! cmp -s "$policy_fixture/expected-stdout" "$policy_fixture/stdout"; then
    printf 'FAIL: %s did not run the child exactly once with unchanged arguments and stdout\n' "$1" >&2
    exit 1
  fi
}

printf 'INFO: PATH policy fixtures check wrapper behavior; they cannot prove network isolation\n'
for allow_network in unset '' 0 true; do
  run_policy probe-fail "$allow_network" 0
  if [[ "$status" != 1 ]]; then
    printf 'FAIL: unavailable namespace, allow_network=%q: expected exit 1, got %s\n' "$allow_network" "$status" >&2
    exit 1
  fi
  assert_no_child "unavailable namespace, allow_network=$allow_network"
  printf 'PASS: unavailable namespace, allow_network=%q: exit 1, child not run\n' "$allow_network"
done

for child_exit in 0 1 37 73 126 127 255; do
  run_policy probe-fail 1 "$child_exit"
  if [[ "$status" != "$child_exit" ]]; then
    printf 'FAIL: network opt-in lost child exit %s, got %s\n' "$child_exit" "$status" >&2
    exit 1
  fi
  assert_child_once "network opt-in, child exit=$child_exit"
  if ! grep -q '^!\{20,\}$' "$policy_fixture/stderr" ||
    ! grep -q '경고:.*VALLY_CHECK_ALLOW_NETWORK=1' "$policy_fixture/stderr" ||
    ! grep -q '외부 TCP, DNS, 실제 키움(Kiwoom) 접속은 차단되지 않습니다' "$policy_fixture/stderr" ||
    ! grep -q '^child stderr$' "$policy_fixture/stderr"; then
    printf 'FAIL: network opt-in must warn on stderr that external TCP, DNS, and actual Kiwoom are not blocked\n' >&2
    exit 1
  fi
  printf 'PASS: network opt-in: child once, arguments unchanged, warning on stderr, exit %s\n' "$status"
done

run_policy probe-success-launch-fail 1 0
if [[ "$status" != 42 || -s "$policy_fixture/stderr" ]]; then
  printf 'FAIL: namespace launch failure must exit 42 without warning or fallback, got %s\n' "$status" >&2
  exit 1
fi
assert_no_child 'namespace launch failure with network opt-in'
printf 'PASS: namespace launch failure with network opt-in: exit 42, no child or fallback\n'

run_policy probe-success-delegate 1 73
if [[ "$status" != 73 ]] || ! cmp -s "$policy_fixture/expected-stderr" "$policy_fixture/stderr"; then
  printf 'FAIL: isolated-path child failure must preserve exit 73 without warning or fallback, got %s\n' "$status" >&2
  exit 1
fi
assert_child_once 'isolated-path child failure with network opt-in'
printf 'PASS: isolated-path child failure with network opt-in: exit 73, child once, no warning or fallback\n'

if ! unshare --map-root-user --net true 2>/dev/null; then
  printf 'SKIP: offline loopback setup tests require network namespaces\n'
  exit 0
fi

parent_netns=$(readlink /proc/self/ns/net)
status=0
VALLY_CHECK_ALLOW_NETWORK=1 "$offline" bash -c '
  printf "run\n" >> "$1"
  readlink /proc/self/ns/net
  exit 73
' offline "$fixtures/real-record" > "$fixtures/real-stdout" 2> "$fixtures/real-stderr" || status=$?
if [[ "$status" != 73 || "$(cat "$fixtures/real-stdout")" == "$parent_netns" ]] ||
  ! grep -q '^net:\[[0-9]\+\]$' "$fixtures/real-stdout" ||
  ! cmp -s "$policy_fixture/expected-record" "$fixtures/real-record" || [[ -s "$fixtures/real-stderr" ]]; then
  printf 'FAIL: available namespace with network opt-in must isolate the child once, preserve exit 73, and omit warnings\n' >&2
  exit 1
fi
printf 'PASS: real namespace with network opt-in: distinct network namespace, child once, exit 73, no warning\n'

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
