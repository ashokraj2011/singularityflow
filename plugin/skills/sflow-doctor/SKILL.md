---
name: sflow-doctor
description: Diagnose Singularity Flow repository, workflow, persona, publication, working-tree, and remote readiness without changing state.
argument-hint: "[work ID]"
disable-model-invocation: true
---
# Diagnose setup and recovery

Run `singularity-flow doctor $ARGUMENTS`. Report each failure with its exact safe fix and summarize warnings separately. This command is read-only. Do not reset, stash, switch branches, or edit configuration unless the user explicitly asks you to apply a fix.
