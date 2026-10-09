---
name: sflow-epic-review
description: Review hash-bound Story submissions across Epic repositories and record exact-SHA governance, configured repository-check, PR, and conformance evidence.
disable-model-invocation: true

---

# Review an Epic Story submission

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic review --epic <EPIC-KEY>` to show the cross-repository review inbox.
2. Open one exact packet with `singularity-flow epic review <STORY-KEY> --epic <EPIC-KEY>`.
3. Display the complete documents, source/spec hashes, Epic → REQ/AC → plan ID → Jira key → branch lineage, Git diff, approvals, self-approval warnings, models/tokens/cost, and conformance state.
4. Run `singularity-flow epic checks <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256>` only when the reviewer requests it.
5. Checks may read configured GitHub repository-check and PR state for the exact submitted SHA; they must not execute repository build or test code locally.
6. Do not approve automatically. When the reviewer decides, use `/sf-epic-review-decision` so the governed agent, rejection target, and exact packet confirmation are captured through a selection receipt. Approval authority still comes from the reviewer’s real Git/GitHub identity.
