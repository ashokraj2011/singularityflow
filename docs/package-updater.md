# Update from a SharePoint folder

## Standalone updater — no clone

Distribute `SFlow-Updater.zip` to users. Extract it once, close SFlow sessions, then open
**Update SFlow.command** on Mac or **Update SFlow.cmd** on Windows. The first run asks for the public
SharePoint folder link; later runs reuse it. The extracted package needs no repository, installed
Node or npm dependencies. It prepares SFlow's private runtime when needed.

The standalone edition reinstalls SFlow's VS Code extension and Copilot plugin/owned skills through
the full-product installer's existing lease and resumable transaction. It activates the checked CLI
and retains the previous CLI for recovery. It preserves Stories, workspaces, personal settings,
other extensions, the IDE, GitHub Copilot itself and global Node/npm.

Build the distributable with:

```sh
node scripts/build-package-updater.mjs
```

The ZIP is written to `dist/SFlow-Updater.zip`. `--out-dir DIRECTORY` chooses another destination.
Its scripts and runtime closure come from the same canonical updater sources used by the repository
and CLI package. See the included README for terminal commands and restart instructions.

## From VS Code or the installed CLI

Keep the current SFlow **.tgz** and **.vsix** in a SharePoint folder shared with "Anyone with the
link" and downloading allowed. Then, on any machine with SFlow installed:

- VS Code: **Singularity Flow: Update SFlow…**. The first time it asks for the link; later it shows
  the saved link with **Change source…**, confirms once, and runs the update in a terminal named
  "Update SFlow". It runs the updater the installed extension ships (`cli/runtime/` inside the
  VSIX), copied into `~/.singularity-flow/package-updater/vscode-runs/` first, so it works even when
  the installed CLI is old or broken.
- Terminal: `singularity-flow update --source 'YOUR_SHAREPOINT_FOLDER_LINK'` once, then
  `singularity-flow update`.
- Downloaded files instead of the link: **Use files I already downloaded…**, or
  `singularity-flow update --local-folder FOLDER`. With several pairs in the folder, the newest pair
  that is one build is used.

From a checkout, an extracted CLI package or the standalone ZIP, `bash update-sflow.sh` and
`.\update-sflow.ps1` take the same arguments and share the same saved link.

The updater downloads the two files, checks their identities and matching builds, and updates the
CLI where it is installed now: an `npm install -g` install with the npm that owns that global folder
(never a second CLI), SFlow's own engine folder with the full-product installer, or that folder when
no CLI is installed yet. It then reinstalls the Copilot plugin and skills and installs the VS Code
extension. This direct path needs no release ZIP, manifest or artifact-builder key. Package source
trust comes from the HTTPS folder you select; this path does not claim signed release certification.

A link that is not an anonymous shared folder is refused before anything is downloaded or installed,
with what link is needed: a link to one file, a site page, a link that asks people to sign in (shared
only inside the organisation), an expired link (403/404), a folder without the `.tgz` and `.vsix`, and
a `.tgz` and `.vsix` of different versions or builds.

Restart VS Code/Copilot and open a new terminal after completion. The updater does not close applications or modify workspaces and Stories.

## Options

- `--check-only` downloads and checks without activating the product.
- `--local-folder FOLDER` uses a folder of downloaded files instead of the link (a folder path as the
  only argument works too).
- Every update uninstalls SFlow's Copilot plugin and owned skills and installs them again.
  `--reinstall` also removes the VS Code extension before installing it again, inside the product
  transaction; the standalone edition enables it automatically. VS Code's menu never does that: it
  installs the extension over itself, so a failed install cannot leave VS Code without the menu.
- `--timeout-seconds 1800` changes the remembered download timeout. Default: 15 minutes; accepted range: 5–60 minutes.
- Give a new folder link to replace the saved location.
- Keep one current pair in the folder. If several exist, the newest of each type is selected by SharePoint's modification dates. Ambiguous dates or mismatched builds stop with a concrete error and preserve the current installation.

VS Code and GitHub Copilot CLI must already be installed. The updater prepares SFlow's pinned private Node if needed, without replacing global Node/npm or requesting administrator access. Existing corporate runtime mirror settings `SINGULARITY_FLOW_NODE_MIRROR` and `SINGULARITY_FLOW_NODE_ARCHIVE_DIR` apply.

## Settings and recovery

The remembered link is stored in `~/.singularity-flow/package-updater/source.json` (under the Windows user profile on Windows). `SINGULARITY_FLOW_PACKAGE_UPDATER_HOME` can redirect this machine-local folder. The file keeps the link in `source` and a chosen folder in `localFolder`; `mode` (`folder` or `local-folder`) says which one is used, so switching to downloaded files never forgets the link. An older updater reads only `source`.

Successful staging is cleaned up. A failed update retains its exact downloaded files and prints their location. The product installer owns activation and recovery; rerunning the updater completes any retained product operation before accepting a new build. An existing legacy recovery blocker retains its exact original recovery route.

Public folder tokens and cookies are obtained fresh and removed after downloading. Browser cookies are not imported and no Microsoft app registration or sign-in is required for a public download. A sign-in-only link or unsupported page layout receives an explicit error. The system curl handles HTTPS and corporate proxies/certificates; `CURL_CA_BUNDLE` can provide an approved CA bundle on either OS. TLS verification remains enabled.

## Verification

```sh
node --test test/package-updater.test.mjs test/package-updater-standalone.test.mjs \
  test/package-updater-sources.test.mjs test/package-updater-cli-install.test.mjs test/vscode-sflow-update.test.mjs
```

The suite exercises public-folder metadata, pagination/cookies, direct downloads, saved-link reuse, both launchers, mismatched files, interrupted installation and offline package staging in isolated machine state. The local HTTPS certificate is generated by the fixture; no machine certificate store is modified. Windows runs exercise Windows PowerShell 5.1 and PowerShell 7.

The protocol uses the scoped drive/download details exposed by the public folder page and [SharePoint REST v2 endpoints](https://learn.microsoft.com/en-us/sharepoint/dev/apis/sharepoint-rest-graph). A real organisation's folder still needs its own connectivity/access check; fixture tests do not establish access to that tenant.
