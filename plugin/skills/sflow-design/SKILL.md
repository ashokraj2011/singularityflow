---
name: sflow-design
description: Produce and register the architecture and design artifact for the active Singularity Flow design phase, grounded in approved requirements and the codebase.
argument-hint: "[design constraints or emphasis]"
disable-model-invocation: true
---
# Architecture and design phase

1. Run `singularity-flow status --json`; stop if the current phase is not `design`.
2. Run `singularity-flow wm compose --phase design --task "<design objective>"` and use the complete returned prompt. If the model or exact task guide is missing or stale, first run `singularity-flow wm build --phase design --task "<design objective>"`, then rerun the identical compose command. Use architecture and security grounding as evidence.
3. Read approved requirements, list/view relevant uploaded documents and designs, and inspect only the additional source locations identified by the grounding package.
4. Run `singularity-flow prepare design` and complete the returned document.
5. Cover components, interfaces, data flow, alternatives, compatibility, security, privacy, observability, migration, rollout, rollback, risks, and an ordered implementation plan.
6. State assumptions and tradeoffs. Do not implement production code.
7. Remove every placeholder and run `singularity-flow phase publish design`.
8. Run `singularity-flow phase show design --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
9. Report the publication commit and token status. Do not submit or approve automatically.
