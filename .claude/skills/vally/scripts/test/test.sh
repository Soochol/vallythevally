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
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$FAKE_DIR/notify.log"\n' > "$T/bin/notify-send"; chmod +x "$T/bin/notify-send"
  export PATH=$T/bin:$ORIG_PATH
  echo '{"terminals":[]}' > "$FAKE_DIR/terminals.json"
  add_lead t1 "$T/lead" 1000000 '{"herdr.space":"sp1"}'
  add_lead t2 /home/dev/.herdr/worktrees/vallythevally/ochestra1 2000000
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

db_edit() { jq "$@" "$FAKE_DIR/terminals.json" > "$FAKE_DIR/t.tmp" && mv "$FAKE_DIR/t.tmp" "$FAKE_DIR/terminals.json"; }

add_terminal() {
  db_edit --arg a "$1" --arg n "$2" --arg c "$3" --argjson l "$4" --arg s "${5:-idle}" --arg p "${6-t1}" \
    '.terminals += [{address: $a, name: $n, cwd: $c, parent: (if $p == "" then null else $p end), created_ms: (([.terminals[].created_ms] | max // 0) + 1000), state: "live", status: {state: $s}, labels: $l}]'
}

add_lead() {
  db_edit --arg a "$1" --arg c "$2" --argjson ms "$3" --argjson l "${4-"{}"}" \
    '.terminals += [{address: $a, name: null, cwd: $c, parent: null, created_ms: $ms, state: "live", status: {state: "working"}, labels: $l}]'
}

kill_lead() { db_edit --arg a "$1" 'del(.terminals[] | select(.address == $a))'; }
as_t2() { HC_TERMINAL_ID=t2 "$@"; }
labels_of() { jq -c --arg t "$1" '.terminals[] | select(.address == $t or .name == $t) | .labels' "$FAKE_DIR/terminals.json"; }
lock_of() { git worktree list --porcelain | awk -v w="$1" '/^worktree / { p = substr($0, 10) } /^locked/ && p == w { print substr($0, 8) }'; }

changes_since() { tail -n +$(( $1 + 1 )) "$FAKE_DIR/hc.log" | grep -E '^(send|kill|rm|run|label) ' | grep -vE '^label (t1|t2) vally\.lead=' || true; }
mark() { wc -l < "$FAKE_DIR/hc.log" 2>/dev/null || echo 0; }

park_t1_in() { # <tool> <regex>
  local tool=$1 real
  if [ "$tool" = hc ]; then real=$here/fake-hc; else real=$(command -v "$tool"); fi
  rm -f "$T/bin/$tool"
  { echo '#!/usr/bin/env bash'; printf 're=%q real=%q\n' "$2" "$real"
    cat <<'SH'
if [ "$HC_TERMINAL_ID" = t1 ] && [[ "$*" =~ $re ]]; then
  touch "$FAKE_DIR/parked"
  for ((i = 0; i < 600; i++)); do [ -e "$FAKE_DIR/go" ] && break; sleep 0.05; done
fi
exec "$real" "$@"
SH
  } > "$T/bin/$tool"
  chmod +x "$T/bin/$tool"
}
wait_for() { for ((i = 0; i < 200; i++)); do [ -e "$1" ] && return 0; sleep 0.05; done; echo "    never appeared: $1"; return 1; }
free_t1_when_ended_or_after_3s() { for ((i = 0; i < 60; i++)); do kill -0 "$1" 2>/dev/null || break; sleep 0.05; done; touch "$FAKE_DIR/go"; }
section() { sed -n "/^## $2/,/^## /p" "$1"; }

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
  ok grep -q -- '--outlive-parent --name w58-impl --label vally.role=worker --label vally.issue=58 --label vally.round=0 --label vally.owner=t1@1000 --label herdr.space=sp1 --cwd '"$wt"' vally-worker' "$FAKE_DIR/hc.log" &&
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
  git worktree add -q --no-track -b fix/58-theme "$VALLY_WORKTREES/fix-58-theme" origin/main
  add_terminal t5 helper "$VALLY_WORKTREES/fix-58-theme" '{"vally.issue":"58","vally.role":"worker"}'
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
  ok grep -q -- '--name w58-review0 --label vally.role=reviewer --label vally.issue=58 --label vally.round=0 --label vally.owner=t1@1000 --label vally.pr=61' "$FAKE_DIR/hc.log" &&
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
  ok grep -q -- '--name docs-garden-t1 --label vally.role=gardener' "$FAKE_DIR/hc.log" &&
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
  ok grep -q -- "--name check-61-t1 .*--cwd $VALLY_WORKTREES/review-58-${head:0:7} -- bash -c" "$FAKE_DIR/hc.log"
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
  ok test -f "$VALLY_STATE/status-t1.md"
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

t_impl_writer_starts_writer() {
  "$agent/start.sh" impl 58 --branch docs/58-x --spec "$T/spec.md" --writer >/dev/null || return 1
  ok grep -q -- '--name w58-impl --label vally.role=writer .* vally-writer' "$FAKE_DIR/hc.log" &&
  ok grep -q '^command: env VALLY_ROLE=writer claude ' "$VALLY_TEMPLATES/vally-writer.md" &&
  ok grep -q 'pstack:technical-writing' "$VALLY_TEMPLATES/vally-writer.md" &&
  ! grep -q 'poteto-mode' "$VALLY_TEMPLATES/vally-writer.md"
}

t_reviewer_reviews_docs_alone() {
  "$agent/sync-templates.sh" >/dev/null || return 1
  ok grep -q 'documents only.*no `pstack:interrogate`, no subagents' "$VALLY_TEMPLATES/vally-reviewer.md"
}

t_sync_templates_writes_three() {
  printf 'worker claude opus -\nreviewer codex gpt-x high\ngardener claude sonnet -\nwriter claude w -\n' > "$T/models.conf"
  VALLY_MODELS=$T/models.conf "$agent/sync-templates.sh" >/dev/null || return 1
  for r in worker reviewer gardener writer; do
    ok grep -q "^name: vally-$r$" "$VALLY_TEMPLATES/vally-$r.md" || return 1
    ok grep -q "^command: env VALLY_ROLE=$r " "$VALLY_TEMPLATES/vally-$r.md" || return 1
  done
  ok grep -q -- '--no-daemon' "$VALLY_TEMPLATES/vally-reviewer.md"
}

t_models_conf_sets_each_role() {
  printf 'worker codex gpt-x low\nreviewer claude sonnet high\ngardener claude haiku -\nwriter claude w -\n' > "$T/models.conf"
  VALLY_MODELS=$T/models.conf "$agent/sync-templates.sh" >/dev/null || return 1
  ok grep -q '^command: env VALLY_ROLE=worker codex --no-daemon -m gpt-x -c model_reasoning_effort=low --approve-for-me$' "$VALLY_TEMPLATES/vally-worker.md" &&
  ok grep -q '^command: env VALLY_ROLE=reviewer claude --model sonnet --effort high$' "$VALLY_TEMPLATES/vally-reviewer.md" &&
  ok grep -q '^command: env VALLY_ROLE=gardener claude --model haiku$' "$VALLY_TEMPLATES/vally-gardener.md"
}

t_models_conf_rejects_missing_role_and_bad_agent() {
  printf 'worker claude opus -\n' > "$T/models.conf"
  ! VALLY_MODELS=$T/models.conf "$agent/sync-templates.sh" >/dev/null 2>"$T/err" && ok grep -q 'no line for role reviewer' "$T/err" || return 1
  printf 'worker gemini x -\nreviewer codex y -\ngardener claude z -\nwriter claude w -\n' > "$T/models.conf"
  ! VALLY_MODELS=$T/models.conf "$agent/sync-templates.sh" >/dev/null 2>"$T/err" && ok grep -q "unknown agent 'gemini'" "$T/err"
}

t_start_uses_current_models_conf() {
  printf 'worker claude sonnet -\nreviewer codex y -\ngardener claude z -\nwriter claude w -\n' > "$T/models.conf"
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

t_lead_owner_is_recorded_on_agent_lead_and_worktree() {
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  ok test "$(labels_of w58-impl | jq -r '.["vally.owner"]')" = t1@1000 &&
  ok test "$(jq -r '.terminals[] | select(.name == "w58-impl") | .parent' "$FAKE_DIR/terminals.json")" = t1 &&
  ok test "$(labels_of t1 | jq -r '.["vally.lead"] + " " + .["vally.lead.since"]')" = "main 1000" &&
  ok test "$(lock_of "$VALLY_WORKTREES/fix-58-theme")" = "vally owner t1@1000 issue 58" &&
  as_t2 "$agent/start.sh" impl 66 --branch feat/66-x --spec "$T/spec.md" >/dev/null &&
  ok test "$(labels_of t2 | jq -r '.["vally.lead"]')" = ochestra1 &&
  ok test "$(labels_of w66-impl | jq -r '.["vally.owner"]')" = t2@2000
}

t_start_refuses_issue_of_live_lead() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  m=$(mark); before=$(git worktree list --porcelain)
  ! "$agent/start.sh" fix 58 --pr 61 --round 1 --spec "$T/spec.md" 2>"$T/err" && ok grep -q 'live lead ochestra1' "$T/err" &&
  ! "$agent/start.sh" review 58 --pr 61 --round 0 2>"$T/err" && ok grep -q 'live lead ochestra1' "$T/err" &&
  ! "$agent/start.sh" impl 58 --branch fix/58-other --spec "$T/spec.md" 2>"$T/err" &&
  ok test -z "$(changes_since "$m")" && ok test "$(git worktree list --porcelain)" = "$before"
}

t_locked_worktree_keeps_issue_when_no_agent_runs() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null &&
  as_t2 "$agent/retire.sh" w58-impl >/dev/null || return 1
  m=$(mark)
  ! "$agent/start.sh" review 58 --pr 61 --round 0 2>"$T/err" && ok grep -q 'live lead ochestra1' "$T/err" &&
  ok test -z "$(changes_since "$m")" && ok test ! -d "$VALLY_WORKTREES/review-58-$(git rev-parse --short=7 origin/fix/58-theme)" &&
  ! git worktree remove "$VALLY_WORKTREES/fix-58-theme" 2>/dev/null && ok test -d "$VALLY_WORKTREES/fix-58-theme"
}

t_retire_check_finish_refuse_issue_of_live_lead() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  m=$(mark)
  ! "$agent/retire.sh" w58-impl --worktree 2>"$T/err" && ok grep -q 'w58-impl belongs to the live lead ochestra1' "$T/err" &&
  ! "$agent/check-pr.sh" 58 --pr 61 2>"$T/err" && ok grep -q 'live lead ochestra1' "$T/err" &&
  jq '.state = "MERGED"' "$FAKE_DIR/gh/pr-61.json" > "$T/pr" && mv "$T/pr" "$FAKE_DIR/gh/pr-61.json" &&
  ! "$agent/finish.sh" 58 --pr 61 2>"$T/err" && ok grep -q 'live lead ochestra1' "$T/err" &&
  ok test -z "$(changes_since "$m")" && ok test -d "$VALLY_WORKTREES/fix-58-theme"
}

t_dead_lead_is_shown_not_taken() {
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  kill_lead t2
  m=$(mark)
  "$agent/status.sh" > "$T/out" || return 1
  ok grep -q '^- w58-impl \[worker\] 이슈 #58: 작업 중 (리드 t2 없음)$' "$T/out" &&
  ok grep -q "^- $VALLY_WORKTREES/fix-58-theme (fix/58-theme): 리드 t2 없음$" "$T/out" &&
  ! "$agent/retire.sh" w58-impl 2>"$T/err" && ok grep -q '주인 없음.*take.sh 58' "$T/err" &&
  ! "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" 2>"$T/err" && ok grep -q 'take.sh 58' "$T/err" &&
  ok test -z "$(changes_since "$m")" &&
  ok test "$(lock_of "$VALLY_WORKTREES/fix-58-theme")" = "vally owner t2@2000 issue 58"
}

t_take_adopts_issue_of_dead_lead() {
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  w=$(jq -r '.terminals[] | select(.name == "w58-impl") | .address' "$FAKE_DIR/terminals.json")
  HC_TERMINAL_ID=$w "$agent/report.sh" "done 58 PR #61 /r.md" >/dev/null 2>&1
  kill_lead t2; HC_TERMINAL_ID=$w "$agent/report.sh" "done 58 PR #61 /r.md" >/dev/null 2>&1
  ok test "$(labels_of w58-impl | jq -r '.["vally.orphan"]')" = done || return 1
  "$agent/take.sh" 58 > "$T/out" || { cat "$T/out"; return 1; }
  ok test "$(labels_of w58-impl | jq -c '[.["vally.owner"], .["vally.orphan"]]')" = '["t1@1000",null]' &&
  ok grep -q "^send $w lead is now t1" "$FAKE_DIR/hc.log" &&
  ok test "$(lock_of "$VALLY_WORKTREES/fix-58-theme")" = "vally owner t1@1000 issue 58" &&
  "$agent/retire.sh" w58-impl > "$T/out" && ok grep -q 'retired w58-impl' "$T/out"
}

t_take_refuses_live_lead_unless_forced() {
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  m=$(mark)
  ! "$agent/take.sh" 58 2>"$T/err" && ok grep -q 'live lead ochestra1.*--force' "$T/err" &&
  ok test -z "$(changes_since "$m")" || return 1
  "$agent/take.sh" 58 --force > "$T/out" || return 1
  ok test "$(labels_of w58-impl | jq -r '.["vally.owner"]')" = t1@1000 &&
  ok grep -q '^send t2 vally: 사용자가 강제해서 이슈 #58' "$FAKE_DIR/hc.log" &&
  ok test "$(lock_of "$VALLY_WORKTREES/fix-58-theme")" = "vally owner t1@1000 issue 58"
}

t_reused_address_is_not_the_old_lead() {
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  kill_lead t2; add_lead t2 /elsewhere/other 9000000
  as_t2 "$agent/status.sh" >/dev/null || return 1
  "$agent/status.sh" > "$T/out" &&
  ok grep -q 'w58-impl .*(리드 t2 없음)' "$T/out" && "$agent/take.sh" 58 >/dev/null &&
  ok test "$(labels_of w58-impl | jq -r '.["vally.owner"]')" = t1@1000
}

t_check_terminals_are_per_lead() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  as_t2 "$agent/check-pr.sh" 59 --pr 61 > "$T/out2" && "$agent/check-pr.sh" 58 --pr 61 > "$T/out" || { cat "$T/out2" "$T/out"; return 1; }
  ok grep -q '^terminal: check-61-t2$' "$T/out2" && ok grep -q '^terminal: check-61-t1$' "$T/out" &&
  ok test "$(labels_of check-61-t1 | jq -r '.["vally.owner"]')" = t1@1000
}

t_finish_hands_docs_only_to_own_gardener() {
  make_pr 62 feat/66-x MERGED '["web/b.ts"]'; merge_pr feat/66-x
  as_t2 "$agent/finish.sh" 66 --pr 62 >/dev/null || return 1
  ok test -n "$(jq -r '.terminals[] | select(.name == "docs-garden-t2") | .address' "$FAKE_DIR/terminals.json")" || return 1
  make_pr 63 fix/58-theme MERGED '["web/a.ts"]'; merge_pr fix/58-theme
  "$agent/finish.sh" 58 --pr 63 > "$T/out" || { cat "$T/out"; return 1; }
  ok grep -q -- '--name docs-garden-t1 ' "$FAKE_DIR/hc.log" && ok test -z "$(ran 'send docs-garden-t2')" &&
  ok test -z "$(ran 'send t1')" || return 1
  make_pr 64 fix/58-more MERGED '["web/c.ts"]'; merge_pr fix/58-more
  "$agent/finish.sh" 58 --pr 64 > "$T/out" &&
  g1=$(jq -r '.terminals[] | select(.name == "docs-garden-t1") | .address' "$FAKE_DIR/terminals.json") &&
  ok grep -q "handed PR #64 to the live gardener $g1" "$T/out"
}

t_status_shows_only_my_space() {
  echo '[{"number":66,"title":"x"},{"number":80,"title":"free"}]' > "$FAKE_DIR/gh/issue-list.json"
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null &&
  as_t2 "$agent/start.sh" impl 66 --branch feat/66-x --spec "$T/spec.md" >/dev/null &&
  as_t2 "$agent/start.sh" impl 75 --branch feat/75-x --spec "$T/spec.md" >/dev/null || return 1
  m=$(mark)
  "$agent/status.sh" > "$T/out" || return 1
  ok grep -q '^- w58-impl \[worker\] 이슈 #58: working$' "$T/out" && ok grep -q '^- #58: w58-impl, fix-58-theme$' "$T/out" &&
  ok grep -q "^- $VALLY_WORKTREES/fix-58-theme (fix/58-theme)" "$T/out" &&
  ok test "$(grep -c 'w66-impl\|w75-impl\|feat-66-x\|feat-75-x' "$T/out")" = 0 &&
  ok grep -q '^- 다른 리드 사용 중: ochestra1 (이슈 #66, #75)$' "$T/out" &&
  ok grep -q '^- #80 free$' "$T/out" && ! grep -q '^- #66 x$' "$T/out" &&
  ok test -z "$(changes_since "$m")"
}

t_report_reaches_live_lead() {
  add_terminal t5 w58-impl /w '{"vally.issue":"58","vally.role":"worker","vally.owner":"t1@1000"}' working ''
  HC_TERMINAL_ID=t1 "$agent/status.sh" >/dev/null
  HC_TERMINAL_ID=t5 "$agent/report.sh" "done 58 PR #61 /r/w58-impl.md" > "$T/out" || return 1
  ok grep -q '^send t1 done 58 PR #61 /r/w58-impl.md$' "$FAKE_DIR/hc.log" && ok test "$(labels_of t5 | jq -r '.["vally.orphan"]')" = null
}

t_report_without_lead_marks_orphan_and_notifies() {
  add_terminal t5 w58-impl /w '{"vally.issue":"58","vally.role":"worker","vally.owner":"t9@5"}' idle ''
  HC_TERMINAL_ID=t5 "$agent/report.sh" "done 58 PR #61 /r/w58-impl.md" > "$T/out"; code=$?
  ok test $code = 3 && ok grep -q '^리드가 없어 보고하지 못했다: done 58 PR #61 /r/w58-impl.md$' "$T/out" &&
  ok test "$(labels_of t5 | jq -r '.["vally.orphan"]')" = done &&
  ok grep -q '^vally #58 리드 없음: done 58 PR #61 /r/w58-impl.md$' "$FAKE_DIR/notify.log" && ok test -z "$(ran 'send t9')" &&
  "$agent/status.sh" > "$T/out" && ok grep -q '^- w58-impl \[worker\] 이슈 #58: 보고 완료 (리드 t9 없음)$' "$T/out"
}

t_report_to_blocked_lead_is_not_orphan() {
  as_t2 "$agent/status.sh" >/dev/null || return 1
  db_edit '(.terminals[] | select(.address == "t2") | .status.state) = "blocked"'
  add_terminal t5 w66-impl /w '{"vally.issue":"66","vally.role":"worker","vally.owner":"t2@2000"}' idle ''
  ! HC_TERMINAL_ID=t5 "$agent/report.sh" "done 66 PR #70 /r.md" >/dev/null 2>"$T/err" &&
  ok grep -q 'it may be blocked' "$T/err" && ok test "$(labels_of t5 | jq -r '.["vally.orphan"]')" = null &&
  ok test ! -s "$FAKE_DIR/notify.log"
}

t_templates_report_through_script() {
  "$agent/sync-templates.sh" >/dev/null || return 1
  for r in worker reviewer gardener writer; do
    ok grep -q "$agent/report.sh" "$VALLY_TEMPLATES/vally-$r.md" && ! grep -q '@VALLY_SCRIPTS@' "$VALLY_TEMPLATES/vally-$r.md" || return 1
  done
}

t_finish_and_retire_unlock_and_remove_own_worktrees() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  "$agent/start.sh" fix 58 --pr 61 --round 1 --spec "$T/spec.md" >/dev/null &&
  "$agent/start.sh" review 58 --pr 61 --round 0 >/dev/null || return 1
  head=$(jq -r .headRefOid "$FAKE_DIR/gh/pr-61.json")
  ok test -n "$(lock_of "$VALLY_WORKTREES/review-58-${head:0:7}")" || return 1
  jq '.state = "MERGED"' "$FAKE_DIR/gh/pr-61.json" > "$T/pr" && mv "$T/pr" "$FAKE_DIR/gh/pr-61.json" && merge_pr fix/58-theme
  "$agent/finish.sh" 58 --pr 61 > "$T/out" 2>&1 || { cat "$T/out"; return 1; }
  ok test ! -d "$VALLY_WORKTREES/fix-58-theme" && ok test ! -d "$VALLY_WORKTREES/review-58-${head:0:7}" &&
  ok test -z "$(git branch --list fix/58-theme)" && ok test -d "$VALLY_WORKTREES/docs-garden-61" || return 1
  ok test "$(git worktree list --porcelain | grep -c '^locked')" = 1 &&
  "$agent/retire.sh" docs-garden-t1 --worktree > "$T/out" 2>&1 || { cat "$T/out"; return 1; }
  ok test ! -d "$VALLY_WORKTREES/docs-garden-61" && ok test -z "$(git worktree list --porcelain | grep '^locked')"
}

t_same_lead_names_show_the_address() {
  kill_lead t2; add_lead t2 "$T/lead/sub" 2000000; add_lead t3 /a/ochestra1 3000000; add_lead t4 /b/ochestra1 4000000
  as_t2 "$agent/start.sh" impl 66 --branch feat/66-x --spec "$T/spec.md" >/dev/null &&
  HC_TERMINAL_ID=t3 "$agent/start.sh" impl 75 --branch feat/75-x --spec "$T/spec.md" >/dev/null &&
  HC_TERMINAL_ID=t4 "$agent/start.sh" impl 76 --branch feat/76-x --spec "$T/spec.md" >/dev/null || return 1
  "$agent/status.sh" > "$T/out" || return 1
  ok grep -q '^- 다른 리드 사용 중: main(t2) (이슈 #66)$' "$T/out" &&
  ok grep -q '^- 다른 리드 사용 중: ochestra1(t3) (이슈 #75)$' "$T/out" &&
  ok grep -q '^- 다른 리드 사용 중: ochestra1(t4) (이슈 #76)$' "$T/out"
}

t_starts_at_once_give_the_issue_to_one_lead() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  park_t1_in git '^worktree add'
  "$agent/start.sh" fix 58 --pr 61 --round 1 --spec "$T/spec.md" > "$T/t1" 2>&1 & p1=$!
  wait_for "$FAKE_DIR/parked" || return 1
  as_t2 "$agent/start.sh" review 58 --pr 61 --round 0 > "$T/t2" 2>&1 & p2=$!
  free_t1_when_ended_or_after_3s $p2
  wait $p1; c1=$?; wait $p2; c2=$?
  cat "$T/t1" "$T/t2"
  ok test $c1 = 0 && ok test $c2 != 0 && ok grep -q 'issue #58 belongs to the live lead main' "$T/t2" &&
  ok test -z "$(labels_of w58-review0)" && ok test "$(git worktree list --porcelain | grep -c '^locked')" = 1
}

t_check_and_start_at_once_give_the_issue_to_one_lead() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  park_t1_in git '^worktree add'
  "$agent/check-pr.sh" 58 --pr 61 > "$T/t1" 2>&1 & p1=$!
  wait_for "$FAKE_DIR/parked" || return 1
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-other --spec "$T/spec.md" > "$T/t2" 2>&1 & p2=$!
  free_t1_when_ended_or_after_3s $p2
  wait $p1; c1=$?; wait $p2; c2=$?
  cat "$T/t1" "$T/t2"
  ok test $c1 = 0 && ok test $c2 != 0 && ok grep -q 'issue #58 belongs to the live lead main' "$T/t2" &&
  ok test -z "$(labels_of w58-impl)" && ok test ! -d "$VALLY_WORKTREES/fix-58-other"
}

t_takes_at_once_give_the_issue_to_one_lead() {
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  kill_lead t2; add_lead t3 /c/macheck2 3000000
  park_t1_in hc '^label .* vally\.owner='
  "$agent/take.sh" 58 > "$T/t1" 2>&1 & p1=$!
  wait_for "$FAKE_DIR/parked" || return 1
  HC_TERMINAL_ID=t3 "$agent/take.sh" 58 > "$T/t3" 2>&1 & p3=$!
  free_t1_when_ended_or_after_3s $p3
  wait $p1; c1=$?; wait $p3; c3=$?
  cat "$T/t1" "$T/t3"
  ok test $c1 = 0 && ok test $c3 != 0 && ok grep -q 'issue #58 belongs to the live lead main' "$T/t3" &&
  ok test "$(labels_of w58-impl | jq -r '.["vally.owner"]')" = t1@1000 &&
  ok test "$(lock_of "$VALLY_WORKTREES/fix-58-theme")" = "vally owner t1@1000 issue 58"
}

t_agent_without_owner_belongs_to_an_older_parent_only() {
  add_terminal t5 w58-impl /w '{"vally.issue":"58","vally.role":"worker"}' working t2
  as_t2 "$agent/status.sh" > "$T/out" && ok grep -q '^- w58-impl \[worker\] 이슈 #58: working$' "$T/out" &&
  "$agent/status.sh" > "$T/out" && ok grep -q '^- 다른 리드 사용 중: ochestra1 (이슈 #58)$' "$T/out" || return 1
  kill_lead t2; add_lead t2 /recycled/lead 9000000
  m=$(mark)
  HC_TERMINAL_ID=t5 "$agent/report.sh" 'done 58 /r.md' > "$T/out"; code=$?
  ok test $code = 3 && ok test "$(labels_of t5 | jq -r '.["vally.orphan"]')" = done &&
  ! as_t2 "$agent/retire.sh" w58-impl 2>"$T/err" && ok grep -q 'w58-impl has no live lead (주인 없음, was t2)' "$T/err" &&
  ok test -z "$(changes_since "$m" | grep -E '^(send|kill|rm) ')"
}

t_take_moves_gardener_with_its_worktree() {
  as_t2 "$agent/start.sh" garden 58 --pr 61 >/dev/null || return 1
  kill_lead t2
  "$agent/take.sh" 58 > "$T/out" || { cat "$T/out"; return 1; }
  ok test "$(labels_of docs-garden-t2 | jq -r '.["vally.owner"]')" = t1@1000 &&
  ok test "$(lock_of "$VALLY_WORKTREES/docs-garden-61")" = "vally owner t1@1000" &&
  "$agent/retire.sh" docs-garden-t2 --worktree > "$T/out" 2>&1 && ok test ! -d "$VALLY_WORKTREES/docs-garden-61"
}

t_agent_without_any_record_is_shown_without_lead() {
  add_terminal t5 w58-impl /w '{"vally.issue":"58","vally.role":"worker"}' working ''
  HC_TERMINAL_ID=t5 "$agent/report.sh" 'done 58 /r.md' >/dev/null
  "$agent/status.sh" > "$T/out" 2>&1 || { cat "$T/out"; return 1; }
  ok grep -q '^- w58-impl \[worker\] 이슈 #58: 보고 완료 (리드 기록 없음)$' "$T/out" && ! grep -q 'bad array' "$T/out" &&
  ! "$agent/start.sh" impl 58 --branch fix/58-x --spec "$T/spec.md" 2>"$T/err" && ok grep -q '(주인 없음): w58-impl\.' "$T/err" &&
  "$agent/take.sh" 58 >/dev/null && ok test "$(labels_of t5 | jq -r '.["vally.owner"]')" = t1@1000
}

t_take_locks_the_unlocked_worktree_of_its_agent() {
  git worktree add -q --no-track -b fix/58-old "$VALLY_WORKTREES/fix-58-old" origin/main
  add_terminal t5 w58-impl "$VALLY_WORKTREES/fix-58-old" '{"vally.issue":"58","vally.role":"worker","vally.owner":"t9@5"}'
  "$agent/take.sh" 58 > "$T/out" || { cat "$T/out"; return 1; }
  ok grep -qx "took $VALLY_WORKTREES/fix-58-old" "$T/out" &&
  ok test "$(lock_of "$VALLY_WORKTREES/fix-58-old")" = "vally owner t1@1000 issue 58"
}

t_status_lists_my_pr_while_checking_and_after_a_push() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  jq '[. + {number: 61, title: "mine"}]' "$FAKE_DIR/gh/pr-61.json" > "$FAKE_DIR/gh/pr-list.json"
  "$agent/check-pr.sh" 58 --pr 61 >/dev/null && "$agent/status.sh" > "$T/out" || return 1
  ok test -n "$(section "$T/out" '내 PR' | grep '^- #61 mine ')" || return 1
  jq '.[0].headRefOid = "pushed"' "$FAKE_DIR/gh/pr-list.json" > "$T/l" && mv "$T/l" "$FAKE_DIR/gh/pr-list.json"
  "$agent/status.sh" > "$T/out" && ok test -n "$(section "$T/out" '내 PR' | grep '^- #61 mine ')" || return 1
  db_edit 'del(.terminals[] | select(.name == "check-61-t1"))'
  jq '.[0].closingIssuesReferences = [{number: 58}] | . + [{number: 62, title: "theirs", headRefName: "feat/66-x", headRefOid: "y", closingIssuesReferences: [{number: 66}]}]' \
    "$FAKE_DIR/gh/pr-list.json" > "$T/l" && mv "$T/l" "$FAKE_DIR/gh/pr-list.json"
  "$agent/status.sh" > "$T/out" &&
  ok test -n "$(section "$T/out" '내 PR' | grep '^- #61 mine ')" && ok test -z "$(section "$T/out" '내 PR' | grep '#62')"
}

t_issue_handed_to_gardener_stays_with_its_lead() {
  echo '[{"number":58,"title":"docs"},{"number":80,"title":"free"}]' > "$FAKE_DIR/gh/issue-list.json"
  "$agent/start.sh" garden 50 --pr 55 >/dev/null && "$agent/start.sh" garden 58 --pr 61 >/dev/null || return 1
  m=$(mark)
  ! as_t2 "$agent/start.sh" garden 58 --pr 61 2>"$T/err" && ok grep -q 'issue #58 belongs to the live lead main' "$T/err" &&
  ! as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" 2>/dev/null &&
  ok test -z "$(changes_since "$m")" || return 1
  "$agent/status.sh" > "$T/out" && ok grep -q '^- docs-garden-t1 \[gardener\] 이슈 #50, #58 PR #55: working$' "$T/out" &&
  ok grep -q '^- #58: docs-garden-t1$' "$T/out" &&
  as_t2 "$agent/status.sh" > "$T/out" && ok grep -q '^- 다른 리드 사용 중: main (이슈 #50, #58)$' "$T/out" &&
  ok grep -q '^- #80 free$' "$T/out" && ! grep -q '^- #58 docs$' "$T/out" || return 1
  kill_lead t1
  as_t2 "$agent/take.sh" 58 >/dev/null &&
  ok test "$(labels_of docs-garden-t1 | jq -r '.["vally.owner"]')" = t2@2000 &&
  ok test "$(lock_of "$VALLY_WORKTREES/docs-garden-55")" = "vally owner t2@2000"
}

won_issue_58_alone() { # <winner exit> <loser exit> <loser output> <winner name> <winner owner id>
  ok test "$1" = 0 && ok test "$2" != 0 && ok grep -q "issue #58 belongs to the live lead $4" "$3" &&
  ok test "$(jq -r '[.terminals[] | select(.labels["vally.issue"] == "58") | .labels["vally.owner"]] | unique | join(" ")' "$FAKE_DIR/terminals.json")" = "$5"
}

t_start_sees_a_lead_that_started_while_it_waited() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  park_t1_in git '^fetch -q origin$'
  "$agent/start.sh" review 58 --pr 61 --round 0 > "$T/t1" 2>&1 & p1=$!
  wait_for "$FAKE_DIR/parked" || return 1
  add_lead t3 /c/macheck2 3000000
  HC_TERMINAL_ID=t3 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" > "$T/t3" 2>&1 & p3=$!
  free_t1_when_ended_or_after_3s $p3
  wait $p1; c1=$?; wait $p3; c3=$?
  cat "$T/t1" "$T/t3"
  if [ $c3 = 0 ]; then won_issue_58_alone $c3 $c1 "$T/t1" macheck2 t3@3000; else won_issue_58_alone $c1 $c3 "$T/t3" main t1@1000; fi
}

t_takes_of_one_gardener_for_two_issues_give_it_to_one_lead() {
  add_lead t3 /c/macheck2 3000000
  HC_TERMINAL_ID=t3 "$agent/start.sh" garden 50 --pr 55 >/dev/null &&
  HC_TERMINAL_ID=t3 "$agent/start.sh" garden 58 --pr 61 >/dev/null || return 1
  kill_lead t3
  park_t1_in hc '^label .* vally\.owner='
  "$agent/take.sh" 50 > "$T/t1" 2>&1 & p1=$!
  wait_for "$FAKE_DIR/parked" || return 1
  as_t2 "$agent/take.sh" 58 > "$T/t2" 2>&1 & p2=$!
  free_t1_when_ended_or_after_3s $p2
  wait $p1; c1=$?; wait $p2; c2=$?
  cat "$T/t1" "$T/t2"
  if [ $c1 = 0 ]; then w=t1@1000 c=$c2 out=$T/t2 name=main; else w=t2@2000 c=$c1 out=$T/t1 name=ochestra1; fi
  ok test $c != 0 && ok grep -q "belongs to the live lead $name" "$out" &&
  ok test "$(labels_of docs-garden-t3 | jq -r '.["vally.owner"]')" = "$w" &&
  ok test "$(lock_of "$VALLY_WORKTREES/docs-garden-55")" = "vally owner $w"
}

t_retire_during_a_forced_take_stops_only_its_own_agent() {
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  park_t1_in hc '^kill w58-impl$'
  "$agent/retire.sh" w58-impl > "$T/t1" 2>&1 & p1=$!
  wait_for "$FAKE_DIR/parked" || return 1
  as_t2 "$agent/take.sh" 58 --force > "$T/t2" 2>&1 & p2=$!
  free_t1_when_ended_or_after_3s $p2
  wait $p1; wait $p2; c2=$?
  cat "$T/t1" "$T/t2"
  ok test $c2 = 0 && ok test "$(lock_of "$VALLY_WORKTREES/fix-58-theme")" = "vally owner t2@2000 issue 58" || return 1
  if grep -q '^took w58-impl' "$T/t2"; then ok test "$(labels_of w58-impl | jq -r '.["vally.owner"]')" = t2@2000
  else ok test -z "$(labels_of w58-impl)"; fi
}

t_report_during_a_take_reaches_the_new_lead() {
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  w=$(jq -r '.terminals[] | select(.name == "w58-impl") | .address' "$FAKE_DIR/terminals.json")
  kill_lead t2
  park_t1_in hc '^label .* vally\.owner='
  "$agent/take.sh" 58 > "$T/t1" 2>&1 & p1=$!
  wait_for "$FAKE_DIR/parked" || return 1
  HC_TERMINAL_ID=$w "$agent/report.sh" "done 58 PR #61 /r.md" > "$T/w" 2>&1 & pw=$!
  free_t1_when_ended_or_after_3s $pw
  wait $p1; wait $pw; cw=$?
  cat "$T/t1" "$T/w"
  ok test $cw = 0 && ok grep -q '^send t1 done 58 PR #61 /r.md$' "$FAKE_DIR/hc.log" &&
  ok test "$(labels_of w58-impl | jq -r '.["vally.orphan"]')" = null
}

t_orphan_status_shows_what_was_reported() {
  add_terminal t51 w58-impl /w1 '{"vally.issue":"58","vally.role":"worker","vally.owner":"t9@5"}' idle ''
  add_terminal t52 w59-impl /w2 '{"vally.issue":"59","vally.role":"worker","vally.owner":"t9@5"}' idle ''
  add_terminal t53 w60-review0 /w3 '{"vally.issue":"60","vally.role":"reviewer","vally.owner":"t9@5"}' idle ''
  HC_TERMINAL_ID=t51 "$agent/report.sh" "done 58 PR #61 /r/a.md" >/dev/null
  HC_TERMINAL_ID=t52 "$agent/report.sh" "ask 59 which branch? /r/q.md" >/dev/null
  HC_TERMINAL_ID=t53 "$agent/report.sh" "blocked 60 missing approval" >/dev/null
  ok test "$(for t in t51 t52 t53; do labels_of $t | jq -r '.["vally.orphan"]'; done | tr '\n' ' ')" = "done ask blocked " &&
  "$agent/status.sh" > "$T/out" || return 1
  ok grep -q '^- w58-impl \[worker\] 이슈 #58: 보고 완료 (리드 t9 없음)$' "$T/out" &&
  ok grep -q '^- w59-impl \[worker\] 이슈 #59: 질문 대기 (리드 t9 없음)$' "$T/out" &&
  ok grep -q '^- w60-review0 \[reviewer\] 이슈 #60: 막힘 (리드 t9 없음)$' "$T/out"
}

t_start_and_check_stop_on_an_issue_without_live_lead() {
  make_pr 61 fix/58-theme OPEN '["web/a.ts"]'
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  kill_lead t2
  m=$(mark); before=$(git worktree list --porcelain)
  ! "$agent/start.sh" review 58 --pr 61 --round 0 2>"$T/err" && ok grep -q '(주인 없음): w58-impl .*take.sh 58$' "$T/err" &&
  ! "$agent/check-pr.sh" 58 --pr 61 2>"$T/err" && ok grep -q '(주인 없음): w58-impl .*take.sh 58$' "$T/err" &&
  ok test -z "$(changes_since "$m")" && ok test "$(git worktree list --porcelain)" = "$before" || return 1
  "$agent/take.sh" 58 >/dev/null && "$agent/start.sh" review 58 --pr 61 --round 0 >/dev/null &&
  ok test "$(labels_of w58-review0 | jq -r '.["vally.owner"]')" = t1@1000
}

t_finish_keeps_what_has_no_live_lead_and_starts_no_gardener() {
  make_pr 61 fix/58-theme MERGED '["web/a.ts"]'; merge_pr fix/58-theme
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  add_terminal t9 w58-review0 /w '{"vally.issue":"58","vally.role":"reviewer","vally.owner":"t8@5"}' idle ''
  "$agent/finish.sh" 58 --pr 61 > "$T/out" 2>&1; code=$?
  cat "$T/out"
  ok test $code = 0 && ok grep -q '^retired ' "$T/out" && ok grep -q '^kept w58-review0: no live lead' "$T/out" &&
  ok grep -q '^no gardener: issue #58 has things without a live lead (주인 없음): w58-review0\. .*take.sh 58, then start.sh garden 58 --pr 61$' "$T/out" &&
  ok test -z "$(labels_of w58-impl)" && ok test -n "$(labels_of w58-review0)" &&
  ok test ! -d "$VALLY_WORKTREES/fix-58-theme" && ok test -z "$(ran run | grep docs-garden)"
}

id_of() { echo "$1@$(labels_of "$1" | jq -r '.["vally.lead.since"]')"; }

t_take_finds_a_gardener_worktree_whose_terminal_is_gone() {
  as_t2 "$agent/start.sh" garden 58 --pr 61 >/dev/null && as_t2 "$agent/retire.sh" docs-garden-t2 >/dev/null || return 1
  kill_lead t2
  "$agent/take.sh" 58 > "$T/out" || { cat "$T/out"; return 1; }
  ok grep -qx "took $VALLY_WORKTREES/docs-garden-61 from t2" "$T/out" &&
  ok test "$(lock_of "$VALLY_WORKTREES/docs-garden-61")" = "vally owner $(id_of t1) issue 58" &&
  "$agent/start.sh" garden 58 --pr 61 > "$T/out" 2>&1 || { cat "$T/out"; return 1; }
  ok test "$(labels_of docs-garden-t1 | jq -r '.["vally.owner"]')" = "$(id_of t1)"
}

t_take_moves_a_gone_gardener_worktree_with_every_issue_it_holds() {
  as_t2 "$agent/start.sh" garden 50 --pr 55 >/dev/null && as_t2 "$agent/start.sh" garden 58 --pr 61 >/dev/null || return 1
  ok test "$(lock_of "$VALLY_WORKTREES/docs-garden-55")" = "vally owner $(id_of t2) issue 50,58" || return 1
  as_t2 "$agent/retire.sh" docs-garden-t2 >/dev/null && kill_lead t2
  "$agent/take.sh" 58 > "$T/out" || { cat "$T/out"; return 1; }
  ok grep -qx 'took issues #50, #58' "$T/out" &&
  ok test "$(lock_of "$VALLY_WORKTREES/docs-garden-55")" = "vally owner $(id_of t1) issue 50,58" &&
  "$agent/start.sh" impl 50 --branch fix/50-x --spec "$T/spec.md" >/dev/null
}

t_take_moves_every_issue_its_gardener_holds() {
  make_pr 61 fix/58-theme MERGED '["web/a.ts"]'; merge_pr fix/58-theme
  as_t2 "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  echo wip > "$VALLY_WORKTREES/fix-58-theme/wip.txt"
  as_t2 "$agent/start.sh" garden 50 --pr 55 >/dev/null && as_t2 "$agent/finish.sh" 58 --pr 61 > "$T/out" 2>&1 || { cat "$T/out"; return 1; }
  ok grep -q '^handed PR #61 to the live gardener' "$T/out" || return 1
  m=$(mark)
  ! "$agent/take.sh" 50 2>"$T/err" && ok grep -q 'live lead ochestra1.*--force' "$T/err" && ok test -z "$(changes_since "$m")" || return 1
  "$agent/take.sh" 50 --force > "$T/out" || { cat "$T/out"; return 1; }
  cat "$T/out"
  ok test "$(lock_of "$VALLY_WORKTREES/fix-58-theme")" = "vally owner $(id_of t1) issue 58" &&
  ok test "$(labels_of docs-garden-t2 | jq -r '.["vally.owner"]')" = "$(id_of t1)" &&
  ok grep -qx 'took issues #50, #58' "$T/out" &&
  ok grep -q '^send t2 vally: 사용자가 강제해서 이슈 #50, #58' "$FAKE_DIR/hc.log" &&
  "$agent/start.sh" impl 58 --branch fix/58-new --spec "$T/spec.md" >/dev/null &&
  ! as_t2 "$agent/start.sh" impl 58 --branch fix/58-next --spec "$T/spec.md" 2>"$T/err" && ok grep -q 'issue #58 belongs to the live lead main' "$T/err"
}

end_t1_on_send() { # <jq edit that ends t1>
  rm -f "$T/bin/hc"
  { echo '#!/usr/bin/env bash'; printf 'end=%q real=%q\n' "$1" "$here/fake-hc"
    cat <<'SH'
if [ "$1 $2" = "send t1" ]; then jq "$end" "$FAKE_DIR/terminals.json" > "$FAKE_DIR/end.tmp" && mv "$FAKE_DIR/end.tmp" "$FAKE_DIR/terminals.json"; fi
exec "$real" "$@"
SH
  } > "$T/bin/hc"
  chmod +x "$T/bin/hc"
}

report_marks_orphan_when_t1_ends_during_the_send() { # <jq edit that ends t1>
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  w=$(jq -r '.terminals[] | select(.name == "w58-impl") | .address' "$FAKE_DIR/terminals.json")
  end_t1_on_send "$1"
  HC_TERMINAL_ID=$w "$agent/report.sh" "done 58 PR #61 /r/w58-impl.md" > "$T/out" 2>&1; code=$?
  cat "$T/out"
  ok test $code = 3 && ok grep -q '^리드가 없어 보고하지 못했다: done 58 PR #61 /r/w58-impl.md$' "$T/out" &&
  ok test "$(labels_of w58-impl | jq -r '.["vally.orphan"]')" = done &&
  ok grep -q '^vally #58 리드 없음: done 58 PR #61 /r/w58-impl.md$' "$FAKE_DIR/notify.log"
}
t_report_marks_orphan_when_its_lead_is_removed_during_the_send() { report_marks_orphan_when_t1_ends_during_the_send 'del(.terminals[] | select(.address == "t1"))'; }
t_report_marks_orphan_when_its_lead_finishes_during_the_send() { report_marks_orphan_when_t1_ends_during_the_send '(.terminals[] | select(.address == "t1") | .state) = "finished"'; }

t_lead_address_reused_within_a_second_is_another_lead() {
  "$agent/start.sh" impl 58 --branch fix/58-theme --spec "$T/spec.md" >/dev/null || return 1
  w=$(jq -r '.terminals[] | select(.name == "w58-impl") | .address' "$FAKE_DIR/terminals.json")
  HC_TERMINAL_ID=$w "$agent/report.sh" "ask 58 which? /r/q.md" >/dev/null && ok grep -q '^send t1 ask 58' "$FAKE_DIR/hc.log" || return 1
  kill_lead t1; add_lead t1 "$T/lead" 1000999
  m=$(mark)
  HC_TERMINAL_ID=$w "$agent/report.sh" "done 58 PR #61 /r.md" > "$T/out" 2>&1; code=$?
  cat "$T/out"
  ok test $code = 3 && ok test -z "$(changes_since "$m" | grep '^send ')" &&
  ok test "$(labels_of w58-impl | jq -r '.["vally.orphan"]')" = done
}

t_scripts_print_their_usage() {
  for s in check-pr finish report retire start take; do
    "$agent/$s.sh" > /dev/null 2>"$T/err"; code=$?
    ok test $code = 2 && ok grep -q "^#   $s.sh " "$T/err" || return 1
  done
}

for t in $(declare -F | awk '{print $3}' | grep '^t_'); do
  [ -z "$only" ] || [[ $t == *"$only"* ]] || continue
  run_case "${t#t_}" "$t"
done
echo "$pass passed, $fail failed"
[ $fail = 0 ]
