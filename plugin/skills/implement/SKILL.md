---
name: implement
description: Implement the approved Singularity Flow design, add or update tests, and create the implementation summary while preserving phase traceability.
argument-hint: "[implementation focus]"
disable-model-invocation: true
---
# Implementation phase

1. Run `singularity-flow status --json`; stop if the current phase is not `implementation`.
2. Ground the phase with `singularity-flow wm context implementation --task "<implementation objective>" --concat`. If missing or stale, run `singularity-flow wm build --phase implementation --task "<implementation objective>"`, then rerun context. Use the development and testing views to select entry points, conventions, and commands.
3. Read approved requirements, design artifacts, and the source locations selected by the grounding package.
4. Inspect further files only as the implementation requires.
5. Implement only approved scope; add or update tests and documentation. Tag tests with the corresponding `@ac:AC-n` identifiers.
6. Run relevant format, build, lint, and test commands.
7. Run `singularity-flow prepare implementation` and complete the summary with changed components, decisions, deviations, tests, limitations, and operational notes.
8. Remove placeholders, then run `singularity-flow artifact scan`.
9. Report commands and outcomes. Do not submit or approve automatically.
