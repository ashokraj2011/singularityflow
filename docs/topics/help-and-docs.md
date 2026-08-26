---
id: help-and-docs
title: Getting help
aliases:
  - help
  - explain
  - docs
questions:
  - How can I ask Singularity Flow a natural-language question?
  - What can sf-help answer?
keywords:
  - natural language
  - cited answer
  - help intent
commands:
  - nextsteps
  - doctor
  - about
  - help
  - explain
related:
  - getting-started
  - nextsteps
version: 4
---
Every command supports `--help` (without executing). `sflow nextsteps` answers "what should I do here" from state; `sflow doctor` answers "why is my machine unhappy" with named fixes. Product questions in Copilot are answered from these packaged topics — grounded in the served text with the topic cited, never from model memory; questions with no matching topic say so and list the nearest topics. Judgment questions ("should I escalate?") are for `nextsteps` and the humans your pinned configuration names.

`/sf-help` accepts a topic ID or an ordinary question. The model-free router first classifies the
answer shape as concept, procedure, diagnosis, comparison, command discovery, or recovery. It then
matches only authored topic metadata and returns the cited topic bytes. Exact IDs and aliases win;
a weak match is refused and a close tie returns choices. This classification selects help content,
never a lifecycle operation. Questions about current blockers remain on the durable Home/readiness
path, and action-shaped prose still requires the normal explicit governed selection.

VS Code also contributes the explicit `@sflow` participant. Use `@sflow /help`, `/why`, `/how`,
`/recover`, or `/topics`. It uses the same resolver and never calls the chat model. Its action
buttons open a partial `/sf-*` query for review; they do not submit the query or execute a lifecycle
command.

## Purpose and prerequisites

Use this topic when the current goal matches **help and docs**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow nextsteps`, `sflow doctor`, `sflow about`, `sflow help`, `sflow explain`. Quote a natural question as one argument, for example `sflow explain "What is project binding?"`. Add `--here` when the concept should be paired with the current Story snapshot. Run `singularity-flow nextsteps --help` for the exact forms supported by this build.
- **Copilot:** `@sflow /why Why can’t I submit?`, `@sflow /help What is project binding?`, or the existing `/sf-nextsteps`, `/sf-doctor`, `/sf-about`, and `/sf-help` skills. Help relays bounded cited documentation and never mutates state.
- **VS Code:** open Singularity Flow **Help Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

The commands mapped to this topic are read-only. They may inspect local files and Git state, but they do not advance lifecycle state or grant authority. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain getting-started`, `sflow explain nextsteps`.
