---
name: resume
description: Resume an existing Singularity Flow work item by ID, check out its branch, load durable workflow state, and identify the correct SDLC phase.
argument-hint: "<WORK-ID> [--fetch]"
disable-model-invocation: true
---
# Resume Singularity Flow work

1. Run `singularity-flow resume <arguments>`.
2. Read `workflow.json`, `STATUS.md`, source context, and approved artifacts from earlier phases.
3. Verify the checked-out branch exactly matches the work ID.
4. Summarize completed phases, the active phase, rejection reason if present, and required output.
5. Continue only in the active phase; do not skip ahead.
