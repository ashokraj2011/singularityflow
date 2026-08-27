---
name: sflow-progress
description: Show how far a work item has got.
argument-hint: "[WORK-ID]"

---
# Show workflow progress

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow session current --json`. Require `ready=true`; when `workId` is present it must equal the explicitly requested Work ID. Run the progress command with the process working directory set to the exact returned `repositoryPath`; do not rely on a prior child command to have changed the shell directory. If no workspace is active, use the current governed repository and never search for one.
2. Run `singularity-flow progress <WORK-ID> --markdown`, omitting `<WORK-ID>` when none was supplied. Do not forward user-supplied formatting flags.
3. Reproduce the complete returned Markdown in the visible Copilot response so its headings, journey, summary fields, and phase table render normally. A collapsed Shell/tool block does not count; do not wrap the Markdown in a code fence.
4. Preserve the exact deterministic percentage and approved/total phase count. Never invent partial completion inside an unapproved phase.
5. Preserve `exact`, `partial`, `unavailable`, and `not recorded` token disclosures exactly as returned.
6. If the output shows a rejected or approval-pending phase, briefly call out that state after the table without guessing a decision or changing the next action.
7. Do not change files or lifecycle state.
