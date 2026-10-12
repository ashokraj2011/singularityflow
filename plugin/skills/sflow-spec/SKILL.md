---
name: sflow-spec
description: Inspect and maintain specification indexes, claims, coverage, acceptance evidence, and traceability.
disable-model-invocation: true
argument-hint: "analyze|claims|coverage|acceptance|tasks|trace"
---
# Work with specification traceability

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Inspect the active work item and approved specification before selecting a subcommand.
2. Use read-only `singularity-flow spec analyze|coverage|trace` directly. State when `analyze --assisted` requests optional model help.
3. Preview index, acceptance, or task-map writes with `--dry-run` when that form is supported, then require the user to request the mutation.
4. Preserve every `SPEC-nnn`, `AC-nnn`, test tag, missing claim, stale evidence reason, and output path.
5. Do not treat generated indexes or model candidates as approved requirements.

