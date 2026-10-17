---
name: sflow-progress
description: Show how far a work item has got.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---
# Show workflow progress

<!-- sflow-copilot-pause -->
Read-only utility: run the requested read once with `--utility-entry --for-agent --json` (default `singularity-flow progress --utility-entry --for-agent --json`). Keep explicit Work IDs/filters; do not replace requested edits with a list. Eligible forms: status, progress, nextsteps, logs, agents list/mappings/status, workflow list, skill/instruction list/show without retained selectors. It checks pause before Git and returns verified `repositoryPath` plus `data`; no separate pause/session/workspace lookup or STATUS.md read. If paused, native Copilot; only offer `/sf-pause off`, never resume implicitly. Other forms: Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. Reads never authorize mutations; preserve later gates. If unsupported, stop with the compatibility error, never retry blindly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Use the Boundary repository. With an explicit Work ID, do not require or change the active Story. Without an ID, let the utility entry resolve the attached Story; never infer selection.
2. Run `singularity-flow progress <WORK-ID> --utility-entry --for-agent --json` (omit the ID only when absent). Do not forward user-supplied formatting flags.
3. Render the returned `data` as a concise journey and phase table, preserving status, generation, approvals and tokens. Do not fetch Markdown or other documents for display.
4. Preserve the exact deterministic percentage and approved/total phase count. Never invent partial completion inside an unapproved phase.
5. Preserve `exact`, `partial`, `unavailable`, and `not recorded` token disclosures exactly as returned.
6. If the output shows a rejected or approval-pending phase, briefly call out that state after the table without guessing a decision or changing the next action.
7. Do not change files or lifecycle state.
