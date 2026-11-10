#!/usr/bin/env bash
# Print the current state of vally work and save it to $VALLY_STATE/status.md.
source "$(dirname "$0")/lib.sh"

mkdir -p "$VALLY_STATE"
report=$VALLY_STATE/status.md
cwds=$(live_cwds)
agents=''
for role in $VALLY_ROLES; do agents+=$(terminals_with vally.role="$role")$'\n'; done
prs=$(gh pr list --state open --limit 200 --json number,title,headRefName,headRefOid) || die "gh pr list failed"
ready=$(gh issue list --state open --limit 200 --label ready-for-agent --json number,title) || die "gh issue list failed"
common=$(git rev-parse --path-format=absolute --git-common-dir)
{
  echo "# vally 현황 ($(date '+%Y-%m-%d %H:%M'))"
  echo
  echo "## 일하는 에이전트"
  any=0
  for t in $agents; do
    terminal_json "$t" | jq -r --arg t "$t" '"- \(.name // $t) [\(.labels["vally.role"])] 이슈 #\(.labels["vally.issue"])\(if .labels["vally.pr"] then " PR #"+.labels["vally.pr"] else "" end): \((.status | if type == "object" then .state else . end) // .state)"'
    any=1
  done
  [ $any = 1 ] || echo "- 없음"
  echo
  echo "## 열린 PR"
  jq -r '.[] | "- #\(.number) \(.title) (\(.headRefName))"' <<<"$prs" | grep . || echo "- 없음"
  echo
  echo "## 바로 맡길 수 있는 이슈 (ready-for-agent)"
  jq -r '.[] | "- #\(.number) \(.title)"' <<<"$ready" | grep . || echo "- 없음"
  echo
  echo "## 남은 작업 공간 (일하는 에이전트도 열린 PR도 없음)"
  orphan=0
  for w in "$VALLY_WORKTREES"/*/; do
    w=${w%/}
    [ "$(git -C "$w" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" = "$common" ] || continue
    grep -qxF "$w" <<<"$cwds" && continue
    b=$(git -C "$w" branch --show-current)
    if [ -n "$b" ]; then jq -e --arg b "$b" 'any(.[]; .headRefName == $b)' <<<"$prs" >/dev/null && continue
    else jq -e --arg h "$(git -C "$w" rev-parse HEAD)" 'any(.[]; .headRefOid == $h)' <<<"$prs" >/dev/null && continue; fi
    echo "- $w (${b:-detached})$(is_clean "$w" || echo ', 커밋 안 한 변경 있음')"
    orphan=1
  done
  [ $orphan = 1 ] || echo "- 없음"
} | tee "$report"
