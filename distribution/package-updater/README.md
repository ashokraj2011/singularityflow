# SFlow updater for Mac and Windows

1. Extract this entire ZIP to a folder you want to keep.
2. Close SFlow sessions in VS Code and Copilot before reinstalling.
3. Mac: open **Update SFlow.command**. Windows: open **Update SFlow.cmd**.
4. On first use, paste the public SharePoint folder link when prompted.

The folder must contain the current SFlow `.tgz` and `.vsix`, downloadable without sign-in.
Future runs remember the link: open the same launcher again.

You can also run from a terminal in this extracted folder:

Mac:

```sh
bash update-sflow.sh
```

Windows PowerShell:

```powershell
.\update-sflow.ps1
```

To provide or change the link directly, add it as one quoted argument.
`--check-only` downloads and checks the packages without installing anything.
`--timeout-seconds 1800` changes the saved download timeout (default 15 minutes; range 5–60 minutes).

The updater downloads and checks both packages before changing the installation. It installs and
verifies the SFlow CLI, removes and reinstalls the SFlow VS Code extension, then removes and
reinstalls SFlow's Copilot plugin and owned skills. It checks that all surfaces match the download.
The CLI's previous release stays available for recovery. Workspaces, Stories, documents, personal
settings, other extensions and personal skills are preserved.

Microsoft VS Code and GitHub Copilot CLI must already be installed. Their applications and your
global Node/npm are preserved. SFlow's private Node is prepared automatically when needed; no
administrator access, repository clone, npm install command or signing key is required from users.
On Mac, if opening the launcher is restricted, use the Terminal command above. Corporate execution
policy still applies on Windows.

After completion, restart VS Code/Copilot and open a new terminal. The updater never force-closes
applications. If an operation fails, its error and retained files are reported. Fix the reported
cause and run the same updater again; the full-product installer owns the resumable transaction.
Active installation recovery is preserved, including any exact legacy recovery instruction.

The link is stored under your user profile at `.singularity-flow/package-updater/source.json`,
outside this extracted folder. `SINGULARITY_FLOW_PACKAGE_UPDATER_HOME` can redirect that location.
Keep all files in this extracted folder together; the scripts need their accompanying runtime files.

Source trust is your chosen HTTPS folder. Matching identities and content hashes are checked;
this direct updater does not claim signed-release certification or sign in to Microsoft for you.
