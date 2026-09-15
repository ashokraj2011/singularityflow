---
name: sflow-requirements
description: Produce and register the requirements artifact for the active Singularity Flow requirements phase, including scope and testable acceptance criteria.
disable-model-invocation: true
argument-hint: "[additional business context]"

---
# Requirements phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, obey the pinned clarification mode, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow status --json`; stop unless the current phase is `requirements`. Use its governed workflow.
2. Run `documents list`; view relevant inputs before deciding what is unclear.
3. Run `singularity-flow wm compose --phase requirements` and use its complete prompt. If World-Model intelligence is unavailable, continue with zero context and ordinary repository access; show recovery only as optional. Never derive `--task` from Story text.
4. Execute the composed prompt's **Human clarification checkpoint** before preparation. Use `ask_user` for one concise batch and wait. This starter phase is `required`: even when the evidence looks complete, ask the contributor to confirm your concise interpretation of outcome, scope, and acceptance criteria. Write the accepted batch to a temporary JSON file, run `singularity-flow clarification record requirements --response-file <file>`, and stop if the record is rejected as absent or stale. Incorporate accepted answers into the artifact. If `ask_user` is unavailable, display the questions and stop before preparation.
5. Run `singularity-flow prepare requirements` and read the returned path and `source.json`.
6. Inspect other files only when world-model evidence points to them. Do not implement code.
7. Complete the document with the problem, desired outcome, in/out scope, measurable `AC-n` acceptance criteria, dependencies, assumptions, risks, confirmed clarification decisions, and explicitly deferred open questions.
8. Run `singularity-flow phase draft-check requirements --json`. Correct every agent finding now from governed evidence; recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer; route it to its owner/regenerator.
9. Only when `status` is `ready`, publish via `singularity-flow phase publish requirements` with its configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop.
10. Run `singularity-flow phase show requirements --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
11. Summarize confirmed clarification decisions, unresolved decisions, token status, and publication commit. Do not submit or approve automatically. End with `Next in Copilot: /sf-submit requirements`, followed by `Terminal equivalent: singularity-flow submit requirements`.
