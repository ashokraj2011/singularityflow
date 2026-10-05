---
name: sflow-capability-add
description: Propose a narrower repository capability for one explicit directory.
disable-model-invocation: true
argument-hint: "<ID> --owns <DIRECTORY>"
---
# Add a capability boundary

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require a lower-case kebab-case ID and one repository-relative directory. Accept only a trailing `/**` shorthand; never accept other glob syntax.
2. Run `singularity-flow capability show <DIRECTORY> --json` and show the current owner.
3. After the contributor confirms the exact ID and directory, run once:
   `singularity-flow capability add <ID> --owns <DIRECTORY> [--name <TEXT>] [--team <TEXT>]... --json`.
4. Relay the review branch, commit, receipt, and activation command. Stop; do not review, merge, activate, or hand-edit the map.
