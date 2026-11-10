# Source and evidence contracts

An executable `coord:ticket` Issue has exactly one block. The coordinator owns source changes. Narrative outside the block is context; there is no independently editable local acceptance spec.

````markdown
<!-- vally-ticket:v1 -->
```json
{
  "version": 1,
  "goal": "Correct the arithmetic in the scratch note",
  "acceptance_conditions": [{"id": "C1", "outcome": "The note's total agrees with its two stated quantities"}],
  "scope": "scratch note only",
  "constraints": ["Preserve repository and external applications"],
  "verification_plan": [{"condition": "C1", "method": "Recalculate the stated total and compare the corrected note", "evidence": "report.md"}],
  "evidence_outputs": ["corrected-note.md", "report.md", "result.json"],
  "delivery": {"kind": "no_repository_change", "reason": "Scratch-only note correction"},
  "capabilities": {"skills": [], "tools": ["python3"], "account_data_scope": ["assigned scratch files only"]}
}
```
<!-- /vally-ticket -->
````

Each condition has a unique ID and observable outcome; every condition has a verification method and planned evidence. Skill capabilities have `path`, `revision`, and `dependencies`. Tools and authorized account/data scope are string lists. Optional `supplied_evidence` entries carry `source`, `scope`, `time`, `omissions`, and `path`. Optional `product_checks_inapplicable` explains a task-specific omission. A scratch/read-only Ticket may declare `delivery: {"kind":"no_repository_change","reason":"task-specific reason"}` in its source; the default requires a PR. No-PR delivery still requires independent evidence, final check, and scoped user closure approval. Capability observations do not expand authorization.

The semantic revision is SHA-256 of JSON serialized with `ensure_ascii=False, sort_keys=True, separators=(',', ':')`. Comment timestamps and unrelated issue prose do not change it. Source identity includes repository, number, database ID, node ID, and revision. Native parent, blockers, state and phase are separately observed and rechecked before effects. Missing native capability fails explicitly.

Execution request JSON contains only these fields. `brief` resolves relative to this file or is absolute at runtime. It scopes execution and preserves literal Markdown; it cannot replace source conditions.

```json
{"ticket": 56, "conditions": ["C3"], "revision": "ACTUAL_SEMANTIC_SHA256", "brief": "smoke.md"}
```

A compact result has `kind: result`, stable `id: result:<actual Dispatch ID>`, exact `source`, `role`, `assignment`, `subjects`, `report`, `capability_observations`, `procedure`, `provider_execution`, and `provenance`. Use the `assignment` request/launch from the actual local `launched.json`, plus its operation ID and intent `issued_at`. The coordinator can supply this immutable receipt to the worker; label it supplied evidence. Never invent runtime identities. Exactly one immutable result belongs to an execution. Ingestion validates its actual receipt, publication matches the recorded claim, and remote conflicting reuse is refused.

```json
{
  "kind": "result",
  "id": "result:ACTUAL_DISPATCH",
  "source": {"repository": "Soochol/vallythevally", "number": 56, "id": 6299411664, "node_id": "ACTUAL_NODE_ID", "revision": "ACTUAL_SEMANTIC_SHA256"},
  "role": "worker",
  "assignment": {"operation": "ACTUAL_OPERATION", "issued_at": "ACTUAL_INTENT_TIME", "requested": {}, "launch": {}},
  "subjects": [{"pr": null, "head": "FULL_RESULT_HEAD", "conditions": {"C3": {"outcome": "unverified", "evidence": "local placement-report.md; available on execution host only"}}, "findings": [], "resolves": []}],
  "report": "local report.md; available on execution host only",
  "capability_observations": {"tool:python3": {"status": "available", "evidence": "interpreter observation"}},
  "procedure": {"skills": [], "playbooks": [], "skips": ["partial read-only smoke"]},
  "provider_execution": {"model": null, "source": null},
  "provenance": {"class": "worker_claim", "ref": "actual completion", "time": "actual observation time", "scope": "selected conditions", "omissions": "full source condition not verified"}
}
```

Fill `requested`/`launch` from receipts, not the empty illustrative objects. Report each selected condition across one or more PR/head subjects; use `pr: null` before a PR exists. Outcomes are `passed`, `failed`, or `unverified`, each with evidence and its availability. Capability keys exactly match `skill:<path>`, `tool:<name>`, and `scope:<account_data_scope entry>` from the source manifest; status is available/unavailable/unverified. List actual skills/playbooks/skips. Provider execution stays null without provider evidence; an Orca launch receipt is not provider verification.

Review uses `role: reviewer` and provenance class `reviewer_claim`. Its exact assigned head must match each subject and its Task/Dispatch must differ from implementation. A proven finding has `id`, `condition`, `summary`, and `reproduction`. A fresh review names prior IDs in `resolves` only after reproducing the correction. A finding cannot both appear and resolve in one result. Old-head/earlier-execution evidence cannot clear current findings.

Accepted reviews fold by validated timezone-aware assignment `issued_at`, normalized to UTC, independently of comment arrival. This is local coordinator assignment-time ordering, not a distributed clock or causality guarantee. Findings retain their origin execution and time and are scoped by PR, condition, and finding ID. Only a strictly later accepted review at the current source and subject head can resolve an older finding in its accepted subject conditions. Equal-time reviews cannot resolve each other. Newer findings and other PR or condition scopes remain independent.

Coordinator decisions have exact `source`, `summary`, `provenance`, optional `effect`, and these fields:

| Kind | Required content |
|---|---|
| `accept` | `claim` containing the exact result, `claim_hash` from canonical JSON, and explicit accepted `conditions`. Acceptance never manufactures independent evidence. |
| `final_check` | `subjects` with PR/head/condition lists, `outcome` passed/failed/unverified, and `report`. Perform after applicable acceptance. |
| `approval` | `approval_kind` merge/close/design/account, `decision` approved/revoked, exact `subjects`. Original user instruction is the source, not a self-authored approval comment. |
| `exclusion` | approved/revoked `decision`, `reason`, exact `subjects`; remains unverified. |
| `phase` | Explicit `effect: {"action":"phase","phase":"coord:working"}` or another supported phase. |
| `close` | Explicit `effect: {"action":"close"}`; whole-Ticket readiness is checked before closure. |

Decision `subjects` have `pr`, full `head`, and nonempty `conditions` ID list. Provenance has `class`, `ref`, `time`, `scope`, and `omissions`. Approval/exclusion uses class `user_instruction`; other decisions use `coordinator_verdict`. The default effect is comment-only. Publication is an explicit coordinator action; local flags and these records grant no authority.

Acceptance validates the entire immutable claim. Current remote-head checks apply only to subjects intersecting the explicitly accepted conditions. Other subjects remain historical and unaccepted. Final checks compose by PR, head, and condition. Each condition requires its latest verdict to pass after its applicable worker and reviewer acceptances. A later failed or unverified verdict, or reacceptance of that scope, invalidates its prior final pass. Unrelated condition checks and acceptances leave it intact.

Canonical remote comments have a stable operation marker and exact payload hash. The reader rejects malformed, duplicate, conflicting, and non-allowlisted-author markers. The repository config names permitted author database IDs; shared credentials remain indistinguishable. Raw logs stay local with honest availability, while compact decisions and reproducible summaries may be public.
