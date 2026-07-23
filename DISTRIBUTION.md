# Singularity Flow desktop distribution

Singularity Flow Desktop is packaged with electron-builder as a universal macOS DMG and a Windows x64 NSIS installer. The desktop contains its own CLI runtime. Installing the desktop does not install the global `singularity-flow` command or the Copilot plugin; use `install.sh` for those tools.

## Local test packages

Install dependencies once from the repository root:

```bash
npm ci
```

On macOS:

```bash
npm run desktop:package:mac
# equivalent: ./scripts/desktop-release.sh package --platform mac
```

On Windows PowerShell:

```powershell
npm run desktop:package:win
# equivalent:
./scripts/desktop-release.ps1 package --platform win
```

`npm run desktop:package:current` chooses macOS or Windows from the current host. `npm run desktop:dist` remains an alias for the same command. Packaging runs the Node tests, deterministic checks, and renderer build before electron-builder.

Local packaging defaults to signing mode `auto`. Complete credentials produce a signed local package; otherwise the output is visibly named `-unsigned`. Unsigned packages are suitable only for testing and cause Gatekeeper or SmartScreen warnings. Files are written under `apps/desktop/release/local/<version>/` with SHA-256 checksums and `release-manifest.json`.

The source tree must be clean. For a deliberate package of uncommitted development work, add `--allow-dirty`. Rebuilding a populated, version-specific output directory requires `--replace`; only that exact release directory is removed.

## Official signing credentials

Official builds use `--release-mode official --sign required` and fail before packaging if any required credential is absent. Never commit certificates, private keys, passwords, or tokens.

macOS direct distribution requires an Apple Developer ID Application certificate and App Store Connect notarization credentials:

```text
MAC_CSC_LINK             Base64 certificate, local .p12 path, or secret URL
MAC_CSC_KEY_PASSWORD     Certificate password
APPLE_API_KEY_B64        Base64 contents of the App Store Connect .p8 key
APPLE_API_KEY_ID         App Store Connect key ID
APPLE_API_ISSUER         App Store Connect issuer ID
```

The release script decodes `APPLE_API_KEY_B64` into a permission-restricted temporary directory and removes it after electron-builder finishes. `APPLE_API_KEY` may instead point to an existing local `.p8` file.

Windows Authenticode signing uses:

```text
WIN_CSC_LINK             Base64 certificate, local .pfx path, or secret URL
WIN_CSC_KEY_PASSWORD     Certificate password
```

## GitHub release

Add the signing values above as GitHub Actions secrets. The workflow `.github/workflows/desktop-release.yml` runs on an existing `v<package-version>` tag or through manual dispatch. Every version field in the root package, desktop package, lock file, plugin manifest, and marketplace manifest must match the tag.

Example release:

```bash
git tag -a v0.8.0 -m "Singularity Flow 0.8.0"
git push origin v0.8.0
```

The workflow tests the source, builds on native macOS and Windows runners, signs and verifies the packages, validates the universal Mac binary, performs a silent Windows install/launch/uninstall smoke test, and combines both manifests. It creates a **draft** GitHub Release so a maintainer can inspect the assets before publication:

```bash
gh release view v0.8.0
gh release edit v0.8.0 --draft=false
```

Official output contains:

```text
singularity-flow-desktop-<version>-macos-universal.dmg
singularity-flow-desktop-<version>-macos-universal.zip
singularity-flow-desktop-<version>-windows-x64-setup.exe
SHA256SUMS.txt
release-manifest.json
```

The publisher refuses an unverified manifest, a local release, an unsigned artifact, a non-notarized macOS artifact, a size mismatch, or a SHA-256 mismatch.

## Artifactory

Configure a generic Artifactory repository with environment variables:

```bash
export SINGULARITY_FLOW_ARTIFACTORY_BASE_URL="https://artifacts.company.example/artifactory"
export SINGULARITY_FLOW_ARTIFACTORY_REPOSITORY="desktop-releases"
export SINGULARITY_FLOW_ARTIFACTORY_TOKEN="..."
# Set SINGULARITY_FLOW_ARTIFACTORY_USER only when Basic authentication is required.
```

Preview every destination without contacting Artifactory:

```bash
npm run desktop:publish:artifactory -- \
  --dir apps/desktop/release/official/0.8.0 \
  --dry-run
```

Publish after verification:

```bash
npm run desktop:publish:artifactory -- \
  --dir apps/desktop/release/official/0.8.0
```

Files are uploaded with HTTPS PUT to `<repository>/singularity-flow-desktop/<version>/`. Existing files are never overwritten unless `--replace` is supplied explicitly. The manual GitHub workflow also has an optional **Publish Artifactory** input; its URL, repository, and optional username come from repository variables and its token comes from a secret.

## Install and uninstall

On macOS, open the DMG, drag **Singularity Flow** to **Applications**, then eject the image. Official packages are signed, notarized, and stapled for offline verification.

On Windows, run the `Setup.exe`. The assisted installer defaults to the current user, can change the installation directory, and can create Desktop and Start Menu shortcuts. Enterprise deployment can install or uninstall silently with `/S`.

The desktop does not currently auto-update. Install a newer signed package over the existing application when upgrading. Uninstalling preserves Electron user data and the recent-repository list; repositories and their `.singularity` content are never removed.

## Verification commands

Verify metadata and platform signatures from the producing host:

```bash
npm run desktop:verify -- --dir apps/desktop/release/official/0.8.0 --release-mode official
```

macOS verification includes `hdiutil`, `lipo`, `codesign`, `spctl`, and `xcrun stapler`. Windows verification uses `Get-AuthenticodeSignature`. The release manifest records the source commit, package version, Electron and Node versions, build time, platform, architecture, byte size, SHA-256, signature status, and notarization status.
