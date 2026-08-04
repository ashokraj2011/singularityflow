---
name: sflow-initiative-materialize
description: Preview and explicitly materialize approved initiative stories across registered repositories from GitHub Copilot.
disable-model-invocation: true
argument-hint: "[--initiative INIT-ID]"

---
# Materialize initiative stories

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.

1. Run `singularity-flow initiative breakdown --json` and `singularity-flow initiative materialize --dry-run --json`.
2. Show every Epic, story, repository, branch, blocking flag, dependency, contract, Jira operation, and reachability problem.
3. Ask the contributor to type the exact initiative ID. Never infer, autocomplete, or submit it on their behalf.
4. Run `singularity-flow initiative materialize` in a persistent terminal and send the exact user-entered ID to that process. If persistent input is unavailable, stop without mutation; materialization has no bypass flag.
5. Report each repository/branch/commit receipt, Jira receipt when enabled, partial failure, retry status, commit, and push.

Never force-push, overwrite an unrelated branch, or describe a partial result as complete.
