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
npm run release            # or: npm run release:dry
```

`scripts/release.mjs` refuses a dirty tree, runs `npm run check` (which asserts one version across
every manifest) and the full test suite, packs the CLI tarball, builds the VSIX through the staging
script, and leaves `dist/` holding both artifacts, a `SHA256SUMS` file, a `RELEASE.json`, and a
`RELEASE-CHANNEL.json`. The release-channel record binds the version and source commit to the
minimum Node/VS Code versions and the SHA-256 of each installable artifact.

It deliberately stops there. Uploading to the approved internal registry is the one step that
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

Rollback uses the same commands with the immediately previous approved `.tgz` and `.vsix`. Installing
older product bytes never rewrites repository state, workspace manifests, credentials, the local
journal, or active work. Do not run repository reset or `local-reset` as an upgrade/rollback step.

## Credentials

Jira and provider secrets entered in the VS Code extension are stored through VS Code
`SecretStorage`, backed by the operating-system keychain. The extension injects them only into the
short-lived CLI child process. The CLI continues to support environment variables for headless and
automation use.

## SharePoint status

SharePoint delegated OAuth from the VS Code extension remains unsupported until the corporate
redirect-flow and proxy spike is completed. Do not treat the retired Electron implementation as a
supported credential path.
