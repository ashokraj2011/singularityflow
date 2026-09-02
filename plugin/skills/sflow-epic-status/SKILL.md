---
name: sflow-epic-status
description: Show Epic planning phase progress and read-only delivery aggregation across Jira Stories, repositories, branches, checks, conformance, duration, model, tokens, and cost.
disable-model-invocation: true

---

# Show Epic status

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic status [EPIC-KEY] --json`.
2. Run `singularity-flow epic report [EPIC-KEY] --format json`.
3. Show the four planning phases or selected full-delivery profile as an arrow flow.
4. For every Story show plan ID, Jira key, repository, canonical/child branch, Jira observation, workflow percentage, submission, required checks, conformance, blockers, duration, model, tokens, and cost availability.
5. Label Jira drift, stale sources/specifications, configured-local Git identity assurance, and self-approval honestly.
6. End with `singularity-flow epic next [EPIC-KEY] --json`. Do not mutate lifecycle state.
