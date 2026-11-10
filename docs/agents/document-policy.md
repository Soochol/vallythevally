# Who changes which docs

State each agent's role explicitly in its task brief.

Subagents created to assist a parent agent and independent reviewers do not edit repository documents. Implementation agents follow the Worker permissions in the table below. The coordinator, who assigns work and handles its results, follows the Coordinator permissions.

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
