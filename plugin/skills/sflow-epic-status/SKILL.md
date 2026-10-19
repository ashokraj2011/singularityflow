---
name: sflow-epic-status
description: Show Epic planning phase progress and read-only delivery aggregation across Jira Stories, repositories, branches, checks, conformance, duration, model, tokens, and cost.
disable-model-invocation: true

---

# Show Epic status

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` steps, else `commandGuidance`, `nextAction`, `continuation.actions` or `recovery.actions`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition; run a returned action only when the person asks.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow epic status [EPIC-KEY] --json`.
2. Run `singularity-flow epic report [EPIC-KEY] --format json`.
3. Show the four planning phases or selected full-delivery profile as an arrow flow.
4. For every Story show plan ID, Jira key, repository, canonical/child branch, Jira observation, workflow percentage, submission, required checks, conformance, blockers, duration, model, tokens, and cost availability.
5. Label Jira drift, stale sources/specifications, configured-local Git identity assurance, and self-approval honestly.
6. End with `singularity-flow epic next [EPIC-KEY] --for-agent --json`. Do not mutate lifecycle state.
