---
id: resets-and-cleanup
title: Reset, cleanup, and fresh installation
aliases:
  - reset
  - factory-reset
  - reset-all
  - local-reset
  - uninstall
  - remove-sflow
questions:
  - How do I uninstall Singularity Flow without deleting my workspaces?
  - What does the distribution uninstaller preserve?
commands:
  - factory-reset
  - reset-all
  - local-reset
related:
  - installation-and-upgrades
  - recovery
  - secrets
version: 6
---
Reset commands have deliberately different scopes. Preview the exact scope and use the confirmation printed by that same mode.

## Purpose and prerequisites

Use this topic when the current goal matches **resets and cleanup**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow factory-reset`, `sflow reset-all`, `sflow local-reset --forget-only`, or destructive `sflow local-reset`. To remove installed product surfaces while preserving all governed data, run the promoted distribution's `./uninstall.sh`, `.\uninstall.ps1`, or `uninstall.cmd`. Run `singularity-flow local-reset --help` for the exact reset forms supported by this build.
- **Copilot:** `/sf-factory-reset`, `/sf-local-reset`. There is deliberately no Copilot command for machine-level product uninstall: uninstall removes the Copilot integration itself and must remain an explicit operating-system shell action.
- **VS Code:** open **Workspaces → Fast onboarding & Git → Destructive recovery**, or run
  **Singularity Flow: Factory Reset / Reinitialize Any Git Repository (Destructive)**. Choose the
  Git root, review what is removed and preserved, explicitly accept dirty SFlow data loss when
  present, and type the exact repository-bound confirmation. The apply is also bound to the
  preview's `resetScopeSha256`; any later branch, revision, path, or byte change forces a new
  preview. Application source, Git history, and remote `sflow/config`/`state` branches are preserved.
  Valid custom agents remain active. Invalid custom agents are preserved byte-for-byte under
  `.github/singularity-flow-recovered-agents/<sha256>/`, removed from active discovery, and shown
  with their exact source, destination, digest, size, and validation reason.

## Guided workflow

1. Choose the boundary. Use product uninstall to remove installed SFlow surfaces while retaining machine registrations and every repository. Use `local-reset --forget-only` to forget this machine while preserving physical workspaces. Use `local-reset` with no mode flag only when the workspace directories and all their clones must be deleted.
2. In a script or JSON client, preview the exact mode first: `singularity-flow local-reset --forget-only --dry-run --json` or `singularity-flow local-reset --dry-run --json`.
3. Review `mode`, each workspace `disposition`, capability registry/cache targets, the VS Code reset marker, `remove`, and `preserve`.
4. Apply the identical mode with the previewed phrase. Forget-only requires `--forget-only --confirm "FORGET LOCAL"`; deletion requires `--confirm "RESET LOCAL"`. The phrases cannot authorize the other mode.
5. In an interactive terminal, omit `--dry-run` and `--confirm` to receive the same preview and an exact prompt in one invocation. Entering anything else, EOF, or cancellation changes nothing.
6. Reopen VS Code so the marker clears Singularity Flow SecretStorage credentials, global state, acknowledgements, handoffs, onboarding, favorites, persona, and global extension settings.

## Uninstall product surfaces without deleting governed data

Run the platform uninstaller from an intact promoted distribution directory:

- macOS/Linux shell: `./uninstall.sh --artifact-key /trusted/artifact-builder-public.pem`
- Windows PowerShell: `.\uninstall.ps1 --artifact-key C:\trusted\artifact-builder-public.pem`
- Windows Command Prompt: `uninstall.cmd --artifact-key C:\trusted\artifact-builder-public.pem`

The wrapper invokes the packaged `sf-uninstall` runner. Its first invocation is a no-change preview
that lists the exact product surfaces, preserved data, and a fingerprinted `--confirm` phrase. Run
the same wrapper with that phrase to apply, or use `--yes` only when invoking the command itself is
the reviewed authorization. The operation is retry-safe and idempotent.

Uninstall removes only the global CLI, the Singularity Flow VS Code extension, the two known
Singularity Flow Copilot plugin identities, marker-owned direct `/sf-*` skill aliases, and the
installer-owned telemetry wrapper and exact shell-profile lines. It preserves every repository,
workspace, capability map, Work Item, Git branch and history, credential, VS Code setting, personal
skill, retained artifact, and historical installation receipt. It never runs Git.

The VS Code extension is removed first because VS Code can require a restart before reinstall or
removal. If that step is refused, the uninstaller stops before removing the CLI, Copilot surfaces,
or current installation receipt; close VS Code and retry the same command. The global CLI is
removed last so diagnostics remain available during earlier steps.

There is no Copilot uninstall skill. This is intentional: a participant must not remove
its own runtime or turn a conversational response into a machine-wide product mutation. Use the
displayed shell command on the target machine.

## State and safety

Forget-only removes the workspace registry and active selection, capability lead registry and organisation cache, other `~/.singularity-flow` state, supported custom registry/cache locations, and Singularity-named Copilot session state. It preserves workspace directories, repository clones, manifests, branches, worktrees, dirty files, `.git/singularity-flow` recovery state, remote capability maps, `sflow/config`, state/proposal branches, Git history, repository-owned `.vscode/settings.json`, and installed product surfaces.

Destructive local reset retains the existing stricter boundary: run it outside every workspace it will delete, and each existing registration must have an exact matching regular workspace manifest. Both modes reject symlink targets and dangerously broad custom directories, stage renames before committing, and roll back moved targets if application fails.

Product uninstall is separate from both reset modes. Uninstall removes executable product surfaces
and preserves local registrations and governed bytes; forget-only removes registrations and
preserves installed product surfaces; destructive reset can remove registered workspace
directories but does not uninstall the product.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a non-interactive call has no confirmation, run the matching mode with `--dry-run` first. `--json` never prompts.
- If `FORGET LOCAL` is refused, keep `--forget-only` on both preview and apply. If `RESET LOCAL` is refused, remove `--forget-only`; never swap phrases.
- A corrupt workspace registry blocks physical deletion because directories cannot be proven. Forget-only can still remove the corrupt machine registration without touching any workspace bytes.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If uninstall reports a VS Code restart refusal, close every VS Code process and retry; do not manually delete the CLI or extension directories between attempts.
- If no installed product surfaces are found, the uninstall preview reports that state and makes no change. Re-running an already completed uninstall is safe.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain installation-and-upgrades`, `sflow explain recovery`, `sflow explain secrets`.
