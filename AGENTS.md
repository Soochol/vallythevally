## Roles

"The coordinator" in this file and in `docs/agents/` is the vally lead: the one agent the user talks to (`.claude/skills/vally`). It starts workers and reviewers, answers their `ask`, and merges. Workers and reviewers reach it through hc.

## Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

## Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

## Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Document policy

Before editing documents, proposing document changes, or assigning document work, read [docs/agents/document-policy.md](docs/agents/document-policy.md) for ownership, approval, and folder rules.

## Kiwoom access (ADR 0004)

- One process holds the Kiwoom token at a time. Ask the coordinator before any live Kiwoom call.
- Approval covers the stated measurement method. Before changing that method, ask the coordinator again and wait for approval before making the live call.
- Call market-data APIs only. Never add `/api/dostk/ordr` or `/api/dostk/acnt`.
- Never print app keys, app secrets, or tokens to logs, docs, or chat.

## The user's server

The user's own server runs from the main checkout in the hc terminal `vally-server` on 127.0.0.1:8080, uses `data/vally.db` there, and holds the Kiwoom token. Do not stop, restart, or write to it or its DB. Start your own instances with temporary data dirs instead: `verify-app` or the e2e harness.

## Verifying in the real app

When a change alters what a user sees or does in the app, prove it in the real app with `.claude/skills/verify-app` (fake Kiwoom, no network) and put the evidence path in your report. When the PR checked a real screen, copy the screenshots that prove it into `docs/verification/issue-<n>/`.

## Public repository rules (ADR 0008)

This repository is public.
- **Never commit secrets**, and never write them into issues, PR bodies, or comments: `.env`, app keys, app secrets, tokens.
- Real Kiwoom response JSON, real numbers in docs, verification numbers, and screenshots are allowed. The account-level risk under Kiwoom's terms (Article 5③) was accepted knowingly (ADR 0008).

## Rust formatting

The Rust code is not in rustfmt style. Do not run `cargo fmt` in a feature or fix PR: it rewrites about 3,800 lines in the server crate and buries the diff. Follow the surrounding style by hand. Issue #17 applies `cargo fmt` once. After #17 merges, CI checks `cargo fmt --check`, so always format from then on.

## This PC's environment (docs/dev-environment.md)

If Kiwoom returns `[8050]`, the public IP probably changed. Do not reissue tokens. Ask the user to register the new IP on the Kiwoom portal.
