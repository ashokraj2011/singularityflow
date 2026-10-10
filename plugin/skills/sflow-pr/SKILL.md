---
name: sflow-pr
description: Preview deterministic pull-request text or explicitly create and update the governed Story pull request.
disable-model-invocation: true
argument-hint: "[WORK-ID] [describe|create]"
---
# Prepare or publish a pull request

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Inspect Story status, finalization, remote branch, and pending publication before any PR operation.
2. Use `singularity-flow pr describe <WORK-ID> --format markdown` for deterministic local text.
3. Before a network write, show the exact head, base, title, body, and existing-PR state. Require explicit confirmation, then run `singularity-flow pr <WORK-ID> --create` or `singularity-flow pr describe <WORK-ID> --write --yes` as selected.
4. Report the PR URL and exact head commit. Never merge, force-push, or change the selected base branch. Use `/sf-stack` for Epic dependency order.
