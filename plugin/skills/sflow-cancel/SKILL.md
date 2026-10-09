---
name: sflow-cancel
description: Cancel an active governed Story, preserve all generated artifacts and approvals, record the human reason and identity, commit and push the decision, and move the Story to Archived.
disable-model-invocation: true
argument-hint: "[WORK-ID] --reason 'explanation'"
---
# Cancel and archive governed work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

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
