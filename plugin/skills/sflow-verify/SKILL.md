---
name: sflow-verify
description: Verify implementation against acceptance criteria, run checks, capture evidence, and register the Singularity Flow verification artifact.
disable-model-invocation: true
argument-hint: "[test scope or environment]"

---
# Verification phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, obey the pinned clarification mode, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow verify --json`. It resolves state and kernel operations. Stop at `recovery` or `approval`; otherwise continue with the returned authoring path.
2. From the Boundary result require `ready`, phase `verification`, and exact `phaseAgent` readiness; run `singularity-flow phase show verification --json`. Story context stays in the governed workflow.
3. Run `singularity-flow wm compose --phase verification --evidence`; use its prompt. If World-Model intelligence is unavailable, continue with repository evidence; recovery is optional. Never derive `--task` from Story text.
4. Read approved requirements, design, implementation, and source evidence.
5. Map each AC to executable evidence and qualified `@ac:WORK-ID:AC-001` in an executable test. Inspect planned source-bound `@clause:WORK-ID:REQ-001` comments as trace witnesses, never a passing verdict. Reject bare `AC-001` tags; exempt reviewed test-only/non-code clauses from source tagging.
6. Run tests and add missing tests when needed. Record exact commands and results.
7. Cover regression, boundaries, failures, security, accessibility, and performance as applicable.
8. Run `singularity-flow prepare verification`, complete the evidence without unobserved claims, and fill `Agent brief` with the verdict, material failures or omissions, residual risk, and release recommendation.
9. Run `singularity-flow phase draft-check verification --json`, then `singularity-flow phase prepublish verification --json`. If unready, run read-only `singularity-flow recover <WORK-ID> --phase verification --json`. Correct every agent finding now from evidence; route other producers to their owner. Recheck up to three changed fingerprints; stop on an unchanged fingerprint. Never delete markers blindly, invent facts, use padding, invoke nested models, or overwrite another producer.
10. Only when prepublish `status` is `ready`, publish with its exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
11. Run `singularity-flow phase show verification --json`; reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with ID, kind, bytes, and hash. A collapsible Shell/tool block does not count. Never say “shown above”; never replace it with a summary. For binary documents show absolute path, metadata, and open instruction.
12. Do not submit or approve automatically. End the handoff with the direct Copilot action first, followed by its terminal equivalent:
   - `Next in Copilot: /sf-submit verification`
   - `Terminal equivalent: singularity-flow submit verification`
