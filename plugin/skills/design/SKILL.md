---
name: design
description: Produce and register the architecture and design artifact for the active Singularity Flow design phase, grounded in approved requirements and the codebase.
argument-hint: "[design constraints or emphasis]"
disable-model-invocation: true
---
# Architecture and design phase

1. Run `singularity-flow status --json`; stop if the current phase is not `design`.
2. Ground the phase with `singularity-flow wm context design --task "<design objective>" --concat`. If missing or stale, run `singularity-flow wm build --phase design --task "<design objective>"`, then rerun context. Use the architecture and security views as evidence.
3. Read approved requirements and only the additional source locations identified by the grounding package.
4. Run `singularity-flow prepare design` and complete the returned document.
5. Cover components, interfaces, data flow, alternatives, compatibility, security, privacy, observability, migration, rollout, rollback, risks, and an ordered implementation plan.
6. State assumptions and tradeoffs. Do not implement production code.
7. Remove every placeholder and run `singularity-flow artifact add <design-path> --kind design`.
8. Do not submit or approve automatically.
