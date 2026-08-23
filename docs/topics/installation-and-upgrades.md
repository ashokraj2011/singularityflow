---
id: installation-and-upgrades
title: Installation, initialization, and upgrades
aliases:
  - upgrade
  - bootstrap
  - reinstall
commands:
  - init
  - bootstrap
  - quickstart
  - plugin
  - workspace
  - fresh-install
  - reinstall
related:
  - getting-started
  - resets-and-cleanup
  - diagnostics-and-regression
version: 5
---
Use this workflow to install Singularity Flow, govern an existing checkout or remote repository, verify the product surfaces, and replace an installed build without changing governed application history.

## Purpose and prerequisites

Use this topic when the current goal matches **installation and upgrades**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow init`, `sflow bootstrap`, `sflow quickstart`, `sflow plugin`, `sflow fresh-install`, `sflow reinstall`. Run `singularity-flow init --help` for the exact forms supported by this build.
- **Copilot:** `/sf-init`, `/sf-quickstart`, `/sf-reinstall`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

When `./install.sh` performs a normal source install, it runs `workspace refresh-configuration`
against every unique repository registered by every non-archived workspace. Refresh operates in
isolated clones, so dirty application checkouts and active Story branches are never switched or
edited. It three-way merges packaged workflow policy and assets against the last examined package
baseline, publishes the approved result to `sflow/config`, and mirrors the exact configuration,
source commit, product revision, and per-file hashes to the repository's orphan state branch.
Configuration remains at its canonical paths (`singularity/**` and `.github/agents/**`); only the
projection manifest lives under `configuration/`. Refresh removes stale managed configuration and
the older `configuration/files/**` layout, while preserving runtime state such as
`singularity/world-model/**`. Existing Story configuration snapshots remain immutable; new Stories
use the new authority revision.

Use `workspace refresh-configuration --dry-run` to preview all repositories, or add a workspace
reference and repeatable `--repository ID` filters for a bounded repair. Repository customizations
changed in parallel with the package are retained and reported. Use repeatable
`--resolve PATH=local|bundled|merge` choices to decide individual conflicts. A UI preview can bind
apply to the observed authorities with `--confirm-plan ID`; if either branch moved, apply refuses
and requires a new preview. `--accept-bundled-conflicts` remains the broad migration boundary for
explicitly selecting every packaged value. A protected `sflow/config` push retains
the exact candidate on the reported `sflow/config-refresh/*` review branch. Merge that proposal and
re-run the command to complete its state mirror. Reruns are idempotent and retry incomplete
repositories while current repositories become no-ops.

In VS Code, open **Workspaces**, choose a workspace, and use **SFlow configuration**. Check the
selected workspace or every registered workspace, review each conflict in its dropdown, then apply
the plan. The convenience action selects packaged templates, prompts, and agents only; it does not
silently replace unrelated workflow policy.

Use `--no-workspace-configuration-refresh` to skip this normal-install refresh. The legacy
`--no-workspace-workflow-sync` spelling remains accepted. The separate
`--clean-reinstall` path delegates before workspace discovery and never reads or changes Git
repositories or workspaces.

For a normal source install of a commit that has already passed its test suite, use
`./install.sh --skip-tests`. This still runs `npm run check`, builds the requested CLI and VS Code
surfaces, stamps provenance, and packages before installation; it skips only `npm test` (or
`test:cli` with `--cli-only`). The installer prints a warning so an untested artifact is not mistaken
for a validated one. The flag is refused for `--factory-reset` and `--clean-reinstall`.

## State and safety

These commands can mutate governed or machine-local state: `init`, `bootstrap`, `quickstart`, `plugin`, `fresh-install`, `reinstall`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain getting-started`, `sflow explain resets-and-cleanup`, `sflow explain diagnostics-and-regression`.
