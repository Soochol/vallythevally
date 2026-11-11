# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the "Label in our tracker" column to match whatever vocabulary you actually use.

## Other labels in this repo

These are not triage roles; skills and people use them as follows.

| Label | Meaning |
| ----- | ------- |
| `spec` | The source spec of one feature. Its work tickets are sub-issues of it (see [`AGENTS.md`](../../AGENTS.md#이슈와-새-기능)). |
| `bug` | Something that is broken in released behaviour. |
| `wayfinder:map` | A wayfinder map: the index of decisions for an effort that was still foggy. |
| `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task` | A decision ticket under a map, by how it gets resolved. |

