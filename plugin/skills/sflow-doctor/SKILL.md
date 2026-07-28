---
name: sflow-doctor
description: Diagnose Singularity Flow repository, workflow, working-lens, human-identity authority, publication, working-tree, and remote readiness without changing state.
argument-hint: "[work ID]"
disable-model-invocation: true
---
# Diagnose setup and recovery

Run `singularity-flow doctor $ARGUMENTS`. Report each failure with its exact safe fix and summarize warnings separately. This command is read-only. Do not reset, stash, switch branches, or edit configuration unless the user explicitly asks you to apply a fix.

When a failure is not explained by the current state, read what actually happened with `/sflow-logs` — `singularity-flow logs --level warn` shows recent failures and refused tool calls, including the reason a hook blocked a command. Diagnose from the log rather than retrying blindly.
