---
name: sflow-verify
description: Verify implementation against acceptance criteria, run checks, capture evidence, and register the Singularity Flow verification artifact.
argument-hint: "[test scope or environment]"
disable-model-invocation: true
---
# Verification phase

1. Run `singularity-flow status --json`; stop if the current phase is not `verification`.
2. Ground the phase with `singularity-flow wm context verification --task "<verification scope>" --concat --evidence --no-persona`. If missing or stale, run `singularity-flow wm build --phase verification --task "<verification scope>"`, then rerun context. Use testing, development, security, and evidence views.
3. Run `singularity-flow wm inject --phase verification` and use the returned, rule-grounded persona prompt.
4. Read approved requirements, design, implementation summary, and selected source evidence.
5. Map each acceptance criterion to executable or inspectable evidence and its `@ac:AC-n` test tag.
6. Run relevant tests and add missing tests when needed. Record exact commands and results.
7. Cover regression, negative cases, boundaries, failure modes, security, reliability, accessibility, and performance where applicable.
8. Run `singularity-flow prepare verification`, complete the evidence without unobserved claims, remove placeholders, and run `singularity-flow phase publish verification`.
9. Do not submit or approve automatically.
