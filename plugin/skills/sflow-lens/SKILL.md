---
name: sflow-lens
description: Interactively choose and persist a prompt-only Singularity Flow working lens for the current work-item session without changing committed state or human approval authority.
argument-hint: "[WORK-ID]"
disable-model-invocation: true
---

# Select the session working lens

1. Run `singularity-flow lens <WORK-ID>` in a persistent interactive shell; omit the ID when the current branch already identifies it.
2. When the CLI prints `Choose working lens`, call Copilot's `ask_user` tool with every displayed label, ID, and description. Never infer or choose for the contributor.
3. Map the selected ID to the displayed menu number and send that number plus a newline to the same shell process with `write_bash`. Do not use a persona flag, environment-variable bypass, or direct session-file edit.
4. If `ask_user` is unavailable or disabled, stop and ask the contributor to run `sflow-lens`; do not select on their behalf.
5. Run `singularity-flow session status --json`, then report the lens, work-item scope, and Copilot-session binding. Explain that the lens changes prompt perspective only. It never changes the human Git identity, team membership, assignment, or approval authority.
