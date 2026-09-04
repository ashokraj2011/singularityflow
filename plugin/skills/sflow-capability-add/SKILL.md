---
name: sflow-capability-add
description: Propose a narrower repository capability for one explicit directory.
disable-model-invocation: true
argument-hint: "<ID> --owns <DIRECTORY>"
---
# Add a capability boundary

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Show the exact proposed boundary and relay the CLI proposal or refusal; never activate it.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require a lower-case kebab-case ID and one repository-relative directory. Accept only a trailing `/**` shorthand; never accept other glob syntax.
2. Run `singularity-flow capability show <DIRECTORY> --json` and show the current owner.
3. After the contributor confirms the exact ID and directory, run once:
   `singularity-flow capability add <ID> --owns <DIRECTORY> [--name <TEXT>] [--team <TEXT>]... --json`.
4. Relay the review branch, commit, receipt, and activation command. Stop; do not review, merge, activate, or hand-edit the map.
