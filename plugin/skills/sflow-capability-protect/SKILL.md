---
name: sflow-capability-protect
description: Propose one path protection and its approval obligation atomically.
disable-model-invocation: true
argument-hint: "<PATH> --approver <GROUP>"
---
# Protect a capability path

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require one repository-relative path. Run `singularity-flow capability show <PATH> --json`.
2. Require an explicit approval group when the CLI cannot resolve exactly one.
3. After confirmation, run once:
   `singularity-flow capability protect <PATH> --approver <GROUP> [--reason <TEXT>] --json`.
4. Relay the exact review branch, commit, and receipt. Stop; never split the path rule from its approval, activate the proposal, or edit YAML.
