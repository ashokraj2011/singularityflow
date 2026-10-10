---
name: sflow-workflow-rules
description: Background rules for Singularity Flow-managed SDLC work. Load when a repository has governed Story state at its configured work-item root or when the user discusses Singularity Flow phases, approvals, handoffs, or artifact registration.
disable-model-invocation: true
user-invocable: false
---
# Singularity Flow workflow contract

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

`/sf-session` is setup only; stop after its report. `workflow.json` is state, `singularity/workflow.yml` defines policy, and `.github/agents` owns prompts/views.

1. Before Story work run `singularity-flow session current --json`; require `ready`, use its `repositoryPath` as cwd, then run `singularity-flow status <WORK-ID> --json`. Repository-only configuration uses its own guarded skill.
2. Use only the returned branch, immutable `workflow.resolution.workItemRoot`, and CLI-returned artifact/input paths. Never assume a default root, skip phases, or hand-edit lifecycle state, `STATUS.md`, `documents.json`, or approvals.
3. Create documents only at paths returned by `singularity-flow prepare <PHASE>` or `singularity-flow phase show <PHASE> --json`. Upload via `singularity-flow documents upload`; register via `singularity-flow artifact add` or `singularity-flow artifact scan`.
4. Never store secrets. Treat approved artifacts as inputs and record deviations.
5. Before agent publication run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). On correction run read-only `singularity-flow recover <WORK-ID> --phase <phase> --json`; stay in this phase. Correct only proven agent-owned findings from evidence when `correction.sameTurn`; route other producers to their owner. Use returned `commands.publish` when `ready`; absent: relay `commands.next`, stop; never submit or approve. On race-time `ARTIFACT_AUTHORING_INCOMPLETE`, recheck once; never invent, pad, nest models, overwrite producers, or loop. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
6. Run `singularity-flow gate` before review and `singularity-flow gate --terminal` before merge readiness. Tag tests with full clauses such as `@ac:WORK-ID:AC-001`.
7. Compose the exact phase prompt. Missing/stale/unreachable WM means zero-byte World-Model context and file access. Returned `singularity-flow wm ensure ...` is optional, once after separate explicit contributor consent; never delay phase work. Add `--evidence` for verification/review/release.
8. Never choose a workflow. Use the phase-default agent unless `/sf-agent` was invoked; only matching human authority may approve, and `singularity-flow approve` requires an explicit approval request.
9. Never run `singularity-flow next`. For `/sf-next`, run `singularity-flow nextsteps <WORK-ID> --json`, load the first `NOW` returned SFlow skill route, complete its preflight, execute at most one authorized action, and stop.
10. Show `/sf-*` before its complete `singularity-flow ...` equivalent. Record accepted clarifications before publication; never turn a hypothesis into a requirement or design decision.
