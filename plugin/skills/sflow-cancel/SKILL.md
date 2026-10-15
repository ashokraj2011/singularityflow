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
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

This is an explicit human lifecycle decision, not an artifact-generation task.

1. Run `singularity-flow status [WORK-ID]` and show the current phase, generated artifacts, approvals, branch, and publication state.
2. Require the human to provide a non-empty cancellation reason. Never invent or infer the reason.
3. Explain that cancellation stops the lifecycle but preserves the Story branch, state, artifacts, approvals, telemetry, and Git history. It does not claim successful completion and does not delete files.
4. Ask the human for explicit confirmation of the exact Work ID.
5. Run `singularity-flow cancel <WORK-ID> --fetch --reason "<exact reason>" --confirm <WORK-ID>`.
6. Stop on a stale/diverged branch, pending publication, closed Story, already-cancelled Story, or confirmation mismatch. Never reset, rebase, force-push, or delete the branch.
7. If cancellation reports remaining uncommitted paths, explain that a new Story will remain blocked until they are preserved. Run `singularity-flow cancel <WORK-ID> --release --json` to preview the exact paths, stash consequence, and recorded base branch. Ask separately whether to apply that release; never infer this authority from the cancellation confirmation.
8. Only after explicit release approval, run `singularity-flow cancel <WORK-ID> --release --apply --confirm <WORK-ID> --json`. Report the durable stash SHA and recovery command exactly. The archived branch and governed history remain intact.
9. Report the cancellation reason, human Git identity, governed agent audit context, phase, commit, push, and that the Story is now visible under **Archived** in VS Code.
