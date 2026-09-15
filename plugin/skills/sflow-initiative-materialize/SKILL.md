---
name: sflow-initiative-materialize
description: Preview and explicitly materialize approved initiative stories across registered repositories from GitHub Copilot.
disable-model-invocation: true
argument-hint: "[--initiative INIT-ID]"

---
# Materialize initiative stories

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require the exact initiative ID from the invocation or ask the contributor for it. Never infer or autocomplete it.
2. Run `singularity-flow initiative breakdown --initiative <INIT-ID> --json` and `singularity-flow initiative materialize --initiative <INIT-ID> --dry-run --json`.
3. Show every Epic, story, repository, branch, blocking flag, dependency, contract, Jira operation, and reachability problem.
4. Ask the contributor to type the exact initiative ID as mutation confirmation. Never infer, autocomplete, or submit it on their behalf.
5. Only after that exact confirmation, run `singularity-flow initiative materialize --initiative <INIT-ID> --confirm <INIT-ID> --json`. A persistent terminal is not required; never supply or infer the confirmation before the contributor provides it.
6. Report each repository/branch/commit receipt, Jira receipt when enabled, partial failure, retry status, commit, and push.

Never force-push, overwrite an unrelated branch, or describe a partial result as complete.
