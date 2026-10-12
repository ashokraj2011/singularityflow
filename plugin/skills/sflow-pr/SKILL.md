---
name: sflow-pr
description: Preview deterministic pull-request text or explicitly create and update the governed Story pull request.
disable-model-invocation: true
argument-hint: "[WORK-ID] [describe|create]"
---
# Prepare or publish a pull request

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Inspect Story status, finalization, remote branch, and pending publication before any PR operation.
2. Use `singularity-flow pr describe <WORK-ID> --format markdown` for deterministic local text.
3. Before a network write, show the exact head, base, title, body, and existing-PR state. Require explicit confirmation, then run `singularity-flow pr <WORK-ID> --create` or `singularity-flow pr describe <WORK-ID> --write --yes` as selected.
4. Report the PR URL and exact head commit. Never merge, force-push, or change the selected base branch. Use `/sf-stack` for Epic dependency order.
