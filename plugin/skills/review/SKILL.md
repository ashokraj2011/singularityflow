---
name: review
description: Perform an independent Singularity Flow review, record actionable findings, and register the review decision.
argument-hint: "[review emphasis]"
disable-model-invocation: true
---
# Independent review phase

1. Run `singularity-flow status --json`; stop if the current phase is not `review`.
2. Read approved requirements, design, implementation summary, verification evidence, and the actual diff.
3. Review correctness, acceptance coverage, maintainability, architecture alignment, security, failures, observability, rollout, rollback, and tests.
4. Rank findings by severity and include file/line references when available.
5. Do not silently fix findings unless explicitly asked.
6. Run `singularity-flow prepare review`, complete the decision document, remove placeholders, and run `singularity-flow artifact scan`.
7. Do not submit or approve automatically.
