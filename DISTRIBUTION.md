# Singularity Flow distribution

Singularity Flow is distributed as two artifacts:

1. the `singularity-flow` npm package, which provides the `sflow` CLI and Copilot plugin;
2. the Singularity Flow VS Code extension (`.vsix`), which provides Workspaces,
   Lifecycle, Inbox, and Configuration.

Use `sflow explain installation-and-upgrades` and `sflow explain resets-and-cleanup` for the packaged operator workflows and their exact safety boundaries.

The retired Electron app is preserved at Git tag `desktop-final-v0.9.0` and branch
`archive/desktop-app`; it is not built, installed, or supported by current releases.

## Cut a release

```bash
npm run release:dry
npm run release -- \
  --verification-receipt verification-matrix-receipt.json \
  --verification-key trusted-release-public.pem
```

`scripts/release.mjs` refuses a dirty tree, runs `npm run check` (which asserts one version across
every manifest) and the full test suite, packs the CLI tarball, builds the VSIX through the staging
script, and leaves `dist/` holding both artifacts, a `SHA256SUMS` file, a `RELEASE.json`, and a
`RELEASE-CHANNEL.json`. The release-channel record binds the version and source commit to the
minimum Node/VS Code versions and the SHA-256 of each installable artifact.

Real promotion requires a reviewed signed aggregate of the clean-checkout receipts from the
supported macOS/Linux/Windows and Node 20/22 matrix. Before signing a cell, exercise the exact npm
tarball and VSIX on that physical host and create a reviewed JSON record conforming to
`schemas/release-platform-evidence.schema.json`. Start from
`examples/release-platform-evidence.template.json`; its `REPLACE_WITH_...` sentinels are
intentionally invalid until every observation is supplied. On Windows, replace the template's
`windowsNpmNpxRoundTrip` object with `passed`, a retained evidence digest, and `reasonCode: null`.
Generate the receipt on the same host/runtime with
`npm run verification:receipt -- --signing-key <runner.pem> --platform-evidence
<outside-checkout/platform-evidence.json> --out <cell.json>`, then merge the six receipts with
`npm run verification:receipt:merge -- --receipt <cell.json> ...
--artifact-receipt <selected-cell.json> --signing-key <release.pem> --identity <reviewer>`. Mixed
commits, trees, npm tarballs, or VSIX bytes are refused; the selected signed artifact receipt binds
the identical artifacts that every matrix cell verified. Old receipts without reviewed platform
evidence are refused by merge and promotion. Dry runs and ordinary developer checks remain
single-machine operations.

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

The JSON accepts no transcript, command, filesystem path, host name, registry URL, credential, or
other free-form observation. Keep raw evidence in the approved release evidence store and place only
its `sha256:` digest in this input. `reviewerIdentity` must equal `--identity` (or the Git email used
when `--identity` is omitted), and every subject value must match what the receipt generator observes.
Put the JSON outside the checkout or under Git-private storage so the clean-checkout gate remains
meaningful. Unit tests and the local stub-host smoke never create this file and therefore can never
masquerade as physical release evidence.

The release command deliberately stops after local artifact collection. Uploading to the approved internal registry is the one step that
differs per organization, so it is left to whoever knows the destination.

Build the VSIX through `npm run vscode:package` or the release script — never `vsce package`
directly, which produces a `.vsix` with no CLI staged inside it. That extension installs cleanly and
then cannot run a single command.

## Installing — Windows, macOS, and Linux

Both artifacts install with the same two commands on every platform. Prerequisites are Node.js 20 or
newer, Git, and VS Code.

```bash
npm install --global <registry-or-path>/singularity-flow-<version>.tgz
singularity-flow plugin install
code --install-extension <path>/singularity-flow-vscode-<version>.vsix --force
```

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
`PATH`.

Each admitted activation reconstructs a fresh private candidate CLI from the retained candidate
tarball and uses that verified copy for Copilot plugin installation. It does not depend on, or
replace, the global CLI while the other surfaces are being activated. Requested surfaces are applied
and verified in this order: VS Code extension, Copilot plugin/skills, managed telemetry, and global
CLI last. Skipped surfaces remain untouched. The journal records the exact candidate and prior
bindings, requested modes, per-surface transitions, operation ID, and revision in
`activation-current.json`. One process-owned activation lease excludes concurrent installers;
every journal update is bound to its operation ID and expected revision, and a dead lease owner is
reclaimed safely.

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

## Build and verify

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

## Build the VSIX

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

For corporate distribution, upload the VSIX and npm tarball to the approved internal
Artifactory/registry. A VSIX is platform-neutral and requires no DMG, NSIS installer, code-signing
certificate, notarization, or custom auto-updater.

## Build the CLI tarball

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
`./install.sh --clean-reinstall` delegates to this same planner.

Automatic rollback is available only after admission proved exact restoration material for every
managed surface being replaced. This fail-closed rule is why an older installation that has only a
version label, but no trusted `current.json` artifact binding, must first be repaired or reinstalled
from known artifacts rather than being overwritten. A separate manual downgrade still uses the same
artifact installation commands with explicitly selected, approved older `.tgz` and `.vsix` files.
Neither automatic compensation nor a manual downgrade rewrites repository state, workspace
manifests, credentials, or active work. Do not run repository reset or `local-reset` as an
upgrade/rollback step.

An installer process reporting success is not sufficient proof of activation. Each selected surface
is verified before the next one begins, and the journal is committed only after all selected surfaces
pass. An activation or compensation verification failure leaves the journal recoverable as
`rollback-failed` rather than claiming success.

## Credentials

Jira and provider secrets entered in the VS Code extension are stored through VS Code
`SecretStorage`, backed by the operating-system keychain. The extension injects them only into the
short-lived CLI child process. The CLI continues to support environment variables for headless and
automation use.

## SharePoint status

SharePoint delegated OAuth from the VS Code extension remains unsupported until the corporate
redirect-flow and proxy spike is completed. Do not treat the retired Electron implementation as a
supported credential path.
