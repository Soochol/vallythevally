# Commands and recovery

Run from the actual coordinator checkout with the canonical script path and guide-selected `ORCA_CLI_COMMAND`. The public commands are `status`, `dispatch`, `record`, and `ready`. `dispatch.py preview/start` remains the dispatch entry for existing callers, with the current source-derived execution request and operation arguments.

```bash
python3 .agents/skills/vally-coordinate/scripts/coordinate.py status --feature 55
python3 .agents/skills/vally-coordinate/scripts/coordinate.py status --ticket 56
python3 .agents/skills/vally-coordinate/scripts/coordinate.py dispatch preview \
  --operation inventory-unique --run run_ACTUAL --role worker \
  --coordinator /runtime/coordinator --spec /runtime/execution.json \
  --title 'Read-only inventory' --new-worktree inventory --base FULL_BASE_SHA --setup skip
```

Inspect the literal preview, then replace preview with start using the same inputs. A child launch omits Orca's `--repo`. The CLI compares official cwd-derived `worktree current` with explicit coordinator path/ID/instance/repository and matches the registered Git common directory. It launches without changing cwd, then reads actual parent ID/instance. Base ref and UI parent are independent. A mismatch can leave a worker and is never retried automatically.

Existing clean review uses `--role reviewer --worktree /runtime/reviewer --head FULL_HEAD_SHA`. New child review uses `--role reviewer --new-worktree review --base FULL_HEAD_SHA --head FULL_HEAD_SHA`. Setup defaults to run; this task's coordinator-owned smoke requires skip. Top-level needs an explicit request and `--placement top-level`. This CLI supports local placement only; consult installed Orca guidance for other authorized placement.

```bash
python3 .agents/skills/vally-coordinate/scripts/coordinate.py record --file /runtime/result.json
python3 .agents/skills/vally-coordinate/scripts/coordinate.py record --publish --operation accept-unique --file /runtime/decision.json
python3 .agents/skills/vally-coordinate/scripts/coordinate.py record --reconcile --operation accept-unique --file /runtime/decision.json
python3 .agents/skills/vally-coordinate/scripts/coordinate.py ready --ticket 56
```

All commands accept `--state-dir /runtime/isolated-evidence`. Default output is `$XDG_STATE_HOME/vallythevally/orchestration`, or `~/.local/state/vallythevally/orchestration`. Cooperating dispatchers use the same local directory. Different roots, other hosts, and bypassing clients are outside the reservation guarantee. No SQLite, mutable task ledger, scheduler, provider runner, automatic follow-on assignment, or merge command is provided.

Local operation directories contain fresh immutable intent/request/receipt/acknowledgment files. Files and relevant directory entries are fsynced. Partial writes fail closed. Stable IDs reject conflicting reuse. Launch reservations serialize cooperating repository starts while a new checkout path is unknown; canonical checkout ownership is established before releasing launch/name protection. A crash may leave both protections and requires exact recovery evidence. No atomic transaction spans files, GitHub, and Orca.

Read-only preflight rejection proves worker-start was not invoked and can release only its own reservation. Once a start may have occurred, preserve request/output/uncertain evidence and load the installed Orca recovery guide. A `record --recover-launch --operation ID --file recovery.json` uses proof never_started/exited, runtime_evidence, and exact dispatch for a known launch. It records an attributed recovery assertion; it cannot prove liveness itself. Never release from time, missing inventory, or unverifiable liveness.

Publication first persists intent, checks current source and relevant state, then requests a marker-bearing comment. It verifies remote ID/body/author before comment acknowledgment. An optional phase/close effect has a separate request and actual state read-back. Phase changes add/delete only the coordination labels; body, assignees, and unrelated labels are preserved. Concurrent edits and partial phase updates fail explicitly. Remote read-check-write has a race window and is not a global lock.

If the remote request succeeded but its response/local ack was lost, use reconcile with the same ID/payload. It searches all necessary comment pages and verifies the exact marker/hash/known content; it never posts again. Missing/conflicting/duplicate markers or incomplete phase/state effects remain unresolved. A comment alone does not prove a phase change or closure. Coordinator inspection is required before a new explicitly authorized operation.

`ready` reports condition/PR-head gates, missing whole-Ticket conditions, findings, exclusions, current runtime observations, and next action. Exit zero means the query succeeded, not permission to merge or close. No-PR evidence remains delivery-unverified unless the canonical Ticket explicitly declares no repository change. That task-specific choice still requires review, final check, and user closure approval. Selected-condition success does not imply whole-Ticket completion. Feature closure always needs separate overall/integration acceptance.

Verify changes with the external-boundary Python suite, skill-creator quick_validate, and relative resource checks. Native relation and comment pages must be completely read or fail. Fake tests are not live placement proof. Prepare a source-derived read-only new-child spec with setup skip and isolated evidence for one coordinator-owned roundtrip/pilot. Keep the original repository pre-push hook, default offline.sh, fake product config, and Chromium sandbox; do not install home skills or bypass unavailable capabilities.

```bash
python3 -m unittest discover -s .agents/skills/vally-coordinate/scripts -p 'test_*.py' -v
```
