---
name: sflow-session
description: Apply the configured Copilot session-persona policy, reuse a valid binding, or interactively ask the contributor to choose a persona before work begins.
disable-model-invocation: true
---
# Initialize the Copilot persona session

1. Run `singularity-flow session status --json`.
2. If no Singularity Flow work item is active, stop quietly. If `selectionRequired` is false, report the active persona and work item in one sentence and do not change it.
3. If selection is required, run `singularity-flow persona <WORK-ID>` in a persistent interactive shell.
4. When the CLI prints `Choose persona`, call Copilot's `ask_user` tool with every displayed label, ID, and description. Never recommend, infer, preselect, or silently reuse a persona when the policy requires a choice.
5. Map the contributor's selected ID to the displayed menu number and send only that number plus a newline to the same shell with `write_bash`.
6. Rerun `singularity-flow session status --json` and confirm `selectionRequired` is false, `bound` is true, and `activePersona` matches the contributor's choice.
7. If interactive questions are unavailable, stop and ask the contributor to run `sflow-persona` directly. Never bypass the picker with an environment variable, flag, or session-file edit.
