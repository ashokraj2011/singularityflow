---
name: status
description: Show the current Singularity Flow SDLC phase, artifact state, quality checks, and approval history for the checked-out work item.
argument-hint: "[WORK-ID]"
disable-model-invocation: true
---
# Show Singularity Flow status

Run `singularity-flow status` with the supplied work ID, if any. Read `STATUS.md` and report the exact branch, overall status, current phase, owner persona, required artifact, registered artifacts, approval state, and next valid Singularity Flow action. Do not change files or lifecycle state.
