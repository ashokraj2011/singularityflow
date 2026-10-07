---
name: sflow-work-interval
description: Inspect, checkpoint, reconcile, or safely escalate the current governed Story work interval without committing unfinished source.
disable-model-invocation: true
argument-hint: "[status|checkpoint|reconcile|escalate]"

---
# Manage a governed work interval

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

Use the CLI as the authority. Never stage, commit, push, or copy unfinished source for a checkpoint.

1. Run `singularity-flow story interval status --json` first.
2. For a local recovery point explicitly requested by the contributor, run `singularity-flow story interval checkpoint --name "<name>" --note "<note>"`. Explain that it stores only file hashes and metadata under `.git/singularity-flow/checkpoints/`; it does not store source bytes or change Git history.
3. For a read-only alignment preview, run `singularity-flow story interval reconcile --json`. Report planned, unplanned, protected, and total changed paths plus any escalation reason.
4. If reconciliation requires a stronger workflow, run `singularity-flow story interval escalate --to <work-type> --json`. This returns a plan only: it preserves the current branch and work and never rewrites the immutable work type.
5. Final reconciliation is automatic inside `/sf-submit`; do not record a second final report manually. Submission must block when its baseline is missing or when policy requires escalation.
6. Report whether each result is local-only or governed, and give the exact next valid `/sf-*` and `singularity-flow ...` commands.
