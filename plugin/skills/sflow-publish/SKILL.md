---
name: sflow-publish
description: Publish the current phase's existing authored draft after a fresh governed readiness check. Does not draft, submit, or approve.
disable-model-invocation: true
argument-hint: "[phase]"
---

# Publish an existing phase draft

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Bind the optional phase to the active phase in this entry; mismatch: stop with the returned selection route. Publication-only: never edit source/artifacts, compose, prepare, begin a generation, record clarification, submit, approve or change policy.
2. Run `singularity-flow phase prepublish <phase> --for-agent --json` once. Use native file-read tools for captured output, not shell parsers, pipes or command chains. Preserve the existing draft. Unless `status: ready` and `commands.publish` is present, relay exact blockers and author/repair actions, then stop. No re-asking settled clarification or retrying unchanged failures.
3. Run returned `commands.publish` once, with its pinned producer/channel; do not invent authorship flags, waive gates or run separate tests. `advisories` never block this attempt; report any `requiredBefore: approve` warning as a later obligation, not a current owner hold. Do not edit documentation or package scripts in this publication-only skill. Publication owns any configured fresh test execution. Already-published/no-op results do not authorize a successor or resubmission.
4. Show publication generation/commit/push and warnings truthfully. If requested to view documents, use the returned document route; publication is not approval. End with exact returned next actions in Copilot, Shell and model-free order. Never advance to the next phase in this turn.
