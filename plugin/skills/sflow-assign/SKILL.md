---
name: sflow-assign
description: Assign a governed workflow phase to a named contributor through the deterministic assignment command.
disable-model-invocation: true
argument-hint: "<phase> <assignee>"
---
# Assign a workflow phase

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Require an explicit phase and assignee; never infer either from chat identity or the active agent.
2. Inspect current status and authority with `singularity-flow status --json` before changing the assignment.
3. Run `singularity-flow assign <PHASE> <ASSIGNEE>` with the exact values supplied.
4. Report the durable assignment result and next action. Assignment coordinates work; it never grants approval authority or changes the governed phase agent.

