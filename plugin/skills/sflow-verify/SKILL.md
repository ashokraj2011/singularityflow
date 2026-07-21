---
name: sflow-verify
description: Verify implementation against acceptance criteria, run checks, capture evidence, and register the Singularity Flow verification artifact.
argument-hint: "[test scope or environment]"
disable-model-invocation: true
---
# Verification phase

1. Run `singularity-flow status --json`; stop if the current phase is not `verification`.
2. Ground the phase with `singularity-flow wm context verification --task "<verification scope>" --concat --evidence`. If missing or stale, run `singularity-flow wm build --phase verification --task "<verification scope>"`, then rerun context. Use testing, development, security, and evidence views.
3. Read approved requirements, design, implementation summary, and selected source evidence.
4. Map each acceptance criterion to executable or inspectable evidence and its `@ac:AC-n` test tag.
5. Run relevant tests and add missing tests when needed. Record exact commands and results.
6. Cover regression, negative cases, boundaries, failure modes, security, reliability, accessibility, and performance where applicable.
7. Run `singularity-flow prepare verification`, complete the evidence without unobserved claims, remove placeholders, and run `singularity-flow phase publish verification`.
8. Do not submit or approve automatically.
