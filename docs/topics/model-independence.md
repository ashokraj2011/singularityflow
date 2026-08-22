---
id: model-independence
title: Model independence
aliases:
  - no-model
  - model-policy
  - tripwire
commands:
  - doctor
related:
  - manual-authorship
  - telemetry-and-cost
version: 3
---
Every operation is classified `never`, `optional` (with a deterministic fallback), or `required`; unclassified operations are rejected, not assumed safe. One chokepoint invokes providers; the effective policy is the most restrictive in the call stack. `SINGULARITY_FLOW_NO_MODEL=1` (or `--no-model`) disables model use — most-restrictive-wins — and model-dependent commands fail fast with the manual alternative.

Deterministic light generation and previews retain that guarantee through aliases: `wm build --depth light`, `wm ensure --depth light`, `copilot --dry-run`, `workspace copilot --dry-run`, and `workspace impact analyze --dry-run` all resolve to registered `never` operations. A real launch or semantic analysis remains model-required.

## Purpose and prerequisites

Use this topic when the current goal matches **model independence**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow doctor`. Run `singularity-flow doctor --help` for the exact forms supported by this build.
- **Copilot:** `/sf-doctor`. The skill must preserve the CLI result and ask before any governed mutation.
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

Continue with `sflow explain manual-authorship`, `sflow explain telemetry-and-cost`.
