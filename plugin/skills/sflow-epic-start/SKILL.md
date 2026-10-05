---
name: sflow-epic-start
description: Start or resume a Jira-keyed Epic planning workspace with an explicitly selected immutable profile and an automatic phase agent.
disable-model-invocation: true

---

# Start an Epic workspace

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require the Jira Epic key. Run `singularity-flow initiative choices begin start <EPIC-KEY> --json`.
2. Present every profile and governed-agent option with Copilot's selectable question UI. Do not infer an answer.
3. Record each answer with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
4. When the receipt is ready, run `singularity-flow epic start <EPIC-KEY> --selection-receipt <TOKEN>`.
5. The default profile is `epic-planning`; a user may select a configured full-delivery profile instead.
6. Show the created branch, pinned profile, source Jira identity, commit/push result, complete phase flow, and first deterministic next action.
7. Do not create branches manually or approve any phase.
