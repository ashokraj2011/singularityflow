---
name: sflow-epic-review
description: Review hash-bound Story submissions across Epic repositories and record exact-SHA governance, configured repository-check, PR, and conformance evidence.
disable-model-invocation: true

---

# Review an Epic Story submission

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow epic review --epic <EPIC-KEY>` to show the cross-repository review inbox.
2. Open one exact packet with `singularity-flow epic review <STORY-KEY> --epic <EPIC-KEY>`.
3. Display the complete documents, source/spec hashes, Epic → REQ/AC → plan ID → Jira key → branch lineage, Git diff, approvals, self-approval warnings, models/tokens/cost, and conformance state.
4. Run `singularity-flow epic checks <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256>` only when the reviewer requests it.
5. Checks may read configured GitHub repository-check and PR state for the exact submitted SHA; they must not execute repository build or test code locally.
6. Do not approve automatically. When the reviewer decides, use `/sf-epic-review-decision` so the governed agent, rejection target, and exact packet confirmation are captured through a selection receipt. Approval authority still comes from the reviewer’s real Git/GitHub identity.
