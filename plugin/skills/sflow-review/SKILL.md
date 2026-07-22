---
name: sflow-review
description: Perform an independent Singularity Flow review, record actionable findings, and register the review decision.
argument-hint: "[review emphasis]"
disable-model-invocation: true
---
# Independent review phase

1. Run `singularity-flow status --json`; stop if the current phase is not `review`.
2. Run `singularity-flow wm compose --phase review --task "<review scope>" --evidence` and use the complete returned prompt. If the model or exact task guide is missing or stale, first run `singularity-flow wm build --phase review --task "<review scope>"`, then rerun the identical compose command. Use architecture, development, testing, security, and evidence grounding.
3. Read approved requirements, design, implementation summary, verification evidence, the actual diff, and selected source evidence.
4. Review correctness, acceptance coverage, maintainability, architecture alignment, security, failures, observability, rollout, rollback, and tests.
5. Rank findings by severity and include file/line references when available.
6. Do not silently fix findings unless explicitly asked.
7. If the configured workflow includes review, run `singularity-flow prepare review`, complete the decision document, remove placeholders, and run `singularity-flow phase publish review`.
8. Run `singularity-flow phase show review --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
9. Do not submit or approve automatically.
