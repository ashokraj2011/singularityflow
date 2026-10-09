---
name: sflow-epic-drift
description: Observe Jira drift for an Epic and explicitly adopt Jira observations or prepare a reviewed restore plan without automatic two-way overwrite.
disable-model-invocation: true

---

# Manage Epic Jira drift

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Use one requested action:

- Observe: `singularity-flow epic drift observe --epic <EPIC-KEY> --json`.
- Adopt the recorded observation into a new governed Git generation: `singularity-flow epic drift adopt --epic <EPIC-KEY> --observation <SHA-256> --json`.
- Prepare a reviewed plan that restores Git-owned fields: `singularity-flow epic drift restore-plan --epic <EPIC-KEY> --json`.

Show changed fields and hashes before any mutation. Never silently copy Jira into Git or Git into Jira.
