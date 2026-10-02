---
name: sflow-requirements
description: Produce and register the requirements artifact for the active Singularity Flow requirements phase, including scope and testable acceptance criteria.
disable-model-invocation: true
argument-hint: "[additional business context]"

---
# Requirements phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow status --json`; require current phase `requirements`. Its governed workflow is Story context.
2. Run `singularity-flow documents list`; view relevant inputs before deciding what is unclear.
3. Run `singularity-flow wm compose --phase requirements`; use its complete prompt. Missing WM means zero context and ordinary repo access; recovery is optional. Never derive `--task` from Story text.
4. Execute **Human clarification checkpoint** before preparation: `ask_user` once and wait. Mode is `required`: even when evidence looks complete, confirm outcome/scope/acceptance. Record via `singularity-flow clarification record requirements --response-file <file>` and include answers. Absent/stale answers or unavailable `ask_user`: display questions and stop before preparation.
5. Run `singularity-flow prepare requirements` and read the returned path and `source.json`.
6. Inspect only grounding-selected files. Do not implement code.
7. Cover problem, outcome, scope, measurable acceptance criteria with stable qualified `[WORK-ID:AC-001]` anchors (using the actual work ID), dependencies, assumptions, risks, confirmed decisions, and deferred questions. Never use a bare `AC-001` as the authoritative clause ID.
8. Run `singularity-flow phase draft-check requirements --json`, then `singularity-flow phase prepublish requirements --json`. If unready, run read-only `singularity-flow recover <WORK-ID> --phase requirements --json`; stay in this phase. Correct every agent finding now from governed evidence only when `correction.sameTurn`; otherwise route to its owner/regenerator. Recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer.
9. Only when prepublish `status` is `ready`, publish via `singularity-flow phase publish requirements` with its configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
10. Run `singularity-flow phase show requirements --json`; retain `displayBinding` and `reviewBinding`. Reuse bodies only from a complete visible same-chat display with exactly matching non-null `displayBinding`. Otherwise reproduce every published text document in full: ID/kind/path/bytes/generation/SHA-256 and `--- BEGIN <path> ---` / `--- END <path> ---`. New chat, changed/null binding, omissions or truncation require full display. Tool output or summaries are not review. Binary: path/metadata/open instruction. Show the current `reviewBinding`; body reuse never reuses approval consent.
11. Report decisions, tokens, and commit. End with `Next in Copilot: /sf-submit requirements` and `Terminal equivalent: singularity-flow submit requirements`; do not submit or approve.
