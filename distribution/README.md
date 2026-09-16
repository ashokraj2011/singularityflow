# Install or uninstall a promoted Singularity Flow release

Keep this directory intact. The scripts admit the exact npm tarball and VSIX named by
`RELEASE.json`, verify their identities and every `SHA256SUMS` entry, and never run Git.

## Install

Obtain the artifact-builder public key through the organisation's independent trust channel. The
key must remain outside this release directory. Pass it explicitly, or set
`SINGULARITY_FLOW_ARTIFACT_PUBLIC_KEY` to its absolute path.

The platform wrapper and `bootstrap.mjs` must themselves arrive through the organisation's
authenticated distribution channel (for example a signed corporate package or approved software
portal). The detached artifact receipt authenticates the npm/VSIX product pair before package code
runs; it cannot retroactively authenticate a launcher that has already started.

- macOS/Linux: `./install.sh --artifact-key /trusted/artifact-builder-public.pem`
- Windows PowerShell: `.\install.ps1 --artifact-key C:\trusted\artifact-builder-public.pem`
- Windows Command Prompt: `install.cmd --artifact-key C:\trusted\artifact-builder-public.pem`

Use `--dry-run` for a no-change preview. Use `--cli-only` when Copilot CLI is unavailable and only
the terminal CLI is required. Registry credentials belong in the user's `.npmrc`; pass a corporate
registry with `--registry <URL>` without embedding credentials in the URL.

Before replacement, the installer requires exact retained rollback bytes for every already-managed
CLI or VS Code surface. It durably snapshots those bytes plus managed Copilot skills, telemetry, and
the installation receipt. A failure or handled interrupt restores and verifies touched surfaces in
reverse order. An abrupt process death leaves `distribution-install-pending.json`; retry the exact
installer command to complete that rollback before a new activation starts.

Build, package, checksum, and private-staging messages are not installation completion. The
installer rejects a globally reachable CLI that has the right semantic version but a different
`singularity-flow --build` identity. Full activation is complete only after selected surfaces
verify, `~/.singularity-flow/installations/current.json` commits, and the final output says exactly
`Singularity Flow product activation — COMPLETE AND VERIFIED`. A `--cli-only` result instead says
`Singularity Flow product activation — PARTIAL BY REQUEST`; when an optional manager is unavailable,
the result says `Singularity Flow product activation — COMPLETE WITH SKIPS` and records the skipped
surface. If none of these final banners appears, use the printed recovery command; do not infer
success from the earlier artifact output.

## Uninstall

The first invocation is a no-change preview and prints a fingerprinted confirmation.

- macOS/Linux: `./uninstall.sh --artifact-key /trusted/artifact-builder-public.pem`
- Windows PowerShell: `.\uninstall.ps1 --artifact-key C:\trusted\artifact-builder-public.pem`
- Windows Command Prompt: `uninstall.cmd --artifact-key C:\trusted\artifact-builder-public.pem`

Pass the printed `--confirm` value, or use `--yes` when the command itself is the reviewed
authorization. Uninstall removes only the global CLI, Singularity Flow VS Code extension, the two
known Copilot plugin identities, marker-owned `/sf-*` aliases, and the installer-owned telemetry
helper. It preserves every repository, workspace, capability map, work item, credential, VS Code
setting, personal skill, retained artifact, and historical receipt.
