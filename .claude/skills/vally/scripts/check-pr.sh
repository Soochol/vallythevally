#!/usr/bin/env bash
# Run scripts/check.sh at a PR's exact head in a clean detached worktree, in the background.
# Refuses a PR that is behind main, so the checked tree equals the merge result.
# hc tells the calling terminal when check-<pr> exits; merge with the printed head pinned.
#   check-pr.sh <issue> --pr 61
source "$(dirname "$0")/lib.sh"

[ $# -eq 3 ] && [ "$2" = --pr ] || { sed -n '5p' "$0" >&2; exit 2; }
issue=$1 pr=$3
need_issue "$issue"
view=$(gh pr view "$pr" --json headRefOid,files,state) || die "gh pr view $pr failed"
[ "$(jq -r .state <<<"$view")" = OPEN ] || die "PR #$pr is not open"
head=$(jq -r .headRefOid <<<"$view")
files=$(jq -r '.files[].path' <<<"$view")
git fetch -q origin main "pull/$pr/head"
git merge-base --is-ancestor origin/main "$head" || die "PR #$pr is behind main; have its worker rebase on origin/main and push, then check again"
worktree=$VALLY_WORKTREES/review-$issue-${head:0:7}
[ -d "$worktree" ] || git worktree add -q --detach "$worktree" "$head"
[ "$(git -C "$worktree" rev-parse HEAD)" = "$head" ] || die "$worktree is not at PR head $head"
is_clean "$worktree" || die "$worktree is dirty; check needs a clean checkout"
cwds=$(live_cwds)
! grep -qxF "$worktree" <<<"$cwds" || die "a live terminal works in $worktree; retire the reviewer first"
mkdir -p "$VALLY_REPORTS/$issue"
log=$VALLY_REPORTS/$issue/check-pr$pr-${head:0:7}.log
hc run --bg --json --name "check-$pr" --label vally.issue="$issue" --cwd "$worktree" -- bash -c "scripts/check.sh > '$log' 2>&1" >/dev/null
if [ "$(jq '.files | length' <<<"$view")" -lt 100 ] && docs_only "$files" && ! touches_agent_rules "$files"; then merge=auto; else merge=user; fi
echo "check-$pr running at ${head:0:7}; log: $log"
echo "head: $head"
echo "merge: $merge"
