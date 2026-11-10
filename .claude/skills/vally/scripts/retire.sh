#!/usr/bin/env bash
# Retire one vally agent: stop and remove its terminal. With --worktree, also remove its
# worktree when clean and its branch when every commit is on origin.
#   retire.sh <name> [--worktree]
source "$(dirname "$0")/lib.sh"

[ $# -ge 1 ] && { [ $# = 1 ] || [ "$2" = --worktree ]; } || { sed -n '4p' "$0" >&2; exit 2; }
name=$1
info=$(terminal_json "$name")
[ -n "$(jq -r '.labels["vally.role"] // empty' <<<"$info")" ] || die "$name has no vally.role label; not a vally agent"
worktree=$(jq -r .cwd <<<"$info")
retire_terminal "$name"
[ $# = 2 ] || exit 0

case $worktree in "$VALLY_WORKTREES"/*) ;; *) die "kept $worktree: outside $VALLY_WORKTREES";; esac
is_clean "$worktree" || die "kept $worktree: uncommitted changes"
branch=$(git -C "$worktree" branch --show-current)
git fetch -q origin
if [ -n "$branch" ] && ! branch_is_safe_to_delete "$branch"; then die "kept $worktree: $branch has commits that are not on origin"; fi
git worktree remove "$worktree" && echo "removed $worktree"
[ -z "$branch" ] || { git branch -D "$branch" >/dev/null && echo "deleted branch $branch"; }
