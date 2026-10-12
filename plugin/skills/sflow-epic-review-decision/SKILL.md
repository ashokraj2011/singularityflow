---
name: sflow-epic-review-decision
description: Approve or reject one finalized Epic Story against its exact review-packet hash using Copilot choice receipts and auditable Git publication.
disable-model-invocation: true
argument-hint: "<EPIC-KEY> <STORY-KEY> <approve|reject> <PACKET-SHA256>"

---

# Decide an exact Story packet

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require Epic key, Story key, decision (`approve` or `reject`), and the exact full packet SHA-256 previously displayed by `/sf-epic-review`.
2. Run `singularity-flow epic review-choice begin <DECISION> <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --json`.
3. Ask the user to select exactly the returned `choiceSets` (rejection target when rejecting, exact packet confirmation). Show reviewer authority from `singularity-flow epic review <STORY-KEY> --epic <EPIC-KEY> --json` `approval.reviewerAuthority` as information only.
4. Record each answer with `singularity-flow epic review-choice answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
5. For rejection, require a meaningful reason.
6. Execute:
   - approve: `singularity-flow epic review approve <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --selection-receipt <TOKEN>`;
   - reject: `singularity-flow epic review reject <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --selection-receipt <TOKEN> --reason "<REASON>"`.
7. Show the Story commit, Epic aggregation commit, push results, and self-approval warning.

Approve only when that review's `approval.evidence.ready` and `approval.reviewerAuthority.authorized` are true; otherwise offer `singularity-flow epic checks`. Never infer a governed agent, target, packet, or confirmation.
