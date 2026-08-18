---
id: resets-and-cleanup
title: Reset, cleanup, and fresh installation
aliases:
  - reset
  - factory-reset
  - reset-all
  - local-reset
commands:
  - factory-reset
  - reset-all
  - local-reset
related:
  - installation-and-upgrades
  - recovery
  - secrets
version: 2
---
Reset commands have deliberately different scopes. Preview the exact scope and use the confirmation printed by that same mode.

## Purpose and prerequisites

Use this topic when the current goal matches **resets and cleanup**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow factory-reset`, `sflow reset-all`, `sflow local-reset --forget-only`, or destructive `sflow local-reset`. Run `singularity-flow local-reset --help` for the exact forms supported by this build.
- **Copilot:** `/sf-factory-reset`, `/sf-local-reset`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Choose the boundary. Use `local-reset --forget-only` to forget this machine while preserving physical workspaces. Use `local-reset` with no mode flag only when the workspace directories and all their clones must be deleted.
2. In a script or JSON client, preview the exact mode first: `singularity-flow local-reset --forget-only --dry-run --json` or `singularity-flow local-reset --dry-run --json`.
3. Review `mode`, each workspace `disposition`, capability registry/cache targets, the VS Code reset marker, `remove`, and `preserve`.
4. Apply the identical mode with the previewed phrase. Forget-only requires `--forget-only --confirm "FORGET LOCAL"`; deletion requires `--confirm "RESET LOCAL"`. The phrases cannot authorize the other mode.
5. In an interactive terminal, omit `--dry-run` and `--confirm` to receive the same preview and an exact prompt in one invocation. Entering anything else, EOF, or cancellation changes nothing.
6. Reopen VS Code so the marker clears Singularity Flow SecretStorage credentials, global state, acknowledgements, handoffs, onboarding, favorites, persona, and global extension settings.

## State and safety

Forget-only removes the workspace registry and active selection, capability lead registry and organisation cache, other `~/.singularity-flow` state, supported custom registry/cache locations, and Singularity-named Copilot session state. It preserves workspace directories, repository clones, manifests, branches, worktrees, dirty files, `.git/singularity-flow` recovery state, remote capability maps, `sflow/config`, state/proposal branches, Git history, repository-owned `.vscode/settings.json`, and installed product surfaces.

Destructive local reset retains the existing stricter boundary: run it outside every workspace it will delete, and each existing registration must have an exact matching regular workspace manifest. Both modes reject symlink targets and dangerously broad custom directories, stage renames before committing, and roll back moved targets if application fails.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a non-interactive call has no confirmation, run the matching mode with `--dry-run` first. `--json` never prompts.
- If `FORGET LOCAL` is refused, keep `--forget-only` on both preview and apply. If `RESET LOCAL` is refused, remove `--forget-only`; never swap phrases.
- A corrupt workspace registry blocks physical deletion because directories cannot be proven. Forget-only can still remove the corrupt machine registration without touching any workspace bytes.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain installation-and-upgrades`, `sflow explain recovery`, `sflow explain secrets`.
