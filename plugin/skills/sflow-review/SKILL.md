---
name: sflow-review
description: Perform an independent Singularity Flow review, record actionable findings, and register the review decision.
argument-hint: "[review emphasis]"
disable-model-invocation: true
---
# Independent review phase

1. Run `singularity-flow status --json`; stop if the current phase is not `review`.
2. Ground the phase with `singularity-flow wm context review --task "<review scope>" --concat --evidence --no-persona`. If missing or stale, run `singularity-flow wm build --phase review --task "<review scope>"`, then rerun context. Use architecture, development, testing, security, and evidence views.
3. Run `singularity-flow wm inject --phase review` and use the returned, rule-grounded persona prompt.
4. Read approved requirements, design, implementation summary, verification evidence, the actual diff, and selected source evidence.
5. Review correctness, acceptance coverage, maintainability, architecture alignment, security, failures, observability, rollout, rollback, and tests.
6. Rank findings by severity and include file/line references when available.
7. Do not silently fix findings unless explicitly asked.
8. If the configured workflow includes review, run `singularity-flow prepare review`, complete the decision document, remove placeholders, and run `singularity-flow phase publish review`.
9. Do not submit or approve automatically.
