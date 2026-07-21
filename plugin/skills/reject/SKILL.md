---
name: reject
description: Reject a Singularity Flow phase awaiting approval, record a required reason, and return it to in-progress state.
argument-hint: "--reason 'required explanation' [--by 'Name']"
disable-model-invocation: true
---
# Reject the submitted phase

1. Require a specific rejection reason; do not invent one.
2. Run `singularity-flow status --json`; verify the phase is awaiting approval.
3. Run `singularity-flow reject <arguments>`.
4. Read updated status and explain what must change before resubmission.
5. Do not modify artifacts unless the user asks to address the rejection.
