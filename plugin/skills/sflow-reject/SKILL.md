---
name: sflow-reject
description: Interactively select a persona and reject a submitted Singularity Flow phase to an allowed current or earlier phase, recording the reason and invalidating downstream approvals.
argument-hint: "[WORK-ID] [--fetch] --to PHASE --reason 'explanation'"
disable-model-invocation: true
---
# Reject the submitted phase

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

1. Require a specific rejection reason and target phase; do not invent either.
2. Run `singularity-flow reject <WORK-ID> --fetch --to <phase> --reason "..."` in a persistent interactive shell.
3. When the CLI prints `Choose persona`, call Copilot's `ask_user` tool with the displayed rejection-capable persona labels, IDs, and descriptions as selectable options. Never infer or preselect one.
4. Map the selected ID to the displayed number and send that number plus a newline to the same shell process with `write_bash`. Do not pass a persona flag, set a selection environment variable, or edit the session file. If `ask_user` is unavailable or disabled, stop and ask the reviewer to run the command directly in their terminal.
5. Show which approvals and later phases will be invalidated.
6. Confirm the rejection, commit, push, reopened target, and recorded reason.
7. Do not modify artifacts unless the user asks to address the rejection.
