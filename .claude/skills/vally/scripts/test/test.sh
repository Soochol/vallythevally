#!/usr/bin/env bash
# Tests for the vally skill scripts against a throwaway git origin, fake hc and fake gh.
#   .claude/skills/vally/scripts/test/test.sh [case-name-substring]
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
agent=$(cd "$here/.." && pwd)
only=${1-}
pass=0 fail=0
ORIG_PATH=$PATH
T_LOG=$(mktemp)

setup() {
  T=$(mktemp -d)
  export FAKE_DIR=$T/fake VALLY_WORKTREES=$T/wt VALLY_STATE=$T/state VALLY_TEMPLATES=$T/tpl
  export HC_TERMINAL_ID=t1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
  unset VALLY_SHOW FAKE_SENT FAKE_HC_FAIL
  mkdir -p "$FAKE_DIR/gh" "$T/bin" "$VALLY_WORKTREES"
  ln -s "$here/fake-hc" "$T/bin/hc"; ln -s "$here/fake-gh" "$T/bin/gh"
  export PATH=$T/bin:$ORIG_PATH
  echo '{"terminals":[{"address":"t1","name":null,"cwd":"/lead","state":"live","status":{"state":"working"},"labels":{"herdr.space":"sp1"}}]}' > "$FAKE_DIR/terminals.json"
  git init -q --bare -b main "$T/origin.git"
  git clone -q "$T/origin.git" "$T/lead" 2>/dev/null
  cd "$T/lead"
  echo hi > README.md; git add .; git commit -qm init; git push -q origin main
  echo "# spec" > "$T/spec.md"
}

# A PR branch on origin with refs/pull/<n>/head, and gh's view of it.
make_pr() { # <n> <branch> <state> <files-json>
  git -C "$T/lead" checkout -q -b "$2" origin/main
  echo "$1" > "$T/lead/change-$1.txt"; git -C "$T/lead" add .; git -C "$T/lead" commit -qm "pr $1"
  git -C "$T/lead" push -q origin "$2" "$2:refs/pull/$1/head"
  head=$(git -C "$T/lead" rev-parse HEAD)
  git -C "$T/lead" checkout -q main
  jq -n --arg b "$2" --arg h "$head" --arg s "$3" --argjson f "$4" \
    '{headRefName: $b, headRefOid: $h, state: $s, files: ($f | map({path: .}))}' > "$FAKE_DIR/gh/pr-$1.json"
}

merge_pr() { # <branch>: what GitHub does on --merge
  git -C "$T/lead" merge -q --no-ff -m merge "origin/$1" && git -C "$T/lead" push -q origin main
}

add_terminal() { # <address> <name> <cwd> <labels-json> [status]
  jq --arg a "$1" --arg n "$2" --arg c "$3" --argjson l "$4" --arg s "${5:-idle}" \
    '.terminals += [{address: $a, name: $n, cwd: $c, state: "live", status: {state: $s}, labels: $l}]' \
    "$FAKE_DIR/terminals.json" > "$FAKE_DIR/t.tmp" && mv "$FAKE_DIR/t.tmp" "$FAKE_DIR/terminals.json"
}

ran() { grep "^$1" "$FAKE_DIR/hc.log" 2>/dev/null; }
ok() { if "$@"; then return 0; else echo "    failed: $*"; return 1; fi; }
run_case() {
  local name=$1; shift
  ( setup; "$@" ) > "$T_LOG" 2>&1
  if [ $? = 0 ]; then pass=$((pass+1)); echo "ok   $name"
  else fail=$((fail+1)); echo "FAIL $name"; sed 's/^/     /' "$T_LOG"; fi
}

# ---- start.sh

t_impl_starts_worker() {
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" || return 1
  wt=$VALLY_WORKTREES/fix-58-theme
  ok test "$(git -C "$wt" branch --show-current)" = fix/58-theme &&
  ok grep -q -- '--outlive-parent --name w58-impl --label vally.role=worker --label vally.issue=58 --label vally.round=0 --label herdr.space=sp1 --cwd '"$wt"' vally-worker' "$FAKE_DIR/hc.log" &&
  ok test -f "$VALLY_STATE/reports/58/w58-impl.spec.md" &&
  ok test -f "$VALLY_STATE/reports/58/w58-impl.launch.json" &&
  ok grep -q "보고서는 $VALLY_STATE/reports/58/w58-impl.md" "$FAKE_DIR/hc.log"
}

t_impl_branch_has_no_upstream() {
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  ok test -z "$(git -C "$VALLY_WORKTREES/fix-58-theme" rev-parse --abbrev-ref '@{u}' 2>/dev/null)"
}

t_impl_continues_remote_branch() {
  make_pr 61 feat/58-x OPEN '["a.ts"]'
  git branch -q -D feat/58-x
  remote=$(git rev-parse origin/feat/58-x)
  "$agent/start.sh" impl 58 --branch feat/58-x --spec "$T/spec.md" >/dev/null || return 1
  ok test "$(git -C "$VALLY_WORKTREES/feat-58-x" rev-parse HEAD)" = "$remote"
}

t_impl_rejects_bad_branch() {
  ! "$agent/start.sh" impl 58 --branch theme --spec "$T/spec.md" 2>/dev/null && ok test -z "$(ran run)"
}

t_flag_without_value_shows_usage() {
  "$agent/start.sh" impl 58 --spec 2>"$T/err"; code=$?
  ok test $code = 2 && ok grep -q 'start.sh impl' "$T/err"
}

t_impl_refuses_busy_worktree() {
  add_terminal t5 w58-impl "$VALLY_WORKTREES/fix-58-theme" '{"vally.issue":"58","vally.role":"worker"}'
  ! "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" 2>"$T/err" &&
  ok grep -q 'already works in' "$T/err" && ok test -z "$(ran run)"
}

t_start_stops_when_hc_is_down() {
  export FAKE_HC_FAIL=ls
  ! "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" 2>"$T/err" &&
  ok grep -q 'hc ls failed' "$T/err" && ok test -z "$(ran run)"
}

t_unsent_first_message_fails_loudly() {
  export FAKE_SENT=false
  ! "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" 2>"$T/err" &&
  ok grep -q 'NOT sent' "$T/err"
}

t_no_tab_when_hidden() {
  export VALLY_SHOW=0
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null &&
  ok test -z "$(ran run | grep herdr.space)"
}

t_review_uses_exact_head() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  head=$(jq -r .headRefOid "$FAKE_DIR/gh/pr-61.json")
  "$agent/start.sh" review 58 --pr 61 --round 0 >/dev/null || return 1
  wt=$VALLY_WORKTREES/review-58-${head:0:7}
  ok test "$(git -C "$wt" rev-parse HEAD)" = "$head" &&
  ok grep -q -- '--name w58-review0 --label vally.role=reviewer --label vally.issue=58 --label vally.round=0 --label vally.pr=61' "$FAKE_DIR/hc.log" &&
  ok grep -q "vally-reviewer" "$FAKE_DIR/hc.log"
}

t_fix_reuses_pr_branch() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  "$agent/start.sh" fix 58 --pr 61 --round 1 --spec "$T/spec.md" >/dev/null || return 1
  ok test "$(git -C "$VALLY_WORKTREES/fix-58-theme" branch --show-current)" = fix/58-theme &&
  ok grep -q -- '--name w58-fix1 .*--label vally.round=1' "$FAKE_DIR/hc.log"
}

t_garden_hands_off_with_issue_report_and_rebase() {
  add_terminal t7 docs-garden /g '{"vally.role":"gardener","vally.issue":"50","vally.pr":"55"}'
  "$agent/start.sh" garden 58 --pr 61 >/dev/null || return 1
  msg=$(ran 'send t7')
  ok grep -q '이슈 #58' <<<"$msg" && ok grep -q 'rebase origin/main' <<<"$msg" &&
  ok grep -q "$VALLY_STATE/reports/58/docs-garden-pr61.md" <<<"$msg" && ok test -z "$(ran run)"
}

t_garden_hands_off_once() {
  add_terminal t7 docs-garden /g '{"vally.role":"gardener","vally.issue":"50","vally.pr":"55"}'
  "$agent/start.sh" garden 58 --pr 61 >/dev/null && "$agent/start.sh" garden 58 --pr 61 >/dev/null || return 1
  ok test "$(ran 'send t7' | wc -l)" = 1 &&
  "$agent/start.sh" garden 50 --pr 55 >/dev/null && ok test "$(ran 'send t7' | wc -l)" = 1
}

t_garden_handoff_to_blocked_gardener_fails() {
  add_terminal t7 docs-garden /g '{"vally.role":"gardener","vally.issue":"50","vally.pr":"55"}' blocked
  ! "$agent/start.sh" garden 58 --pr 61 2>"$T/err" && ok grep -q 'could not hand' "$T/err"
}

# ---- finish.sh

t_finish_refuses_open_pr() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  ! "$agent/finish.sh" 58 --pr 61 2>"$T/err" && ok grep -q 'not merged' "$T/err"
}

t_finish_cleans_and_starts_gardener() {
  make_pr 61 fix/58-theme MERGED '["web/a.ts","docs/x.md"]'; merge_pr fix/58-theme
  git worktree add -q "$VALLY_WORKTREES/fix-58-theme" fix/58-theme
  add_terminal t5 w58-fix1 /gone '{"vally.issue":"58","vally.role":"worker"}'
  add_terminal t7 w58-review1 /r '{"vally.issue":"58","vally.role":"reviewer"}'
  "$agent/finish.sh" 58 --pr 61 > "$T/out" || { cat "$T/out"; return 1; }
  ok grep -q '^retired t5' "$T/out" && ok grep -q '^retired t7' "$T/out" &&
  ok test ! -d "$VALLY_WORKTREES/fix-58-theme" &&
  ok test -z "$(git branch --list fix/58-theme)" &&
  ok grep -q -- '--name docs-garden --label vally.role=gardener' "$FAKE_DIR/hc.log" &&
  ok test -d "$VALLY_WORKTREES/docs-garden-61"
}

t_finish_keeps_dirty_worktree() {
  make_pr 61 fix/58-theme MERGED '["web/a.ts"]'; merge_pr fix/58-theme
  git worktree add -q "$VALLY_WORKTREES/fix-58-theme" fix/58-theme
  echo wip > "$VALLY_WORKTREES/fix-58-theme/wip.txt"
  "$agent/finish.sh" 58 --pr 61 > "$T/out" || return 1
  ok grep -q 'kept .*uncommitted' "$T/out" && ok test -d "$VALLY_WORKTREES/fix-58-theme" &&
  ok test -n "$(git branch --list fix/58-theme)"
}

t_finish_keeps_unpushed_commits() {
  make_pr 61 fix/58-theme MERGED '["web/a.ts"]'; merge_pr fix/58-theme
  git worktree add -q "$VALLY_WORKTREES/fix-58-theme" fix/58-theme
  echo late > "$VALLY_WORKTREES/fix-58-theme/late.txt"
  git -C "$VALLY_WORKTREES/fix-58-theme" add . && git -C "$VALLY_WORKTREES/fix-58-theme" commit -qm late
  git worktree remove "$VALLY_WORKTREES/fix-58-theme"
  "$agent/finish.sh" 58 --pr 61 > "$T/out" || return 1
  ok grep -q 'kept branch fix/58-theme: it has commits' "$T/out" && ok test -n "$(git branch --list fix/58-theme)"
}

t_finish_keeps_live_gardener_worktree() {
  make_pr 61 docs/garden-55 MERGED '["docs/a.md"]'; merge_pr docs/garden-55
  git worktree add -q "$VALLY_WORKTREES/docs-garden-55" docs/garden-55
  add_terminal t7 docs-garden "$VALLY_WORKTREES/docs-garden-55" '{"vally.issue":"58","vally.role":"gardener"}'
  "$agent/finish.sh" 58 --pr 61 > "$T/out" || return 1
  ok test -d "$VALLY_WORKTREES/docs-garden-55" && ok grep -q 'kept .*live terminal' "$T/out" &&
  ok test -z "$(ran 'kill t7')" && ok grep -q 'gardener PR: no gardener' "$T/out"
}

t_finish_docs_only_skips_gardener() {
  make_pr 62 docs/x MERGED '["docs/a.md","AGENTS.md"]'; merge_pr docs/x
  "$agent/finish.sh" 58 --pr 62 > "$T/out" || return 1
  ok grep -q 'docs-only PR: no gardener' "$T/out" && ok test -z "$(ran run)"
}

t_finish_stops_when_hc_is_down() {
  make_pr 61 fix/58-theme MERGED '["web/a.ts"]'; merge_pr fix/58-theme
  git worktree add -q "$VALLY_WORKTREES/fix-58-theme" fix/58-theme
  export FAKE_HC_FAIL=ls
  ! "$agent/finish.sh" 58 --pr 61 >/dev/null 2>"$T/err" &&
  ok grep -q 'hc ls failed' "$T/err" && ok test -d "$VALLY_WORKTREES/fix-58-theme"
}

# ---- retire.sh

t_retire_removes_clean_merged_worktree() {
  make_pr 61 fix/58-theme MERGED '["a"]'; merge_pr fix/58-theme
  git worktree add -q "$VALLY_WORKTREES/fix-58-theme" fix/58-theme
  add_terminal t5 w58-impl "$VALLY_WORKTREES/fix-58-theme" '{"vally.issue":"58","vally.role":"worker"}'
  "$agent/retire.sh" w58-impl --worktree > "$T/out" || return 1
  ok grep -q 'retired w58-impl' "$T/out" && ok test ! -d "$VALLY_WORKTREES/fix-58-theme" &&
  ok test -z "$(git branch --list fix/58-theme)"
}

t_retire_keeps_unpushed_work() {
  git worktree add -q --no-track -b docs/garden-9 "$VALLY_WORKTREES/docs-garden-9" origin/main
  echo x > "$VALLY_WORKTREES/docs-garden-9/x.md"; git -C "$VALLY_WORKTREES/docs-garden-9" add . && git -C "$VALLY_WORKTREES/docs-garden-9" commit -qm x
  add_terminal t7 docs-garden "$VALLY_WORKTREES/docs-garden-9" '{"vally.issue":"9","vally.role":"gardener"}'
  ! "$agent/retire.sh" docs-garden --worktree 2>"$T/err" && ok grep -q 'not on origin' "$T/err" &&
  ok test -d "$VALLY_WORKTREES/docs-garden-9"
}

t_retire_refuses_non_vally_terminal() {
  ! "$agent/retire.sh" t1 2>"$T/err" && ok grep -q 'not a vally agent' "$T/err" && ok test -z "$(ran kill)"
}

# ---- check-pr.sh

t_check_pr_runs_at_head_and_says_merge_mode() {
  make_pr 61 docs/x OPEN '["docs/a.md"]'
  "$agent/check-pr.sh" 58 --pr 61 > "$T/out" || { cat "$T/out"; return 1; }
  head=$(jq -r .headRefOid "$FAKE_DIR/gh/pr-61.json")
  ok grep -q "^head: $head" "$T/out" && ok grep -q '^merge: auto' "$T/out" &&
  ok grep -q -- "--name check-61 .*--cwd $VALLY_WORKTREES/review-58-${head:0:7} -- bash -c" "$FAKE_DIR/hc.log"
}

t_check_pr_agent_rules_need_user() {
  make_pr 61 docs/x OPEN '["AGENTS.md"]'
  "$agent/check-pr.sh" 58 --pr 61 > "$T/out" && ok grep -q '^merge: user' "$T/out"
}

t_check_pr_refuses_pr_behind_main() {
  make_pr 61 fix/58-theme OPEN '["a.ts"]'
  echo more > more.txt; git add .; git commit -qm more; git push -q origin main
  ! "$agent/check-pr.sh" 58 --pr 61 2>"$T/err" && ok grep -q 'behind main' "$T/err" && ok test -z "$(ran run)"
}

t_check_pr_refuses_worktree_with_reviewer() {
  make_pr 61 fix/58-theme OPEN '["a.ts"]'
  head=$(jq -r .headRefOid "$FAKE_DIR/gh/pr-61.json")
  add_terminal t9 w58-review0 "$VALLY_WORKTREES/review-58-${head:0:7}" '{"vally.issue":"58","vally.role":"reviewer"}'
  ! "$agent/check-pr.sh" 58 --pr 61 2>"$T/err" && ok grep -q 'retire the reviewer' "$T/err"
}

# ---- status.sh

t_status_lists_agents_and_orphans() {
  add_terminal t5 w58-impl /w '{"vally.issue":"58","vally.role":"worker","vally.pr":"61"}' working
  git branch -q leftover; git worktree add -q "$VALLY_WORKTREES/leftover" leftover
  echo '[{"number":61,"title":"fix theme","headRefName":"fix/58-theme","headRefOid":"x"}]' > "$FAKE_DIR/gh/pr-list.json"
  "$agent/status.sh" > "$T/out" || return 1
  ok grep -q 'w58-impl \[worker\] 이슈 #58 PR #61: working$' "$T/out" &&
  ok grep -q '#61 fix theme' "$T/out" &&
  ok grep -q "$VALLY_WORKTREES/leftover (leftover)" "$T/out" &&
  ok test -f "$VALLY_STATE/status.md"
}

t_status_skips_review_worktree_of_open_pr() {
  make_pr 61 fix/58-theme OPEN '["a.ts"]'
  head=$(jq -r .headRefOid "$FAKE_DIR/gh/pr-61.json")
  git worktree add -q --detach "$VALLY_WORKTREES/review-58-${head:0:7}" "$head"
  jq -s '.' "$FAKE_DIR/gh/pr-61.json" | jq '.[0] += {number: 61, title: "t"}' > "$FAKE_DIR/gh/pr-list.json"
  "$agent/status.sh" > "$T/out" || return 1
  ok test -z "$(grep review-58 "$T/out")"
}

t_status_stops_when_hc_is_down() {
  export FAKE_HC_FAIL=ls
  ! "$agent/status.sh" >/dev/null 2>"$T/err" && ok grep -q 'hc ls failed' "$T/err"
}

# ---- sync-templates.sh, lib.sh

t_sync_templates_writes_three() {
  printf 'worker claude opus -\nreviewer codex gpt-x high\ngardener claude sonnet -\n' > "$T/models.conf"
  VALLY_MODELS=$T/models.conf "$agent/sync-templates.sh" >/dev/null || return 1
  for r in worker reviewer gardener; do
    ok grep -q "^name: vally-$r$" "$VALLY_TEMPLATES/vally-$r.md" || return 1
    ok grep -q "^command: env VALLY_ROLE=$r " "$VALLY_TEMPLATES/vally-$r.md" || return 1
  done
  ok grep -q -- '--no-daemon' "$VALLY_TEMPLATES/vally-reviewer.md"
}

t_models_conf_sets_each_role() {
  printf 'worker codex gpt-x low\nreviewer claude sonnet high\ngardener claude haiku -\n' > "$T/models.conf"
  VALLY_MODELS=$T/models.conf "$agent/sync-templates.sh" >/dev/null || return 1
  ok grep -q '^command: env VALLY_ROLE=worker codex --no-daemon -m gpt-x -c model_reasoning_effort=low --approve-for-me$' "$VALLY_TEMPLATES/vally-worker.md" &&
  ok grep -q '^command: env VALLY_ROLE=reviewer claude --model sonnet --effort high$' "$VALLY_TEMPLATES/vally-reviewer.md" &&
  ok grep -q '^command: env VALLY_ROLE=gardener claude --model haiku$' "$VALLY_TEMPLATES/vally-gardener.md"
}

t_models_conf_rejects_missing_role_and_bad_agent() {
  printf 'worker claude opus -\n' > "$T/models.conf"
  ! VALLY_MODELS=$T/models.conf "$agent/sync-templates.sh" >/dev/null 2>"$T/err" && ok grep -q 'no line for role reviewer' "$T/err" || return 1
  printf 'worker gemini x -\nreviewer codex y -\ngardener claude z -\n' > "$T/models.conf"
  ! VALLY_MODELS=$T/models.conf "$agent/sync-templates.sh" >/dev/null 2>"$T/err" && ok grep -q "unknown agent 'gemini'" "$T/err"
}

t_start_uses_current_models_conf() {
  printf 'worker claude sonnet -\nreviewer codex y -\ngardener claude z -\n' > "$T/models.conf"
  VALLY_MODELS=$T/models.conf "$agent/start.sh" impl 58 --branch fix/58-x --spec "$T/spec.md" >/dev/null || return 1
  ok grep -q '^command: env VALLY_ROLE=worker claude --model sonnet$' "$VALLY_TEMPLATES/vally-worker.md"
}

t_docs_classifiers() {
  source "$agent/lib.sh"
  docs_only $'docs/a.md\nAGENTS.md\n.github/ISSUE_TEMPLATE/bug.md' &&
  ! docs_only $'docs/a.md\nweb/src/x.ts' && ! docs_only 'web/README.md' && ! docs_only '' &&
  touches_agent_rules $'docs/a.md\ndocs/agents/document-policy.md' && touches_agent_rules 'CLAUDE.md' &&
  ! touches_agent_rules $'docs/a.md\nREADME.md'
}

for t in $(declare -F | awk '{print $3}' | grep '^t_'); do
  [ -z "$only" ] || [[ $t == *"$only"* ]] || continue
  run_case "${t#t_}" "$t"
done
echo "$pass passed, $fail failed"
[ $fail = 0 ]
