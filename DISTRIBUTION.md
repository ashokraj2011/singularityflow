# Singularity Flow distribution

Singularity Flow is distributed as two artifacts:

1. the `singularity-flow` npm package, which provides the `sflow` CLI and Copilot plugin;
2. the Singularity Flow VS Code extension (`.vsix`), which provides Workspaces, Lifecycle, and Configuration.

The retired Electron app is preserved at Git tag `desktop-final-v0.9.0` and branch
`archive/desktop-app`; it is not built, installed, or supported by current releases.

## Build and verify

```bash
npm ci
npm run check
npm run test:all
npm run vscode:typecheck
npm run vscode:build
npm run pack:dry
```

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
corporate npm registry and builds the VS Code extension sources. Repository credentials are never
placed in registry URLs; configure approved npm authentication in `.npmrc`.

## Credentials

Jira and provider secrets entered in the VS Code extension are stored through VS Code
`SecretStorage`, backed by the operating-system keychain. The extension injects them only into the
short-lived CLI child process. The CLI continues to support environment variables for headless and
automation use.

## SharePoint status

SharePoint delegated OAuth from the VS Code extension remains unsupported until the corporate
redirect-flow and proxy spike is completed. Do not treat the retired Electron implementation as a
supported credential path.
