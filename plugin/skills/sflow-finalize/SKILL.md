---
name: sflow-finalize
description: Finalize a fully approved developer Story into an exact hash-bound packet for Product Owner spec-to-code review.
disable-model-invocation: true

---

# Finalize a Story

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Run `singularity-flow finalize`; it decides whether every step is settled (approved, or skipped by a workflow decision), so never pre-check it yourself. On refusal relay its findings or `Incomplete:` list and stop.
2. The command verifies a clean tree, the governed seed, parent and Story specification hashes, every phase artifact, approvals, quality evidence, model/token records, and exact source/test tree.
3. Show the finalization packet path/hash, source commit/tree hash, commit, and push.
4. Do not approve or promote the Story. Finalization changes delivery state to `finalized_for_review`; Product Owner review is a separate decision.
