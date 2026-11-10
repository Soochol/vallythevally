# Shared settings for the vally skill scripts. Source it; do not run it.
set -euo pipefail

VALLY_WORKTREES=${VALLY_WORKTREES:-$HOME/.vally/worktrees/vallythevally}
VALLY_STATE=${VALLY_STATE:-$HOME/.vally/state/vallythevally}
VALLY_REPORTS=$VALLY_STATE/reports
VALLY_TEMPLATES=${VALLY_TEMPLATES:-$HOME/.config/herdr-core/templates}
VALLY_ROLES="worker reviewer gardener"
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
