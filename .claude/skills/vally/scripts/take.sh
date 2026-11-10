#!/usr/bin/env bash
# Take over an issue whose lead is gone: relabel its live terminals vally.owner=<this lead>, tell its
# agents where to report, and relock its worktrees and the worktrees its agents work in. Run it only when the user says so.
# An issue a live lead holds is refused; --force takes it anyway and tells that lead.
#   take.sh <issue> [--force]
source "$(dirname "$0")/lib.sh"

[ $# = 1 ] || { [ $# = 2 ] && [ "$2" = --force ]; } || { sed -n '5p' "$0" >&2; exit 2; }
issue=$1 force=${2-}
need_issue "$issue"
as_lead
hold_vally_lock

take_worktree() { # <path> <issue for an unlocked worktree>
  local owner issue
  IFS=$'\t' read -r owner issue < <(worktree_lock "$1") || true
  [ "$owner" != "$ME" ] || return 0
  if [ -n "$owner" ]; then git worktree unlock "$1"; lock_worktree "$1" "$issue"; else lock_worktree "$1" "$2"; fi
  echo "took $1${owner:+ from $(lead_label "$owner")}"
}

holders=$(issue_holders "$issue") || exit 1
previous=''
while IFS=$'\t' read -r what owner; do
  [ -n "$what$owner" ] || continue
  [ "$(owner_state "$owner")" = live ] || continue
  [ -n "$force" ] || die "issue #$issue belongs to the live lead $(lead_label "$owner") (holds: $what); take it from a live lead only when the user forces it: take.sh $issue --force"
  previous+="${owner%%@*}"$'\n'
done <<<"$holders"

ts=$(issue_terminals "$issue")
taken=0
for t in $ts; do
  info=$(terminal_json "$t")
  owner=$(owner_of <<<"$info")
  [ "$(owner_state "$owner")" != me ] || continue
  name=$(jq -r --arg t "$t" '.name // $t' <<<"$info")
  hc label "$t" "vally.owner=$ME" vally.orphan= >/dev/null || die "could not relabel $name"
  if [ -n "$(jq -r '.labels["vally.role"] // empty' <<<"$info")" ]; then
    hc send "$t" "lead is now $HC_TERMINAL_ID ($MY_NAME); send reports there with report.sh" >/dev/null \
      || warn "could not tell $name its new lead (it may be blocked); check with: hc read $name"
  fi
  echo "took $name from $(lead_label "$owner")"
  taken=1
  w=$(jq -r .cwd <<<"$info")
  case $w in "$VALLY_WORKTREES"/*) take_worktree "$w" "$issue";; esac
done

while IFS=$'\t' read -r path owner lock_issue; do
  [ "$lock_issue" = "$issue" ] && [ "$owner" != "$ME" ] || continue
  take_worktree "$path" "$issue"
  taken=1
done < <(worktree_locks)

for p in $(sort -u <<<"$previous"); do
  hc send "$p" "vally: 사용자가 강제해서 이슈 #$issue를 리드 $MY_NAME($HC_TERMINAL_ID)가 넘겨받았다. 이 이슈의 에이전트와 작업 공간은 더 건드리지 마라." >/dev/null \
    || warn "could not tell the previous lead $p"
  echo "told the previous lead $p"
done
[ $taken = 1 ] || echo "issue #$issue: nothing to take"
[ $taken = 0 ] || echo "note: hc still sends these agents' blocked and exit notes to the terminal that started them; recheck them with status.sh"
