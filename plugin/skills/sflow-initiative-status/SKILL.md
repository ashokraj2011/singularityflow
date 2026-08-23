---
name: sflow-initiative-status
description: Display initiative phase progress, evidence readiness, child-story milestones, and current gate state in GitHub Copilot.
disable-model-invocation: true
argument-hint: "[INIT-ID]"
---
# Show initiative status

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow initiative status [INIT-ID] --json`.
2. Render the ordered phase flow using approved, active, awaiting-approval, stale, and not-started states.
3. Run `singularity-flow initiative report [INIT-ID] --format json` and summarize blocking stories, stale contracts, evidence assurance, self-approvals, elapsed time, models, tokens, and cost availability.
4. End with the first result from `singularity-flow initiative next [INIT-ID] --json`.

Keep this operation read-only and preserve the `configured-local` identity-assurance disclosure.
