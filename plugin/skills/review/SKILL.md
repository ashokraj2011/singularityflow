---
name: review
description: Perform an independent Singularity Flow review, record actionable findings, and register the review decision.
argument-hint: "[review emphasis]"
disable-model-invocation: true
---
# Independent review phase

1. Run `singularity-flow status --json`; stop if the current phase is not `review`.
2. Ground the phase with `singularity-flow wm context review --task "<review scope>" --concat --evidence`. If missing or stale, run `singularity-flow wm build --phase review --task "<review scope>"`, then rerun context. Use architecture, development, testing, security, and evidence views.
3. Read approved requirements, design, implementation summary, verification evidence, the actual diff, and selected source evidence.
4. Review correctness, acceptance coverage, maintainability, architecture alignment, security, failures, observability, rollout, rollback, and tests.
5. Rank findings by severity and include file/line references when available.
6. Do not silently fix findings unless explicitly asked.
7. Run `singularity-flow prepare review`, complete the decision document, remove placeholders, and run `singularity-flow artifact scan`.
8. Do not submit or approve automatically.
