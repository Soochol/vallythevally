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
- **Recommended**: avoid committing whole raw Kiwoom response JSON. Build new test fixtures from synthetic data that keeps the real response shape. Kiwoom's terms (Article 5③) forbid providing quotes to third parties.
- A few example numbers, verification numbers, and screenshots are allowed.
