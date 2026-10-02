---
name: sflow-release
description: Prepare the Singularity Flow release-readiness artifact with deployment, observability, rollback, communication, and final readiness decision.
disable-model-invocation: true
argument-hint: "[target environment or release window]"

---
# Release-readiness phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. From the Boundary result require `ready`, phase `release`, and exact `phaseAgent` readiness even after the same agent ID; run `singularity-flow phase show release --json`. Story context stays in the governed workflow.
2. Run `singularity-flow wm compose --phase release --evidence`; use its complete prompt and available release/operations/security grounding. Missing/unreachable/stale WM means zero-context evidence and ordinary repository access. Show returned recovery as optional; never run it here or block release on it. Never derive `--task` from Story prose.
3. Read all approved phase artifacts and the deployment locations selected by the grounding package.
4. Run `singularity-flow prepare release`; complete the release report and nonempty `artifacts/release/verification/` bundle. In `verification/evidence-index.md`, bind approved Verification generation, exact paths/hashes, observed results, and gaps. Never invent evidence.
5. Include preconditions, deployment steps, migrations, flags, configuration, validation, metrics, alerts, success criteria, rollback triggers and steps, communication, ownership, and support escalation.
6. Run `singularity-flow phase draft-check release --json`, then `singularity-flow phase prepublish release --json`. If unready, run read-only `singularity-flow recover <WORK-ID> --phase release --json`; stay in this phase. Correct every agent finding now from governed evidence only when `correction.sameTurn`; otherwise route to its owner/regenerator. Recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer.
7. Only when prepublish `status` is `ready`, publish with its exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
8. Run `singularity-flow phase show release --json`; retain `displayBinding` and `reviewBinding`. Reuse bodies only from a complete visible same-chat display with exactly matching non-null `displayBinding`. Otherwise reproduce every published text document in full: ID/kind/path/bytes/generation/SHA-256 and `--- BEGIN <path> ---` / `--- END <path> ---`. New chat, changed/null binding, omissions or truncation require full display. Tool output or summaries are not review. Binary: path/metadata/open instruction. Show the current `reviewBinding`; body reuse never reuses approval consent.
9. Do not submit or approve automatically. End with `Next in Copilot: /sf-submit release`, followed by `Terminal equivalent: singularity-flow submit release`.
