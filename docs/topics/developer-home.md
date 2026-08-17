---
id: developer-home
title: Developer Home and returning to work
aliases:
  - home
  - return-to-work
  - talk-to-sflow
commands:
  - home
  - choices
related:
  - starting-work
  - story-lifecycle
  - nextsteps
version: 4
---
`sflow home` is the read-only front door for a developer. It resolves the active workspace and repository, reports the current Story and repository freshness, and offers no more than six deterministic next choices. `sflow home --request "<ordinary developer request>"` also returns a versioned plan for orient, continue, start, inspect, act, or recover. Home reads the local Git identity's display name and uses its first name once to personalize human replies in the shell, My Work, and Copilot. The presentation name never participates in authority, handle binding, lifecycle state, or telemetry. It never fetches, checks out a branch, mutates lifecycle state, or invokes a model. In VS Code, **My Work** is the visible home. **Talk to SFlow** remains only as a hidden compatibility command for old links and opens that same My Work surface.

## Purpose and prerequisites

Use this topic when the current goal matches **developer home**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow home`, `sflow home --request "What should I do next?" --json`, `sflow choices`. Run `singularity-flow home --help` for the exact forms supported by this build.
- **Copilot:** ask naturally or invoke `/sf-home`. Orientation and inspection reads may run immediately. The skill must show the proposed effects and ask before any governed mutation.
- **VS Code:** open Singularity Flow **My Work and Workspaces**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read current state with `sflow home`, ask Copilot naturally, or use the relevant list/status form. Conversation planning always routes to a read planner and retains no raw request text.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation. Start, Continue, Generate, Submit, and Next require an explicit selection; ceremonies require their exact `/sf-*` invocation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

The commands mapped to this topic are read-only. They may inspect local files and Git state, but they do not advance lifecycle state or grant authority. Automatic invocation is not consent. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth; chat memory is not workflow state.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- If a request could mean more than one governed action, choose from the displayed options or use `/sf-home`; no mutation is silently selected.
- If the greeting is missing or incorrect, set the repository's local Git display name with `git config user.name "Your Name"`, then reopen Home. SFlow does not guess a name from email, login, or chat history.

## Related topics

Continue with `sflow explain starting-work`, `sflow explain story-lifecycle`, `sflow explain nextsteps`.
