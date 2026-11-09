---
name: vally-coordinate
description: Coordinate Orca implementation workers, independent reviews, fix rounds, and approved merges for Soochol/vallythevally.
---

# Vally Coordination

Coordinate implementation assignments, evidence checks, independent reviews, fixes, and approved merges. A worker's `worker_done` ends its assignment, not the overall task.

## Start

1. Read the repository's `AGENTS.md` and task spec. Reconcile work, approvals, and open questions with actual Git/PR state. Before making, approving, or assigning documentation changes, read `docs/agents/document-policy.md` at the repository root.
2. Use the installed `orchestration` skill's current guide for communication, recovery, and CLI selection. Set `ORCA_CLI_COMMAND` to that same executable.
3. Identify whether this continues an existing Run or starts new work, and pass `--run` explicitly. Do not bypass an unresolved execution with a new Task.

## Dispatch

- Specify the goal, rationale, edit scope, completion evidence, prohibited access, approval gates, and push/PR permissions. `scripts/dispatch.py` injects the role and model; `ROLES` is the source of model defaults. Apply user-requested model changes there.
- Use `worker` for implementation and fixes, and a different agent as `reviewer` for independent review. Assign review fixes to a fresh worker.
- A review spec names the PR, exact head, approved exclusions, reproduction criteria, and separate evidence path. Keep original code, docs, Git, and PR state read-only.
- Start subagents with the parent's creation tool. State their task role, scope, and parent-reporting relationship in the brief; do not copy the external Orca reporting protocol.

Run from the skill directory. `--coordinator` is the actual coordinator checkout. `preview` only reads Git; inspect it, then replace `preview` with `start` using the same arguments.

```bash
python3 scripts/dispatch.py preview --role reviewer --run RUN_ID \
  --coordinator /absolute/coordinator-checkout \
  --spec /absolute/review.md --title 'Independent PR review' \
  --worktree /absolute/worker-worktree --head FULL_HEAD_SHA
```

For new implementation work, use `--role worker` and `--new-worktree NAME --repo /absolute/repository --base origin/main`, omitting `--worktree` and `--head`. Orca creates the worktree. Check existing worktrees for competing assignments. Use `--allow-dirty` only for approved implementation handovers that preserve uncommitted work.

`start` creates a new Task; do not use it to retry, change models, or reassign the same Task. Follow Orca's recovery guide, preserving the Task ID and required user instructions. Preserve and investigate receipts for failed starts or response/model mismatches; do not rerun automatically. Record Task, Dispatch, worktree, and head after comparing the receipt with actual state.

After dispatching independent work, end the turn and continue on Orca notifications. Do not supervise by polling or typing into worker terminals.

## Handle notifications

| Notification | Action |
|---|---|
| `question` | Read the evidence and answer technical choices within existing approval. Ask the user about new policy, live-account access, or permissions; keep dependent work waiting for the answer. |
| Blocker, usage limit, or `stopReason` | Establish the remaining state and continue independent work. Follow Orca's recovery guide for stopping or replacing workers. Silence or `unverifiable` does not prove exit. |
| Implementation `worker_done` | Complete the evidence checks below and dispatch independent review when ready. |
| Review findings | Turn proven findings within the approved scope into a fix spec. After fixes, arrange the same reproductions and independent rereview of the changed head. |
| No review findings | Check the results, then proceed to the merge steps. |

## Check results

- Read reports and execution evidence. Compare local/PR heads, scope, worktree state, and completion criteria. Distinguish self-report, automated checks, and independent review; keep failures and unverified results explicit. For bug fixes, confirm the same reproduction fails before and passes after the fix.
- Compare reported skills, playbooks, and `skip` entries with the session record. On Codex, reading SKILL.md and applying its procedure counts as skill use; reading alone does not.
- Repeat full checks only for new changes, failures, evidence gaps, or the repository's required pre-merge check.

## Merge and finish

1. Confirm independent review passed for the current head and the worktree is clean. Design judgments and implementer tests do not replace independent review. Run the repository's coordinator final check and post its result on the PR.
2. Present the PR, changes, checks, and remaining limitations to the user and obtain approval to merge that PR. Reuse existing approval for the same scope; approval for another PR or PR creation does not cover merging.
3. Merge the approved head. If it changes, inspect the difference and refresh the necessary checks and review. Live-account access, Kiwoom connections, and measurements require separate approval.
4. After confirming the merge, follow approved cleanup rules and the Orca guide. Read existing cleanup scripts and preview their targets first. Preserve dirty worktrees, open PRs, active assignments, and unverified executions.
5. Report each PR's outcome and remaining verification. Do not mark the overall task complete while independent review or measurements remain.

Follow repository rules for permissions, secrets, Kiwoom access, and changes to measurement methods. This skill grants no additional authority; role wording and script checks are not security boundaries.
