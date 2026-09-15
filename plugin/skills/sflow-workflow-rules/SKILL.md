---
name: sflow-workflow-rules
description: Background rules for Singularity Flow-managed SDLC work. Load when a repository has governed Story state at its configured work-item root or when the user discusses Singularity Flow phases, approvals, handoffs, or artifact registration.
disable-model-invocation: true
user-invocable: false
---
# Singularity Flow workflow contract

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

`/sf-session` is setup only; stop after its report. `workflow.json` is state, `singularity/workflow.yml` defines policy, and `.github/agents` owns prompts/views.

1. Before Story work run `singularity-flow session current --json`; require `ready`, use its `repositoryPath` as cwd, then run `singularity-flow status <WORK-ID> --json`. Repository-only configuration uses its own guarded skill.
2. Use only the returned branch, immutable `workflow.resolution.workItemRoot`, and CLI-returned artifact/input paths. Never assume a default root, skip phases, or hand-edit lifecycle state, `STATUS.md`, `documents.json`, or approvals.
3. Create phase documents only at paths returned by `singularity-flow prepare <PHASE>` or `singularity-flow phase show <PHASE> --json`. Upload evidence with `singularity-flow documents upload`; register changes with `singularity-flow artifact add` or `singularity-flow artifact scan`.
4. Never store secrets. Treat approved artifacts as inputs and record deviations.
5. Before agent publication run `singularity-flow phase draft-check <phase> --json`; correct findings from evidence, stop on an unchanged fingerprint or after three fingerprints, and publish only when `ready` with the configured producer/channel. On race-time `ARTIFACT_AUTHORING_INCOMPLETE`, recheck once; never invent, pad, nest models, overwrite producers, or loop.
6. Run `singularity-flow gate` before review and `singularity-flow gate --terminal` before merge readiness. Tag tests with full clauses such as `@ac:WORK-ID:AC-001`.
7. Compose the exact phase prompt. If World-Model intelligence is missing, stale, or unreachable, continue with explicit zero-byte World-Model context and ordinary file access. An exact returned `singularity-flow wm ensure ...` command is optional and may run once only after separate explicit contributor consent; never delay phase work. Add `--evidence` for verification/review/release.
8. Never choose a workflow. Use the phase-default agent unless `/sf-agent` was invoked; only matching human authority may approve, and `singularity-flow approve` requires an explicit approval request.
9. Never run `singularity-flow next`. For `/sf-next`, run `singularity-flow nextsteps <WORK-ID> --json`, load the first `NOW` returned SFlow skill route, complete its preflight, execute at most one authorized action, and stop.
10. Show `/sf-*` before its complete `singularity-flow ...` equivalent. Record accepted clarifications before publication; never turn a hypothesis into a requirement or design decision.
