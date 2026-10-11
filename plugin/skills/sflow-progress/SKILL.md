---
name: sflow-progress
description: Show how far a work item has got.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---
# Show workflow progress

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Use the Boundary repository. With an explicit Work ID, do not require or change the active Story. Without an ID, run `singularity-flow session current --json` and require its `ready` Story; use its exact `repositoryPath` as cwd.
2. Run `singularity-flow progress <WORK-ID> --markdown` for an explicit ID, or `singularity-flow progress --markdown` for the attached Story. Do not forward user-supplied formatting flags.
3. Reproduce the complete returned Markdown in the visible Copilot response so its headings, journey, summary fields, and phase table render normally. A collapsed Shell/tool block does not count; do not wrap the Markdown in a code fence.
4. Preserve the exact deterministic percentage and approved/total phase count. Never invent partial completion inside an unapproved phase.
5. Preserve `exact`, `partial`, `unavailable`, and `not recorded` token disclosures exactly as returned.
6. If the output shows a rejected or approval-pending phase, briefly call out that state after the table without guessing a decision or changing the next action.
7. Do not change files or lifecycle state.
