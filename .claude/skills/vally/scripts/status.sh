#!/usr/bin/env bash
# Print this lead's vally space and save it to $VALLY_STATE/status-<lead address>.md.
# Agents without a live lead come first; other live leads get one line each.
source "$(dirname "$0")/lib.sh"

as_lead
mkdir -p "$VALLY_STATE"
report=$VALLY_STATE/status-$HC_TERMINAL_ID.md
cwds=$(live_cwds)
prs=$(gh pr list --state open --limit 200 --json number,title,headRefName,headRefOid) || die "gh pr list failed"
ready=$(gh issue list --state open --limit 200 --label ready-for-agent --json number,title) || die "gh issue list failed"
common=$(git rev-parse --path-format=absolute --git-common-dir)

declare -A state_of=()
state() { [ -n "${state_of[$1]+x}" ] || state_of[$1]=$(owner_state "$1"); echo "${state_of[$1]}"; }

agents=''
for role in $VALLY_ROLES; do
  for t in $(terminals_with vally.role="$role"); do
    info=$(terminal_json "$t")
    owner=$(owner_of <<<"$info")
    agents+=$(jq -c --arg t "$t" --arg o "$owner" --arg s "$(state "$owner")" \
      '{address: $t, name: (.name // $t), cwd, labels, run: (.status | if type == "object" then .state else . end), owner: $o, state: $s}' <<<"$info")$'\n'
  done
done
agents=$(jq -s '.' <<<"$agents")

spaces=''
for w in "$VALLY_WORKTREES"/*/; do
  w=${w%/}
  [ "$(git -C "$w" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" = "$common" ] || continue
  lock=$(worktree_lock "$w")
  owner=${lock%%$'\t'*} issue=${lock#*$'\t'}
  if [ -z "$lock" ]; then
    owner=$(jq -r --arg w "$w" 'first(.[] | select(.cwd == $w) | .owner) // empty' <<<"$agents")
    issue=$(jq -r --arg w "$w" 'first(.[] | select(.cwd == $w) | .labels["vally.issue"]) // empty' <<<"$agents")
  fi
  b=$(git -C "$w" branch --show-current)
  live=false; grep -qxF "$w" <<<"$cwds" && live=true
  if [ -n "$b" ]; then haspr=$(jq --arg b "$b" 'any(.[]; .headRefName == $b)' <<<"$prs")
  else haspr=$(jq --arg h "$(git -C "$w" rev-parse HEAD)" 'any(.[]; .headRefOid == $h)' <<<"$prs"); fi
  dirty=false; is_clean "$w" || dirty=true
  spaces+=$(jq -nc --arg w "$w" --arg b "$b" --arg o "$owner" --arg i "$issue" --arg s "$([ -z "$owner" ] && echo none || state "$owner")" \
    --argjson live "$live" --argjson pr "$haspr" --argjson dirty "$dirty" \
    '{path: $w, branch: $b, owner: $o, issue: $i, state: $s, live: $live, pr: $pr, dirty: $dirty}')$'\n'
done
spaces=$(jq -s '.' <<<"$spaces")

all=$(jq -cs 'add | map(. + {issue: (.labels["vally.issue"]? // .issue // "")})' <<<"$agents$spaces")
leads=$(jq -r '[.[] | select(.state == "live") | .owner | split("@")[0]] | unique | .[]' <<<"$all")
declare -A lead_names=()
for a in $leads; do lead_names[$a]=$(lead_label "$a"); done
others=''
for a in $leads; do
  name=${lead_names[$a]}
  [ "$(printf '%s\n' "${lead_names[@]}" | grep -cxF "$name")" = 1 ] || name="$name($a)"
  issues=$(jq -r --arg a "$a" '[.[] | select((.owner | split("@")[0]) == $a and .issue != "") | "#" + .issue] | unique | join(", ")' <<<"$all")
  others+="- 다른 리드 사용 중: $name${issues:+ (이슈 $issues)}"$'\n'
done
held=$(jq -c '[.[] | select(.state != "none" and .issue != "") | .issue] | unique' <<<"$all")
mine=$(jq -c '[.[] | select(.state == "me") | (.issue, .labels["vally.pr"]?, .branch?) | select(. != null and . != "")] | unique' <<<"$all")

{
  echo "# vally 현황: 리드 $MY_NAME ($(date '+%Y-%m-%d %H:%M'))"
  echo
  echo "## 주인 없는 에이전트 (사용자가 예라고 할 때만 take.sh <이슈>)"
  jq -r '.[] | select(.state == "gone") | "- \(.name) [\(.labels["vally.role"])] 이슈 #\(.labels["vally.issue"]): \(if .labels["vally.orphan"] == "1" then "보고 완료" elif .run == "blocked" then "막힘" elif .run == "working" then "작업 중" else "멈춤 (\(.run))" end) (리드 \(.owner | split("@")[0] | if . == "" then "기록 없음" else . + " 없음" end))"' <<<"$agents" | grep . || echo "- 없음"
  echo
  echo "## 내 에이전트"
  jq -r '.[] | select(.state == "me") | "- \(.name) [\(.labels["vally.role"])] 이슈 #\(.labels["vally.issue"])\(if .labels["vally.pr"] then " PR #"+.labels["vally.pr"] else "" end): \(.run)"' <<<"$agents" | grep . || echo "- 없음"
  echo
  echo "## 내 이슈"
  jq -r '[.[] | select(.state == "me" and .issue != "")] | group_by(.issue)[] | "- #\(.[0].issue): \(map(.name // (.path | split("/") | last)) | join(", "))"' <<<"$all" | grep . || echo "- 없음"
  echo
  echo "## 내 PR"
  jq -r --argjson mine "$mine" '.[] | select(((.number | tostring) | IN($mine[])) or (.headRefName | IN($mine[]))) | "- #\(.number) \(.title) (\(.headRefName))"' <<<"$prs" | grep . || echo "- 없음"
  echo
  echo "## 내 작업 공간"
  jq -r '.[] | select(.state == "me") | "- \(.path) (\(if .branch == "" then "detached" else .branch end))\(if (.live or .pr) | not then ", 일하는 에이전트도 열린 PR도 없음" else "" end)\(if .dirty then ", 커밋 안 한 변경 있음" else "" end)"' <<<"$spaces" | grep . || echo "- 없음"
  echo
  echo "## 주인 없는 작업 공간"
  jq -r '.[] | select(.state == "gone" or (.state == "none" and (.live or .pr | not))) | "- \(.path) (\(if .branch == "" then "detached" else .branch end)): \(if .state == "none" then "기록 없음" else "리드 \(.owner | split("@")[0]) 없음" end)\(if .dirty then ", 커밋 안 한 변경 있음" else "" end)"' <<<"$spaces" | grep . || echo "- 없음"
  echo
  echo "## 다른 리드"
  printf '%s' "$others" | grep . || echo "- 없음"
  echo
  echo "## 바로 맡길 수 있는 이슈 (ready-for-agent, 맡은 리드 없음)"
  jq -r --argjson held "$held" '.[] | select((.number | tostring) | IN($held[]) | not) | "- #\(.number) \(.title)"' <<<"$ready" | grep . || echo "- 없음"
} | tee "$report"
