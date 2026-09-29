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
  - product
related:
  - getting-started
  - resets-and-cleanup
  - diagnostics-and-regression
version: 29
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

Build, test, package, and artifact-retention output means only that candidate artifacts are staged;
it does not mean that installed product surfaces changed. A matching semantic version is also
insufficient because different builds can carry the same version. A full installation is complete
only when the final activation banner is exactly
`Singularity Flow product activation — COMPLETE AND VERIFIED`.
Before printing it, the installer must prove that the installed `singularity-flow --build` output
exactly matches the admitted candidate, verify every selected surface (including
`singularity-flow plugin verify --json` when Copilot is selected), and commit
`~/.singularity-flow/installations/current.json`. An explicitly narrowed install reports
`Singularity Flow product activation — PARTIAL BY REQUEST` instead of full completion. A normal
install whose optional manager is unavailable reports `Singularity Flow product activation —
COMPLETE WITH SKIPS` and names the skipped surface in the receipt. If no recognized final activation
banner appears, follow the printed recovery command or committed-receipt verification commands and
do not infer success from package output, a matching version, or a subset of healthy surfaces.

An upgrade must prove exact retained rollback bytes for each existing managed CLI and VS Code
surface before changing anything. The installer durably snapshots those bytes plus managed
Copilot skills, telemetry/profile files, and the installation receipt. A refusal or handled
interrupt restores and verifies touched surfaces in reverse order. If the process dies, retry the
same platform installer; it completes the retained `distribution-install-pending.json` rollback
before admitting a new activation.

A legacy clean reinstall is different only when no trusted prior product bytes exist yet. It cannot
claim to restore an unknown old build. If apply fails after removal, it retains the verified new
candidate and prints one exact roll-forward recovery command. Its successful schema-v2 receipt gives
later upgrades the exact rollback authority needed for automatic compensation.

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

After a new build loads, VS Code runs this refresh as a review: for each registered repository whose
approved configuration lags the build's packaged configuration, it opens a
`sflow/config-refresh/*` review branch and names it. Nothing changes until someone merges the review.
The shell form is `singularity-flow product reviews`: the one pass per build, which a window and a
terminal share through one machine-local record, so it never runs twice or twice at once. Step by
step, it is `workspace refresh-configuration --confirm-plan <PLAN-ID> --review-only`. A review-only
refresh never creates a first configuration authority. A review is named by the approved commit it
starts from and the exact configuration it proposes, so every teammate on the same build joins that
one review instead of opening another. The proposal records its build in the package baseline, so a
teammate on another build proposes a review of that build. A window waiting to reload onto a newer
build opens none; the reloaded build does.

A terminal has no window to wait in, so a new build's first mutation starts the same pass as a
background worker. `singularity-flow product status` lists the reviews it opened. One pass runs on a
machine at a time. A registered repository that cannot be reached does not hold up the others: the
reachable ones are proposed, and the pass is tried again an hour later, by the next window or command,
for the rest. So is a pass that failed. A first mutation that is itself a configuration refresh starts
no worker beside it. Set `SINGULARITY_FLOW_CONFIGURATION_REVIEWS=off` to switch the background pass off.

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
seeded configuration and schema report, then apply the returned plan with
`workspace reinitialize --confirm-plan <PLAN-ID>`. Capability-specific publication and portable
locator repair are outside this command; user-owned capability definitions remain unchanged when
the approved configuration is mirrored. Use the explicit capability publication journey when
those links must change. This command never rewrites
immutable historical records. Registered older records are migrated in memory by their readers;
future or unreadable schema versions remain explicit blockers with upgrade guidance. Compatibility
roots and registered-v4 state requirements come from the exact isolated approved configuration
candidate, not a potentially stale application checkout. Old local workflow formats remain
registered long enough for this recovery command to inspect and upgrade them. A corrupt workspace
registry is an explicit `WORKSPACE_REGISTRY_INVALID` refusal rather than a misleading successful
zero-target refresh; only a registry that does not exist means there are no registered workspaces.
Reinitialize uses a durable ownership receipt for workflow IDs, phase/artifact/MCP dependencies,
templates, prompts, and agents. Missing seeds and exact current or registered historical package
bytes can establish framework ownership. User-created and user-modified workflows, phases,
artifact sets, templates, prompts, and agents stay repository-owned and unchanged—even if a receipt
previously described the path as framework-owned. Same-name and modified-seed collisions are
reported for review. Repository-only IDs and files, organisation policy YAML, and all work-item
artifacts remain untouched. Reinitialize refuses `--resolve ...=bundled` and
`--accept-bundled-conflicts`; use ordinary `refresh-configuration` for a separate, explicit
three-way decision when packaged content should deliberately replace repository-owned content.
Reinitialize never falls through to factory reset; destructive recovery remains a separate,
explicitly named operation.
Recognized v3 World Model manifests use the older `schema_version` field and are reported as
migration advisories, not corrupt v4 records; an unversioned artifact that claims `wmb-v4` still
fails closed.

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

In VS Code, run **Singularity Flow: Reinitialize Framework Assets (Preserves User Content)** from
the Command Palette. It opens Workspaces and previews every registered repository. The same page can
review only the selected workspace and applies only a plan bound to that preview. An open Story
Intake reloads the approved workflow catalog after a successful apply without clearing its authored
draft. **Factory Reset Local SFlow Data (Destructive)** remains a separately named operation and is
never selected by the normal Reinitialize action.

`spec-driven-standard` and `reference-driven-build` remain standard product contracts rather than
optional catalog samples during ordinary refresh. Safe reinitialize restores them only when they
are missing or exactly match a registered framework revision, together with framework-owned
dependencies. A customized standard workflow, phase, artifact set, template, prompt, or agent is
repository-owned and remains untouched, and choosing a different workflow for a Story remains
unrestricted.

Use `--no-workspace-configuration-refresh` to skip this normal-install refresh. The legacy
`--no-workspace-workflow-sync` spelling remains accepted. The separate
`--clean-reinstall` path delegates before workspace discovery and never reads or changes Git
repositories or workspaces.

For a normal source install of a commit that has already passed its test suite, use
`./install.sh --skip-tests`. This still runs `npm run check`, builds the requested CLI and VS Code
surfaces, stamps provenance, and packages before installation; it skips only `npm test` (or
`test:cli` with `--cli-only`). The installer prints a warning so an untested artifact is not mistaken
for a validated one. The flag is refused for `--factory-reset` and `--clean-reinstall`.

## Keep every surface on one build

The terminal and Copilot run the CLI on PATH, while VS Code runs the CLI bundled in its extension.
A partial install (`--cli-only`, `--vscode-only`, `--skip-copilot`) or an out-of-band
`npm install --global` or VSIX can leave them on different builds. They all report the same
version, so nothing looks wrong until an older build refuses a record that a newer build wrote.

- **Shell:** `sflow product status` compares the build each surface runs with the build the
  installation receipt (`~/.singularity-flow/installations/current.json`) recorded. `sflow product
  align` brings a lagging surface to that installed build from the bytes the receipt retained.
- **VS Code:** after a window opens, the extension checks once per loaded build and at most daily. It
  aligns in the background and offers a reload when its own files were replaced.

Alignment follows the same rules on every surface:

1. The target is the installed build, not whichever build is newest. A surface newer than the
   installed build is never downgraded; it is reported with one full-install step.
2. Only the retained, content-addressed artifacts are installed, and only when their bytes still
   match the receipt. A development checkout is never replaced.
3. It never runs while an install or its interrupted-install recovery owns the product surfaces.
4. Each surface is verified before the next one starts. VS Code goes first, then the CLI, then the
   Copilot plugin and `/sf-*` skills, which the aligned CLI reinstalls from its own package.

A new build also runs one pass before its first mutation command. It aligns the surfaces and repairs
machine-local state: a workspace registry entry that drifted from its manifest, and clone staging an
interrupted clone left behind. If the CLI running that command was the one replaced, the command
continues on the aligned build. A failed pass never fails the command:
it prints the retry command, `singularity-flow product align`. Set
`SINGULARITY_FLOW_PRODUCT_ALIGNMENT=off` to switch the automatic pass off.

Alignment reproduces only builds this machine retains. When a record was written by a teammate's
newer release that was never installed here, every surface already runs the installed build, and the
refusal says to install that release with its own install wrapper. A repository whose approved
configuration requires the newer build installs it automatically; see "Keep a team on one build".

## Keep a team on one build

A repository can require a minimum build in its approved configuration, `singularity/product.yml`.
It names the build, where the signed release lives (a shared folder or an https location), and the
artifact-builder public key that must have signed it. See `docs/RELEASE-ARTIFACT-HANDOFF.md` for
the file and how to publish a release there.

On a teammate's machine, the next mutation in that repository on an older build installs the release
on every surface before the command runs, then continues the command on the new build:

- Only a file read from the approved configuration authority counts. A copy in a working tree
  installs nothing, because it names both what to install and who may sign it.
- The release is verified against the key the reviewed file carries, never a key shipped beside
  the release, and is installed by the same transactional distribution installer, with rollback.
- A release is installed only when the build stamped inside it meets the requirement and is not
  older than the running build, judged before anything is staged and again on the verified bytes.
  A requirement raised before its release was published installs nothing; publish the build there.
- When the machine already runs the required build on PATH (a VS Code window that has not reloaded
  yet), the command continues on that build instead of installing the release again.
- The check reads each repository's approved configuration at most once a day per build, on the
  first mutation, whether or not the working tree carries the file: approved configuration lives on
  `sflow/config`, and a Story pins its own copy when it starts, so neither `main` nor an older
  Story has it. A requirement file written after the last check, such as a new Story's copy, is read
  at once. A development checkout never updates itself.
- A failed download or install never fails the command: it says what to run and continues on the
  current build. A download that sends nothing for 30 seconds, or does not finish in time, is
  abandoned, and a file larger than its limit is refused before it is read. Set `SINGULARITY_FLOW_PRODUCT_UPDATE=off` to switch the check off.
- `singularity-flow product status` lists each repository's last check on this machine, including
  why a required release could not be installed. VS Code warns once about each failed install.

## State and safety

These commands can mutate governed or machine-local state: `init`, `bootstrap`, `quickstart`, `plugin`, `fresh-install`, `reinstall`, `product align`, `product reviews`, and `sf-install`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth. Distribution installation changes product surfaces only; it does not refresh repositories unless the separately displayed refresh command is reviewed and run.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a distribution wrapper refuses the release directory, restore the complete promoted directory instead of editing its manifest, checksums, or scripts.
- If VS Code asks for a restart, close every VS Code process and retry the same distribution install; the existing CLI remains available because CLI activation occurs last.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain getting-started`, `sflow explain resets-and-cleanup`, `sflow explain diagnostics-and-regression`.
