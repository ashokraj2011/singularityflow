---
name: sflow-doctor
description: Diagnose Singularity Flow repository, workflow, working-lens, human-identity authority, publication, working-tree, and remote readiness without changing state.
argument-hint: "[work ID]"
disable-model-invocation: true
---
# Diagnose setup and recovery

Run `singularity-flow init --check --json` first, then run
`singularity-flow doctor $ARGUMENTS`. Report each failure with its exact safe
fix and summarize warnings separately. The initialization check covers the
workflow, portfolio, templates, prompts, and working-lens files installed on
the current branch. Both commands are read-only. Recommend `/sflow-init` when
assets are missing. Do not reset, stash, switch branches, or edit
configuration unless the user explicitly asks you to apply a fix.

When a failure is not explained by the current state, read what actually happened with `/sflow-logs` — `singularity-flow logs --level warn` shows recent failures and refused tool calls, including the reason a hook blocked a command. Diagnose from the log rather than retrying blindly.
