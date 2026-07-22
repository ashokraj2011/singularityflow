---
name: sflow-persona
description: Interactively choose and persist any configured Singularity Flow persona for the current work-item session without changing committed workflow state.
argument-hint: "[WORK-ID]"
disable-model-invocation: true
---
# Select the session persona

1. Run `singularity-flow persona <WORK-ID>` in a persistent interactive shell; omit the ID when the current branch already identifies it.
2. When the CLI prints `Choose persona`, call Copilot's `ask_user` tool with the displayed labels, IDs, and descriptions as selectable options. Never infer, recommend as a default, or choose for the contributor.
3. Map the selected ID to its displayed menu number and send that number plus a newline to the same shell process with `write_bash`. Do not use a persona flag, environment-variable bypass, or direct session-file edit.
4. If `ask_user` is unavailable or disabled, stop and ask the contributor to run `sflow-persona` in their terminal; do not select on their behalf.
5. Report the selected persona and work-item scope. The CLI stores it locally in `.git/singularity-flow/session.json`; opening or changing a session does not commit or push.
