---
name: sflow-workflow-rules
description: Background rules for Singularity Flow-managed SDLC work. Load when a repository has governed Story state at its configured work-item root or when the user discusses Singularity Flow phases, approvals, handoffs, or artifact registration.
disable-model-invocation: true
user-invocable: false
---
# Singularity Flow workflow contract

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

`/sf-session` is setup only; stop after its report. `workflow.json` is state, `singularity/workflow.yml` defines policy, and `.github/agents` owns prompts/views.

1. Before Story work run `singularity-flow session current --json`; require `ready`, use its `repositoryPath` as cwd, then run `singularity-flow status <WORK-ID> --for-agent --json`. Repository-only configuration uses its own guarded skill.
2. Use only the returned branch, immutable `workflow.resolution.workItemRoot`, and CLI-returned artifact/input paths. Never assume a default root, skip phases, or hand-edit lifecycle state, `STATUS.md`, `documents.json`, or approvals.
3. Create documents only at paths returned by `singularity-flow prepare <PHASE>` or `singularity-flow phase show <PHASE> --for-agent --json`. Upload via `singularity-flow documents upload`; register via `singularity-flow artifact add` or `singularity-flow artifact scan`.
4. Never store secrets. Treat approved artifacts as inputs and record deviations.
5. Before agent publication run `singularity-flow phase prepublish <phase> --for-agent --json --publish-if-ready` (includes draft-check). On correction run read-only `singularity-flow recover <WORK-ID> --phase <phase> --for-agent --json`; stay in this phase. Correct only proven agent-owned findings from evidence when `correction.sameTurn`; route other producers to their owner. Use returned `commands.publish` when `ready` unless `publishIfReady.published`; absent: relay `commands.next`, stop; never submit or approve. On race-time `ARTIFACT_AUTHORING_INCOMPLETE`, recheck once; never invent, pad, nest models, overwrite producers, or loop. Follow returned `repairLoop.protocol` for persistent correction/resume; never recheck an unchanged draft; same findings after a change: correct differently, up to `correction.maximumChangedFingerprints` changed drafts, then stop.
6. Submit and approval run the governance and final checks themselves; never run a separate gate first. Tag tests with full clauses such as `@ac:WORK-ID:AC-001`.
7. Compose the exact phase prompt. The Repository brief is guidance; a missing one never delays phase work.
8. Never choose a workflow. Use the phase-default agent unless `/sf-agent` was invoked; only matching human authority may approve, and `singularity-flow approve` requires an explicit approval request.
9. Never run `singularity-flow next`. For `/sf-next`, run `singularity-flow nextsteps <WORK-ID> --for-agent --json`, load the first `NOW` returned SFlow skill route, complete its preflight, execute at most one authorized action, and stop.
10. Show `/sf-*` before its complete `singularity-flow ...` equivalent. Record accepted clarifications before publication; never turn a hypothesis into a requirement or design decision.
