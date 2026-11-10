#!/usr/bin/env bash
# After a PR merges: retire the issue's agents, remove its clean worktrees and its branch,
# start (or hand work to) the docs gardener for code PRs, then print status.
# Worktrees a live terminal still uses (such as a gardener's) stay.
#   finish.sh <issue> --pr 61
source "$(dirname "$0")/lib.sh"

[ $# -eq 3 ] && [ "$2" = --pr ] || { sed -n '5p' "$0" >&2; exit 2; }
issue=$1 pr=$3
need_issue "$issue"
view=$(gh pr view "$pr" --json state,headRefName,files) || die "gh pr view $pr failed"
[ "$(jq -r .state <<<"$view")" = MERGED ] || die "PR #$pr is not merged"
branch=$(jq -r .headRefName <<<"$view")
files=$(jq -r '.files[].path' <<<"$view")
nfiles=$(jq '.files | length' <<<"$view")

agents=$(terminals_with vally.issue="$issue")
for t in $agents; do
  [ "$(label_of "$t" vally.role)" = gardener ] && continue
  retire_terminal "$t"
done

git fetch -q origin
cwds=$(live_cwds)
kept=0
for w in "$(worktree_for_branch "$branch")" "$VALLY_WORKTREES"/review-"$issue"-*; do
  [ -d "$w" ] || continue
  if grep -qxF "$w" <<<"$cwds"; then echo "kept $w: a live terminal works there"; kept=1
  elif ! is_clean "$w"; then echo "kept $w: uncommitted changes"; kept=1
  else git worktree remove "$w"; echo "removed $w"; fi
done
if git show-ref --verify --quiet "refs/heads/$branch"; then
  if [ $kept = 1 ]; then echo "kept branch $branch: its worktree stays"
  elif branch_is_safe_to_delete "$branch"; then git branch -D "$branch" >/dev/null && echo "deleted branch $branch"
  else echo "kept branch $branch: it has commits that are not on origin"; fi
fi

if [[ $branch == docs/garden-* ]]; then
  echo "gardener PR: no gardener"
elif [ "$nfiles" -lt 100 ] && docs_only "$files"; then
  echo "docs-only PR: no gardener"
else
  "$(dirname "$0")/start.sh" garden "$issue" --pr "$pr"
fi
"$(dirname "$0")/status.sh"
