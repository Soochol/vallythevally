## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Public repository rules (ADR 0008)

This repository is public.
- **Never commit secrets**, and never write them into issues, PR bodies, or comments: `.env`, app keys, app secrets, tokens.
- Real Kiwoom response JSON, real numbers in docs, verification numbers, and screenshots are allowed. The account-level risk under Kiwoom's terms (Article 5③) was accepted knowingly (ADR 0008).

### Comments (poteto-mode)

Keep a comment only for a non-obvious constraint that comes from outside the code. Example: Kiwoom also sends `[8050]` with HTTP 403. Express everything the repository controls through names, types, tests, and structure, not comments. Before opening or updating a PR, run `pstack:no-comments` on the PR diff.
