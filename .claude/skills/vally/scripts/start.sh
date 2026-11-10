#!/usr/bin/env bash
# Start one vally agent in its own locked worktree as a child of the calling terminal (the lead).
# Stops when another live lead holds the issue, the worktree, or the name.
#   start.sh impl   <issue> --branch feat/58-x --spec FILE [--writer]
#   start.sh fix    <issue> --pr 61 --round 1 --spec FILE [--writer]
#   start.sh review <issue> --pr 61 --round 0 [--spec FILE]
#   start.sh garden <issue> --pr 61
source "$(dirname "$0")/lib.sh"

usage() { sed -n '4,7p' "$0" >&2; exit 2; }
[ $# -ge 2 ] || usage
kind=$1 issue=$2; shift 2
need_issue "$issue"
branch='' pr='' round='' spec='' writer=''
while [ $# -gt 0 ]; do
  [ "$1" = --writer ] && { writer=1; shift; continue; }
  [ $# -ge 2 ] || usage
  case $1 in
    --branch) branch=$2;; --pr) pr=$2;; --round) round=$2;; --spec) spec=$2;;
    *) usage;;
  esac
  shift 2
done
git rev-parse --git-dir >/dev/null 2>&1 || die "run from a vallythevally checkout"
[ -z "$spec" ] || [ -f "$spec" ] || die "spec not found: $spec"
[ -z "$pr" ] || [[ $pr =~ ^[0-9]+$ ]] || die "--pr must be a number: $pr"
[ -z "$round" ] || [[ $round =~ ^[0-9]+$ ]] || die "--round must be a number: $round"
as_lead

git fetch -q origin
case $kind in
  impl)
    [ -n "$spec" ] || die "impl needs --spec"
    [[ $branch =~ ^(feat|fix|chore|docs|test|ci)/[a-z0-9][a-z0-9.-]*$ ]] || die "impl needs --branch like fix/58-theme-frame: '$branch'";;
  fix)
    [ -n "$spec" ] && [ -n "$pr" ] && [ -n "$round" ] || die "fix needs --pr, --round and --spec"
    branch=$(gh pr view "$pr" --json headRefName --jq .headRefName);;
  review)
    [ -n "$pr" ] && [ -n "$round" ] || die "review needs --pr and --round"
    head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
    git fetch -q origin "pull/$pr/head";;
  garden) [ -n "$pr" ] || die "garden needs --pr";;
  *) usage;;
esac

lock_and_load_live
need_issue_open "$issue"
lock_issue=$issue
case $kind in
  impl)
    role=worker template=vally-worker name=w$issue-impl round=${round:-0}
    [ -z "$writer" ] || role=writer template=vally-writer
    worktree=$(worktree_for_branch "$branch")
    if git show-ref --verify --quiet "refs/heads/$branch"; then add=(git worktree add -q "$worktree" "$branch")
    elif git show-ref --verify --quiet "refs/remotes/origin/$branch"; then add=(git worktree add -q -b "$branch" "$worktree" "origin/$branch")
    else add=(git worktree add -q --no-track -b "$branch" "$worktree" origin/main); fi
    ;;
  fix)
    role=worker template=vally-worker name=w$issue-fix$round
    [ -z "$writer" ] || role=writer template=vally-writer
    worktree=$(worktree_for_branch "$branch")
    if git show-ref --verify --quiet "refs/heads/$branch"; then add=(git worktree add -q "$worktree" "$branch")
    else add=(git worktree add -q -b "$branch" "$worktree" "origin/$branch"); fi
    ;;
  review)
    role=reviewer template=vally-reviewer name=w$issue-review$round
    worktree=$VALLY_WORKTREES/review-$issue-${head:0:7}
    add=(git worktree add -q --detach "$worktree" "$head")
    ;;
  garden)
    handed=$VALLY_STATE/garden-handed
    gardeners=$(terminals_with vally.role=gardener)
    live=''
    for g in $gardeners; do
      [ "$(owner_state "$(terminal_json "$g" | owner_of)")" = me ] && { live=$g; break; }
    done
    if [ -n "$live" ]; then
      if [ "$(label_of "$live" vally.pr)" = "$pr" ] || grep -qxF "$pr" "$handed" 2>/dev/null; then
        echo "PR #$pr is already with the gardener $live"; exit 0
      fi
      report=$VALLY_REPORTS/$issue/docs-garden-pr$pr.md
      mkdir -p "$VALLY_REPORTS/$issue"
      hc label "$live" vally.garden."$issue"=1 >/dev/null || die "could not record issue #$issue on the gardener $live"
      hc send "$live" "PR #$pr (이슈 #$issue)도 병합됐다. 먼저 git fetch origin && git rebase origin/main 으로 브랜치를 최신 main 위에 올린 뒤 같은 방식으로 문서를 점검하라. 보고서는 $report 에 쓰고 done $issue 로 알려라." \
        || die "could not hand PR #$pr to $live (it may be blocked); check with: hc read $live"
      echo "$pr" >> "$handed"
      echo "handed PR #$pr to the live gardener $live"
      exit 0
    fi
    role=gardener template=vally-gardener name=docs-garden-$HC_TERMINAL_ID round=0 lock_issue=''
    branch=docs/garden-$pr
    worktree=$(worktree_for_branch "$branch")
    add=(git worktree add -q --no-track -b "$branch" "$worktree" origin/main)
    ;;
esac

live_names=$(hc ls --json | jq -r '.terminals[].name // empty') || die "hc ls failed; is herdr-core running?"
! grep -qxF "$name" <<<"$live_names" || die "a live terminal is already named $name; see vally/status.sh"
cwds=$(live_cwds)
if [ -d "$worktree" ]; then
  owner=$(worktree_owner "$worktree")
  [ -z "$owner" ] || need_mine "$owner" "worktree $worktree" "$issue"
  ! grep -qxF "$worktree" <<<"$cwds" || die "a live terminal already works in $worktree; retire it first: retire.sh <name>"
else
  "${add[@]}"
fi
if [ "$kind" = review ]; then
  [ "$(git -C "$worktree" rev-parse HEAD)" = "$head" ] || die "review worktree $worktree is not at PR head $head"
  is_clean "$worktree" || die "review worktree is dirty: $worktree"
fi
[ "$(worktree_owner "$worktree")" = "$ME" ] || lock_worktree "$worktree" "$lock_issue"

out=$VALLY_REPORTS/$issue
mkdir -p "$out"
task="이슈 #$issue."
if [ -n "$spec" ]; then cp "$spec" "$out/$name.spec.md"; task="$task 명세: $out/$name.spec.md."; fi
[ -z "$pr" ] || task="$task PR #$pr."
[ "$kind" != garden ] || name_report=docs-garden-pr$pr
task="$task 보고서는 $out/${name_report:-$name}.md 에 쓴다."

labels=(--label vally.role=$role --label vally.issue=$issue --label vally.round=$round --label vally.owner=$ME)
[ -z "$pr" ] || labels+=(--label vally.pr=$pr)
space=$(label_of "$HC_TERMINAL_ID" herdr.space)
[ -z "$space" ] || [ "${VALLY_SHOW-1}" = 0 ] || labels+=(--label herdr.space=$space)

"$(dirname "$0")/sync-templates.sh" >/dev/null || die "could not write templates from $VALLY_MODELS"
hc run --bg --json --outlive-parent --name "$name" "${labels[@]}" --cwd "$worktree" "$template" "$task" > "$out/$name.launch.json"
sent=$(jq -r '.first_message.sent | tostring' "$out/$name.launch.json")
address=$(jq -r '.address // empty' "$out/$name.launch.json")
echo "started $name ($address) in $worktree"
[ "$sent" != false ] || die "first message was NOT sent; check with: hc read $name (do not resend blindly)"
