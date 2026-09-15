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
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow verify --json`. It resolves state and kernel operations. Stop at `recovery` or `approval`; otherwise continue with the returned authoring path.
1. Run `singularity-flow status --json`; stop if the current phase is not `verification`. Use that governed workflow as Story context.
2. Run `singularity-flow wm compose --phase verification --evidence` and use its complete prompt. If World-Model intelligence is unavailable, continue with zero-context evidence and ordinary repository access; recovery is optional. Never derive `--task` from Story text.
3. Read approved requirements, design, implementation summary, and selected source evidence.
4. Map each acceptance criterion to executable or inspectable evidence and its `@ac:AC-n` test tag.
5. Run relevant tests and add missing tests when needed. Record exact commands and results.
6. Cover regression, negative cases, boundaries, failure modes, security, reliability, accessibility, and performance where applicable.
7. Run `singularity-flow prepare verification`, complete the evidence without unobserved claims, and fill `Agent brief` with the verdict, material failures or omissions, residual risk, and release recommendation.
8. Run `singularity-flow phase draft-check verification --json`. Correct every agent finding now from governed evidence; recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer; route it to its owner/regenerator.
9. Only when `status` is `ready`, publish with the exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop.
10. Run `singularity-flow phase show verification --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
11. Do not submit or approve automatically. End the handoff with the direct Copilot action first, followed by its terminal equivalent:
   - `Next in Copilot: /sf-submit verification`
   - `Terminal equivalent: singularity-flow submit verification`
