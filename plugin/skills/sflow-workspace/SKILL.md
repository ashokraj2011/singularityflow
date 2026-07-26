---
name: sflow-workspace
description: Select a saved Singularity Flow workspace and repository for this Copilot session, optionally binding the visible context to a Story ID.
disable-model-invocation: true
---
# Switch the active Singularity Flow workspace

1. Run `singularity-flow workspace list --json`.
2. If no workspaces are saved, explain that a workspace must first be created or opened in the desktop app. Do not invent a directory or repository URL.
3. Use Copilot's `ask_user` facility to ask the contributor to choose the exact workspace. Show its name, workspace ID, Jira anchor, and path.
4. If the workspace contains multiple repositories, ask which repository to use. Clearly mark the configured lead repository when that information is available from `workspace status`.
5. If the contributor supplied a Story/Jira ID, preserve it. Otherwise let Singularity Flow detect a Story from the selected repository's checked-out governed branch.
6. Run:

   `singularity-flow workspace use <WORKSPACE-ID> --repository <REPOSITORY-ID> [--story <STORY-ID>] --json`

7. Reproduce the returned `prompt`, workspace, repository, path, branch, and Story in the visible response. Treat the returned repository path as the working directory for subsequent shell commands in this Copilot session.
8. Do not launch a nested Copilot process from inside Copilot. Explain that a new terminal session can start directly in this context with `singularity-flow workspace copilot`; its Copilot session name contains the workspace and Story.
9. Be explicit that GitHub Copilot does not support replacing its native `>` input marker. The Singularity Flow context label is a session banner/name and governed prompt context, not a modification of Copilot's built-in UI.

