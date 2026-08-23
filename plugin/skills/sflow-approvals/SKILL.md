---
name: sflow-approvals
description: Show the phase-by-phase approval chain, document names, authority groups, reviewers, decisions, and outstanding thresholds.
disable-model-invocation: true
argument-hint: "[WORK-ID]"
---
# Show the approval chain

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow approvals $ARGUMENTS --json`.
2. Show every phase, governed document, required authority group, approval threshold, recorded reviewer identity, decision, and current wait state.
3. Preserve self-approval and identity warnings exactly.
4. This skill is read-only. Offer `/sf-inbox` to select pending review work and `/sf-approve` or `/sf-reject` only when the user explicitly wants to decide.

