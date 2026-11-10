#!/usr/bin/env bash
# Take over an issue whose lead is gone: relabel its live terminals vally.owner=<this lead>, tell its agents where to report,
# and relock its worktrees and the worktrees its agents work in; a gardener moves whole, with every issue it holds. Run it only when the user says so.
# An issue a live lead holds is refused; --force takes it anyway and tells that lead.
#   take.sh <issue> [--force]
source "$(dirname "$0")/lib.sh"

[ $# = 1 ] || { [ $# = 2 ] && [ "$2" = --force ]; } || { sed -n '5p' "$0" >&2; exit 2; }
issue=$1 force=${2-}
need_issue "$issue"
as_lead
lock_and_load_live

take_worktree() { # <path> <issues for an unlocked worktree>
  local owner locked
  IFS=$'\t' read -r owner locked < <(worktree_lock "$1") || true
  [ "$owner" != "$ME" ] || return 0
  if [ -n "$owner" ]; then git worktree unlock "$1"; lock_worktree "$1" "$locked"; else lock_worktree "$1" "$2"; fi
  echo "took $1${owner:+ from $(lead_label "$owner")}"
}

group=$(issue_group "$issue") || exit 1
issues=$(printf '#%s, ' $group); issues=${issues%, }
[ "$group" = "$issue" ] || together="; take.sh $issue takes $issues together, since a gardener holds them"
declare -A lost=()
for i in $group; do
  holders=$(issue_holders "$i") || exit 1
  while IFS=$'\t' read -r what owner; do
    [ -n "$what$owner" ] || continue
    [ "$(owner_state "$owner")" = live ] || continue
    [ -n "$force" ] || die "issue #$i belongs to the live lead $(lead_label "$owner") (holds: $what)${together-}; take it from a live lead only when the user forces it: take.sh $issue --force"
    p=${owner%%@*}
    has_issue "${lost[$p]-}" "$i" || lost[$p]=${lost[$p]:+${lost[$p]},}$i
  done <<<"$holders"
done

taken=0
for i in $group; do
  ts=$(issue_terminals "$i")
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
    case $w in "$VALLY_WORKTREES"/*) take_worktree "$w" "$(terminal_issues <<<"$info")";; esac
  done
  while IFS=$'\t' read -r path owner lock_issues; do
    has_issue "$lock_issues" "$i" && [ "$owner" != "$ME" ] || continue
    take_worktree "$path" "$i"
    taken=1
  done < <(worktree_locks)
done

for p in "${!lost[@]}"; do
  hc send "$p" "vally: 사용자가 강제해서 이슈 #${lost[$p]//,/, #}를 리드 $MY_NAME($HC_TERMINAL_ID)가 넘겨받았다. 이 이슈의 에이전트와 작업 공간은 더 건드리지 마라." >/dev/null \
    || warn "could not tell the previous lead $p"
  echo "told the previous lead $p"
done
[ $taken = 1 ] || { echo "issue #$issue: nothing to take"; exit 0; }
if [ "$group" = "$issue" ]; then echo "took issue #$issue"; else echo "took issues $issues"; fi
echo "note: hc still sends these agents' blocked and exit notes to the terminal that started them; recheck them with status.sh"
