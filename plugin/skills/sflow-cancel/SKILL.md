---
name: sflow-cancel
description: Cancel an active governed Story, preserve all generated artifacts and approvals, record the human reason and identity, commit and push the decision, and move the Story to Archived.
disable-model-invocation: true
argument-hint: "[WORK-ID] --reason 'explanation'"
---
# Cancel and archive governed work

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

This is an explicit human lifecycle decision, not an artifact-generation task.

1. Run `singularity-flow status [WORK-ID]` and show the current phase, generated artifacts, approvals, branch, and publication state.
2. Require the human to provide a non-empty cancellation reason. Never invent or infer the reason.
3. Explain that cancellation stops the lifecycle but preserves the Story branch, state, artifacts, approvals, telemetry, and Git history. It does not claim successful completion and does not delete files.
4. Ask the human for explicit confirmation of the exact Work ID.
5. Run `singularity-flow cancel <WORK-ID> --fetch --reason "<exact reason>" --confirm <WORK-ID>`.
6. Stop on a stale/diverged branch, pending publication, completed Story, already-cancelled Story, or confirmation mismatch. Never reset, rebase, force-push, or delete the branch.
7. Report the cancellation reason, human Git identity, governed agent audit context, phase, commit, push, and that the Story is now visible under **Archived** in VS Code.
