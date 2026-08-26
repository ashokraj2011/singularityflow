---
id: copilot-and-surfaces
title: Copilot, VS Code, and shell surfaces
aliases:
  - copilot
  - surfaces
  - vscode
  - shell
commands:
  - about
  - help
  - plugin
related:
  - developer-home
  - help-and-docs
  - governed-execution
version: 5
---
CLI, Copilot, and VS Code read the same durable repository and workspace records through shared projections. They do not share an in-memory global store, conversation history, or signed handles. Copilot accepts ordinary developer language for seven closed intents: orient, continue, start, inspect, act, recover, and help. Help retrieves cited packaged documentation; it does not convert an answer into an action.

## Purpose and prerequisites

Use this topic when the current goal matches **copilot and surfaces**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow about`, `sflow help`, `sflow plugin`. Use `sflow home --request "What is blocking this Story?" --json` to inspect the conversational plan. Run `singularity-flow about --help` for the exact forms supported by this build.
- **Copilot:** ask “What am I working on?”, “Continue my Story”, “Start a new bug fix”, “What is blocking this?”, “Generate the active phase”, “The publication push is stuck”, or “What is project binding?” `/sf-home`, `/sf-help`, `/sf-start`, and the other `/sf-*` skills remain explicit escape hatches.
- **VS Code:** open the Singularity Flow Navigator. My Work, Start intake, and Inbox are suggested as first-use Favorites; use **Favorites → Choose favorites** to change them or pin Approvals, Workspaces, Configuration, impact, logs, audit, or Help. Favorites and Lifecycle start expanded while supporting sections stay collapsed, and the extension preserves later choices. It renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Ask naturally or read current state with `sflow home`, `sflow status`, or the relevant list/status form. The conversational layer selects a read planner only; it never turns prose directly into a lifecycle mutation.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Read-only orientation, inspection, and recovery diagnosis may run immediately. For Start, Continue, Generate, Submit, or Next, review the proposed action and its effects, then explicitly select it. Approval, rejection, cancellation, resets, and destructive operations require their exact `/sf-*` skill and ceremony.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.
6. In VS Code, pin frequently used menus from **Favorites → Choose favorites**. Launching a favorite executes the original command; it does not bypass confirmation or authority checks.

## State and safety

These commands can mutate governed or machine-local state: `plugin`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Automatic Home invocation is not mutation consent. Raw developer prose is not retained in the conversational plan; only the deterministic intent and route are returned. VS Code Favorites store only stable menu IDs in personal global state; they never store lifecycle data or enter Git. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- If ordinary language is ambiguous, choose from the displayed Home directions or invoke `/sf-home`; the router deliberately refuses to guess between mutations.
- If a favorite disappears after an upgrade, reopen **Choose favorites**. Unknown or retired menu IDs are discarded rather than guessed.

## Related topics

Continue with `sflow explain developer-home`, `sflow explain help-and-docs`, `sflow explain governed-execution`.
