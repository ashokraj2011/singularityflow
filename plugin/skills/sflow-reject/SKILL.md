---
name: sflow-reject
description: Interactively select a persona and reject a submitted Singularity Flow phase to an allowed current or earlier phase, recording the reason and invalidating downstream approvals.
argument-hint: "[WORK-ID] [--fetch] --to PHASE --reason 'explanation'"
disable-model-invocation: true
---
# Reject the submitted phase

1. Require a specific rejection reason and target phase; do not invent either.
2. Run `singularity-flow reject <WORK-ID> --fetch --to <phase> --reason "..."` in an interactive terminal.
3. Let the reviewer choose a persona and show which approvals and later phases will be invalidated.
4. Confirm the rejection, commit, push, reopened target, and recorded reason.
5. Do not modify artifacts unless the user asks to address the rejection.
