---
name: sflow-cancel
description: Cancel an active governed Story, preserve all generated artifacts and approvals, record the human reason and identity, commit and push the decision, and move the Story to Archived.
disable-model-invocation: true
argument-hint: "[WORK-ID] --reason 'explanation'"
---
# Cancel and archive governed work

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. A result whose `act.state` is `author`, or a returned route to the skill you are running, is this turn's own work: do it now; never relay it or end the turn on it. A file edit that does not match is not a refusal: read the file again and redo the edit. On a refusal or a blocker this step cannot clear, relay the returned route before ending: `remediationPlan` (run its first read-only step once and follow `context.strategy`), else `commandGuidance`, `nextAction`, `continuation.actions`, `recovery.actions` or `correction.skill`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

This is an explicit human lifecycle decision, not an artifact-generation task.

1. Run `singularity-flow status [WORK-ID]` and show the current phase, generated artifacts, approvals, branch, and publication state.
2. Require the human to provide a non-empty cancellation reason. Never invent or infer the reason.
3. Explain that cancellation stops the lifecycle but preserves the Story branch, state, artifacts, approvals, telemetry, and Git history. It does not claim successful completion and does not delete files.
4. Ask the human for explicit confirmation of the exact Work ID.
5. Run `singularity-flow cancel <WORK-ID> --fetch --reason "<exact reason>" --confirm <WORK-ID>`.
6. Stop on a stale/diverged branch, pending publication, closed Story, already-cancelled Story, or confirmation mismatch. Pending publication: `singularity-flow sync <WORK-ID>`; stale or diverged branch: `/sf-recover`; then rerun `/sf-cancel`. Never reset, rebase, force-push, or delete the branch.
7. If cancellation reports remaining uncommitted paths, explain that a new Story will remain blocked until they are preserved. Run `singularity-flow cancel <WORK-ID> --release --json` to preview the exact paths, stash consequence, and recorded base branch. Ask separately whether to apply that release; never infer this authority from the cancellation confirmation.
8. Only after explicit release approval, run `singularity-flow cancel <WORK-ID> --release --apply --confirm <WORK-ID> --json`. Report the durable stash SHA and recovery command exactly. The archived branch and governed history remain intact.
9. Report the cancellation reason, human Git identity, governed agent audit context, phase, commit, push, and that the Story is now visible under **Archived** in VS Code, or in `/sf-stories` for Copilot CLI users.
