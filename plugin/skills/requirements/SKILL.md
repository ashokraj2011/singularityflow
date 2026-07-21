---
name: requirements
description: Produce and register the requirements artifact for the active Singularity Flow requirements phase, including scope and testable acceptance criteria.
argument-hint: "[additional business context]"
disable-model-invocation: true
---
# Requirements phase

1. Run `singularity-flow status --json`; stop if the current phase is not `requirements`.
2. Run `singularity-flow prepare requirements` and read the returned path and `source.json`.
3. Inspect the repository only as needed to understand current behavior. Do not implement code.
4. Complete the document with the problem, desired outcome, in/out scope, measurable acceptance criteria, dependencies, assumptions, risks, and open questions.
5. Remove every `TODO`, `TBD`, template instruction, and unsupported claim.
6. Run `singularity-flow artifact add <requirements-path> --kind requirements`.
7. Summarize unresolved decisions. Do not submit or approve automatically.
