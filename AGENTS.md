## Agent skills

### Roles

Every agent in this repository reads this file. Find your role from what your first prompt contains, checking in this order, and follow the rules for that role. In this file, "the worker" and "the coordinator" mean these roles.

1. **Subagent.** Another agent started you with its Agent tool. Do only the brief and return the result to that agent. Do not open PRs, send `worker_done`, or `ask` the coordinator. This holds even when the brief quotes a worker's Task or Dispatch IDs.
2. **Reviewer.** Your prompt has Orca `Task` and `Dispatch` IDs, and the spec gives you a review role. Do not change code. Run `pstack:interrogate` and report only findings a run proved.
3. **Worker.** Your prompt has Orca `Task` and `Dispatch` IDs and a `worker_done` template. Follow the Workflow section. Ask the coordinator with `ask`.
4. **Working with the user.** None of the above. Read "the coordinator" in this file as the user.

### Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Who changes which docs

Subagents and reviewers change no docs. The worker and the coordinator follow this table.

| Docs | Who changes them | When |
|---|---|---|
| `GLOSSARY.md`, `docs/adr/` | The coordinator | The user decides something, or the coordinator accepts a worker's proposal. The worker does not edit these. It writes proposals under "ADR·용어 제안" in the PR body. |
| `docs/design/backend.md`, `docs/design/frontend.md` | The worker | The implementation departs from the design. Fix the doc in the same PR as the code. |
| `docs/design/*-proposal.md` | The worker that wrote it | A research task before implementation. Afterwards only the coordinator edits its status line. |
| `docs/kiwoom.md`, `docs/kiwoom-ws-errors.md` | The worker that measured it | A live Kiwoom measurement shows a new fact. Write the date and what was measured. |
| `docs/verification/issue-<number>/` | The worker | A PR checked a real screen. Add files only. |
| `docs/research/<YYYY-MM-DD>-<topic>/` | The worker that did the research | A research task keeps its sources and raw data. |
| `docs/dev-environment.md` | The worker or the coordinator | A new trap on this PC is confirmed. |

Deleting, moving, or renaming a doc needs the user's approval through the coordinator. The worker proposes it in the PR body.

New folders:
- A subfolder that follows a pattern in the table, such as `docs/verification/issue-25/`, needs no approval. It follows the rules of its row.
- Any other new folder under `docs/` needs the user's approval through the coordinator. The worker does not create it. It proposes the folder under "문서 구조 제안" in the PR body: the name, what goes in it, and who changes it when. The folder lands only in the same PR that adds its row to this table.

### Workflow (poteto-mode)

The worker runs implementation, fix, and diagnosis work under `pstack:poteto-mode`.
- The worker picks the playbook from the task and names it in its first message. The spec may suggest one.
- The worker does every step of the chosen playbook, or records the step as `skip: <reason>`.
- The worker cites a principle only if it invoked that `pstack:principle-*` skill in this session.
- `worker_done` lists the skills the worker invoked, the playbooks it read, and each skipped step with its reason. The coordinator checks this list against the session log.

The worker owns a feature's design and its implementation. Per the Feature playbook, it runs `pstack:how` and `pstack:architect`, delegates code-writing to `pstack:poteto-agent` subagents, and reviews their diff. Every task in this repository permits `pstack:poteto-agent` subagents and the subagents that `pstack:architect` and `pstack:arena` start.

Architect's Agree checkpoint (phase C) is off by default. The coordinator's spec turns it on when the work has any of these:
- shared state, concurrent writers, or a state machine
- a policy the user has to decide
- a Kiwoom constraint that can lock or drop the account: the token, the WebSocket session, `[8050]`

The worker turns it on itself if `pstack:how` turns up one of these. At the checkpoint, the worker sends the sketch and its rationale to the coordinator with `ask` and waits for the reply before it writes the implementation.

Code review runs outside the worker. After the PR, the coordinator starts a Codex reviewer, then a new worker for the fix round with the Bug fix playbook. The worker records Feature step 7 as `skip: Codex review follows`.

### Kiwoom access (ADR 0004)

- One process holds the Kiwoom token at a time. Ask the coordinator before any live Kiwoom call.
- Call market-data APIs only. Never add `/api/dostk/ordr` or `/api/dostk/acnt`.
- Never print app keys, app secrets, or tokens to logs, docs, or chat.

### Public repository rules (ADR 0008)

This repository is public.
- **Never commit secrets**, and never write them into issues, PR bodies, or comments: `.env`, app keys, app secrets, tokens.
- Real Kiwoom response JSON, real numbers in docs, verification numbers, and screenshots are allowed. The account-level risk under Kiwoom's terms (Article 5③) was accepted knowingly (ADR 0008).

### Comments (poteto-mode)

Keep a comment only for a non-obvious constraint that comes from outside the code. Example: Kiwoom also sends `[8050]` with HTTP 403. Express everything the repository controls through names, types, tests, and structure, not comments. Before opening or updating a PR, run `pstack:no-comments` on the PR diff.

### Rust formatting

The Rust code is not in rustfmt style. Do not run `cargo fmt` in a feature or fix PR: it rewrites about 3,800 lines in the server crate and buries the diff. Follow the surrounding style by hand. Issue #17 applies `cargo fmt` once. After #17 merges, CI checks `cargo fmt --check`, so always format from then on.

### This PC's environment (docs/dev-environment.md)

AhnLab ASTx can drop connections, including loopback ones, while its session is active. Run local tests inside a network namespace: `unshare -Urn sh -c 'ip link set lo up && cargo test --offline'`. If Kiwoom returns `[8050]`, the public IP probably changed. Do not reissue tokens. Ask the user to register the new IP on the Kiwoom portal.
