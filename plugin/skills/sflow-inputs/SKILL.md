---
name: sflow-inputs
description: Inspect and render the approved phase-artifact inputs configured for the active Singularity Flow phase.
argument-hint: "[phase]"
disable-model-invocation: true
---
# Inspect phase inputs

1. Run `singularity-flow status --json` and use only the active phase.
2. Preview resolution with `singularity-flow inputs <phase> --dry-run`.
3. Explain every missing, unapproved, truncated, or hash-mismatched producer artifact before continuing.
4. Run `singularity-flow inputs <phase>` to write the next-generation audit record and render the managed input block.
5. Read the returned artifact and preserve the marker-delimited managed block.
6. Do not submit, approve, or reject automatically.
