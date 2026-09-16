---
id: installation-and-upgrades
title: Installation, initialization, and upgrades
aliases:
  - upgrade
  - bootstrap
  - reinstall
questions:
  - How do I reinstall SFlow on Windows?
  - How do I install SFlow on macOS?
  - How do I install a promoted SFlow distribution without a source checkout?
  - How do I safely reinitialize an existing workspace?
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
version: 13
---
Use this workflow to install Singularity Flow, govern an existing checkout or remote repository, verify the product surfaces, and replace an installed build without changing governed application history.

## Purpose and prerequisites

Use this topic when the current goal matches **installation and upgrades**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow init`, `sflow bootstrap`, `sflow quickstart`, `sflow plugin`, `sflow fresh-install`, `sflow reinstall`. A promoted distribution is installed with its platform wrapper: `./install.sh`, `.\install.ps1`, or `install.cmd`. Run `singularity-flow init --help` for the exact forms supported by this build.
- **Copilot:** `/sf-init`, `/sf-quickstart`, `/sf-reinstall`. There is no Copilot equivalent for the machine-level promoted-distribution install because Copilot may not be installed yet. After installation, use `/sf-refresh-configuration` to refresh registered repositories; the shell equivalent is `singularity-flow workspace refresh-configuration`.
- **VS Code:** open Singularity Flow **Lifecycle**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## Install a promoted distribution

A promoted release directory contains exactly one npm tarball, one VSIX, `RELEASE.json`,
`SHA256SUMS`, and platform install and uninstall wrappers. Keep the directory intact and run the
wrapper from that directory:

- macOS/Linux shell: `./install.sh --artifact-key /trusted/artifact-builder-public.pem`
- Windows PowerShell: `.\install.ps1 --artifact-key C:\trusted\artifact-builder-public.pem`
- Windows Command Prompt: `install.cmd --artifact-key C:\trusted\artifact-builder-public.pem`

Obtain the public key independently from the organisation's trust channel and keep it outside the
release directory; `SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY` may name it instead. The wrappers verify
the artifact-builder signature and snapshot the exact pair before executing the packaged
`sf-install` runner. They do not clone a repository or call Git. Before changing the machine, the
runner verifies the release manifest, every checksum, package and VSIX identity/version, and each
operator asset against the signed package's canonical copy.

The wrapper and `bootstrap.mjs` must come from an authenticated organisation delivery channel. The
receipt authenticates the npm/VSIX payload before package code runs; it cannot authenticate a
launcher that was already started.

Use `--dry-run` for a no-change preview. Use `--cli-only` when only the terminal CLI is required,
or `--no-copilot-telemetry` to omit the managed telemetry helper. Corporate registry credentials
belong in the user's `.npmrc`; pass `--registry <URL>` only with a credential-free registry URL.
The install activates the new CLI last, so a failed VSIX or Copilot-surface activation does not
first remove the working CLI. A successful install preserves workspace configuration and prints
both explicit refresh forms:

- **Shell:** `singularity-flow workspace refresh-configuration`
- **Copilot:** `/sf-refresh-configuration`

An upgrade must prove exact retained rollback bytes for each existing managed CLI and VS Code
surface before changing anything. The installer durably snapshots those bytes plus managed
Copilot skills, telemetry/profile files, and the installation receipt. A refusal or handled
interrupt restores and verifies touched surfaces in reverse order. If the process dies, retry the
same platform installer; it completes the retained `distribution-install-pending.json` rollback
before admitting a new activation.

The packaged runners can also be invoked directly as `sf-install --release-dir <DIRECTORY>
--artifact-key <PUBLIC-KEY>` after
they are available on `PATH`, but the platform wrapper is the normal distribution entry point.

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

For the complete safe upgrade/recovery path, use `workspace reinitialize --dry-run`, review its
configuration, schema, and capability-portability report, then apply the returned plan with
`workspace reinitialize --confirm-plan <PLAN-ID>`. The apply is bound to the lead authority selected
by the plan; a filtered delivery-only plan cannot publish capability links from an unreviewed lead
revision and instead returns the exact lead-scoped preview command. This command never rewrites
immutable historical records. Registered older records are migrated in memory by their readers;
future or unreadable schema versions remain explicit blockers with upgrade guidance.

Remote Git used by refresh is bounded and non-interactive. Exact ref observations are shared within
one operation, independent repositories are prepared and published with up to four workers, and
commit authorship reads `user.name`/`user.email` without contacting GitHub. Set
`SINGULARITY_FLOW_GIT_WORKERS=1..8` to tune office proxy load. The operation-specific ceilings are
`SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS` (default 30 seconds),
`SINGULARITY_FLOW_GIT_CONFIGURATION_TIMEOUT_MS` (default 120 seconds), and
`SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS` (default 180 seconds). Git Credential Manager, proxy, and CA
settings are preserved, but terminal credential prompts are disabled because the installer and VS
Code have no safe interactive terminal for them. A credential failure therefore stops with a
classified repair message instead of appearing to hang. Ledger compare-and-swap checks, exact
transport-intent verification, and protected-branch recovery are not skipped or cached.

In VS Code, run **Singularity Flow: Safely Reinitialize Capabilities & Workspaces** from the Command Palette.
It opens Workspaces and previews every registered repository. The same page can review only the
selected workspace, exposes each conflict as a dropdown, and applies only a plan bound to that
preview. When a preserved older agent leaves a phase without its required default, **Repair missing
or outdated agents** selects the engine-reported packaged agent paths and previews again; it never
publishes on the first click. The broader convenience action selects packaged templates, prompts,
and agents only and does not silently replace unrelated workflow policy.

`spec-driven-standard` is part of the standard product contract rather than an optional catalog
sample. Refresh restores it when an older approved configuration does not contain it, together with
any missing phase and approval-authority definitions it requires. Existing customizations inside an
installed profile still use the reviewed three-way merge, and choosing a different workflow for a
Story remains unrestricted.

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

These commands can mutate governed or machine-local state: `init`, `bootstrap`, `quickstart`, `plugin`, `fresh-install`, `reinstall`, and `sf-install`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth. Distribution installation changes product surfaces only; it does not refresh repositories unless the separately displayed refresh command is reviewed and run.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a distribution wrapper refuses the release directory, restore the complete promoted directory instead of editing its manifest, checksums, or scripts.
- If VS Code asks for a restart, close every VS Code process and retry the same distribution install; the existing CLI remains available because CLI activation occurs last.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain getting-started`, `sflow explain resets-and-cleanup`, `sflow explain diagnostics-and-regression`.
