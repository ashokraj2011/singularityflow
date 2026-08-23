---
name: sflow-progress
description: Show how far a work item has got.
argument-hint: "[WORK-ID]"

---
# Show workflow progress

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow progress <WORK-ID> --markdown`, omitting `<WORK-ID>` when none was supplied. Do not forward user-supplied formatting flags.
2. Reproduce the complete returned Markdown in the visible Copilot response so its headings, journey, summary fields, and phase table render normally. A collapsed Shell/tool block does not count; do not wrap the Markdown in a code fence.
3. Preserve the exact deterministic percentage and approved/total phase count. Never invent partial completion inside an unapproved phase.
4. Preserve `exact`, `partial`, `unavailable`, and `not recorded` token disclosures exactly as returned.
5. If the output shows a rejected or approval-pending phase, briefly call out that state after the table without guessing a decision or changing the next action.
6. Do not change files or lifecycle state.
