# Shared settings for the vally skill scripts. Source it; do not run it.
set -euo pipefail

VALLY_WORKTREES=${VALLY_WORKTREES:-$HOME/.vally/worktrees/vallythevally}
VALLY_STATE=${VALLY_STATE:-$HOME/.vally/state/vallythevally}
VALLY_REPORTS=$VALLY_STATE/reports
VALLY_TEMPLATES=${VALLY_TEMPLATES:-$HOME/.config/herdr-core/templates}
VALLY_ROLES="worker reviewer gardener writer"
VALLY_MODELS=${VALLY_MODELS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models.conf}

# The command a role runs, built from its line in models.conf.
# Codex must run with --no-daemon under hc, or its commands execute outside hc.
role_command() { # <role>
  local agent model effort
  read -r agent model effort < <(awk -v r="$1" '$1 == r && $1 !~ /^#/ {print $2, $3, $4; exit}' "$VALLY_MODELS")
  [ -n "${model-}" ] || die "$VALLY_MODELS has no line for role $1"
  case $agent in
    claude) printf 'env VALLY_ROLE=%s claude --model %s' "$1" "$model"
            [ "${effort:--}" = - ] || printf ' --effort %s' "$effort";;
    codex)  printf 'env VALLY_ROLE=%s codex --no-daemon -m %s' "$1" "$model"
            [ "${effort:--}" = - ] || printf ' -c model_reasoning_effort=%s' "$effort"
            printf ' --approve-for-me';;
    *) die "$VALLY_MODELS: role $1 has unknown agent '$agent' (claude or codex)";;
  esac
}

die() { echo "vally: $*" >&2; exit 1; }
warn() { echo "vally: $*" >&2; }

worktree_for_branch() { echo "$VALLY_WORKTREES/${1//\//-}"; }

need_issue() { [[ $1 =~ ^[0-9]+$ ]] || die "issue must be a number: $1"; }

# Live terminals carrying every K=V label given, one address per line. Fails when hc fails.
terminals_with() {
  local args=() out
  for kv in "$@"; do args+=(--label "$kv"); done
  out=$(hc ls --json "${args[@]}") || die "hc ls failed; is herdr-core running?"
  jq -r '.terminals[].address' <<<"$out"
}

# Launch folders of every live terminal, one per line.
live_cwds() {
  local out
  out=$(hc ls --json) || die "hc ls failed; is herdr-core running?"
  jq -r '.terminals[].cwd // empty' <<<"$out"
}

terminal_json() { hc get "$1" --json || die "hc get $1 failed"; }

label_of() { terminal_json "$1" | jq -r --arg k "$2" '.labels[$k] // empty'; }

is_clean() { [ -z "$(git -C "$1" status --porcelain)" ]; }

# True when every commit on local branch $1 is already on origin (merged into main or pushed).
branch_is_safe_to_delete() {
  git merge-base --is-ancestor "$1" origin/main 2>/dev/null && return 0
  git show-ref --verify --quiet "refs/remotes/origin/$1" && git merge-base --is-ancestor "$1" "origin/$1"
}

# True when every changed file is a document (docs/, a root *.md, an issue template).
docs_only() {
  [ -n "$1" ] || return 1
  ! grep -qvE '^(docs/|\.github/ISSUE_TEMPLATE/|[^/]*\.md$)' <<<"$1"
}

# True when a change touches files that steer agents; those need the user's yes.
touches_agent_rules() { grep -qE '^(AGENTS\.md|CLAUDE\.md|docs/agents/|\.claude/|\.agents/)' <<<"$1"; }

# Retire one terminal: stop it, then remove it. Prints what happened.
retire_terminal() {
  hc kill "$1" >/dev/null 2>&1 || true
  if hc rm "$1" >/dev/null 2>&1; then echo "retired $1"; else warn "could not remove terminal $1; check with: hc get $1"; fi
}

# A lead is the hc terminal that runs these scripts. Its owner id is <address>@<since>, since being the
# terminal's creation time: hc keeps its address counter in its state folder, and a lost
# state folder starts the counter over, so an address alone could name a newer terminal.

since_of() { jq -r '.labels["vally.lead.since"] // (.created_ms | tostring)'; }

owner_of() {
  local info parent p
  info=$(cat)
  jq -re '.labels["vally.owner"] // empty' <<<"$info" && return
  parent=$(jq -r '.parent // empty' <<<"$info")
  [ -n "$parent" ] || return 0
  if p=$(hc get "$parent" --json 2>/dev/null) && [ "$(jq .created_ms <<<"$p")" -le "$(jq .created_ms <<<"$info")" ]; then
    echo "$parent@$(since_of <<<"$p")"
  else echo "$parent"; fi
}

lead_name() {
  local main
  main=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
  case $1 in "$main"|"$main"/*) echo main;; *) basename "$1";; esac
}

as_lead() {
  [ -n "${HC_TERMINAL_ID-}" ] || die "run from the lead's hc terminal (HC_TERMINAL_ID is unset)"
  local info name since
  info=$(terminal_json "$HC_TERMINAL_ID")
  since=$(since_of <<<"$info")
  name=$(lead_name "$(jq -r .cwd <<<"$info")")
  if [ "$(jq -r '.labels["vally.lead"] // ""' <<<"$info")" != "$name" ] || [ "$(jq -r '.labels["vally.lead.since"] // ""' <<<"$info")" != "$since" ]; then
    hc label "$HC_TERMINAL_ID" "vally.lead=$name" "vally.lead.since=$since" >/dev/null || die "could not label $HC_TERMINAL_ID as a lead"
  fi
  ME=$HC_TERMINAL_ID@$since MY_NAME=$name
}

load_live() { LIVE=$(hc ls --json | jq -r '.terminals[].address') || die "hc ls failed; is herdr-core running?"; }

lock_and_load_live() {
  mkdir -p "$VALLY_STATE/locks"
  exec {vally_lock}>>"$VALLY_STATE/locks/vally.lock"
  flock -x -w 120 "$vally_lock" || die "another vally script has held $VALLY_STATE/locks/vally.lock for 120 s; try again when it ends"
  load_live
}

release_lock() { exec {vally_lock}>&-; }

lead_alive() {
  [[ $1 == *@* ]] && grep -qxF "${1%%@*}" <<<"$LIVE" || return 1
  [ "$(hc get "${1%%@*}" --json 2>/dev/null | since_of)" = "${1#*@}" ]
}

owner_state() {
  if [ "$1" = "$ME" ]; then echo me
  elif lead_alive "$1"; then echo live
  else echo gone; fi
}

lead_label() {
  local addr=${1%%@*} info name
  [ -n "$1" ] || { echo "(기록 없음)"; return; }
  lead_alive "$1" && info=$(hc get "$addr" --json 2>/dev/null) || { echo "$addr"; return; }
  name=$(jq -r '.labels["vally.lead"] // empty' <<<"$info")
  [ -n "$name" ] || name=$(lead_name "$(jq -r .cwd <<<"$info")")
  [ "$addr" = "$HC_TERMINAL_ID" ] || [ "$name" != "${MY_NAME-}" ] || name="$name($addr)"
  echo "$name"
}

need_mine() {
  case $(owner_state "$1") in
    me) ;;
    live) die "$2 belongs to the live lead $(lead_label "$1"); leave it to that lead";;
    *) die "$2 has no live lead (주인 없음, was $(lead_label "$1")); only when the user says so: take.sh $3";;
  esac
}

worktree_locks() {
  git worktree list --porcelain | awk '
    /^worktree / { path = substr($0, 10) }
    /^locked vally owner / { n = split(substr($0, 20), f, " "); print path "\t" f[1] "\t" (f[2] == "issue" ? f[3] : "") }'
}

worktree_lock() {
  local p; p=$(realpath -m "$1")
  worktree_locks | while IFS=$'\t' read -r path owner issue; do [ "$(realpath -m "$path")" != "$p" ] || printf '%s\t%s\n' "$owner" "$issue"; done
}

worktree_owner() { worktree_lock "$1" | cut -f1; }

lock_worktree() { git worktree lock --reason "vally owner $ME${2:+ issue $2}" "$1"; }

has_issue() { [[ ",$1," == *",$2,"* ]]; }

lock_issue_too() {
  local worktree=$1 issue=$2 owner issues
  IFS=$'\t' read -r owner issues < <(worktree_lock "$worktree") || return 0
  [ "$owner" = "$ME" ] && ! has_issue "$issues" "$issue" || return 0
  git worktree unlock "$worktree" && lock_worktree "$worktree" "${issues:+$issues,}$issue"
}

remove_worktree() {
  [ "$(worktree_owner "$1")" != "$ME" ] || git worktree unlock "$1"
  git worktree remove "$1"
}

issue_terminals() {
  local a b
  a=$(terminals_with vally.issue="$1") && b=$(terminals_with vally.garden."$1"=1) || exit 1
  printf '%s\n' $a $b | sort -u
}

issue_holders() {
  local ts t info
  ts=$(issue_terminals "$1") || exit 1
  for t in $ts; do
    info=$(terminal_json "$t") || exit 1
    printf '%s\t%s\n' "$(jq -r --arg t "$t" '.name // $t' <<<"$info")" "$(owner_of <<<"$info")"
  done
  worktree_locks | awk -F'\t' -v i="$1" 'index("," $3 ",", "," i ",") { print $1 "\t" $2 }'
}

ISSUES_JQ='([.labels["vally.issue"] // empty] + [.labels | to_entries[] | select((.key | startswith("vally.garden.")) and .value == "1") | .key | ltrimstr("vally.garden.")])'

terminal_issues() { jq -r "$ISSUES_JQ | join(\",\")"; }

issue_group() {
  local -A seen=([$1]=1)
  local todo=("$1") i t ts info more j
  while [ ${#todo[@]} -gt 0 ]; do
    i=${todo[0]} todo=("${todo[@]:1}")
    more=$(worktree_locks | awk -F'\t' -v i="$i" 'index("," $3 ",", "," i ",") { print $3 }')
    ts=$(issue_terminals "$i") || exit 1
    for t in $ts; do info=$(terminal_json "$t") || exit 1; more+=,$(terminal_issues <<<"$info"); done
    for j in ${more//,/ }; do [ -n "${seen[$j]-}" ] || { seen[$j]=1; todo+=("$j"); }; done
  done
  printf '%s\n' "${!seen[@]}" | sort -n
}

issue_orphans() {
  local holders owner what lead='' live='' gone=''
  holders=$(issue_holders "$1") || exit 1
  while IFS=$'\t' read -r what owner; do
    [ -n "$what$owner" ] || continue
    case $(owner_state "$owner") in
      live) lead=$(lead_label "$owner"); live+=" $what";;
      gone) gone+=" $what";;
    esac
  done <<<"$holders"
  [ -z "$live" ] || die "issue #$1 belongs to the live lead $lead (holds:$live); leave it to that lead"
  echo "${gone# }"
}

orphans_note() { echo "issue #$1 has things without a live lead (주인 없음): $2. Ask the user; only on a yes: take.sh $1"; }

need_issue_open() {
  local gone
  gone=$(issue_orphans "$1") || exit 1
  [ -z "$gone" ] || die "$(orphans_note "$1" "$gone")"
}
