---
name: sflow-design
description: Produce and register the architecture and design artifact for the active Singularity Flow design phase, grounded in approved requirements and the codebase.
argument-hint: "[design constraints or emphasis]"
disable-model-invocation: true
---
# Architecture and design phase

1. Run `singularity-flow status --json`; stop if the current phase is not `design`.
2. Ground the phase with `singularity-flow wm context design --task "<design objective>" --concat --no-persona`. If missing or stale, run `singularity-flow wm build --phase design --task "<design objective>"`, then rerun context. Use the architecture and security views as evidence.
3. Run `singularity-flow wm inject --phase design` and use the returned, rule-grounded persona prompt.
4. Read approved requirements, list/view relevant uploaded documents and designs, and inspect only the additional source locations identified by the grounding package.
5. Run `singularity-flow prepare design` and complete the returned document.
6. Cover components, interfaces, data flow, alternatives, compatibility, security, privacy, observability, migration, rollout, rollback, risks, and an ordered implementation plan.
7. State assumptions and tradeoffs. Do not implement production code.
8. Remove every placeholder and run `singularity-flow phase publish design`.
9. Report the publication commit and token status. Do not submit or approve automatically.
