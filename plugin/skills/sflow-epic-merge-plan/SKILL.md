---
name: sflow-epic-merge-plan
description: Show the dependency-safe merge sequence for finalized Epic Stories and the readiness of the Epic branch.
disable-model-invocation: true

---

# Show the Epic merge plan

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic merge-plan --epic <EPIC-KEY> --json`.
2. Display Story order, repository, blocking flag, dependencies, current state, and the next merge candidate.
3. Clearly separate unreachable, blocked, and ready Stories.
4. Report whether every blocking Story has merged and whether the Epic branch is ready.
5. This is read-only; do not merge, rebase, or push.
