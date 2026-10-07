---
name: sflow-workspaces
description: Show the complete saved-workspace table and active context; workspace selection belongs to /sf-workspace.
disable-model-invocation: true

---
# Show Singularity Flow workspaces

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

1. Run only `singularity-flow workspace list --table`.
2. Relay the complete CLI table and its active context, warnings, and handoffs verbatim. Keep every row, including inactive workspaces. Do not replace the roster with a current-workspace summary, reorder it, or add Home headings.
3. Selection belongs to singular `/sf-workspace`, not `/sf-workspaces`. Preserve that exact CLI handoff; do not select a workspace in this read-only turn.
4. Do not run Home or a second current-context command. Do not create, clone, repair, archive, switch, or modify a workspace.
