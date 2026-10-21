# SFlow-managed Node runtime

The managed engine installs its own exact Node runtime. It never replaces the user's global
`node`/`npm`, changes application dependencies, or adds a private Node directory to the application PATH.
The initial qualified target is Node 26.12.0. This rollout does not change the legacy Node 20+
source/developer support contract or make a blanket compatibility claim for future Node releases.
At introduction, Node 26 is Current; making managed installation the production default is a separate rollout
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

Normal managed source installation installs the CLI, SFlow VS Code extension and Copilot
plugin/skills, verifies them, and configures user PATH in the same command. VS Code and Copilot CLI
must already be installed; their vendor applications/licences are not downloaded or accepted by SFlow.
`--cli-only` preserves the deliberately narrower engine-only mode and its manual PATH instructions.
Private Node/npm is never added to the persistent PATH. The new full setup receipt is separate from
legacy activation/telemetry receipts and does not claim that telemetry was configured.

## One build command, one user setup command

From a clean source checkout:

```sh
# macOS; also bootstraps private Node if global Node/npm is absent
bash build-distribution.sh
```

```powershell
# Windows
.\build-distribution.ps1
```

The command installs locked build dependencies, runs product checks and the reinstall safety suite,
builds/signs the canonical CLI + VSIX pair once, verifies it and writes the complete installable
`dist/` directory. Existing output is replaced through the crash-recoverable directory publisher.
On first use it creates a private, per-user local builder key outside the checkout, under
`.singularity-flow/distribution-keys`. It does not generate a production reviewer or approval key.
For an organisation's existing builder key set `SINGULARITY_FLOW_DISTRIBUTION_SIGNING_KEY` and
`SINGULARITY_FLOW_DISTRIBUTION_BUILDER` once, or use `--signing-key` and `--identity`.
`--out-dir` selects another destination. `--skip-tests` is an explicit candidate-build choice only;
it never bypasses integrity or the production certification gate.

Distribute the whole `dist/` directory through an authenticated software channel. Deliver its printed
public trust key independently; the private key never enters the package. The default output is
explicitly an **installable candidate, not a certified production release**. Production still requires
the exact retained pair and the existing independently signed platform matrix; see
[the release handoff](RELEASE-ARTIFACT-HANDOFF.md). No new build command invents that evidence.

From the extracted distribution, users run `bash setup.sh` on Mac or `.\setup.cmd` on Windows.
First setup needs the organisation-provisioned trust key or one `--artifact-key <trusted-public-key>`
argument. Successful setup stores that verified key in per-user trust for later no-argument updates.
The same command updates CLI, VS Code and Copilot and configures PATH without administrator access.
It discovers the usual per-user VS Code installation even when `code` is not on PATH. Open a new
terminal and reload the editor/chat once; setup does not forcibly restart them.

The full product receipt at `engine/product-install.json` records each verified surface. If a manager
fails or the process dies, the next setup finishes the exact retained candidate before a newer one.
It reports incomplete setup honestly and keeps recovery/artifacts. An engine-only install/rollback
cannot bypass that pending full-product record. This is resumable roll-forward across independent
managers, not a claim that third-party managers form an atomic transaction. Historical engine
rollback and legacy staged-recovery boundaries remain unchanged.

The updated extension automatically uses the managed engine unless an explicit CLI setting selects
another engine. An explicit Node setting remains an operator override. The extension itself stays
inside VS Code's own extension host. Reload after installing the new VSIX to load its updated
integration. Thereafter, an already managed client resolves one active pair at each invocation,
including background prewarming, without reloading for an engine-only upgrade.
Remote SSH, WSL and container extension hosts need their own
matching managed installation; a laptop's executable path is not transferred to another host.

## Install a promoted distribution

Use the existing authenticated distribution and independently supplied artifact-builder public key:

```sh
./install.sh --managed-runtime --artifact-key /trusted/artifact-builder-public.pem
```

```powershell
.\install.ps1 --managed-runtime --artifact-key C:\trusted\artifact-builder-public.pem
# Command Prompt: install-managed.cmd --artifact-key C:\trusted\artifact-builder-public.pem
```

Put `--managed-runtime` first for the shell/PowerShell entrypoints so a Node-free bootstrap can select
the private runtime. The separate `install-managed.cmd` avoids reparsing CMD's escaped arguments;
the legacy `install.cmd` remains unchanged. The authenticated
operator launcher and reviewed runtime lock are the initial trust root. The existing Ed25519 receipt
and exact npm/VSIX hashes are verified before any SFlow package code executes. The managed route stages
the signed npm archive offline using private npm with lifecycle scripts disabled. It never invokes
global npm or replaces global package-manager shims. `--dry-run` verifies/stages but does not activate
an engine; private Node may be downloaded/prepared. `--cli-only` requests engine installation only.
Otherwise setup installs and verifies all three SFlow surfaces and retains the exact VSIX for recovery.

## Storage and runtime selection

Default location: the user's `.singularity-flow/engine`, not a source checkout or Story clone.
`SINGULARITY_FLOW_ENGINE_HOME` can select an absolute machine-local installation root.
Use a private per-user directory. For a custom root, each terminal, VS Code extension host and hook
launcher must receive the same environment setting; the default root needs no such override.
Windows command paths must not contain `%`, `!`, `^`, `&`, `|`, `<`, `>` or control characters;
spaces and parentheses are supported. A custom root never bypasses user-level legacy recovery.

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
Existing native failed-test-risk adapters still require their approved runner to match the
authenticated host Node. A different application Node may therefore remain unsupported for that
specialized risk path. Managed mode does not rewrite the runner, switch the application to Node 26,
or waive the adapter's authority check. Ordinary configured application commands retain their own
executable/environment selection; broadening that risk adapter is a separate compatibility change.

## Corporate delivery and security updates

`runtime/node-runtime.lock` pins the exact version, platform archive name and SHA-256. The bootstrap
checks that digest before extraction or execution and retains upstream LICENSE/notices. Pin updates
must be reviewed against upstream authenticated release metadata and qualified on native hosts.

- `SINGULARITY_FLOW_NODE_MIRROR`: HTTPS mirror with the official `v<version>/<archive>` layout.
- `SINGULARITY_FLOW_NODE_ARCHIVE_DIR`: offline directory containing the exact pinned archive.
- Neither option changes the pinned digest or permits credential-bearing download URLs.
- Never disable integrity checking to accommodate a mirror, proxy, unavailable cache or failed test.

Runtime downloads use a ten-minute request deadline. Offline npm extraction can be slow on Windows
under filesystem/antivirus load: its default deadline is fifteen minutes, configurable through
`SINGULARITY_FLOW_ENGINE_INSTALL_TIMEOUT_MS` from `300000` to `3600000` (5–60 minutes). The progress/error
message identifies that installer stage and preserves the real failure and active selection.
Application/network execution deadlines remain
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
Runtime preparation publishes a complete directory by same-filesystem rename; it does not leave a
persistent preparation lease that could prevent a Node-free reinstall after a crash. Old preparation
markers are preserved but do not govern the new atomic publication path.

## Qualification

Run `test/managed-runtime.test.mjs` for integrity, selection, upgrade/rollback, lease recovery,
redirection, process deadlines and environment isolation. Existing About, VS Code resolution/prewarm,
plugin, distribution and installer suites exercise compatibility. Run
`node scripts/managed-runtime-qualification.mjs` on native macOS and Windows for actual private-runtime
download/install, CLI/About execution, read-only cache files, offline upgrade/rollback and global
toolchain preservation. All native qualification uses isolated temporary installation roots, never
real workspaces, approvals, global installations or the user's running editor.

Native installation qualification targets macOS/arm64 and Windows/x64. The other pinned download
targets are not thereby claimed as natively qualified. Compatibility suites retain their existing
opposite-platform skips; the POSIX shell-install harness runs on Mac, while Windows entries are
executed natively. This feature qualification does not change the zero-skip 1.0 release policy or
constitute full release certification. Source-install packaging can be exercised with `--skip-tests`
only as an explicit fixture/build choice, alongside separately executed safety suites.

### Initial qualification record

Native run `39516460623`, engine code `bdf2050a`, passed nine macOS/arm64 checks and ten
Windows/x64 checks. It exercised the actual pinned download, Node-free bootstrap/reuse, preserved
stale preparation markers, real CLI/About, unchanged foreground cache files, hooks without global
Node, authenticated distribution installation, offline upgrade/rollback and toolchain isolation.
The additional Windows check executed the managed CMD entry through quoted release/key paths.
Its compatibility jobs also passed on Node 22 and 26.12.0, as did product checks, UI typechecking
and UI builds. Existing platform-only test skips remain disclosed above.

A separate full source-install fixture built the CLI and VSIX on this Mac under private Node 26.12.0;
it did not install either integration into the running editor. No models, real Stories or approvals
were used. Earlier run `39516003950` hit the original five-minute offline-extraction deadline on a
slower Windows worker; the installer-only configurable deadline and stage-specific error follow-up
addresses that limit without changing application/workflow deadlines or relaxing integrity checks.
That follow-up, code `d67f9ebb`, passed all four Mac/Windows × Node 22/26.12.0 jobs in run
`39518257978`: managed-runtime and distribution-entry regressions, UI/prewarming tests, product
checks, UI typechecking and UI builds. This separately verifies the deadline bounds/forwarding and
error preservation; the full native installation record above identifies its exact earlier code.

Native post-install smoke calls were approximately 110 ms on Mac and 116 ms on Windows. Those are
single calls after preparation, not OS-cold benchmarks, comparative gains or latency guarantees.
