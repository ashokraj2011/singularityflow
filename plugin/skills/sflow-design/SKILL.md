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
2. Run `singularity-flow wm compose --phase design` and use the complete returned prompt. If composition reports unavailable World-Model intelligence—missing or unreachable, or stale under staleness `fail`—continue with its explicit zero-context evidence and ordinary repository access. Show any exact returned recovery command only as an optional improvement; do not run it from this skill or make it a prerequisite for design work. Never add the Story title or a conversational design objective as `--task`. Use available shared architecture and security grounding as evidence.
3. Read approved requirements, list/view relevant uploaded documents and designs, and inspect only the additional source locations identified by the grounding package.
4. Execute the composed prompt's **Human clarification checkpoint**. Use `ask_user` for one concise batch, wait, then record the accepted response with `singularity-flow clarification record design --response-file <json>`. Even if the evidence looks complete, ask the human to confirm the proposed boundaries, contracts, failure behavior, and material tradeoffs. Stop if interactive questions or the durable response record are unavailable.
5. Run `singularity-flow prepare design` and complete the returned document.
6. Cover components, interfaces, data flow, alternatives, compatibility, security, privacy, observability, migration, rollout, rollback, risks, and an ordered implementation plan.
7. State assumptions and tradeoffs. Do not implement production code.
8. Run `singularity-flow phase draft-check design --json`. Correct every agent finding now from governed evidence; recheck up to three changed fingerprints and stop on an unchanged fingerprint. Never blindly delete markers, invent facts or padding, invoke a nested model, or overwrite another producer; route it to its owner/regenerator.
9. Only when `status` is `ready`, publish with the exact configured producer/channel. Race-time `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once if ready, never loop.
10. Run `singularity-flow phase show design --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
11. Report the publication commit and token status. Do not submit or approve automatically. End with `Next in Copilot: /sf-submit design`, followed by `Terminal equivalent: singularity-flow submit design`.
