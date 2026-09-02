# Windows Git Bash installation compatibility

Status: implemented

Release line: `0.9.0`

Implementation commits: `4498852`, `2856241`

Merged to `main`: `958f37d`, `9120245`

## Problem

Installing Singularity Flow from Git Bash on Windows produced hundreds of test failures. The first useful failures reported that governed agents such as `sflow-utility` had no description even though their Markdown files contained one.

The defect was caused by line-ending assumptions in the Markdown frontmatter parsers. Git for Windows commonly checks text files out with CRLF (`\r\n`) line endings, while the parsers required LF (`\n`) at exact delimiter positions. Some Windows editors may also add a UTF-8 byte-order mark (BOM).

When parsing failed, the agent frontmatter was treated as absent. Required fields such as `description` were therefore missing, causing agent discovery, agent mapping, hooks, direct skills, and dependent tests to fail. The npm registry and Artifactory were not the cause of these failures.

## Corrective changes

### Agent Markdown parser

`src/agents.mjs` now:

- Accepts both LF and CRLF around YAML frontmatter delimiters.
- Accepts and removes an optional UTF-8 BOM before parsing.
- Locates the closing delimiter without assuming a specific operating-system newline.
- Preserves the prompt body after the frontmatter.
- Continues to reject unclosed or non-object YAML frontmatter.

This makes agent discovery independent of the user's `core.autocrlf` setting.

### Direct skill renderer

`src/direct-skills.mjs` now:

- Reads and replaces `name:` fields ending in LF or CRLF.
- Accepts an optional UTF-8 BOM.
- Finds YAML frontmatter delimiters with either newline convention.
- Preserves the source newline convention when inserting the Singularity-managed marker.
- Continues to verify that a skill declares the same name as its directory.

### Guarded Windows installer

The new `install-windows-git-bash.sh` wrapper provides one supported source-install command for Git Bash. It:

1. Resolves the Singularity Flow checkout from the script location.
2. Checks for Git Bash and verifies `bash`, `git`, `node`, and `npm`.
3. Requires Node.js 20 or newer.
4. Requires Copilot CLI only for modes that install standalone Copilot assets; `--cli-only`,
   `--vscode-only`, and `--skip-copilot` do not require it.
5. Refuses to install from a dirty checkout.
6. Updates the checkout using `git pull --ff-only`.
7. Verifies that the CRLF-safe agent parser is present before the long build and test stages.
8. Delegates installation to the canonical `install.sh`.
9. Passes through the selected npm registry, bounded install mode, update choice, and telemetry
   choice. The wrapper makes the update decision once and tells the canonical installer not to
   repeat the pull.

The wrapper can be run from any directory because it resolves its own checkout path.

## Safety boundaries

The fix deliberately does not:

- Change global or repository `core.autocrlf` settings.
- Run `dos2unix` or rewrite tracked Markdown files.
- Store registry credentials in command-line URLs.
- Bypass the canonical installer validation or test suite.
- Reset, clean, force-update, or otherwise rewrite Git history.

Registry credentials remain in the user's `.npmrc` or the organization's approved npm credential mechanism.

## Public usage

From Git Bash in a clean checkout:

```bash
git switch main
git pull --ff-only
bash ./install-windows-git-bash.sh
```

With a corporate npm registry or Artifactory:

```bash
bash ./install-windows-git-bash.sh \
  --registry "https://artifactory.company.example/api/npm/npm-virtual/"
```

CLI-only installation:

```bash
bash ./install-windows-git-bash.sh --cli-only
```

Install the VS Code extension only, without changing the global CLI or Copilot assets:

```bash
bash ./install-windows-git-bash.sh --vscode-only
```

Install the CLI and VS Code extension when the standalone Copilot CLI is unavailable or managed by
the organization:

```bash
bash ./install-windows-git-bash.sh --skip-copilot
```

Build the exact current clean checkout without another Git network operation:

```bash
bash ./install-windows-git-bash.sh --no-update
```

If activation stops after artifacts were packaged, use only the exact command printed by the
installer:

```bash
bash ./install-windows-git-bash.sh --from-staged-artifacts
```

This delegates immediately to the canonical exact-artifact recovery. It does not inspect or update
Git, reinstall source dependencies, rerun tests, rebuild, or repackage. Before any mutation, the
activation journal revalidates both the candidate artifacts and the exact prior retained tarball or
VSIX needed to restore each previously managed surface. Those archives are content-addressed copies
under `~/.singularity-flow/installations/versions/sha256/<digest>/`, not mutable files in the source
checkout. If `current.json` says a managed prior surface exists but its rollback artifact is absent,
escaped, symlinked, or digest-mismatched, activation fails closed before changing the machine. Do not
add registry or mode flags; the reviewed values come from the journal.

Only one activation can run at a time. The journal lease is owned by the installer shell's native
Windows PID (resolved by Node rather than trusting Git Bash's MSYS `$$` pseudo-PID), stale
dead-owner leases are reclaimed through an atomic rename, and each journal write must match both
the recorded operation ID and current revision. The isolated CLI prefix is rebuilt from the exact
retained candidate tarball on every normal or recovery activation, so a modified digest-named cache
is not run. This private candidate CLI installs the Copilot plugin; the previously working global CLI
is not used as an activation helper.

The canonical installer applies and verifies selected surfaces in this order: VSIX, Copilot
plugin/skills, managed telemetry, then the global CLI last. This keeps the old global CLI available
until the other requested surfaces are known good. If the shell receives `ERR`, `INT`, `TERM`, or
`HUP` after mutation begins, it automatically compensates in reverse order, starting with the
installation receipt if its replacement began. Exact prior artifacts restore previously present
surfaces, and previously absent surfaces are removed. The journal reports `rolled-back` only after
every touched surface is verified in its prior state. It reports `rollback-failed`, with the failed
surface details and recovery command, if any restoration cannot be completed or proved; it never
presents that state as a successful install. A normal install also refuses to replace an incomplete
journal: the exact printed recovery must finish first.

Workspace configuration refresh is not part of this cross-product transaction. It runs only after
the CLI, extension, plugin, and telemetry activation is committed. If refresh is blocked or fails,
the product installation remains active and the installer reports the refresh as a separate pending
operation with its retry command.

The npm alias is:

```bash
npm run install:windows
```

## Failure behavior

The wrapper stops before the expensive installer stages when:

- A required executable is unavailable.
- Node.js is older than version 20.
- Copilot CLI is absent in a mode that requested standalone Copilot assets.
- The checkout contains uncommitted changes.
- The current branch cannot be updated by fast-forward.
- The checkout predates the Windows CRLF parser fix.

Each refusal identifies the corrective action. It does not attempt an automatic destructive repair.
Once admitted product activation has mutated a surface, however, process errors and termination
signals use the bounded compensating rollback described above. Repository and workspace Git state is
never used as rollback material.

## Regression coverage

Automated tests cover:

- Agent frontmatter using Windows CRLF.
- Agent frontmatter containing a UTF-8 BOM.
- Direct skills using CRLF and a BOM.
- Preservation of CRLF when inserting the managed direct-skill marker.
- Installer executability and Node.js version guard.
- Fast-forward-only checkout update.
- CRLF-fix detection before canonical installation.
- Corporate registry, CLI-only, VS Code-only, skip-Copilot, no-update, and telemetry arguments.
- Fail-closed admission when an existing managed surface lacks its exact retained rollback artifact.
- VSIX/plugin/telemetry/global-CLI-last activation and reverse compensation after injected failures
  or termination signals.
- Distinct, verified `rolled-back` and actionable `rollback-failed` journal outcomes.
- Workspace refresh beginning only after product activation commits.
- Rejection of global Git line-ending changes and file-rewriting utilities.

Validation at delivery completed with deterministic checks passing and 1,433 Node tests passing with zero failures.

## Acceptance criteria

The correction is accepted when:

- The same tracked agent and skill Markdown files parse on macOS, Linux, and Windows Git Bash checkouts.
- Agent descriptions and mappings remain available under CRLF.
- A Windows source installation uses the canonical validated installation path.
- Corporate registry selection reaches npm without embedding credentials in the URL.
- Existing managed surfaces are not changed unless their exact prior restoration material passes
  admission.
- A failed or interrupted activation either restores and verifies every touched surface or remains
  explicitly `rollback-failed` with an exact recovery path.
- Workspace refresh cannot turn a committed product activation into a cross-product rollback.
- No Git line-ending policy or repository content is rewritten by the wrapper.
- Existing LF behavior and validation errors remain unchanged.
