#!/usr/bin/env bash
# Retire one of this lead's vally agents: stop and remove its terminal. With --worktree, also remove
# its worktree when clean and its branch when every commit is on origin.
# Stops when the agent or its worktree belongs to another lead, or to none (take.sh first).
#   retire.sh <name> [--worktree]
source "$(dirname "$0")/lib.sh"

[ $# -ge 1 ] && { [ $# = 1 ] || [ "$2" = --worktree ]; } || { sed -n '5p' "$0" >&2; exit 2; }
name=$1
as_lead
info=$(terminal_json "$name")
[ -n "$(jq -r '.labels["vally.role"] // empty' <<<"$info")" ] || die "$name has no vally.role label; not a vally agent"
need_mine "$(owner_of <<<"$info")" "$name" "$(jq -r '.labels["vally.issue"] // "<issue>"' <<<"$info")"
worktree=$(jq -r .cwd <<<"$info")
if [ $# = 2 ]; then
  case $worktree in "$VALLY_WORKTREES"/*) ;; *) die "kept $worktree: outside $VALLY_WORKTREES";; esac
  owner=$(worktree_owner "$worktree")
  [ -z "$owner" ] || need_mine "$owner" "worktree $worktree" "$(jq -r '.labels["vally.issue"] // "<issue>"' <<<"$info")"
fi
retire_terminal "$name"
[ $# = 2 ] || exit 0

is_clean "$worktree" || die "kept $worktree: uncommitted changes"
branch=$(git -C "$worktree" branch --show-current)
git fetch -q origin
if [ -n "$branch" ] && ! branch_is_safe_to_delete "$branch"; then die "kept $worktree: $branch has commits that are not on origin"; fi
remove_worktree "$worktree" && echo "removed $worktree"
[ -z "$branch" ] || { git branch -D "$branch" >/dev/null && echo "deleted branch $branch"; }
