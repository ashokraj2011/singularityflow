---
id: starting-work
title: Starting work
aliases:
  - start
  - intake
  - jira-intake
  - story-file
commands:
  - start
  - story
related:
  - epics-and-planning
  - pins
  - work-intervals
version: 3
---
Three intake doors, one result: Jira, a manual description, or a Story released from an Epic breakdown. For every new Jira or manual Story, first run `sflow workspace branches --json` and explicitly choose a branch published by every required repository. `sflow start PAY-1234 --jira --from-branch main` then refreshes that remote base, verifies that the configured remote can accept `PAY-1234`, creates the canonical branch, pins its exact base commit, and pushes only `refs/heads/PAY-1234`. The selected base ref is never changed. Existing and Epic-materialized Stories keep their already-pinned lineage instead of choosing a second base.

## Purpose and prerequisites

Use this topic when the current goal matches **starting work**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow start`, `sflow story`. Run `singularity-flow start --help` for the exact forms supported by this build.
- **Copilot:** `/sf-start`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **My Work and Workspaces**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, configured remote, and remote base branches. Remote access is mandatory and no branch is preselected.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `start`, `story`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace branches --json` before retrying.
- If remote branch discovery or publication preflight fails, fix the configured Git remote before retrying. No Story branch or state has been created yet.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain epics-and-planning`, `sflow explain pins`, `sflow explain work-intervals`.
