---
name: sflow-resume
description: Resume an existing Singularity Flow work item by ID, check out its branch, load durable workflow state, and identify the correct SDLC phase.
disable-model-invocation: true
argument-hint: "<WORK-ID> [--fetch]"

---
# Resume Singularity Flow work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow resume <arguments>`.
2. The CLI activates the current phase's default governed agent automatically. Do not ask the contributor to select a role. Use `/sf-agent` only when they explicitly request an override.
5. Read `workflow.json`, `STATUS.md`, source context, and approved artifacts from earlier phases.
6. Run `singularity-flow wm check`. If stale, rebuild for the active phase before doing phase work.
7. Verify the checked-out branch exactly matches the work ID.
6. Summarize the active governed agent, completed phases, active phase, rejection reason if present, and required output. Keep the contributor's Git identity and approval authority separate.
9. Continue only in the active phase; recommend `/sf-phase` for custom phases and do not skip ahead.
