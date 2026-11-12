---
name: sflow-epic-review-decision
description: Approve or reject one finalized Epic Story against its exact review packet using Copilot choice receipts and auditable Git publication.
disable-model-invocation: true
agent: agent
argument-hint: "<EPIC-KEY> <STORY-KEY> <approve|reject> <PACKET-SHA256>"

---

# Decide an exact Story packet

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Require Epic key, Story key, decision (`approve` or `reject`), and the exact full packet SHA-256 previously displayed by `/sf-epic-review`.
2. Run `singularity-flow epic review-choice begin <DECISION> <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --json`.
3. Ask the user to select exactly the returned `choiceSets` (rejection target when rejecting, exact packet confirmation). Show reviewer authority from `singularity-flow epic review <STORY-KEY> --epic <EPIC-KEY> --json` `approval.reviewerAuthority` as information only.
4. Record each answer with `singularity-flow epic review-choice answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
5. For rejection, require a meaningful reason.
6. Execute:
   - approve: `singularity-flow epic review approve <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --selection-receipt <TOKEN>`;
   - reject: `singularity-flow epic review reject <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --selection-receipt <TOKEN> --reason "<REASON>"`.
7. Show the Story commit, Epic aggregation commit, push results, and self-approval warning.

Approve only when that review's `approval.evidence.ready` and `approval.reviewerAuthority.authorized` are true. Evidence not ready: offer `singularity-flow epic checks <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256>`. Reviewer not authorized: show `approval.reviewerAuthority.reason` and stop for an authorized reviewer; checks never change authority. Never infer a governed agent, target, packet, or confirmation.
