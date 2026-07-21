---
name: sflow-status
description: Show the current Singularity Flow SDLC phase, artifact state, quality checks, and approval history for the checked-out work item.
argument-hint: "[WORK-ID]"
disable-model-invocation: true
---
# Show Singularity Flow status

Run `singularity-flow status` with the supplied work ID, if any. Read `STATUS.md` and report the branch, immutable work type, current phase, suggested personas, generation, artifacts, token usage, approval threshold, self-approval warnings, publication state, and next valid action. Do not change files or lifecycle state.
