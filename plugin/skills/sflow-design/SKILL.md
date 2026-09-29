---
name: sflow-design
description: Produce and register the architecture and design artifact for the active Singularity Flow design phase, grounded in approved requirements and the codebase.
disable-model-invocation: true
argument-hint: "[design constraints or emphasis]"

---
# Architecture and design phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, obey the pinned clarification mode, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Run `singularity-flow status --json`; require `design`. Its governed workflow is Story context.
2. Run `singularity-flow wm compose --phase design` and use its complete prompt. If WM is missing/unreachable/stale, continue with zero-context evidence and repository access; show recovery as optional, never prerequisite. Never derive `--task` from Story text. Use available architecture/security evidence.
3. Read approved requirements and relevant uploads; inspect grounding-selected source.
4. Execute the prompt's **Human clarification checkpoint**: `ask_user` in one batch, wait, then record accepted answers via `singularity-flow clarification record design --response-file <json>`. Even if evidence looks complete, confirm boundaries, contracts, failures, and tradeoffs. Stop if questions or durable recording are unavailable.
5. Run `singularity-flow prepare design` and complete the returned document.
6. Cover components, interfaces, data flow, alternatives, compatibility, security, privacy, observability, migration, rollout/rollback, risks, and implementation order.
7. State assumptions and tradeoffs. Do not implement production code.
8. Run `singularity-flow phase draft-check design --json`, then `singularity-flow phase prepublish design --json`. If unready, run read-only `singularity-flow recover <WORK-ID> --phase design --json`; stay in this phase. Correct every agent finding now from governed evidence only when `correction.sameTurn`; otherwise route to its owner/regenerator. Recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer.
9. Only when prepublish `status` is `ready`, publish with its exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop. Never submit or approve.
10. Run `singularity-flow phase show design --json`; reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with ID, kind, bytes, hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binaries show path, metadata, open instruction.
11. Report commit and tokens. End with `Next in Copilot: /sf-submit design` and `Terminal equivalent: singularity-flow submit design`; do not submit or approve.
