---
name: sflow-epic-merge-plan
description: Show the dependency-safe merge sequence for finalized Epic Stories and the readiness of the Epic branch.
disable-model-invocation: true

---

# Show the Epic merge plan

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow epic merge-plan --epic <EPIC-KEY> --json`.
2. Display Story order, repository, blocking flag, dependencies, current state, and the next merge candidate.
3. Clearly separate unreachable, blocked, and ready Stories.
4. Report whether every blocking Story has merged and whether the Epic branch is ready.
5. This is read-only; do not merge, rebase, or push.
