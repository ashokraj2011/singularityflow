---
name: sflow-epic-start
description: Start or resume a Jira-keyed Epic planning workspace with an explicitly selected immutable profile and an automatic phase agent.
disable-model-invocation: true

---

# Start an Epic workspace

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` steps, else `commandGuidance`, `nextAction`, `continuation.actions` or `recovery.actions`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition; run a returned action only when the person asks.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Require the Jira Epic key. Run `singularity-flow initiative choices begin start <EPIC-KEY> --json`.
2. Present exactly the returned `choiceSets` (profiles) with Copilot's selectable question UI; the phase agent is selected automatically. Do not infer an answer.
3. Record each answer with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
4. When the receipt is ready, run `singularity-flow epic start <EPIC-KEY> --selection-receipt <TOKEN>`.
5. Offer only the profiles the receipt returns; never preselect one.
6. Show the created branch, pinned profile, source Jira identity, commit/push result, complete phase flow, and first deterministic next action.
7. Do not create branches manually or approve any phase.
