---
name: sflow-review
description: Perform an independent Singularity Flow review, record actionable findings, and register the review decision.
disable-model-invocation: true
argument-hint: "[review emphasis]"

---
# Portable review bundle and independent review

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

First run `singularity-flow review` and reproduce its unified artifact, approved-input provenance, checks, decisions, source-change summary, usage, and supporting evidence. Use `singularity-flow review --format html --out <file>` when the user wants a portable browser view.

1. Run `singularity-flow status --json` and use that governed workflow as Story context. If the configured workflow has no phase named `review`, use the bundle to review the active phase and do not require that phase ID.
2. Run `singularity-flow wm compose --phase review --evidence` and use the complete returned prompt. If composition reports unavailable World-Model intelligence—missing or unreachable, or stale under staleness `fail`—continue with its explicit zero-context evidence and ordinary repository access. Show any exact returned recovery command only as an optional improvement; do not run it from this skill or make it a prerequisite for review. Never add the Story title or a conversational review scope as `--task`. Use available shared architecture, development, testing, security, and evidence grounding.
3. Read approved requirements, design, implementation summary, verification evidence, the actual diff, and selected source evidence.
4. Review correctness, acceptance coverage, maintainability, architecture alignment, security, failures, observability, rollout, rollback, and tests.
5. Rank findings by severity and include file/line references when available.
6. Do not silently fix findings unless explicitly asked.
7. If configured, prepare and complete review, then run `singularity-flow phase draft-check review --json`. Correct every agent finding now from governed evidence; recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer; route it to its owner/regenerator.
8. Only when `status` is `ready`, publish with the exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop.
9. When review was published, run `singularity-flow phase show review --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
10. Do not submit or approve automatically. When review was published, end with `Next in Copilot: /sf-submit review`, followed by `Terminal equivalent: singularity-flow submit review`.
