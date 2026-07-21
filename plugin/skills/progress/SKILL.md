---
name: progress
description: Show how far a Singularity Flow work item has progressed, including percentage, approved phases, current position, approval thresholds, generations, documents, and token usage.
argument-hint: "[WORK-ID] [--json]"
disable-model-invocation: true
---
# Show workflow progress

1. Run `singularity-flow progress <arguments>`.
2. Report the exact phase-based percentage and approved/total phase count. Do not invent partial completion within an unapproved phase.
3. Identify the current phase and position, its generation, approvals received/required, uploaded-document count, and token status.
4. Call out blocked publication, rejection, or self-approval warnings from `singularity-flow status` when they affect the next action.
5. Do not change files or lifecycle state.
