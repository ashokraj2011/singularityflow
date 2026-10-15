---
name: sflow-work-interval
description: Inspect, checkpoint, reconcile, or safely escalate the current governed Story work interval without committing unfinished source.
disable-model-invocation: true
argument-hint: "[status|checkpoint|reconcile|escalate]"

---
# Manage a governed work interval

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Use the CLI as the authority. Never stage, commit, push, or copy unfinished source for a checkpoint.

1. Run `singularity-flow story interval status --json` first.
2. For a local recovery point explicitly requested by the contributor, run `singularity-flow story interval checkpoint --name "<name>" --note "<note>"`. Explain that it stores only file hashes and metadata under `.git/singularity-flow/checkpoints/`; it does not store source bytes or change Git history.
3. For a read-only alignment preview, run `singularity-flow story interval reconcile --json`. Report planned, unplanned, protected, and total changed paths plus any escalation reason.
4. Only when reconcile returns `decision.reasons` and `decision.escalationTarget`, run `singularity-flow story interval escalate --to <decision.escalationTarget> --json`; never pick a work type. This returns a plan only: it preserves the current branch and work and never rewrites the immutable work type.
5. Final reconciliation is automatic inside `/sf-submit`; do not record a second final report manually. Submission must block when its baseline is missing or when policy requires escalation.
6. Report whether each result is local-only or governed, and give the exact next valid `/sf-*` and `singularity-flow ...` commands.
