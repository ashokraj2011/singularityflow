---
name: implement
description: Implement the approved Singularity Flow design, add or update tests, and create the implementation summary while preserving phase traceability.
argument-hint: "[implementation focus]"
disable-model-invocation: true
---
# Implementation phase

1. Run `singularity-flow status --json`; stop if the current phase is not `implementation`.
2. Read approved requirements and design artifacts.
3. Inspect repository conventions, build commands, and tests.
4. Implement only approved scope; add or update tests and documentation.
5. Run relevant format, build, lint, and test commands.
6. Run `singularity-flow prepare implementation` and complete the summary with changed components, decisions, deviations, tests, limitations, and operational notes.
7. Remove placeholders, then run `singularity-flow artifact scan`.
8. Report commands and outcomes. Do not submit or approve automatically.
