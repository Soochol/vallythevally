#!/usr/bin/env bash
# For agents: send one message to this agent's lead (its vally.owner label). When the lead is gone,
# leave the report where it is, label this terminal vally.orphan=<done|ask|blocked|message> after the
# message's first word, say so on screen and on the desktop, and exit 3.
#   report.sh "<message>"
source "$(dirname "$0")/lib.sh"

[ $# = 1 ] || { sed -n '5p' "$0" >&2; exit 2; }
[ -n "${HC_TERMINAL_ID-}" ] || die "run from your hc terminal (HC_TERMINAL_ID is unset)"
case ${1%% *} in done|ask|blocked) kind=${1%% *};; *) kind=message;; esac
lock_and_load_live
info=$(terminal_json "$HC_TERMINAL_ID")
owner=$(owner_of <<<"$info")
issue=$(jq -r '.labels["vally.issue"] // "?"' <<<"$info")

if lead_alive "$owner"; then
  hc send "${owner%%@*}" "$1" >/dev/null && { echo "sent to the lead ${owner%%@*}"; exit 0; }
  load_live
  ! lead_alive "$owner" || die "could not reach the lead ${owner%%@*}; it may be blocked. Try again in a minute"
fi
hc label "$HC_TERMINAL_ID" "vally.orphan=$kind" >/dev/null || warn "could not label $HC_TERMINAL_ID vally.orphan=$kind"
release_lock
echo "리드가 없어 보고하지 못했다: $1"
notify-send "vally" "#$issue 리드 없음: $1" 2>/dev/null || warn "notify-send failed"
exit 3
