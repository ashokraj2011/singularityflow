---
name: sflow-epic-sync
description: Synchronize an Epic lead branch and its registered Story repositories, then report exact repository and publication receipts.
disable-model-invocation: true

---

# Synchronize an Epic

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Resolve the Epic key from the argument or current branch.
2. Run `singularity-flow epic sync <EPIC-KEY> --json`.
3. Report every fetched repository, branch, commit, stale context, and pending publication.
4. If synchronization cannot fast-forward, stop and show the conflicting repository; never force-push.
5. End with `/sf-epic-next <EPIC-KEY>`.
