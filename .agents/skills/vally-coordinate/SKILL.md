---
name: vally-coordinate
description: Coordinate Vally GitHub Feature/Ticket work, Orca assignments, task-specific evidence, independent review, and scoped PR readiness.
---

# Vally coordination

GitHub Issues own business scope, conditions, native relations, phase, and acknowledged decisions. GitHub PRs own current heads and merge metadata. Orca owns executions. Local files preserve immutable source snapshots, operation intents, receipts, and evidence, plus narrow launch reservations. There is no local business-state database.

AGENTS.md owns common policy, pstack owns engineering playbooks, and the installed version-matched Orca guide owns execution, communication, placement, and recovery. Keep this one explicit entry skill. `worker_done` ends an execution, not a Ticket or Feature.

## Select work from GitHub

1. Read AGENTS.md and the approved assignment. Before document work, read `docs/agents/document-policy.md`. Read the current Feature/Ticket through `gh` per `docs/agents/issue-tracker.md`.
2. Load the installed `orchestration` guide, select its executable, and set `ORCA_CLI_COMMAND`. Load placement guidance before creation and recovery guidance for any uncertain operation. Use one-shot reads and notifications, not mail-consuming loops.
3. Run `status --feature NUMBER` for native child Tickets, phases, blockers, and frontier. One coordinator may manage several independent Features. Feature bodies hold the overall goal and index, not a duplicate Ticket-status table. Native sub-issues/dependencies are authoritative. Assignees are advisory, not locks.
4. Read [the contract format](references/contracts.md). Executable Tickets have one canonical versioned JSON block containing their human-readable goal, observable conditions, verification/evidence plan, scope, constraints, and capabilities. If formatting is missing or malformed, ask the coordinator to fix the source. Never silently rewrite business scope to fit a parser.
5. Create only an execution request selecting source condition IDs, semantic revision, and a scoped runtime brief. Conditions and evidence tools come from this task. Fake Kiwoom, Playwright, HTTP, or SQLite product tests are examples, not a universal suite. Read-only smoke can explain why product checks are inapplicable; partial evidence does not pass an entire source condition.

Read [commands and recovery](references/operations.md) before dispatch or publication. Canonical skill source stays in Git; the coordinator handles global installation separately.

## Dispatch and inspect evidence

- `config.json` supplies external worker Sol/high and reviewer Astra/high defaults. Task-authorized `--config` overrides only that dispatch. Pstack's internal-role settings remain separate. Preserve requested config, Orca receipt values, and provider execution model or unknown; receipt equality is not provider-model verification.
- Preview, inspect the literal assembled brief and source identity/revision, then start with the same inputs and stable operation ID. The script injects role, selected source conditions, verification plan, capabilities, scope, and output requirements. Required skills name paths/revisions/dependencies; missing tools/access stay explicitly unavailable or unverified. Do not install tools/plugins or broaden account/data access implicitly.
- New local implementation/reviewer workspaces default to `new-child`. Run from the actual coordinator checkout. The CLI compares official cwd-derived current identity with explicit coordinator identity, launches from that same cwd, and reads back actual child parent ID/instance. This verifies Orca workspace placement, not an undocumented independent chat binding. Git base and UI parent are separate. Top-level requires an explicit independent-workspace request; remote child creation is unsupported.
- Existing worktrees retain their hierarchy. Review needs a clean separate worktree and exact full head. Dirty implementation handover needs authorized `--allow-dirty`. Setup defaults to `run`; use `--setup skip` for the coordinator-owned smoke here because registered setup copies credentials and fetches dependencies.
- Native helpers use the parent's native tool, scoped relevant instructions, and parent-only reports. Do not give them external Orca reporting protocols. They and independent reviewers keep repository documents read-only under project policy.
- After launching independent work, end the turn and wait for notifications. A failed start, unknown receipt, or wrong parent may leave a worker. Preserve receipts and follow installed recovery; never start another blindly or reclaim from time, missing inventory, or unverifiable liveness.

Worker and reviewer each return a human report plus compact structured result. Record it locally with `record --file`; this is a claim, not a verdict. Check actual Task/Dispatch, source revision, selected conditions, exact PR/head, report availability, capability observations, procedures, and reproduction evidence. Supplied snapshots carry source/scope/time/omissions and remain supplied evidence.

## Decide and publish

The coordinator inspects claims and publishes explicit condition-scoped acceptance using `record --publish`. Use stable operation IDs and actual source/user references. Publication records intent before mutation and acknowledges only matching remote content/state read-back. A comment acknowledgment and a phase/closure acknowledgment are different facts. An uncertain publication is reconciled by marker/ID, never re-POSTed blindly.

`ready --ticket NUMBER` reads current source, acknowledged decisions, and actual PR heads. Ticket/execution/PR relations are many-to-many; evaluate each subject/condition/head separately. Historical results remain historical. Old criteria or review heads do not pass current requirements. Independent review uses a distinct exact-head assignment; proven findings block until a fresh accepted review resolves them. Approved exclusions remain visibly unverified. Design/account approval never substitutes for applicable merge/closure approval.

Record only approvals actually given, with the original instruction and scope. Reuse valid session approval rather than asking again to fill a record. Role flags, author allowlists, issue comments, and topology metadata are not authorization capabilities. Helpers sharing account credentials cannot be cryptographically distinguished by this CLI. New policy, account access, or measurement methods need the applicable user approval.

A coordinator may explicitly publish a phase or Ticket-close decision after checking current complete Ticket conditions, delivery, review/final checks, findings, exclusions, and approval scope. A selected-condition execution cannot close the whole Ticket. Closing children never automatically closes the Feature; overall acceptance needs integration evidence. This CLI runs no merge and spawns no follow-on agents.

Report PR/head and source Issue IDs/revisions, verified behavior, unverified exclusions, actual skills/playbooks/skips, and next action. Coordinator-owned independent review, live pilot, final repository check, installation, and separate merge authorization remain explicit until completed. Preserve dirty worktrees, open PRs, unrelated metadata, and uncertain executions.
