---
name: sflow-epic-next
description: Show the single next valid action for a governed Epic without changing Git, Jira, approvals, or lifecycle state.
---

# Show the next Epic action

1. Resolve the Epic key from the argument or current branch.
2. Run `singularity-flow epic next <EPIC-KEY> --json`.
3. Present the current phase, blockers, and next action in plain language.
4. Include the exact `/sflow-*` command the user can run next.
5. Do not mutate state or substitute the work-item-only `/sflow-next`.
