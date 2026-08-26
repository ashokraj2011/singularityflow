---
id: recovery
title: Recovery — nothing is ever lost
aliases:
  - sync
  - recover
  - pending-publication
  - crash
  - lost-laptop
questions:
  - Recover interrupted implementation
  - How do I recover after a failed phase on macOS?
  - How do I recover interrupted work?
  - Why was work interrupted before its governed commit completed?
commands:
  - sync
  - recover
  - doctor
  - refresh-branch
related:
  - checkpoints-pause-continue
  - sequence-gates
version: 5
---
Publication is a transaction: verified preconditions, an integrity-bound preimage written to the local journal, one isolated commit of allowlisted paths, compare-and-swap branch advance, and push without force. If the process dies before the commit, `sflow sync` reclaims its dead subject lock, preserves the partial bytes under `.git/singularity-flow/publication-rescues/`, and restores the exact pre-transaction governed state. If the commit exists but push failed, sync retries that exact commit once without regenerating or rewriting it. A live command is reported as active and is never rolled back. A branch-head race refuses rather than clobbering — reload and retry. A dead laptop costs nothing already committed: clone and `sflow resume`. `sflow doctor` diagnoses; `sflow recover` produces a content-addressed, model-free plan for transport, artifact, Agent Brief, code-delivery, and generation-intent blockers. Concurrent writes to the same work item are serialized by a subject lock and caught by a state fingerprint even when uncommitted.

## Purpose and prerequisites

Use this topic when the current goal matches **recovery**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow recover [WORK-ID] --phase <phase> --json` inspects without writing. An automatic action requires `--apply --confirm <planId>`. `sflow sync`, `sflow doctor`, and `sflow refresh-branch` remain available for their narrower roles.
- **Copilot:** `/sf-doctor`, `/sf-refresh-branch`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Inspect the plan. Each blocker names its stable code, category, phase/generation, evidence path and line, and one bounded action.
4. Edit authored content yourself when the action is guided. Recovery never fabricates a requirement, implementation, test, clarification, or approval.
5. For an automatic action, confirm the exact `planId`. The command recomputes repository HEAD and the worktree fingerprint and refuses a stale plan.
6. Re-read recovery once after completion. Retry the original lifecycle command only when its fingerprint changed.

For an interrupted publication, `sflow sync` selects the recovery action from the journal boundary:

- **Live owner:** stop and return to the terminal running the reported PID.
- **Dead owner, before commit:** restore the durable preimage and retain the interrupted bytes in the reported rescue directory.
- **Commit created, push incomplete:** publish the retained commit without rebasing, amending, or regenerating.
- **Legacy dirty journal without a preimage:** fail closed and require manual inspection; recovery never guesses what the previous bytes were.

## State and safety

Recovery inspection is read-only and never invokes a model or AST. `recover --apply`, `sync`, and `refresh-branch` can mutate governed or machine-local state and remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Pre-commit rollback touches only the governed roots named by the integrity-checked journal; unrelated source edits and staged files are not reset. Only system-owned transport and exact preimage restoration are automatic. Source, authored artifacts, policy, approvals, and human answers are never invented or repaired by a model. AST or a language pack being unavailable is advisory and cannot block recovery or ordinary file-based work.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a generation intent was already consumed, use the recovery plan's exact `phase begin` command. Existing source is adopted only when policy permits it and only with the current change-set digest.
- If the same blocker and `planId` return unchanged, stop. Repeating publish cannot change its preconditions.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain checkpoints-pause-continue`, `sflow explain sequence-gates`.
