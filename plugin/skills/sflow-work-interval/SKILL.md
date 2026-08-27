---
name: sflow-work-interval
description: Inspect, checkpoint, reconcile, or safely escalate the current governed Story work interval without committing unfinished source.
disable-model-invocation: true
argument-hint: "[status|checkpoint|reconcile|escalate]"

---
# Manage a governed work interval

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

Use the CLI as the authority. Never stage, commit, push, or copy unfinished source for a checkpoint.

1. Run `singularity-flow story interval status --json` first.
2. For a local recovery point explicitly requested by the contributor, run `singularity-flow story interval checkpoint --name "<name>" --note "<note>"`. Explain that it stores only file hashes and metadata under `.git/singularity-flow/checkpoints/`; it does not store source bytes or change Git history.
3. For a read-only alignment preview, run `singularity-flow story interval reconcile --json`. Report planned, unplanned, protected, and total changed paths plus any escalation reason.
4. If reconciliation requires a stronger workflow, run `singularity-flow story interval escalate --to <work-type> --json`. This returns a plan only: it preserves the current branch and work and never rewrites the immutable work type.
5. Final reconciliation is automatic inside `/sf-submit`; do not record a second final report manually. Submission must block when its baseline is missing or when policy requires escalation.
6. Report whether each result is local-only or governed, and give the exact next valid `/sf-*` and `singularity-flow ...` commands.
