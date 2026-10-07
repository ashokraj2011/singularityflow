---
name: sflow-epic-next
description: Show the single next valid action for a governed Epic without changing Git, Jira, approvals, or lifecycle state.
disable-model-invocation: true

---

# Show the next Epic action

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Resolve the Epic key from the argument or current branch.
2. Run `singularity-flow epic next <EPIC-KEY> --json`.
3. Present the current phase, blockers, and next action in plain language.
4. Include the exact `/sf-*` command the user can run next.
5. Do not mutate state or substitute the work-item-only `/sf-next`.
