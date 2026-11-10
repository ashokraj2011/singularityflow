---
name: sflow-epic-review
description: Review hash-bound Story submissions across Epic repositories and record exact-SHA governance, configured repository-check, PR, and conformance evidence.
disable-model-invocation: true
agent: agent

---

# Review an Epic Story submission

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Say up front: Epic checks, approval and completion currently need a GitHub remote with an authenticated `gh`. On another Git host, relay their refusal as an unsupported-provider limitation; never retry it.

1. Run `singularity-flow epic review --epic <EPIC-KEY>` to show the cross-repository review inbox.
2. Open one exact packet with `singularity-flow epic review <STORY-KEY> --epic <EPIC-KEY>`.
3. Link each document and the Git diff as verified previews and list touched paths with added/deleted line counts; never paste document bodies or the diff. Show source/spec hashes, Epic → REQ/AC → plan ID → Jira key → branch lineage, approvals, self-approval warnings, models/tokens/cost, and conformance state.
4. Run `singularity-flow epic checks <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256>` only when the reviewer requests it.
5. Checks may read configured GitHub repository-check and PR state for the exact submitted SHA; they must not execute repository build or test code locally.
6. Do not approve automatically. When the reviewer decides, use `/sf-epic-review-decision` so the governed agent, rejection target, and exact packet confirmation are captured through a selection receipt. Approval authority comes from the reviewer's configured local Git identity and approval groups (configured-local, not cryptographic).
