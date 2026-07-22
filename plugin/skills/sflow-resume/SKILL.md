---
name: sflow-resume
description: Resume an existing Singularity Flow work item by ID, check out its branch, load durable workflow state, and identify the correct SDLC phase.
argument-hint: "<WORK-ID> [--fetch]"
disable-model-invocation: true
---
# Resume Singularity Flow work

1. Run `singularity-flow resume <arguments>` in a persistent interactive shell.
2. When the CLI prints `Choose persona`, call Copilot's `ask_user` tool with every displayed label, ID, and description as selectable options. Never infer or preselect a persona.
3. Map the selected ID to its displayed number and send that number plus a newline to the same shell process with `write_bash`. Do not pass a persona flag, set a selection environment variable, or edit the session file.
4. If `ask_user` is unavailable or disabled, stop and ask the contributor to run `singularity-flow resume <WORK-ID> --fetch` directly in their terminal; never choose on their behalf.
5. Read `workflow.json`, `STATUS.md`, source context, and approved artifacts from earlier phases.
6. Run `singularity-flow wm check`. If stale, rebuild for the active phase before doing phase work.
7. Verify the checked-out branch exactly matches the work ID.
8. Summarize the selected session persona, completed phases, active phase, rejection reason if present, and required output.
9. Continue only in the active phase; recommend `/sflow-phase` for custom phases and do not skip ahead.
