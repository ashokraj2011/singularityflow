---
name: sflow-implement
description: Implement the approved Singularity Flow design, add or update tests, and create the implementation summary while preserving phase traceability.
argument-hint: "[implementation focus]"
disable-model-invocation: true
---
# Implementation phase

1. Run `singularity-flow status --json`; stop if the current phase is not `implementation`.
2. Ground the phase with `singularity-flow wm context implementation --task "<implementation objective>" --concat --no-persona`. If missing or stale, run `singularity-flow wm build --phase implementation --task "<implementation objective>"`, then rerun context. Use the development and testing views to select entry points, conventions, and commands.
3. Run `singularity-flow wm inject --phase implementation` and use the returned, rule-grounded persona prompt.
4. Read approved requirements, design artifacts, and the source locations selected by the grounding package.
5. Inspect further files only as the implementation requires.
6. Implement only approved scope; add or update tests and documentation. Tag tests with the corresponding `@ac:AC-n` identifiers.
7. Run relevant format, build, lint, and test commands.
8. Run `singularity-flow prepare implementation` and complete the summary with changed components, decisions, deviations, tests, limitations, and operational notes.
9. Remove placeholders, then run `singularity-flow phase publish implementation`.
10. Report commands and outcomes. Do not submit or approve automatically.
