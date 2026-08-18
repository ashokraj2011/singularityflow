---
name: sflow-workspace
description: Select a saved Singularity Flow workspace and repository for this Copilot session, optionally binding the visible context to a Story ID.
disable-model-invocation: true

---
# Switch the active Singularity Flow workspace

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.

1. Run `singularity-flow workspace list --json`.
2. If no workspaces are saved, first check `singularity-flow workspace bootstrap status --json`. If an unfinished session exists, offer `/sf-workspace-bootstrap <BOOTSTRAP-ID>` instead of creating a duplicate. Otherwise explain how one is made: a workspace is a set of capabilities plus a local working directory, and the repositories it holds are what those capabilities ship from rather than a list anybody types. Offer `singularity-flow workspace prepare <LEAD-URL> --id <ID> --capability <ID> [--lead-capability <ID>] --base <DIRECTORY> --initialize`, or the New Workspace screen in the editor extension. Do not invent a directory, a capability, or a repository URL.
3. Use Copilot's `ask_user` facility to ask the contributor to choose the exact workspace. Show its name, workspace ID, Jira anchor, and path.
4. If the workspace contains multiple repositories, ask which repository to use. Clearly mark the lead repository when `workspace status` reports one — it is the repository the workspace's lead capability ships from, and it is where the orphan `state` branch lives.
5. If the contributor supplied a Story/Jira ID, preserve it. Otherwise let Singularity Flow detect a Story from the selected repository's checked-out governed branch.
6. Run:

   `singularity-flow workspace use <WORKSPACE-ID> --repository <REPOSITORY-ID> [--story <STORY-ID>] --json`

7. Reproduce the returned `prompt`, workspace, repository, path, branch, and Story in the visible response. Treat the returned repository path as the working directory for subsequent shell commands in this Copilot session.
8. Do not launch a nested Copilot process from inside Copilot. Explain that a new terminal session can start directly in this context with `singularity-flow workspace copilot`; its Copilot session name contains the workspace and Story.
9. Be explicit that GitHub Copilot does not support replacing its native `>` input marker. The Singularity Flow context label is a session banner/name and governed prompt context, not a modification of Copilot's built-in UI.
