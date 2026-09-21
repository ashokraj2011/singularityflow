# Singularity Flow distribution

Singularity Flow is distributed as two artifacts:

1. the `singularity-flow` npm package, which provides the `sflow` CLI and Copilot plugin;
2. the Singularity Flow VS Code extension (`.vsix`), which provides Workspaces,
   Lifecycle, Inbox, and Configuration.

Use `sflow explain installation-and-upgrades` and `sflow explain resets-and-cleanup` for the packaged operator workflows and their exact safety boundaries.

The retired Electron app is preserved at Git tag `desktop-final-v0.9.0` and branch
`archive/desktop-app`; it is not built, installed, or supported by current releases.

## Cut a release

The installed product supports Node.js 20 or newer. The locked artifact-building toolchains are
narrower: build with Node.js 20.18.1 through 20.x, or Node.js 22.9.0 or newer; collect the declared
physical release matrix on Node 20 and Node 22.

```bash
npm ci
npm run release:artifacts -- \
  --signing-key /secure/artifact-builder-private.pem \
  --identity artifact-builder@example.com \
  --out-dir /retained/release-candidate
# After the six physical cells below have consumed that exact retained pair and their
# receipts have been merged into /retained/verification-matrix-receipt.json:
npm run release -- \
  --artifact-receipt /retained/release-candidate/RELEASE-ARTIFACT-RECEIPT.json \
  --artifact-key /trusted/artifact-builder-public.pem \
  --package /retained/release-candidate/singularity-flow-0.9.0.tgz \
  --vsix /retained/release-candidate/singularity-flow-vscode-0.9.0.vsix \
  --verification-receipt /retained/verification-matrix-receipt.json \
  --verification-key /trusted/release-reviewer-public.pem \
  --wel-corpus-review-key /trusted/wel-corpus-reviewer-public.pem
```

The artifact builder refuses a dirty source tree, materializes npm inputs from exact Git blobs and
modes, uses the locked npm and VSCE toolchains, builds the pair once, and signs their provenance.
`scripts/release.mjs` never repacks or rebuilds that signed pair. Its broader source tests and
bundle-budget check can create disposable diagnostic packs or extension bundles, but none can become
a promoted artifact. Promotion verifies the artifact authority plus the signed platform matrix and
byte-copies the exact pair into `dist/` with `SHA256SUMS`, `RELEASE.json`,
`RELEASE-CHANNEL.json`, `ARTIFACT-RECEIPT.json`, and `VERIFICATION-RECEIPT.json`. See
[`docs/RELEASE-ARTIFACT-HANDOFF.md`](docs/RELEASE-ARTIFACT-HANDOFF.md).

Real promotion requires a reviewed signed aggregate of the clean-checkout receipts from the
supported macOS/Linux/Windows and Node 20/22 matrix. Before signing a cell, exercise the exact npm
tarball and VSIX on that physical host and create a reviewed JSON record conforming to
`schemas/release-platform-evidence.schema.json`. Start from
`examples/release-platform-evidence.template.json`; its `REPLACE_WITH_...` sentinels are
intentionally invalid until every observation is supplied. On Windows, replace the template's
`windowsNpmNpxRoundTrip` object with `passed`, a retained evidence digest, and `reasonCode: null`.
Generate the receipt on the same host/runtime with
`npm run verification:receipt -- --artifact-receipt <retained/artifact-receipt.json>
--artifact-key <trusted/builder-public.pem> --package <retained/release.tgz>
--vsix <retained/release.vsix> --signing-key <secure/runner-private.pem>
--platform-evidence <reviewed/platform-evidence.json>
--wel-corpus-review <reviewed/wel-corpus-review.json>
--wel-corpus-review-key <trusted/wel-corpus-reviewer-public.pem>
--out <retained/cell.json>`, then merge the six
receipts with `npm run verification:receipt:merge -- --receipt <retained/cell.json> ...
--artifact-receipt <retained/artifact-receipt.json> --artifact-key <trusted/builder-public.pem>
--wel-corpus-review-key <trusted/wel-corpus-reviewer-public.pem>
--signing-key <secure/release-reviewer-private.pem> --identity <reviewer>
--out <retained/verification-matrix-receipt.json>`. Mixed commits, trees, artifact authorities, npm
tarballs, or VSIX bytes are refused. Historical receipt formats remain readable but cannot be mixed
into newly generated build-once release authority. Keep every retained path, signing key, and public
trust root outside the checkout. Dry runs and ordinary developer checks remain single-machine
operations.

Every cell's WEL corpus review input is produced independently for that exact source and runtime as
described in [`docs/WEL-CORPUS-REVIEW-RECEIPT.md`](docs/WEL-CORPUS-REVIEW-RECEIPT.md). Its signature
authenticates review of the content-free aggregate only; WEL lifecycle authority remains observe-only.

The platform-evidence input is intentionally digest-only. It names the exact commit, tree, npm
tarball SHA-256, VSIX SHA-256, platform, Node version, reviewer identity, and review time. It then
records `passed` plus the SHA-256 of separately retained evidence for:

- activation of that installed VSIX in a real VS Code host;
- interrupted staged-installer recovery using those artifacts;
- starting the release-pinned `@playwright/mcp` package while an explicitly named mechanism blocks
  network access, with its exact version and transitive closure SHA-256;
- an authenticated Playwright MCP smoke using a named authentication mechanism and the private
  authentication-profile SHA-256 (never its cookies or headers);
- a real npm/npx round trip on Windows. macOS and Linux must record this last check as
  `not-applicable`, with reason code `non-windows-platform`; Windows cannot waive it.

Schema v2 additionally requires six distinct retained evidence digests for the SGOS software-
conversion and hypothesis-analysis journeys, interruption recovery, counterfeit-authority refusal,
cross-machine authority round trip, and the reviewed performance budget. The last also binds the
separate budget-profile digest. Historical schema-v1 evidence remains readable for audit but cannot
authorize a new cell, merge, or promotion.

The JSON accepts no transcript, command, filesystem path, host name, registry URL, credential, or
other free-form observation. Keep raw evidence in the approved release evidence store and place only
its `sha256:` digest in this input. `reviewerIdentity` must equal `--identity` (or the Git email used
when `--identity` is omitted), and every subject value must match what the receipt generator observes.
Put the JSON outside the checkout or under Git-private storage so the clean-checkout gate remains
meaningful. Unit tests and the local stub-host smoke never create this file and therefore can never
masquerade as physical release evidence.

The release command deliberately stops after local artifact collection. Uploading to the approved internal registry is the one step that
differs per organization, so it is left to whoever knows the destination.

For a developer-only VSIX, use `npm run vscode:package`—never `vsce package` directly, which
produces a `.vsix` with no CLI staged inside it. A release-candidate VSIX is produced only by
`npm run release:artifacts`; `scripts/release.mjs` verifies and promotes retained bytes and never
builds it again.

## Installing — Windows, macOS, and Linux

A promoted `dist/` directory is a complete operator handoff. Keep its npm tarball, VSIX,
`RELEASE.json`, `SHA256SUMS`, and install/uninstall scripts together. Prerequisites are Node.js 20
or newer, VS Code, and GitHub Copilot CLI when installing all surfaces. Git and a source checkout
are not required.

```bash
# macOS or Linux
./install.sh --artifact-key /trusted/artifact-builder-public.pem

# Windows PowerShell
.\install.ps1 --artifact-key C:\trusted\artifact-builder-public.pem

# Windows Command Prompt
install.cmd --artifact-key C:\trusted\artifact-builder-public.pem
```

Obtain the artifact-builder public key through an independent organisation trust channel and keep
it outside the release directory. `SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY` may name the same absolute
path instead of repeating `--artifact-key`. Each wrapper first runs the built-in-only
`bootstrap.mjs`: it verifies the Ed25519 artifact receipt against that key and copies the npm
tarball and VSIX through open descriptors into a private directory. Only then does it execute the
`sf-install` runner from the verified npm snapshot. Before any mutation, that runner re-verifies the
release manifest, every distributed script and artifact digest, package/VSIX identities, version
parity, and the signed receipt. Operator assets must byte-match their canonical copies inside the
signed package. The installer never runs Git, rebuilds, or downloads a different SFlow package.
Registry credentials remain in `.npmrc`; use `--registry <URL>` for an approved corporate registry
and `--cli-only` when only the terminal CLI is wanted.

The wrapper and `bootstrap.mjs` must be obtained through the organisation's authenticated software
distribution channel. The artifact signature proves the npm/VSIX pair before package code runs; it
does not retroactively authenticate a bootstrap that was already executed. This is the same trust
boundary as an OS-signed installer: delivery authenticates the launcher, while the independently
obtained Ed25519 key authenticates the product payload.

The bootstrap copies the release metadata, operator assets, signed product pair, and trusted public
key bytes into private snapshots. Package execution consumes only those snapshots; the mutable
handoff directory and original key pathname remain provenance for operator-facing retry commands,
not later installation inputs.

Use `--dry-run` for a no-change fingerprinted preview. A normal invocation is itself the explicit
installation request and applies immediately. Workspace configuration is preserved and is never
refreshed implicitly; the completed installer prints both the shell and Copilot refresh commands.

For an upgrade, admission also requires exact retained rollback bytes for every installed managed
CLI or VS Code surface. Before the first product mutation, the installer durably snapshots that
authority, managed Copilot skills, telemetry files, shell-profile bytes, and `current.json`. It marks
each surface before mutation and compensates in reverse order on a refusal, verification failure, or
handled interrupt. A process death leaves `distribution-install-pending.json`; the exact installer
retry acquires the shared activation lease, restores and verifies the prior state, and only then may
start the candidate again. Missing or changed rollback authority fails closed without claiming that
the product is healthy.

The first VS Code activation performs six bounded, offline checks (bundle, Node, Git, CLI, local
state writability, and repository classification). A healthy install opens My Work. A failed check
is retained as machine-local diagnostics and renders a result card rather than an activation stack.

Nothing in the artifact installation above needs a POSIX shell. Windows users who have a source
checkout and Git for Windows can instead use the guarded Git Bash wrapper:

```bash
bash ./install-windows-git-bash.sh

# Company Artifactory / npm registry
bash ./install-windows-git-bash.sh \
  --registry https://artifacts.company.example/api/npm/npm-virtual/
```

The wrapper validates Git Bash, Node.js 20+, the clean checkout, and the Windows CRLF-safe Agent
Markdown parser before delegating to the canonical `install.sh`. It performs a fast-forward-only
update, does not change `core.autocrlf`, and does not rewrite Markdown files. Authentication remains
in the user's `.npmrc`.

The same bounded source-install modes are available on Windows, macOS, and Linux:

```bash
./install.sh --no-update       # install the exact current clean checkout
./install.sh --skip-copilot    # CLI + VSIX without standalone Copilot assets
./install.sh --vscode-only     # build/install/verify VSIX only; requires `code`
./install.sh --cli-only        # install the global CLI only
./install.sh --from-staged-artifacts # resume exact artifacts after interrupted activation
```

Use `bash ./install-windows-git-bash.sh` in Git Bash on Windows; the wrapper accepts those same
mode flags. `--vscode-only` does not change the global CLI, Copilot plugin/skills, telemetry, or
workspace configuration and therefore cannot serve the managed Playwright MCP host on a blank
machine. Use `--skip-copilot` when the CLI-backed MCP host is required. `--no-update` suppresses Git network update but still refuses a dirty
checkout. A normal CLI replacement uses `npm install --global` directly without first removing the
working package.

Before changing any installed surface, a normal install validates the candidate tarball and VSIX and
copies their exact bytes to
`~/.singularity-flow/installations/versions/sha256/<digest>/`. Admission also reads `current.json`
and validates the exact retained tarball or VSIX needed to restore every previously managed surface
that this mode will replace. If a prior managed surface is present but its recorded rollback path,
identity, or SHA-256 cannot be proved, installation stops before the first mutation. It does not
substitute a same-version download, a mutable checkout artifact, or the CLI currently found on
`PATH`. These build, package, validation, and retention steps stage artifacts only; they are not
product activation.

Each admitted activation reconstructs a fresh private candidate CLI from the retained candidate
tarball and uses that verified copy for Copilot plugin installation. It does not depend on, or
replace, the global CLI while the other surfaces are being activated. Requested surfaces are applied
and verified in this order: VS Code extension, Copilot plugin/skills, managed telemetry, and global
CLI last. Skipped surfaces remain untouched. The journal records the exact candidate and prior
bindings, requested modes, per-surface transitions, operation ID, and revision in
`activation-current.json`. One process-owned activation lease excludes concurrent installers;
every journal update is bound to its operation ID and expected revision, and a dead lease owner is
reclaimed safely.

Semantic-version equality is not activation proof because two builds can report the same version.
The installed `singularity-flow --build` identity must exactly match the admitted candidate. Every
selected surface must then verify; when Copilot is selected this includes
`singularity-flow plugin verify --json`. The installer atomically commits
`~/.singularity-flow/installations/current.json` only after those checks pass.

After the first surface mutation, `ERR`, `INT`, `TERM`, or `HUP` starts a bounded compensating
rollback in reverse order: the installation receipt, global CLI, telemetry, Copilot, then VSIX. A
surface that was previously absent is removed; a surface that was present is restored from its exact
admitted artifact or pre-mutation snapshot. Every restoration is verified. The journal reaches
`rolled-back` only when all touched surfaces match their prior bindings. If any compensation cannot
be completed or proved, it reaches `rollback-failed`, retains the per-surface failures and exact
artifacts, and never reports the candidate as installed. Run only the recovery command printed by
the installer; do not reset a repository or delete the installation store.

`./install.sh --from-staged-artifacts` revalidates both candidate and prior rollback material before
recovery. It still works if checkout archives were changed or removed, and it refuses changed
retained bytes, escaped paths, symlink substitutions, or changed installer bytes. It skips Git
update, `npm ci`, checks, tests, builds, and packaging. Successful activation keeps the
content-addressed candidate and prior version sets for later inspection; only the deliberate machine
reset boundary removes the installation store.

Workspace configuration refresh is intentionally outside the activation transaction. It starts only
after all requested product surfaces are verified and the activation journal is committed. A refresh
failure therefore cannot roll back a healthy CLI, extension, plugin, or telemetry installation; it
is reported separately as pending with its own retry command.

A new normal source install cannot supersede an incomplete activation journal. Complete the exact
printed `--from-staged-artifacts` recovery first. A new operation ID is issued only after the prior
journal is either complete or verified `rolled-back`; prior content-addressed archives are not
deleted.

One Windows note: reading and publishing governed state needs no shell, but **building a world
model** hands the configured runner command to `cmd.exe`, and `sflow-wm-minimal` wraps a shell
script. Installing Git for Windows provides the shell both want. `singularity-flow doctor` reports
this as its `platform` check, so a machine that cannot build models says so rather than failing
later.

## Developer build and verify

Select the approved registry once for every npm subprocess in the build:

```bash
export NPM_CONFIG_REGISTRY="https://artifacts.company.com/artifactory/api/npm/npm-virtual/"
npm ci
npm run check
npm run test:all
npm run vscode:typecheck
npm run vscode:build
npm run pack:dry
```

After packaging, prove the exact VSIX in an isolated VS Code profile without a public registry or
public Git host:

```bash
npm run smoke:golden -- --vsix /absolute/path/to/singularity-flow-vscode-0.9.0.vsix
```

The smoke validates the staged CLI and public Home/Start/Return commands, installs the VSIX into a
temporary profile, checks the installed version, and drives the built extension through its fresh
repository Home fixture. The temporary profile is deleted afterward.

## Build a developer VSIX

```bash
npm run vscode:package
```

The command builds the extension, stages the matching CLI inside it, and creates:

```text
apps/vscode/singularity-flow-vscode-<version>.vsix
```

Install or replace it locally:

```bash
code --install-extension apps/vscode/singularity-flow-vscode-0.9.0.vsix --force
```

The command above creates a developer-only VSIX. For corporate distribution, publish the complete
promoted `dist/` directory through the approved channel; the tarball and VSIX remain the only two
product artifacts, while its receipt, checksums, wrappers, bootstrap, and README are required
operator/trust assets. A VSIX is platform-neutral and requires no DMG, NSIS installer,
code-signing certificate, notarization, or custom auto-updater.

## Build a developer CLI tarball

```bash
npm pack
npm install --global ./singularity-flow-0.9.0.tgz
singularity-flow plugin install
```

`install.sh --registry <URL>` performs the verified CLI/plugin installation using a public or
corporate npm registry and builds the VS Code extension sources. The same value can be supplied as
`SINGULARITY_FLOW_NPM_REGISTRY` or the standard `NPM_CONFIG_REGISTRY`; it is inherited by every npm
subprocess. Repository credentials are never placed in registry URLs; configure approved npm
authentication in `.npmrc`.

For an already installed machine, use the product-only clean reinstall instead of
a repository or workspace reset:

```bash
sf-reinstall --checkout /absolute/path/to/singularityflow --dry-run
sf-reinstall --checkout /absolute/path/to/singularityflow \
  --registry https://artifacts.company.example/api/npm/npm-virtual/ \
  --confirm "REINSTALL SINGULARITY FLOW <fingerprint>"
```

The preview builds, tests, packages, and hashes the npm tarball and VSIX before any
installed surface is removed. The confirmed transaction replaces only the global
npm package, managed Copilot plugin/skills, VS Code extension, and managed telemetry
wrapper. It performs no Git operation and preserves all repositories, worktrees,
workspace clones, governed files and state, credentials, settings, and personal
skills. Receipts are machine-local under `~/.singularity-flow/installations/`.
After all selected surfaces verify, each exact artifact installed by that mode is copied into the
managed content-addressed version store and `current.json` is atomically replaced with a schema-v2
rollback receipt. A full clean reinstall is therefore the supported product-only migration from a
legacy schema-v1 receipt that points at mutable checkout artifacts; the old paths are not trusted or
silently copied. A CLI-only clean reinstall preserves an untouched installed VSIX only when the
existing schema-v2 receipt binds it to verified content-addressed bytes; otherwise preflight refuses
before packaging or product removal and directs the operator to a full clean reinstall.
`./install.sh --clean-reinstall` delegates to this same planner.

That source clean-reinstall planner is also the migration boundary for a legacy installation whose
old exact bytes were never retained. In that one case it cannot honestly restore an unknown prior
build: a post-removal failure retains the verified candidate bundle and prints one exact
roll-forward recovery command. After the schema-v2 receipt has been established, normal source
upgrades and promoted-distribution installs can admit exact prior bytes and compensate touched
surfaces automatically.

Automatic rollback is available only after admission proved exact restoration material for every
managed surface being replaced. This fail-closed rule is why an older installation that has only a
version label, but no trusted `current.json` artifact binding, must first be repaired or reinstalled
from known artifacts rather than being overwritten. A separate manual downgrade still uses the same
artifact installation commands with explicitly selected, approved older `.tgz` and `.vsix` files.
Neither automatic compensation nor a manual downgrade rewrites repository state, workspace
manifests, credentials, or active work. Do not run repository reset or `local-reset` as an
upgrade/rollback step.

An installer process exiting or reporting build/package success is not sufficient proof of
activation. Full installation is complete only when the committed receipt and selected-surface
checks are followed by the exact final banner
`Singularity Flow product activation — COMPLETE AND VERIFIED`. Explicitly narrowed modes instead
report `Singularity Flow product activation — PARTIAL BY REQUEST`; that result must not be presented
as an all-surface installation. A normal install whose optional manager is unavailable reports
`Singularity Flow product activation — COMPLETE WITH SKIPS` and binds the skipped surface in the
receipt. If no recognized final activation banner appears, run the exact recovery command printed
by the installer, or its committed-receipt verification commands when activation already committed;
do not infer success from a matching version or a subset of healthy surfaces.
An activation or compensation verification failure leaves the journal recoverable as
`rollback-failed` rather than claiming success.

## Uninstalling the distributed product

Use the uninstaller from the same retained release directory. Its first invocation is a no-change
preview and prints a state-bound confirmation; `--yes` is the one-command reviewed form.

```bash
# macOS/Linux
./uninstall.sh --artifact-key /trusted/artifact-builder-public.pem
./uninstall.sh --artifact-key /trusted/artifact-builder-public.pem --yes

# Windows PowerShell
.\uninstall.ps1 --artifact-key C:\trusted\artifact-builder-public.pem
.\uninstall.ps1 --artifact-key C:\trusted\artifact-builder-public.pem --yes

# Windows Command Prompt
uninstall.cmd --artifact-key C:\trusted\artifact-builder-public.pem
uninstall.cmd --artifact-key C:\trusted\artifact-builder-public.pem --yes
```

The uninstaller removes only the global npm package, the Singularity Flow VS Code extension, both
known Copilot plugin identities, marker-owned direct `/sf-*` skills, and the installer-owned
telemetry helper/profile lines. The CLI is removed last, so a VS Code or Copilot refusal remains
retryable. It preserves repositories, worktrees, branches, capability maps, state/config branches,
workspace clones, work items, prompt logs, credentials, VS Code state, personal skills, retained
release artifacts, and historical receipts. Completion writes a local uninstall receipt and moves
the former `current.json` into installation history rather than deleting its audit evidence.

## Credentials

Jira and provider secrets entered in the VS Code extension are stored through VS Code
`SecretStorage`, backed by the operating-system keychain. The extension injects them only into the
short-lived CLI child process. The CLI continues to support environment variables for headless and
automation use.

## SharePoint status

SharePoint delegated OAuth from the VS Code extension remains unsupported until the corporate
redirect-flow and proxy spike is completed. Do not treat the retired Electron implementation as a
supported credential path.
