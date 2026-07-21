---
name: design
description: Produce and register the architecture and design artifact for the active Singularity Flow design phase, grounded in approved requirements and the codebase.
argument-hint: "[design constraints or emphasis]"
disable-model-invocation: true
---
# Architecture and design phase

1. Run `singularity-flow status --json`; stop if the current phase is not `design`.
2. Read approved requirements and the repository architecture.
3. Run `singularity-flow prepare design` and complete the returned document.
4. Cover components, interfaces, data flow, alternatives, compatibility, security, privacy, observability, migration, rollout, rollback, risks, and an ordered implementation plan.
5. State assumptions and tradeoffs. Do not implement production code.
6. Remove every placeholder and run `singularity-flow artifact add <design-path> --kind design`.
7. Do not submit or approve automatically.
