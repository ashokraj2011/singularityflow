---
name: sflow-progress
description: Show how far a work item has got.
argument-hint: "[WORK-ID] [--json]"

---
# Show workflow progress

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

1. Run `singularity-flow progress <arguments>`.
2. Preserve the arrow-based workflow map from the command output so completed, current, awaiting-approval, and pending phases are visually clear.
3. Report the exact phase-based percentage and approved/total phase count. Do not invent partial completion within an unapproved phase.
4. Identify the current phase and position, its generation, approvals received/required, uploaded-document count, and token status.
5. Call out blocked publication, rejection, or self-approval warnings from `singularity-flow status` when they affect the next action.
6. Do not change files or lifecycle state.
