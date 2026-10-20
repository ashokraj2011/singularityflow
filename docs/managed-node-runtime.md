# SFlow-managed Node runtime

The opt-in managed engine installs its own exact Node runtime. It never replaces the user's global
`node`/`npm`, changes application dependencies, or adds a private Node directory to the application PATH.
The initial qualified target is Node 26.12.0. This rollout does not change the legacy Node 20+
source/developer support contract or make a blanket compatibility claim for future Node releases.
Node 26 is currently Current; making managed installation the production default is a separate rollout
decision after LTS qualification. Existing installer and staged-recovery commands retain their meaning.

## Install from a reviewed source checkout

macOS/Linux:

```sh
./install.sh --managed-runtime
# Equivalent: ./install-managed.sh
```

Windows PowerShell:

```powershell
.\install-managed.ps1
```

No global Node/npm is needed to bootstrap. Source builds still need their existing native/build
prerequisites and access to the configured npm registry. `--skip-tests` explicitly skips the existing
reinstall safety suite, not archive integrity, smoke checks or activation checks. `--cli-only` also
omits building the extension. The managed source installer builds the selected local checkout;
it does not silently pull another branch or change the repository.

Add the printed **engine/bin** directory to the terminal/Copilot launcher PATH once. Do not add
engine/runtimes to PATH. Install the printed retained VSIX with `code --install-extension ... --force`
and install Copilot integration using the managed `singularity-flow plugin install` command.
This mode activates the engine/runtime pair only: it does not claim that VS Code, Copilot or telemetry
were installed or updated, and does not print the legacy full-product activation banner.

The updated extension automatically uses the managed engine unless an explicit CLI setting selects
another engine. An explicit Node setting remains an operator override. The extension itself stays
inside VS Code's own extension host. Remote SSH, WSL and container extension hosts need their own
matching managed installation; a laptop's executable path is not transferred to another host.

## Install a promoted distribution

Use the existing authenticated distribution and independently supplied artifact-builder public key:

```sh
./install.sh --managed-runtime --artifact-key /trusted/artifact-builder-public.pem
```

```powershell
.\install.ps1 --managed-runtime --artifact-key C:\trusted\artifact-builder-public.pem
# Command Prompt: install.cmd --managed-runtime --artifact-key C:\trusted\artifact-builder-public.pem
```

Put `--managed-runtime` first so a Node-free bootstrap can select the private runtime. The authenticated
operator launcher and reviewed runtime lock are the initial trust root. The existing Ed25519 receipt
and exact npm/VSIX hashes are verified before any SFlow package code executes. The managed route stages
the signed npm archive offline using private npm with lifecycle scripts disabled. It never invokes
global npm or replaces global package-manager shims. `--dry-run` verifies/stages but does not activate
an engine; private Node may be downloaded/prepared. `--cli-only` omits retaining the VSIX. Otherwise the
verified VSIX is retained and its path reported for explicit UI installation.

## Storage and runtime selection

Default location: the user's `.singularity-flow/engine`, not a source checkout or Story clone.
`SINGULARITY_FLOW_ENGINE_HOME` can select an absolute machine-local installation root.

```text
engine/
  runtimes/node-v<exact-version>-<platform>-<architecture>/
  releases/<npm-archive-sha256>/node_modules/singularity-flow/
  bin/                       SFlow commands only; never a node or npm command
  active                     one atomic runtime/release tuple
  last-install.json          prepared/completed activation and prior tuple
  cache/<runtime>/<release>/  disposable bytecode
```

CLI launchers, VS Code and Copilot hooks use the same active pair. Child Node workers inherit the
selected engine executable through the existing `process.execPath` paths. No command checks the
network for a new Node version, scans repositories for runtimes, or downloads packages on startup.
Malformed, missing-target, redirected or wrong-host managed selections fail clearly rather than
silently selecting an unrelated global engine. Without any managed selection, legacy resolution works.

Applications keep their own toolchains. Only installer/build children get a temporary private-Node
PATH; normal commands do not inject that PATH into application builds, tests or servers. Cache policy
uses the Node API rather than exporting new Node environment settings into application children.

## Corporate delivery and security updates

`runtime/node-runtime.lock` pins the exact version, platform archive name and SHA-256. The bootstrap
checks that digest before extraction or execution and retains upstream LICENSE/notices. Pin updates
must be reviewed against upstream authenticated release metadata and qualified on native hosts.

- `SINGULARITY_FLOW_NODE_MIRROR`: HTTPS mirror with the official `v<version>/<archive>` layout.
- `SINGULARITY_FLOW_NODE_ARCHIVE_DIR`: offline directory containing the exact pinned archive.
- Neither option changes the pinned digest or permits credential-bearing download URLs.
- Never disable integrity checking to accommodate a mirror, proxy, unavailable cache or failed test.

Runtime downloads use a ten-minute bounded deadline. Application/network execution deadlines remain
unchanged. Unsupported architecture, archive mismatch, timeout and extraction errors remain explicit;
an installation failure does not imply a DNS problem.

## Upgrade, rollback and recovery

Install new runtime/release directories side by side; do not overwrite a running executable. After
version/build smoke checks and optional final-path cache preparation, one atomic active-record rename
selects both components. The previous pair and exact npm archive remain available. Reinstalling the
same artifact does not erase the rollback selection. Failed candidates remain for inspection, not as
implicitly accepted releases. No active runtime, previous release, recovery record or unpushed Story
is automatically deleted by this feature.

From the reviewed source checkout, use the same managed entrypoint:

```sh
./install-managed.sh --rollback
./install-managed.sh --recover
```

On Windows use `install-managed.ps1` with the same option. `--recover` releases only a proven dead
installer lease; it refuses a live process or ambiguous owner and preserves all release/recovery
bytes. Legacy interrupted installs must finish their exact original recovery first; managed mode
never deletes or bypasses those journals. Legacy global-npm reinstall/uninstall operations are refused
when invoked from a managed engine, so they cannot remove a different global installation.

Optional cache preparation is not installation authority. Node 26.8+ foreground requests use the
prepared cache read-only; missing entries compile normally without persistence. Disabled/unavailable
caching never prevents command execution. New Node versions/releases use separate cache namespaces.

## Qualification

Run `test/managed-runtime.test.mjs` for integrity, selection, upgrade/rollback, lease recovery,
redirection, process deadlines and environment isolation. Existing About, VS Code resolution/prewarm,
plugin, distribution and installer suites exercise compatibility. Run
`node scripts/managed-runtime-qualification.mjs` on native macOS and Windows for actual private-runtime
download/install, CLI/About execution, read-only cache files, offline upgrade/rollback and global
toolchain preservation. All native qualification uses isolated temporary installation roots, never
real workspaces, approvals, global installations or the user's running editor.
