---
id: jetbrains-ide
title: IntelliJ IDEA and Android Studio
aliases:
  - intellij
  - android-studio
  - jetbrains
commands:
  - home
related:
  - copilot-and-surfaces
  - developer-home
  - starting-work
  - workspaces-and-sessions
version: 1
---
The Singularity Flow plugin for IntelliJ IDEA and Android Studio shows your work in a tool window: the active Story and its steps, what needs you, what is worth checking, recent work, and the next actions. It reads `sflow home --json` and nothing else, so the CLI remains the only lifecycle controller and every confirmation stays in the CLI.

## Purpose and prerequisites

Use this topic to install and use the plugin.

- IntelliJ IDEA or Android Studio 2025.3 or newer (Android Studio Panda and later). Older versions cannot load the plugin: the terminal API it uses starts in 2025.3.
- Node.js 20 or newer and the Singularity Flow CLI, installed as usual. The plugin looks on the IDE's PATH, in the npm global directory, Homebrew, Volta and nvm. When it cannot find them, set exact paths in **Settings | Tools | Singularity Flow**.

## Use it from each surface

- **Shell:** `sflow home` prints the same home the panel shows.
- **Copilot:** `/sf-home` shows the same home in chat.
- **VS Code:** **My Work** in the Navigator is the same home.
- **IntelliJ IDEA and Android Studio:** open **View | Tool Windows | Singularity Flow**. The status bar reads `SFlow: <Work ID> · <phase>`, adds how many decisions wait on you, and opens the panel when clicked.

## Guided workflow

1. Download `singularity-flow-intellij-<version>.zip` from the release, then choose **Settings | Plugins | Install Plugin from Disk…** (in the gear menu). The plugin version is the CLI version it was built with; a CLI with a different minor version still works and shows a notice.
2. Open the panel. It shows the active work with its step rail, decisions waiting on you, local risks and faults worth checking, and recent work.
3. Hover over an action to see its exact command and what a click does, then click it:
   - A command the engine classifies as a read, such as `sflow status`, `sflow approvals FIX-1` or `sflow story return FIX-1`, runs in a new terminal tab.
   - Anything that can change state, such as `sflow resume`, `sflow start` or `sflow fix`, and every ceremony, is typed into a new terminal tab for you to review and run. A command with a placeholder such as `<WORK-ID>` is typed for you to complete.
4. The panel refreshes when files under `singularity/` or the active-workspace file change, after a branch switch, when a command in one of its terminal tabs finishes, when the IDE regains focus after more than a minute, and on **Refresh**. An optional timer in settings refreshes it while it is visible.

The panel follows the machine's active workspace, the same one `sflow home` shows in a terminal, whichever project the IDE has open. To show a different workspace in one project, set **Workspace** under **This Project** in the plugin settings. When the work's checkout is not the open project, such as a Story worktree, the panel names the directory where actions run.

## State and safety

The plugin starts only `node --version`, `sflow --version` and `sflow home --json`, with network access turned off for the read. It never runs Git and never itself runs a command that can change state. Which commands may run on click comes from the engine's own read/mutation classification, generated into the plugin when it is built, so the plugin and the CLI cannot disagree about it. A command that fails the safety check (anything but an sflow command, shell syntax, or a credential-shaped argument) is not offered. When the Terminal plugin is disabled, or the terminal's shell is one whose quoting the plugin cannot guarantee, the command is copied to the clipboard instead, prefixed with a change to the action's directory.

## Troubleshooting

- **Set up Singularity Flow:** Node or the CLI was not found or is too old. The card lists every place searched. An IDE started from the Dock may not see PATH entries added by your shell profile; set the paths in settings, then choose **Detect Again**.
- **sflow home did not answer:** a very large repository can make the read slow. The last result stays on screen, greyed; choose **Refresh** to try again.
- **Command copied:** paste it into a terminal. The copied text changes to the action's directory first.
- **The panel shows another project's work:** that is the machine's active workspace. Select a workspace with `sflow workspace use`, or set **Workspace** for this project.

## Related topics

Continue with `sflow explain copilot-and-surfaces`, `sflow explain developer-home`, `sflow explain workspaces-and-sessions`.
