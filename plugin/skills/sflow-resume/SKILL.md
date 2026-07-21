---
name: sflow-resume
description: Resume an existing Singularity Flow work item by ID, check out its branch, load durable workflow state, and identify the correct SDLC phase.
argument-hint: "<WORK-ID> [--fetch]"
disable-model-invocation: true
---
# Resume Singularity Flow work

1. Run `singularity-flow resume <arguments>` in an interactive terminal and let the contributor choose any configured persona for this session.
2. Read `workflow.json`, `STATUS.md`, source context, and approved artifacts from earlier phases.
3. Run `singularity-flow wm check`. If stale, rebuild for the active phase before doing phase work.
4. Verify the checked-out branch exactly matches the work ID.
5. Summarize completed phases, the active phase, rejection reason if present, and required output.
6. Continue only in the active phase; recommend `/sflow-phase` for custom phases and do not skip ahead.
