---
id: nextsteps
title: Guidance — nextsteps and the narration contract
aliases:
  - guidance
  - now-then
  - no-dead-ends
commands:
  - nextsteps
  - guide
  - next
  - recommend
related:
  - getting-started
  - sequence-gates
version: 5
---
`sflow nextsteps` computes the ordered, valid next actions from pinned state — NOW, THEN, and alternatives, each with a reason and a runnable command. Command results follow the same narration contract: outputs explain why you are seeing them (which state, which pin, which rule) and end with a next action or an explicit rest state. Refusals name each unmet condition, its evidence, and the repair command — a gate is never "no," it is "not yet, and here is the path."

## Purpose and prerequisites

Use this topic when the current goal matches **nextsteps**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow recommend` gives one grounded recommendation; `sflow nextsteps` shows the full ordered plan; `sflow next` explicitly executes one lifecycle action. Run `singularity-flow recommend --help` for the exact forms supported by this build.
- **Copilot:** `/sf-nextsteps`, `/sf-next`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

The displayed world-model prerequisite and `sflow next` use the shared repository model keyed by
the scoped source snapshot. Story context is supplied separately by the governed workflow prompt.
Copilot must run the displayed prerequisite exactly and invoke `singularity-flow next` without
adding either the Story title or current conversation as a `--task` value.

## State and safety

These commands can mutate governed or machine-local state: `next`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain getting-started`, `sflow explain sequence-gates`.
