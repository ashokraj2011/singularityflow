---
name: verify
description: Verify implementation against acceptance criteria, run checks, capture evidence, and register the Singularity Flow verification artifact.
argument-hint: "[test scope or environment]"
disable-model-invocation: true
---
# Verification phase

1. Run `singularity-flow status --json`; stop if the current phase is not `verification`.
2. Read approved requirements, design, and implementation summary.
3. Map each acceptance criterion to executable or inspectable evidence.
4. Run relevant tests and add missing tests when needed. Record exact commands and results.
5. Cover regression, negative cases, boundaries, failure modes, security, reliability, accessibility, and performance where applicable.
6. Run `singularity-flow prepare verification`, complete the evidence without unobserved claims, remove placeholders, and run `singularity-flow artifact scan`.
7. Do not submit or approve automatically.
