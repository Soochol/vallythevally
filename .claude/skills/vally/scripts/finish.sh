#!/usr/bin/env bash
# After a PR merges: retire this lead's agents of the issue, remove its clean worktrees and its branch,
# start (or hand work to) this lead's docs gardener for code PRs, then print status.
# Stops when another live lead holds the issue. Worktrees a live terminal still uses, and anything
# without a live lead (take.sh first), stay; while such things stay, no gardener starts.
#   finish.sh <issue> --pr 61
source "$(dirname "$0")/lib.sh"

[ $# -eq 3 ] && [ "$2" = --pr ] || { sed -n '6p' "$0" >&2; exit 2; }
issue=$1 pr=$3
need_issue "$issue"
as_lead
view=$(gh pr view "$pr" --json state,headRefName,files) || die "gh pr view $pr failed"
[ "$(jq -r .state <<<"$view")" = MERGED ] || die "PR #$pr is not merged"
branch=$(jq -r .headRefName <<<"$view")
files=$(jq -r '.files[].path' <<<"$view")
nfiles=$(jq '.files | length' <<<"$view")
git fetch -q origin

lock_and_load_live
orphans=$(issue_orphans "$issue") || exit 1
agents=$(terminals_with vally.issue="$issue")
for t in $agents; do
  info=$(terminal_json "$t")
  [ "$(jq -r '.labels["vally.role"] // empty' <<<"$info")" = gardener ] && continue
  owner=$(owner_of <<<"$info")
  if [ "$(owner_state "$owner")" = me ]; then retire_terminal "$t"
  else echo "kept $(jq -r --arg t "$t" '.name // $t' <<<"$info"): no live lead (주인 없음, was $(lead_label "$owner")); only when the user says so: take.sh $issue"; fi
done

cwds=$(live_cwds)
kept=0
for w in "$(worktree_for_branch "$branch")" "$VALLY_WORKTREES"/review-"$issue"-*; do
  [ -d "$w" ] || continue
  owner=$(worktree_owner "$w")
  if [ -n "$owner" ] && [ "$(owner_state "$owner")" != me ]; then echo "kept $w: locked by $(lead_label "$owner")"; kept=1
  elif grep -qxF "$w" <<<"$cwds"; then echo "kept $w: a live terminal works there"; kept=1
  elif ! is_clean "$w"; then echo "kept $w: uncommitted changes"; kept=1
  else remove_worktree "$w"; echo "removed $w"; fi
done
if git show-ref --verify --quiet "refs/heads/$branch"; then
  if [ $kept = 1 ]; then echo "kept branch $branch: its worktree stays"
  elif branch_is_safe_to_delete "$branch"; then git branch -D "$branch" >/dev/null && echo "deleted branch $branch"
  else echo "kept branch $branch: it has commits that are not on origin"; fi
fi
release_lock

if [[ $branch == docs/garden-* ]]; then
  echo "gardener PR: no gardener"
elif [ "$nfiles" -lt 100 ] && docs_only "$files"; then
  echo "docs-only PR: no gardener"
elif [ -n "$orphans" ]; then
  echo "no gardener: $(orphans_note "$issue" "$orphans"), then start.sh garden $issue --pr $pr"
else
  "$(dirname "$0")/start.sh" garden "$issue" --pr "$pr"
fi
"$(dirname "$0")/status.sh"
