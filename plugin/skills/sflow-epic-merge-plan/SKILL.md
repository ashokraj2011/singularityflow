---
name: sflow-epic-merge-plan
description: Show the dependency-safe merge sequence for finalized Epic Stories and the readiness of the Epic branch.
---

# Show the Epic merge plan

1. Run `singularity-flow epic merge-plan --epic <EPIC-KEY> --json`.
2. Display Story order, repository, blocking flag, dependencies, current state, and the next merge candidate.
3. Clearly separate unreachable, blocked, and ready Stories.
4. Report whether every blocking Story has merged and whether the Epic branch is ready.
5. This is read-only; do not merge, rebase, or push.
