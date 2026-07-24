---
name: sflow-epic-review
description: Review hash-bound Story submissions across Epic repositories and record exact-SHA governance, GitHub Actions, PR, and conformance evidence.
---

# Review an Epic Story submission

1. Run `singularity-flow epic review --epic <EPIC-KEY>` to show the cross-repository review inbox.
2. Open one exact packet with `singularity-flow epic review <STORY-KEY> --epic <EPIC-KEY>`.
3. Display the complete documents, source/spec hashes, Epic → REQ/AC → plan ID → Jira key → branch lineage, Git diff, approvals, self-approval warnings, models/tokens/cost, and conformance state.
4. Run `singularity-flow epic checks <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256>` only when the reviewer requests it.
5. Checks may read GitHub Actions and PR state for the exact submitted SHA; they must not execute repository build or test code locally.
6. Do not approve automatically. A later approval or rejection must remain bound to the displayed packet hash.
