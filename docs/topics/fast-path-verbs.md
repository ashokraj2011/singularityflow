---
id: fast-path-verbs
title: The five verbs
aliases:
  - fast-path
  - specify
  - spec-driven
  - five-verbs
commands:
  - specify
  - plan
  - implement
  - verify
  - converge
related:
  - story-lifecycle
  - starting-work
  - approvals
  - nextsteps
version: 2
---
`spec-driven-standard` Stories are driven by five verbs: `sflow specify`, `plan`, `implement`, `converge`, `verify`. Each is a router, not an autopilot — it resolves the subject, phase, generation, pending publication and approval state, then runs only the registered kernel operations that are legal before the next checkpoint and stops. A checkpoint is any boundary needing model generation, consent, human review, approval, external completion, or recovery. The verbs orchestrate; they never reimplement lifecycle rules, compute competing state, or bypass a transition, so the authoritative result is identical to running the underlying phase commands by hand. Every response names the milestone it is working toward, the checkpoint it stopped at, and the underlying operations — so a small vocabulary never hides which governed operation ran. A milestone counts only when workflow state proves it; a command returning successfully is not completion. Pending publication is routed before any new work. The advanced phase commands remain available and unchanged.

## Purpose and prerequisites

Use this topic when the current goal matches **fast path verbs**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow specify`, `sflow plan`, `sflow implement`, `sflow verify`, `sflow converge`. Run `singularity-flow specify --help` for the exact forms supported by this build.
- **Copilot:** `/sf-specify`, `/sf-plan`, `/sf-implement`, `/sf-verify`, `/sf-converge`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

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

Continue with `sflow explain story-lifecycle`, `sflow explain starting-work`, `sflow explain approvals`, `sflow explain nextsteps`.
