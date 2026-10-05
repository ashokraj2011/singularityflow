---
name: sflow-assign
description: Assign a governed workflow phase to a named contributor through the deterministic assignment command.
disable-model-invocation: true
argument-hint: "<phase> <assignee>"
---
# Assign a workflow phase

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Require an explicit phase and assignee; never infer either from chat identity or the active agent.
2. Inspect current status and authority with `singularity-flow status --json` before changing the assignment.
3. Run `singularity-flow assign <PHASE> <ASSIGNEE>` with the exact values supplied.
4. Report the durable assignment result and next action. Assignment coordinates work; it never grants approval authority or changes the governed phase agent.

