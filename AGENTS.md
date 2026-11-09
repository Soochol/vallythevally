## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Public repository rules (ADR 0008)

This repository is public. Never commit, or write into issues, PR bodies, or comments, **real market data received from Kiwoom**: real response JSON, real prices, volumes, or turnover, or screenshots showing real quotes. Kiwoom's terms (Article 5③) forbid providing quotes to third parties.
- Test fixtures use synthetic data that keeps the real response shape.
- Measurement docs keep structure, units, rules, and counts, and use example values instead of real prices.
- Screenshots come from the fake API.
- Live Kiwoom verification stays local. Report it as "확인함" without numbers.
- Never commit third-party raw data (Yahoo, FRED, BOK, NAVER).
- Never print or commit secrets (`.env`, tokens).
