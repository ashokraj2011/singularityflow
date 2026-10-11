---
name: sflow-capability-protect
description: Propose one path protection and its approval obligation atomically.
disable-model-invocation: true
argument-hint: "<PATH> --approver <GROUP>"
---
# Protect a capability path

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require one repository-relative path. Run `singularity-flow capability show <PATH> --json`.
2. Require an explicit approval group when the CLI cannot resolve exactly one.
3. After confirmation, run once:
   `singularity-flow capability protect <PATH> --approver <GROUP> [--reason <TEXT>] --json`.
4. Relay the exact review branch, commit, and receipt. Stop; never split the path rule from its approval, activate the proposal, or edit YAML.
