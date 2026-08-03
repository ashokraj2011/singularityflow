---
name: sflow-reject
description: Reject a submitted phase as the current Git identity, recording its human authority group, phase-default agent, reason, commit, push, and downstream invalidation.
argument-hint: "[WORK-ID] [--fetch] --to PHASE --reason 'explanation'"
disable-model-invocation: true
---
# Reject the submitted phase

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

1. Require a specific rejection reason and target phase; do not invent either.
2. Run `singularity-flow reject <WORK-ID> --fetch --to <phase> --reason "..."` in a persistent interactive shell.
3. Show the reviewer Git identity, matched authority group, and automatic phase agent. An unauthorized identity must stop; changing agents cannot grant rejection authority.
6. Show which approvals and later phases will be invalidated.
5. Confirm the human identity, authority group, governed agent, rejection, commit, push, reopened target, and recorded reason.
8. Do not modify artifacts unless the user asks to address the rejection.
