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

1. Run `singularity-flow verify --json`; stop at `recovery` or `approval`. When the Boundary phase is `release`, do not run verification authoring: if the returned first `NOW` action is `singularity-flow prepare release`, hand off: `Next in Copilot: /sf-release`; `Terminal equivalent: singularity-flow prepare release`; then stop. For any other release action, relay its exact returned Copilot and Shell routes and stop.
2. Require Boundary `ready`, phase `verification`, and exact `phaseAgent` readiness; run `singularity-flow phase show verification --json`. For another phase, relay router action and stop. Keep Story context governed.
3. Run `singularity-flow wm compose --phase verification --evidence`; use its prompt. Missing WM is non-blocking; use repository evidence. Never derive `--task` from Story text.
4. Read approved requirements, design, implementation, source evidence.
5. Map each AC to evidence and qualified `@ac:WORK-ID:AC-001` in an executable test. Inspect source-bound `@clause:WORK-ID:REQ-001` as a trace witness, not a verdict. Reject bare `AC-001`; honor reviewed test-only/non-code exemptions.
6. Run/add tests. Record exact commands and results.
7. Cover regression, boundaries, failures, security, accessibility, performance as applicable.
8. Run `singularity-flow prepare verification`; fill evidence without unobserved claims and `Agent brief` with verdict, failures/omissions, risk, release recommendation.
9. Run `singularity-flow phase draft-check verification --json`, then `singularity-flow phase prepublish verification --json`. If unready, run read-only `singularity-flow recover <WORK-ID> --phase verification --json`. Correct every agent finding now; route other producers to owner. Recheck up to three changed fingerprints; stop on an unchanged fingerprint. Never delete markers blindly, invent facts, use padding, invoke nested models, or overwrite another producer.
10. Only when prepublish `status` is `ready`, publish with its exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
11. Run `singularity-flow phase show verification --json`; reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with ID, kind, bytes, hash. A collapsible Shell/tool block does not count. Never say “shown above”; never replace it with a summary. For binaries show path, metadata, open instruction.
12. Do not submit or approve automatically. End the handoff with the direct Copilot action first, followed by its terminal equivalent:
   - `Next in Copilot: /sf-submit verification`
   - `Terminal equivalent: singularity-flow submit verification`
