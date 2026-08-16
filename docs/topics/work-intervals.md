---
id: work-intervals
title: Work intervals
aliases:
  - intervals
  - free-work
  - baseline
commands:
  - story
related:
  - checkpoints-pause-continue
  - reconciliation
  - escalation
version: 2
---
Entering a source-writing phase opens a work interval automatically: the baseline pins the source-base commit, spec and policy hashes, protected paths, required checks, and the escalation ladder. Inside the interval you work free — any editor, any assistant, your own commits, offline; no check-ins, no narration, no timers, nothing watching. The system governs the boundaries of work, not the keystrokes. Stopping without any command is legal and breaks nothing. Pause duration is never exported or used as a productivity signal.

## Purpose and prerequisites

Use this topic when the current goal matches **work intervals**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow story`. Run `singularity-flow story --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `story`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain checkpoints-pause-continue`, `sflow explain reconciliation`, `sflow explain escalation`.
